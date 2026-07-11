function isLoginRequiredMessage(value) {
  const message = String(value || '').toLowerCase();
  return [
    'login required',
    'login is required',
    'sign in to confirm',
    'sign in to view',
    'only available for registered users',
    'cookies are required',
    'use --cookies',
    'private video',
    'this video is private',
    '需要登录',
    '请先登录',
    '登录后才能',
    '仅限登录',
    '仅限注册用户'
  ].some((pattern) => message.includes(pattern));
}

function loginRequiredError(detail) {
  const error = new Error(`公开访问失败，Bilibili 要求登录：${String(detail || '').slice(0, 600)}`);
  error.code = 'BILIBILI_LOGIN_REQUIRED';
  return error;
}

module.exports = { isLoginRequiredMessage, loginRequiredError };
