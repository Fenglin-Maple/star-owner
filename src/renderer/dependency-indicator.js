(function exposeDependencyIndicator(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StarOwnerDependencyIndicator = api;
})(typeof globalThis === 'undefined' ? this : globalThis, () => {
  const ACTIVE_STATUSES = new Set([
    'resolving',
    'downloading',
    'pausing',
    'paused',
    'importing',
    'verifying',
    'waiting-install',
    'installing',
    'cancelling'
  ]);

  const STATUS_LABELS = Object.freeze({
    resolving: '正在连接',
    downloading: '正在下载',
    pausing: '正在暂停',
    paused: '已暂停',
    importing: '正在导入',
    verifying: '正在校验',
    'waiting-install': '等待安装',
    installing: '正在安装',
    cancelling: '正在中止'
  });

  function clampProgress(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
  }

  function activeDependencyPackages(state = {}) {
    return (Array.isArray(state.packages) ? state.packages : [])
      .filter((item) => ACTIVE_STATUSES.has(String(item?.status || '')))
      .map((item) => ({ ...item, progress: clampProgress(item.progress) }));
  }

  function aggregateDependencyProgress(packages = []) {
    if (!packages.length) return 0;
    const weighted = packages.filter((item) => Number(item.totalBytes) > 0);
    if (weighted.length === packages.length) {
      const totalBytes = weighted.reduce((sum, item) => sum + Number(item.totalBytes), 0);
      if (totalBytes > 0) {
        return clampProgress(weighted.reduce((sum, item) => sum + clampProgress(item.progress) * Number(item.totalBytes), 0) / totalBytes);
      }
    }
    return clampProgress(packages.reduce((sum, item) => sum + clampProgress(item.progress), 0) / packages.length);
  }

  function dependencyStatusLabel(status) {
    return STATUS_LABELS[String(status || '')] || '处理中';
  }

  return { ACTIVE_STATUSES, activeDependencyPackages, aggregateDependencyProgress, dependencyStatusLabel };
});
