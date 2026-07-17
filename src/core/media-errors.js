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
  if (/(?:bilibili api|error code|code\s*[=:])\s*["']?(?:-404|62002|62004|62012)\b/i.test(message)) return true;
  if (/["']code["']\s*:\s*(?:-404|62002|62004|62012)\b/i.test(message)) return true;
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
    'video does not exist',
    'video not found',
    '视频已失效',
    '视频不存在',
    '稿件不可见',
    '已被删除',
    '已删除',
    '已下架',
    '被下架',
    '仅up主自己可见'
  ].some((pattern) => message.includes(pattern));
}

function isSubmissionValidationMessage(value) {
  const message = String(value || '');
  return /Markdown section order must begin|Referenced image .* file does not exist|Markdown is missing|Mermaid fenced code block|提交校验失败|Markdown 未通过校验|Markdown 校验/i.test(message);
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

function unsupportedVideoError(detail, kind = 'unsupported-video') {
  const error = new Error(String(detail || '当前版本暂不支持该视频类型。').slice(0, 1200));
  error.code = 'UNSUPPORTED_VIDEO_TYPE';
  error.failureKind = 'unsupported-video';
  error.unsupportedKind = String(kind || 'unsupported-video');
  return error;
}

module.exports = {
  isLoginRequiredMessage,
  isSubmissionValidationMessage,
  isVideoUnavailableMessage,
  loginRequiredError,
  unsupportedVideoError,
  videoUnavailableError
};
