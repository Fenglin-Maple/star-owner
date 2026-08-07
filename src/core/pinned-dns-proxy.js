const http = require('http');
const net = require('net');
const { pipeline } = require('stream');
const { isPrivateNetworkHost, parseHttpUrl } = require('./network-policy');

const DEFAULT_CONNECT_TIMEOUT_MS = 20000;
const EXPECTED_DISCONNECT_CODES = new Set([
  'ECONNABORTED',
  'ECONNRESET',
  'EPIPE',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_SOCKET_CLOSED'
]);

async function startPinnedDnsProxy(options = {}) {
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    consumeSocketError(response, 'HTTP client response');
    proxyHttpRequest(request, response, options).catch((error) => {
      writeProxyErrorResponse(response, error);
    });
  });
  server.on('connect', (request, clientSocket, head) => {
    consumeSocketError(clientSocket, 'HTTPS client socket');
    proxyHttpsTunnel(request, clientSocket, head, options).catch((error) => {
      writeTunnelErrorResponse(clientSocket, error);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    consumeSocketError(socket, 'proxy client socket');
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  return {
    host: '127.0.0.1',
    port: Number(address.port),
    proxyRules: `http=127.0.0.1:${address.port};https=127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

async function proxyHttpRequest(request, response, options) {
  if (!['GET', 'HEAD'].includes(String(request.method || '').toUpperCase())) throw new Error('Only GET and HEAD requests are allowed.');
  const url = parseHttpUrl(request.url, 'The proxy received an invalid HTTP URL.');
  if (url.protocol !== 'http:') throw new Error('Plain proxy requests must use HTTP.');
  if (url.username || url.password) throw new Error('URLs cannot contain embedded credentials.');
  const target = await resolveConnectionTarget(url.hostname, options);
  await new Promise((resolve, reject) => {
    let settled = false;
    let upstream = null;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      request.off('aborted', onClientAbort);
      response.off('close', onResponseClose);
      if (error) reject(error);
      else resolve();
    };
    const abortError = () => {
      const error = new Error('The HTTP client closed the proxy connection.');
      error.code = 'ECONNABORTED';
      return error;
    };
    const abortUpstream = () => {
      if (settled) return;
      if (upstream && !upstream.destroyed) upstream.destroy(abortError());
      finish(abortError());
    };
    const onClientAbort = () => abortUpstream();
    const onResponseClose = () => {
      if (!response.writableEnded && !response.writableFinished) abortUpstream();
    };
    const onRequestError = (error) => finish(error);
    const onResponseError = (error) => finish(error);
    const onUpstreamError = (error) => finish(error);
    request.once('aborted', onClientAbort);
    request.once('error', onRequestError);
    response.once('close', onResponseClose);
    response.once('error', onResponseError);
    upstream = http.request({
      protocol: 'http:',
      hostname: url.hostname,
      port: Number(url.port || 80),
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers: sanitizeRequestHeaders(request.headers, url.host),
      agent: false,
      family: target.family,
      lookup: pinnedLookup(target),
      timeout: Number(options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS)
    });
    upstream.once('socket', (socket) => verifyConnectedSocket(socket, target, options));
    upstream.once('timeout', () => upstream.destroy(new Error('Pinned HTTP connection timed out.')));
    upstream.once('error', onUpstreamError);
    upstream.once('response', (upstreamResponse) => {
      if (settled || response.destroyed || response.writableEnded || response.writableFinished) {
        upstreamResponse.resume();
        abortUpstream();
        return;
      }
      try {
        response.writeHead(upstreamResponse.statusCode || 502, sanitizeResponseHeaders(upstreamResponse.headers));
      } catch (error) {
        finish(error);
        return;
      }
      pipeline(upstreamResponse, response, (error) => finish(error));
    });
    try {
      upstream.end();
    } catch (error) {
      finish(error);
    }
  });
}

async function proxyHttpsTunnel(request, clientSocket, head, options) {
  const authority = parseAuthority(request.url);
  const target = await resolveConnectionTarget(authority.hostname, options);
  await new Promise((resolve, reject) => {
    let connected = false;
    let settled = false;
    let closing = false;
    const upstream = net.connect({ host: target.address, port: authority.port, family: target.family });
    const timeout = setTimeout(() => upstream.destroy(new Error('Pinned HTTPS connection timed out.')), Number(options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS));
    const closePair = () => {
      if (closing) return;
      closing = true;
      if (!clientSocket.destroyed) clientSocket.destroy();
      if (!upstream.destroyed) upstream.destroy();
    };
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const onClientClose = () => {
      closePair();
      if (!connected) {
        const error = new Error('The HTTPS client closed the proxy connection.');
        error.code = 'ECONNABORTED';
        finish(error);
      }
    };
    const onClientError = (error) => {
      closePair();
      if (!connected) finish(error);
    };
    const onUpstreamClose = () => {
      closePair();
      if (!connected) {
        const error = new Error('The pinned HTTPS connection closed before the tunnel was established.');
        error.code = 'ECONNRESET';
        finish(error);
      }
    };
    const onUpstreamError = (error) => {
      closePair();
      if (!connected) finish(error);
    };
    clientSocket.once('close', onClientClose);
    clientSocket.on('error', onClientError);
    upstream.once('close', onUpstreamClose);
    upstream.on('error', onUpstreamError);
    upstream.once('connect', () => {
      try {
        assertConnectedAddress(upstream.remoteAddress, target, options);
        if (clientSocket.destroyed || clientSocket.writableEnded || clientSocket.writableFinished) throw Object.assign(new Error('The HTTPS client closed the proxy connection.'), { code: 'ECONNABORTED' });
        clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: StarOwner\r\n\r\n');
        if (head?.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
        connected = true;
        finish();
      } catch (error) {
        closePair();
        finish(error);
      }
    });
  });
}

function writeProxyErrorResponse(response, error) {
  if (!response || response.destroyed || response.writableEnded || response.writableFinished) return;
  try {
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`Blocked by Star Owner network policy: ${error.message || String(error)}`);
  } catch (writeError) {
    if (!isExpectedDisconnect(writeError) && !response.destroyed) response.destroy();
  }
}

function writeTunnelErrorResponse(socket, error) {
  if (!socket || socket.destroyed || socket.writableEnded || socket.writableFinished) return;
  try {
    socket.end(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nBlocked by Star Owner network policy: ${error.message || String(error)}`);
  } catch (writeError) {
    if (!isExpectedDisconnect(writeError) && !socket.destroyed) socket.destroy();
  }
}

function consumeSocketError(socket, label) {
  if (!socket || socket.listenerCount('error')) return;
  socket.on('error', (error) => {
    if (!isExpectedDisconnect(error)) console.warn(`[pinned-dns-proxy] ${label}: ${error.message || String(error)}`);
  });
}

function isExpectedDisconnect(error) {
  if (!error) return false;
  if (EXPECTED_DISCONNECT_CODES.has(error.code)) return true;
  return /aborted|closed|connection reset|broken pipe|premature close/i.test(String(error.message || error));
}

async function resolveConnectionTarget(hostname, options = {}) {
  const host = normalizeAddress(hostname);
  const approvedPrivate = privateHostApproved(hostname, options);
  if (!approvedPrivate && isPrivateNetworkHost(host)) throw new Error('Local or private-network destinations are not allowed.');
  const records = net.isIP(host)
    ? [{ address: host, family: net.isIP(host) }]
    : normalizeResolvedAddresses(await (options.resolve || defaultResolve)(hostname));
  if (!records.length) throw new Error('The destination hostname could not be resolved.');
  if (!approvedPrivate && records.some((record) => isPrivateNetworkHost(record.address))) {
    throw new Error('The destination hostname resolved to a local or private-network address.');
  }
  return records[0];
}

function pinnedLookup(target) {
  return (_hostname, options, callback) => {
    if (options?.all) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  };
}

function verifyConnectedSocket(socket, target, options) {
  const event = socket.encrypted ? 'secureConnect' : 'connect';
  socket.once(event, () => {
    try { assertConnectedAddress(socket.remoteAddress, target, options); }
    catch (error) { socket.destroy(error); }
  });
}

function assertConnectedAddress(remoteAddress, target, options = {}) {
  const actual = normalizeAddress(remoteAddress);
  if (!actual || actual !== normalizeAddress(target.address)) throw new Error('The connected server address did not match the validated DNS result.');
  if (!privateHostApproved(options.requestedHostname || '', options) && isPrivateNetworkHost(actual) && !options.allowPrivate) {
    throw new Error('The connection reached a local or private-network address.');
  }
}

function parseAuthority(value) {
  let url;
  try { url = new URL(`http://${String(value || '')}`); }
  catch { throw new Error('The HTTPS proxy authority is invalid.'); }
  const port = Number(url.port || 443);
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535 || url.username || url.password) throw new Error('The HTTPS proxy authority is invalid.');
  return { hostname: url.hostname, port };
}

function sanitizeRequestHeaders(headers, host) {
  const next = { ...headers, host };
  for (const name of ['connection', 'proxy-authorization', 'proxy-connection', 'upgrade']) delete next[name];
  return next;
}

function sanitizeResponseHeaders(headers) {
  const next = { ...headers };
  for (const name of ['connection', 'proxy-authenticate', 'proxy-connection', 'upgrade']) delete next[name];
  return next;
}

function normalizeResolvedAddresses(records) {
  return (Array.isArray(records) ? records : [records])
    .map((record) => typeof record === 'string' ? { address: record, family: net.isIP(record) } : { address: record?.address, family: Number(record?.family || net.isIP(record?.address)) })
    .map((record) => ({ address: normalizeAddress(record.address), family: record.family }))
    .filter((record) => record.address && [4, 6].includes(record.family));
}

function normalizeAddress(value) {
  const address = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  return mapped ? mapped[1] : address;
}

function privateHostApproved(hostname, options = {}) {
  if (!options.allowPrivate) return false;
  if (!Array.isArray(options.allowedPrivateHosts)) return true;
  const host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  return options.allowedPrivateHosts.some((item) => String(item || '').trim().toLowerCase().replace(/\.$/, '') === host);
}

async function defaultResolve(hostname) {
  const dns = require('dns');
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

module.exports = { resolveConnectionTarget, startPinnedDnsProxy };
