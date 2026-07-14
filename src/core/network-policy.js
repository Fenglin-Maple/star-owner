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
  if (url.username || url.password) throw new Error('Bilibili URL cannot contain embedded credentials.');
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
    || (a === 192 && b === 0 && (octets[2] === 0 || octets[2] === 2))
    || (a === 192 && b === 88 && octets[2] === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19 || b === 51 && octets[2] === 100))
    || (a === 203 && b === 0 && octets[2] === 113);
}

function isPrivateIpv6(host) {
  const value = host.toLowerCase().split('%')[0];
  const bytes = parseIpv6(value);
  if (!bytes) return true;
  const allZero = bytes.every((byte) => byte === 0);
  const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  if (allZero || loopback) return true;
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) >= 0x80) return true;
  if (bytes[0] === 0xff) return true;
  if (matchesPrefix(bytes, [0x01, 0x00], 8)) return true; // 100::/64 discard-only
  if (matchesPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)) return true;
  if (matchesPrefix(bytes, [0x20, 0x01, 0x00, 0x02], 48)) return true;
  if (matchesPrefix(bytes, [0x20, 0x01, 0x00, 0x10], 28) || matchesPrefix(bytes, [0x20, 0x01, 0x00, 0x20], 28)) return true;

  const compatible = bytes.slice(0, 12).every((byte) => byte === 0);
  const mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const translated = bytes.slice(0, 8).every((byte) => byte === 0) && bytes[8] === 0xff && bytes[9] === 0xff;
  const nat64 = matchesPrefix(bytes, [0x00, 0x64, 0xff, 0x9b], 96) || matchesPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48);
  if ((compatible || mapped || translated || nat64) && isPrivateIpv4(bytesToIpv4(bytes.slice(12)))) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x02 && isPrivateIpv4(bytesToIpv4(bytes.slice(2, 6)))) return true;
  return false;
}

function parseIpv6(value) {
  let text = String(value || '').toLowerCase();
  if (text.includes('.')) {
    const split = text.lastIndexOf(':');
    const ipv4 = text.slice(split + 1);
    if (!net.isIPv4(ipv4)) return null;
    const octets = ipv4.split('.').map(Number);
    text = `${text.slice(0, split)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  if ((text.match(/::/g) || []).length > 1) return null;
  const [leftText, rightText] = text.split('::');
  const left = leftText ? leftText.split(':') : [];
  const right = rightText ? rightText.split(':') : [];
  const missing = text.includes('::') ? 8 - left.length - right.length : 0;
  if (missing < 0 || (!text.includes('::') && left.length !== 8)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 255];
  });
}

function matchesPrefix(bytes, prefix, bits) {
  const fullBytes = Math.floor(bits / 8);
  const remaining = bits % 8;
  for (let index = 0; index < fullBytes; index += 1) if (bytes[index] !== prefix[index]) return false;
  if (!remaining) return true;
  const mask = 0xff << (8 - remaining) & 0xff;
  return (bytes[fullBytes] & mask) === ((prefix[fullBytes] || 0) & mask);
}

function bytesToIpv4(bytes) {
  return bytes.map(Number).join('.');
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
