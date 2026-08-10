(function exposeBilibiliAuthNotice(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StarOwnerBilibiliAuthNotice = api;
})(typeof globalThis === 'undefined' ? this : globalThis, () => {
  const LOGIN_GUIDANCE = '请前往应用内部的“B站登录”功能完成登录后重试。';

  function isBilibiliCookieRequired(error) {
    if (String(error?.code || '') === 'BILIBILI_COOKIE_REQUIRED') return true;
    const message = String(error?.message || error || '');
    return /BILIBILI_COOKIE_REQUIRED|未检测到已登录的 B站账户|没有找到可用的 B站登录 Cookie|无法导出登录 Cookie|B站登录 Cookie (?:已失效|不存在)|请先在应用的 B站登录页面完成登录|Not logged in(?: to Bilibili in the desktop app)?\.?/i.test(message);
  }

  function notifyBilibiliCookieRequired(error, notify) {
    if (!isBilibiliCookieRequired(error)) return false;
    if (typeof notify === 'function') notify('需要 B站登录 Cookie', LOGIN_GUIDANCE, 'error');
    return true;
  }

  return { LOGIN_GUIDANCE, isBilibiliCookieRequired, notifyBilibiliCookieRequired };
});
