const http = require('http');
const net = require('net');
const { isPrivateNetworkHost, parseHttpUrl } = require('./network-policy');

const DEFAULT_CONNECT_TIMEOUT_MS = 20000;

async function startPinnedDnsProxy(options = {}) {
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    proxyHttpRequest(request, response, options).catch((error) => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end(`Blocked by Star Owner network policy: ${error.message || String(error)}`);
    });
  });
  server.on('connect', (request, clientSocket, head) => {
    proxyHttpsTunnel(request, clientSocket, head, options).catch((error) => {
      if (!clientSocket.destroyed) {
        clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nBlocked by Star Owner network policy: ${error.message || String(error)}`);
      }
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
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
    const upstream = http.request({
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
    upstream.once('error', reject);
    upstream.once('response', (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, sanitizeResponseHeaders(upstreamResponse.headers));
      upstreamResponse.once('error', reject);
      upstreamResponse.pipe(response);
      upstreamResponse.once('end', resolve);
    });
    upstream.end();
  });
}

async function proxyHttpsTunnel(request, clientSocket, head, options) {
  const authority = parseAuthority(request.url);
  const target = await resolveConnectionTarget(authority.hostname, options);
  await new Promise((resolve, reject) => {
    const upstream = net.connect({ host: target.address, port: authority.port, family: target.family });
    const timeout = setTimeout(() => upstream.destroy(new Error('Pinned HTTPS connection timed out.')), Number(options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS));
    upstream.once('error', reject);
    upstream.once('connect', () => {
      clearTimeout(timeout);
      try {
        assertConnectedAddress(upstream.remoteAddress, target, options);
        clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: StarOwner\r\n\r\n');
        if (head?.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
        resolve();
      } catch (error) {
        upstream.destroy();
        reject(error);
      }
    });
  });
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
