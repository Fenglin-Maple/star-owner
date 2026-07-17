function unsupportedBilibiliUrlReason(value) {
  let url;
  try { url = value instanceof URL ? value : new URL(String(value || '')); }
  catch { return ''; }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const pathname = url.pathname.toLowerCase();
  if (hostname === 'live.bilibili.com' || hostname.endsWith('.live.bilibili.com')) return '当前版本只支持普通 BV 视频，不支持直播页面。';
  if (['manga.bilibili.com', 'show.bilibili.com', 'audio.bilibili.com'].includes(hostname)) return '当前版本只支持普通 BV 视频，不支持漫画、票务或音频页面。';
  if (pathname.startsWith('/bangumi/')) return '当前版本暂不支持番剧、电影、纪录片或综艺等 Bilibili PGC 页面（ep/ss/md）。';
  if (pathname.startsWith('/cheese/')) return '当前版本暂不支持 Bilibili 课程或付费课堂视频。';
  if (pathname.startsWith('/festival/')) return '当前版本暂不支持 Bilibili 活动聚合视频。';
  if (pathname.startsWith('/audio/') || pathname.startsWith('/live/')) return '当前版本只支持普通 BV 视频，不支持音频或直播页面。';
  return '';
}

function inspectVideoSupport(info = {}) {
  const redirectReason = unsupportedBilibiliUrlReason(info.redirectUrl || info.redirect_url || '');
  if (redirectReason) return { supported: false, kind: 'special-video', reason: redirectReason };
  const pages = Array.isArray(info.pages) ? info.pages : [];
  if (pages.length > 1) {
    return {
      supported: false,
      kind: 'multi-part',
      pageCount: pages.length,
      reason: `当前版本暂不支持多 P 视频（检测到 ${pages.length} 个分 P），任务已关闭以避免生成只覆盖第一 P 的不完整文档。`
    };
  }
  if (!String(info.bvid || '').trim()) return { supported: false, kind: 'missing-bvid', reason: '当前版本只支持具有 BV 号的普通单 P 视频。' };
  return { supported: true, kind: 'ordinary-single-part', pageCount: pages.length || 1, reason: '' };
}

module.exports = { inspectVideoSupport, unsupportedBilibiliUrlReason };
