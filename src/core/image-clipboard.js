const dns = require('dns');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { fileURLToPath } = require('url');
const { parseHttpUrl } = require('./network-policy');
const { resolveConnectionTarget } = require('./pinned-dns-proxy');

const MAX_CLIPBOARD_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 4;

async function loadClipboardImage(source, options = {}) {
  const value = String(source || '').trim();
  if (!value) throw new Error('图片地址为空。');
  if (value.startsWith('data:')) return loadDataImage(value, options.maxBytes);
  if (value.startsWith('file:')) return loadLocalImage(value, options.trustedRoots, options.maxBytes);
  return loadRemoteImage(value, options);
}

function loadDataImage(source, maxBytes = MAX_CLIPBOARD_IMAGE_BYTES) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(source);
  if (!match) throw new Error('只支持 Base64 编码的图片 Data URL。');
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  assertImageSize(buffer.length, maxBytes);
  return validatedImage(buffer, match[1].toLowerCase(), 'data');
}

function loadLocalImage(source, trustedRoots = [], maxBytes = MAX_CLIPBOARD_IMAGE_BYTES) {
  const candidate = fs.realpathSync(fileURLToPath(source));
  const roots = trustedRoots.filter(Boolean).map((root) => {
    try { return fs.realpathSync(path.resolve(root)); }
    catch { return path.resolve(root); }
  });
  if (!roots.some((root) => isInside(root, candidate))) throw new Error('该图片不在星藏家管理的 Workspace 中。');
  const stat = fs.statSync(candidate);
  if (!stat.isFile()) throw new Error('图片路径不是文件。');
  assertImageSize(stat.size, maxBytes);
  return validatedImage(fs.readFileSync(candidate), '', 'file');
}

async function loadRemoteImage(source, options = {}) {
  const maxBytes = Number(options.maxBytes || MAX_CLIPBOARD_IMAGE_BYTES);
  const lookup = options.lookup || dns.promises.lookup;
  let url = parseHttpUrl(source, '只支持 HTTP(S) 图片地址。');
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    if (url.username || url.password) throw new Error('图片地址不能包含账号凭据。');
    let target;
    try {
      target = await resolveConnectionTarget(url.hostname, { resolve: (hostname) => lookup(hostname, { all: true, verbatim: true }) });
    } catch (error) {
      if (/private-network|private network|local/i.test(error.message || String(error))) throw new Error('拒绝从本机或私有网络复制图片。');
      throw error;
    }
    const response = options.fetchImpl
      ? await options.fetchImpl(url, { redirect: 'manual', headers: imageRequestHeaders(), signal: AbortSignal.timeout(15000) })
      : await requestPinnedImage(url, target, options);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || redirect === MAX_REDIRECTS) throw new Error('远程图片重定向次数过多。');
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) throw new Error(`远程图片读取失败：HTTP ${response.status}`);
    const mimeType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!mimeType.startsWith('image/')) throw new Error('远程地址返回的不是图片。');
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize) assertImageSize(declaredSize, maxBytes);
    return validatedImage(await readLimitedBody(response, maxBytes), mimeType, 'remote');
  }
  throw new Error('远程图片读取失败。');
}

function requestPinnedImage(url, target, options = {}) {
  const requestModule = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = requestModule.request(url, {
      method: 'GET',
      headers: imageRequestHeaders(),
      agent: false,
      family: target.family,
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions?.all) callback(null, [{ address: target.address, family: target.family }]);
        else callback(null, target.address, target.family);
      },
      signal: options.signal || AbortSignal.timeout(15000)
    }, (response) => resolve({
      status: Number(response.statusCode || 0),
      ok: Number(response.statusCode || 0) >= 200 && Number(response.statusCode || 0) < 300,
      headers: { get: (name) => headerValue(response.headers, name) },
      body: response
    }));
    request.once('error', reject);
    request.end();
  });
}

function imageRequestHeaders() {
  return { accept: 'image/*', 'user-agent': 'StarOwner/desktop-image-copy' };
}

function headerValue(headers, name) {
  const value = headers[String(name || '').toLowerCase()];
  return Array.isArray(value) ? value.join(', ') : String(value || '');
}

async function readLimitedBody(response, maxBytes) {
  if (response.body?.[Symbol.asyncIterator]) {
    const chunks = [];
    let total = 0;
    for await (const value of response.body) {
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        response.body.destroy?.();
        assertImageSize(total, maxBytes);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  }
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    assertImageSize(buffer.length, maxBytes);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      assertImageSize(total, maxBytes);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function assertImageSize(size, maxBytes = MAX_CLIPBOARD_IMAGE_BYTES) {
  if (!Number.isFinite(size) || size <= 0) throw new Error('图片内容为空。');
  if (size > maxBytes) throw new Error(`图片超过 ${Math.round(maxBytes / 1024 / 1024)} MiB 限制。`);
}

function validatedImage(buffer, declaredMimeType, sourceType) {
  const detected = detectRasterImage(buffer);
  if (!detected) throw new Error('只支持 PNG、JPEG、GIF、WebP 或 AVIF 位图。');
  const declared = String(declaredMimeType || '').toLowerCase();
  if (declared && declared !== detected && !(declared === 'image/jpg' && detected === 'image/jpeg')) {
    throw new Error(`图片内容与声明格式 ${declared} 不一致。`);
  }
  return { buffer, mimeType: detected, sourceType };
}

function detectRasterImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp' && /avi[fs]/.test(buffer.subarray(8, Math.min(buffer.length, 40)).toString('ascii'))) return 'image/avif';
  return '';
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

module.exports = {
  MAX_CLIPBOARD_IMAGE_BYTES,
  detectRasterImage,
  loadClipboardImage
};
