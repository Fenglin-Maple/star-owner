const assert = require('assert');
const { BiliClient, isBilibiliCookieDomain, normalizeBilibiliAssetUrl } = require('../src/core/bili');

(async () => {
  assert.strictEqual(normalizeBilibiliAssetUrl('http://i0.hdslb.com/avatar.jpg'), 'https://i0.hdslb.com/avatar.jpg');
  assert.strictEqual(normalizeBilibiliAssetUrl('//i1.hdslb.com/avatar.jpg'), 'https://i1.hdslb.com/avatar.jpg');
  assert.strictEqual(normalizeBilibiliAssetUrl('https://i2.hdslb.com/avatar.jpg'), 'https://i2.hdslb.com/avatar.jpg');
  assert(isBilibiliCookieDomain('.bilibili.com') && isBilibiliCookieDomain('passport.bilibili.com'));
  assert(!isBilibiliCookieDomain('notbilibili.com') && !isBilibiliCookieDomain('bilibili.com.example.org'));

  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({
    code: 0,
    data: { isLogin: true, mid: 123, uname: 'Avatar test', face: 'http://i0.hdslb.com/avatar.jpg' }
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const client = new BiliClient(() => ({ cookies: { get: async () => [] } }));
    const profile = await client.nav();
    assert.strictEqual(profile.face, 'https://i0.hdslb.com/avatar.jpg');
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
  console.log('Bilibili client normalization test passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
