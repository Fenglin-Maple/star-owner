const fs = require('fs');
const path = require('path');
const { fileURLToPath, pathToFileURL } = require('url');
const { detectRasterImage } = require('./image-clipboard');

const MAX_README_IMAGE_BYTES = 15 * 1024 * 1024;

function resolveReadmeImage(root, source) {
  const value = String(source || '').trim();
  if (!value || value.length > 2048 || value.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(value)) return '';
  try {
    const realRoot = realpath(path.resolve(root));
    const baseUrl = pathToFileURL(`${realRoot}${path.sep}`);
    const targetUrl = new URL(value, baseUrl);
    if (targetUrl.protocol !== 'file:' || targetUrl.host) return '';
    targetUrl.search = '';
    targetUrl.hash = '';
    const realFile = realpath(fileURLToPath(targetUrl));
    if (!isInside(realRoot, realFile)) return '';
    const stat = fs.lstatSync(realFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_README_IMAGE_BYTES) return '';
    const descriptor = fs.openSync(realFile, 'r');
    try {
      const header = Buffer.alloc(Math.min(64, stat.size));
      fs.readSync(descriptor, header, 0, header.length, 0);
      if (!detectRasterImage(header)) return '';
    } finally {
      fs.closeSync(descriptor);
    }
    return pathToFileURL(realFile).href;
  } catch {
    return '';
  }
}

function realpath(target) {
  return fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target);
}

function isInside(root, candidate) {
  const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root;
  const normalizedCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

module.exports = { MAX_README_IMAGE_BYTES, resolveReadmeImage };
