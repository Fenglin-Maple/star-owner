const fs = require('fs');

function prepareModelVisionImage(nativeImage, file, options = {}) {
  const original = fs.readFileSync(file);
  const image = nativeImage.createFromBuffer(original);
  if (image.isEmpty()) throw new Error('图片格式无法读取或内容已经损坏。');
  const maxBytes = Math.max(128 * 1024, Number(options.maxBytes) || 1024 * 1024);
  const maxDimension = Math.max(512, Number(options.maxDimension) || 2048);
  const inputMimeType = String(options.mimeType || '').toLowerCase() === 'image/jpg' ? 'image/jpeg' : String(options.mimeType || '').toLowerCase();
  const originalSize = image.getSize();
  const passthroughTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
  if (passthroughTypes.has(inputMimeType) && original.length <= maxBytes && Math.max(originalSize.width, originalSize.height) <= maxDimension) {
    return { buffer: original, mimeType: inputMimeType, ...originalSize };
  }

  let scale = Math.min(1, maxDimension / Math.max(1, originalSize.width, originalSize.height));
  let smallest = null;
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const width = Math.max(1, Math.round(originalSize.width * scale));
    const height = Math.max(1, Math.round(originalSize.height * scale));
    const resized = width === originalSize.width && height === originalSize.height
      ? image
      : image.resize({ width, height, quality: 'good' });
    if (inputMimeType === 'image/png') {
      const png = resized.toPNG();
      if (png.length <= maxBytes) return { buffer: png, mimeType: 'image/png', width, height };
    }
    const quality = Math.max(52, 88 - attempt * 6);
    const jpeg = resized.toJPEG(quality);
    if (!smallest || jpeg.length < smallest.buffer.length) smallest = { buffer: jpeg, mimeType: 'image/jpeg', width, height };
    if (jpeg.length <= maxBytes) return { buffer: jpeg, mimeType: 'image/jpeg', width, height };
    scale *= 0.82;
  }
  if (smallest?.buffer.length <= maxBytes) return smallest;
  throw new Error(`图片优化后仍超过模型输入上限（${Math.ceil((smallest?.buffer.length || original.length) / 1024)} KiB）。`);
}

module.exports = { prepareModelVisionImage };
