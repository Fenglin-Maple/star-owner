const fs = require('fs');

const BILIBILI_COOKIE_REQUIRED = 'BILIBILI_COOKIE_REQUIRED';

async function requireBilibiliCookie({ bili, user, purpose = '请求 B站视频', refresh = false, requireLoginCookie = false } = {}) {
  if (!user?.isLogin) throw bilibiliCookieRequiredError(`${purpose}前未检测到已登录的 B站账户。`);

  let cookieFile = String(user.cookieFile || '').trim();
  if (refresh || !isUsableBilibiliCookieFile(cookieFile)) {
    try {
      cookieFile = String(await bili?.exportCookies?.(user.name || String(user.mid || user.id || 'bilibili')) || '').trim();
    } catch (error) {
      throw bilibiliCookieRequiredError(`${purpose}前无法导出登录 Cookie：${error?.message || String(error)}`);
    }
  }
  if (!isUsableBilibiliCookieFile(cookieFile)) {
    throw bilibiliCookieRequiredError(`${purpose}前没有找到可用的 B站登录 Cookie。`);
  }
  if (requireLoginCookie && !hasBilibiliLoginCookieFile(cookieFile)) {
    throw bilibiliCookieRequiredError(`${purpose}前导出的 B站登录 Cookie 已失效或不存在。`);
  }
  return cookieFile;
}

function isUsableBilibiliCookieFile(file) {
  const cookieFile = String(file || '').trim();
  if (!cookieFile) return false;
  try {
    const stat = fs.lstatSync(cookieFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 8 * 1024 * 1024) return false;
    return parseBilibiliCookieLines(fs.readFileSync(cookieFile, 'utf8')).length > 0;
  } catch {
    return false;
  }
}

function readBilibiliCookieHeader(file) {
  if (!isUsableBilibiliCookieFile(file)) return '';
  try {
    return parseBilibiliCookieLines(fs.readFileSync(file, 'utf8'))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
  } catch {
    return '';
  }
}

function hasBilibiliLoginCookieFile(file) {
  const cookieFile = String(file || '').trim();
  if (!cookieFile) return false;
  try {
    return parseBilibiliCookieLines(fs.readFileSync(cookieFile, 'utf8'))
      .some((cookie) => cookie.name.toUpperCase() === 'SESSDATA');
  } catch {
    return false;
  }
}

function parseBilibiliCookieLines(value) {
  const now = Math.floor(Date.now() / 1000);
  const cookies = [];
  for (const rawLine of String(value || '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length);
    else if (line.startsWith('#')) continue;
    const fields = line.split('\t');
    if (fields.length < 7 || !isBilibiliCookieDomain(fields[0])) continue;
    const expires = Number(fields[4] || 0);
    const name = String(fields[5] || '').trim();
    const cookieValue = String(fields.slice(6).join('\t') || '').trim();
    if (!name || !cookieValue || (Number.isFinite(expires) && expires > 0 && expires <= now)) continue;
    cookies.push({ name, value: cookieValue });
  }
  return cookies;
}

function isBilibiliCookieDomain(value) {
  const domain = String(value || '').trim().toLowerCase().replace(/^\./, '');
  return domain === 'bilibili.com' || domain.endsWith('.bilibili.com');
}

function bilibiliCookieRequiredError(detail = '') {
  const reason = String(detail || '').trim();
  const error = new Error(`${reason ? `${reason} ` : ''}请先在应用的 B站登录页面完成登录，再重试当前操作。`);
  error.code = BILIBILI_COOKIE_REQUIRED;
  return error;
}

module.exports = {
  BILIBILI_COOKIE_REQUIRED,
  bilibiliCookieRequiredError,
  hasBilibiliLoginCookieFile,
  isUsableBilibiliCookieFile,
  readBilibiliCookieHeader,
  requireBilibiliCookie
};
