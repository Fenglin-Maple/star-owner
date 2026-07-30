const fs = require('fs');
const path = require('path');

const DEFAULT_MIN_FREE_BYTES = 2 * 1024 ** 3;
const DEFAULT_MIN_FREE_RATIO = 0.02;
const DEFAULT_MAX_RATIO_BYTES = 8 * 1024 ** 3;

function existingPath(value) {
  let target = path.resolve(String(value || process.cwd()));
  while (!fs.existsSync(target) && path.dirname(target) !== target) target = path.dirname(target);
  return target;
}

function checkDiskSpace(target, options = {}) {
  const root = existingPath(target);
  const stat = options.statfs || fs.statfsSync;
  try {
    const result = stat(root);
    const blockSize = Number(result.bsize || result.frsize || 0);
    const availableBlocks = Number(result.bavail ?? result.bfree ?? 0);
    const totalBlocks = Number(result.blocks || 0);
    const freeBytes = Math.max(0, blockSize * availableBlocks);
    const totalBytes = Math.max(0, blockSize * totalBlocks);
    const ratioMinimum = totalBytes
      ? Math.min(totalBytes * Number(options.minFreeRatio ?? DEFAULT_MIN_FREE_RATIO), Number(options.maxRatioBytes || DEFAULT_MAX_RATIO_BYTES))
      : 0;
    const minimumBytes = Math.max(Number(options.minFreeBytes || DEFAULT_MIN_FREE_BYTES), ratioMinimum);
    return {
      path: root,
      freeBytes,
      totalBytes,
      minimumBytes,
      safe: freeBytes >= minimumBytes,
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      path: root,
      freeBytes: 0,
      totalBytes: 0,
      minimumBytes: Number(options.minFreeBytes || DEFAULT_MIN_FREE_BYTES),
      safe: false,
      unavailable: true,
      error: error.message || String(error),
      checkedAt: new Date().toISOString()
    };
  }
}

function assertDiskSpace(target, options = {}) {
  const state = checkDiskSpace(target, options);
  if (state.safe) return state;
  const error = new Error(state.unavailable
    ? `无法检查磁盘剩余空间：${state.error}`
    : `磁盘剩余空间不足：${formatBytes(state.freeBytes)} 可用，至少需要保留 ${formatBytes(state.minimumBytes)}。请清理磁盘或更换 Workspace。`);
  error.code = 'DISK_SPACE_LOW';
  error.failureKind = 'infrastructure';
  error.disk = state;
  throw error;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

module.exports = {
  DEFAULT_MIN_FREE_BYTES,
  DEFAULT_MIN_FREE_RATIO,
  DEFAULT_MAX_RATIO_BYTES,
  assertDiskSpace,
  checkDiskSpace,
  formatBytes
};
