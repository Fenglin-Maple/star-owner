const dns = require('dns');
const { isPrivateNetworkHost, parseHttpUrl } = require('./network-policy');

async function assertHiddenBrowserUrl(value, options = {}) {
  const url = parseHttpUrl(value, 'Hidden browser only supports HTTP(S).');
  if (url.username || url.password) throw new Error('Hidden browser URLs cannot contain credentials.');
  const allowPrivate = privateHostApproved(url.hostname, options);
  if (!allowPrivate && isPrivateNetworkHost(url.hostname)) throw new Error('Hidden browser refused a local or private-network address.');
  const resolve = options.resolve || defaultResolve;
  const addresses = await resolve(url.hostname);
  if (!addresses.length) throw new Error('Hidden browser could not resolve the requested hostname.');
  if (!allowPrivate && addresses.some((address) => isPrivateNetworkHost(address))) {
    throw new Error('Hidden browser refused a hostname that resolves to a local or private-network address.');
  }
  return url;
}

function installHiddenBrowserRequestGuard(webRequest, options = {}) {
  webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    assertHiddenBrowserUrl(details.url, options)
      .then(() => callback({ cancel: false }))
      .catch(() => callback({ cancel: true }));
  });
}

async function defaultResolve(hostname) {
  const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return records.map((item) => item.address);
}

function privateHostApproved(hostname, options = {}) {
  if (!options.allowPrivate) return false;
  if (!Array.isArray(options.allowedPrivateHosts)) return true;
  const host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  return options.allowedPrivateHosts.some((item) => String(item || '').trim().toLowerCase().replace(/\.$/, '') === host);
}

module.exports = { assertHiddenBrowserUrl, installHiddenBrowserRequestGuard };
