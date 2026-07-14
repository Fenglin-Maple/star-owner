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

function isVideoUnavailableMessage(value) {
  const message = String(value || '').toLowerCase();
  if (!message || isLoginRequiredMessage(message)) return false;
  return [
    '"code":-404',
    "'code': -404",
    'error code: -404',
    'bilibili api -404',
    'code=62002',
    'code=62004',
    '已失效视频',
    '视频已失效',
    '视频不存在',
    '稿件不可见',
    '已被删除',
    '已删除',
    '已下架',
    '被下架',
    'removed by the uploader',
    'video has been removed',
    'video is no longer available',
    'this video is unavailable',
    'video unavailable',
    'does not exist'
  ].some((pattern) => message.includes(pattern));
}

function loginRequiredError(detail) {
  const error = new Error(`公开访问失败，Bilibili 要求登录：${String(detail || '').slice(0, 600)}`);
  error.code = 'BILIBILI_LOGIN_REQUIRED';
  return error;
}

function videoUnavailableError(detail) {
  const error = new Error(`Bilibili 视频已删除、下架或不可用：${String(detail || '').slice(0, 1200)}`);
  error.code = 'BILIBILI_VIDEO_UNAVAILABLE';
  error.failureKind = 'terminal-video';
  return error;
}

module.exports = {
  isLoginRequiredMessage,
  isVideoUnavailableMessage,
  loginRequiredError,
  videoUnavailableError
};
