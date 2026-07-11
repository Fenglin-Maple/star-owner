const net = require('net');

const BILIBILI_HOSTS = new Set(['bilibili.com', 'b23.tv']);

function parseHttpUrl(value, message = 'Only HTTP(S) URLs are supported.') {
  let url;
  try { url = new URL(String(value || '')); }
  catch { throw new Error(message); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(message);
  return url;
}

function isBilibiliHost(hostname) {
  const host = normalizeHost(hostname);
  return [...BILIBILI_HOSTS].some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function assertBilibiliUrl(value) {
  const url = parseHttpUrl(value, '仅支持 Bilibili 官方视频链接。');
  if (!isBilibiliHost(url.hostname)) throw new Error(`拒绝访问非 Bilibili 域名：${url.hostname}`);
  return url;
}

function isAllowedApiOrigin(origin, apiUrl) {
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(apiUrl).origin; }
  catch { return false; }
}

function isPrivateNetworkHost(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const family = net.isIP(host);
  if (family === 4) return isPrivateIpv4(host);
  if (family === 6) return isPrivateIpv6(host);
  return false;
}

function isPrivateIpv4(host) {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function isPrivateIpv6(host) {
  const value = host.toLowerCase().split('%')[0];
  if (value === '::' || value === '::1') return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(value)) return true;
  const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  const mappedHex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!mappedHex) return false;
  const high = Number.parseInt(mappedHex[1], 16);
  const low = Number.parseInt(mappedHex[2], 16);
  return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
}

function normalizeHost(value) {
  return String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

module.exports = {
  assertBilibiliUrl,
  isAllowedApiOrigin,
  isBilibiliHost,
  isPrivateNetworkHost,
  parseHttpUrl
};
