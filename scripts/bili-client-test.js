const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { isUsableBilibiliCookieFile, readBilibiliCookieHeader, requireBilibiliCookie } = require('../src/core/bilibili-auth');
const { BiliClient, isBilibiliCookieDomain, normalizeBilibiliAssetUrl } = require('../src/core/bili');

(async () => {
  const authRoot = path.join(__dirname, '..', '.cache', 'bili-auth-test');
  fs.rmSync(authRoot, { recursive: true, force: true });
  fs.mkdirSync(authRoot, { recursive: true });
  const cookieFile = path.join(authRoot, 'cookies.txt');
  fs.writeFileSync(cookieFile, '# Netscape HTTP Cookie File\n', 'utf8');
  assert.strictEqual(isUsableBilibiliCookieFile(cookieFile), false, 'comment-only Cookie file was treated as authenticated');
  fs.writeFileSync(cookieFile, '# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE\t1\tSESSDATA\texpired\n', 'utf8');
  assert.strictEqual(isUsableBilibiliCookieFile(cookieFile), false, 'expired B站 Cookie was treated as usable');
  fs.writeFileSync(cookieFile, '# Netscape HTTP Cookie File\n#HttpOnly_.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\ttest-session\n', 'utf8');
  assert(isUsableBilibiliCookieFile(cookieFile) && readBilibiliCookieHeader(cookieFile) === 'SESSDATA=test-session', 'valid HttpOnly B站 Cookie was not parsed');
  await assert.rejects(() => requireBilibiliCookie({ bili: {}, user: null, purpose: '测试视频请求' }), (error) => error.code === 'BILIBILI_COOKIE_REQUIRED');

  assert.strictEqual(normalizeBilibiliAssetUrl('http://i0.hdslb.com/avatar.jpg'), 'https://i0.hdslb.com/avatar.jpg');
  assert.strictEqual(normalizeBilibiliAssetUrl('//i1.hdslb.com/avatar.jpg'), 'https://i1.hdslb.com/avatar.jpg');
  assert.strictEqual(normalizeBilibiliAssetUrl('https://i2.hdslb.com/avatar.jpg'), 'https://i2.hdslb.com/avatar.jpg');
  assert(isBilibiliCookieDomain('.bilibili.com') && isBilibiliCookieDomain('passport.bilibili.com'));
  assert(!isBilibiliCookieDomain('notbilibili.com') && !isBilibiliCookieDomain('bilibili.com.example.org'));

  const originalFetch = global.fetch;
  let anonymousNavCookie = null;
  global.fetch = async (_url, options = {}) => {
    anonymousNavCookie = options.headers?.cookie;
    return new Response(JSON.stringify({
      code: 0,
      data: { isLogin: true, mid: 123, uname: 'Avatar test', face: 'http://i0.hdslb.com/avatar.jpg' }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const client = new BiliClient(() => ({ cookies: { get: async () => [] } }));
    const profile = await client.nav();
    assert.strictEqual(profile.face, 'https://i0.hdslb.com/avatar.jpg');
    assert.strictEqual(anonymousNavCookie, '', 'login-state detection unexpectedly required an existing Cookie');
  } finally {
    global.fetch = originalFetch;
  }

  global.fetch = async () => new Response(JSON.stringify({ code: -101, message: '账号未登录' }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const loggedOutClient = new BiliClient(() => ({ cookies: { get: async () => [] } }));
    const loggedOut = await loggedOutClient.nav();
    assert.strictEqual(loggedOut.isLogin, false, 'Bilibili nav -101 was not normalized to a logged-out state');
  } finally {
    global.fetch = originalFetch;
  }

  let avatarRequests = 0;
  const avatarSession = {
    cookies: { get: async () => [] },
    fetch: async (url) => {
      avatarRequests += 1;
      return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': '4' }
      });
    }
  };
  const avatarClient = new BiliClient(() => avatarSession);
  const avatar = await avatarClient.fetchImageDataUrl('//i0.hdslb.com/avatar.jpg');
  assert(avatar.startsWith('data:image/jpeg;base64,'), 'avatar was not converted to a trusted data URL');
  assert.strictEqual(await avatarClient.fetchImageDataUrl('//i0.hdslb.com/avatar.jpg'), avatar);
  assert.strictEqual(avatarRequests, 1, 'avatar data URL cache was not reused');

  const mismatchedAvatar = new BiliClient(() => ({
    cookies: { get: async () => [] },
    fetch: async () => new Response(Buffer.from('<svg onload="alert(1)"></svg>'), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' }
    })
  }));
  await assert.rejects(() => mismatchedAvatar.fetchImageDataUrl('https://i0.hdslb.com/not-a-jpeg.jpg'), /do not match image\/jpeg/);

  let authenticatedRequestCookie = '';
  global.fetch = async (_url, options = {}) => {
    authenticatedRequestCookie = options.headers?.cookie || '';
    return new Response(JSON.stringify({
      code: 0,
      data: {
        info: { media_count: 3 },
        has_more: false,
        medias: [
          { bvid: 'BVCLIENT0001', title: 'Visible A', upper: { name: 'UP A' } },
          { bvid: 'BVCLIENT0002', title: 'Visible B', upper: { name: 'UP B' } }
        ]
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const partialClient = new BiliClient(() => ({ cookies: { get: async () => [{ name: 'SESSDATA', value: 'client-session' }] } }));
    const snapshot = await partialClient.listVideos('123');
    assert.strictEqual(snapshot.videos.length, 2);
    assert.strictEqual(snapshot.reportedTotal, 3);
    assert.strictEqual(snapshot.visibilityGap, 1);
    assert.strictEqual(snapshot.completedPages, true);
    assert.strictEqual(authenticatedRequestCookie, 'SESSDATA=client-session', 'authenticated Bilibili API request omitted the application Cookie');
    const anonymousClient = new BiliClient(() => ({ cookies: { get: async () => [] } }));
    await assert.rejects(() => anonymousClient.listVideos('123'), (error) => error.code === 'BILIBILI_COOKIE_REQUIRED');
  } finally {
    global.fetch = originalFetch;
  }
  fs.rmSync(authRoot, { recursive: true, force: true });
  console.log('Bilibili client normalization test passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
