const fs = require('fs');
const path = require('path');
const { ApiServer, MAX_JSON_BODY_BYTES } = require('../src/core/api-server');
const { isAllowedBilibiliNavigation } = require('../src/core/desktop-security');
const { assertHiddenBrowserUrl } = require('../src/core/hidden-browser-policy');
const { assertBilibiliUrl, isAllowedApiOrigin, isPrivateNetworkHost } = require('../src/core/network-policy');
const { MAX_MARKDOWN_BYTES, validateSubmission } = require('../src/core/validation');
const { normalizeVideoUrl } = require('../tools/video-tool');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  assert(isAllowedBilibiliNavigation('https://passport.bilibili.com/login'), 'Bilibili login navigation was rejected');
  assert(isAllowedBilibiliNavigation('https://b23.tv/abc'), 'Bilibili short link was rejected');
  assert(!isAllowedBilibiliNavigation('https://example.com/?bilibili=1'), 'non-Bilibili navigation was accepted');
  assert(assertBilibiliUrl('https://www.bilibili.com/video/BV1234567890').hostname === 'www.bilibili.com', 'official Bilibili URL was not parsed');
  let embeddedBiliCredentialRejected = false;
  try { assertBilibiliUrl('https://user:password@www.bilibili.com/video/BV1234567890'); } catch { embeddedBiliCredentialRejected = true; }
  assert(embeddedBiliCredentialRejected, 'Bilibili URL with embedded credentials was accepted');
  assert(normalizeVideoUrl('https://example.com/watch/BV1234567890?redirect=1') === 'https://www.bilibili.com/video/BV1234567890', 'video CLI retained an untrusted external origin instead of canonicalizing the BV id');
  assert(isPrivateNetworkHost('127.0.0.1') && isPrivateNetworkHost('192.168.1.2') && isPrivateNetworkHost('::1'), 'private network detection missed a local address');
  assert(isPrivateNetworkHost('::ffff:7f00:1'), 'IPv4-mapped private IPv6 address was not blocked');
  assert(isPrivateNetworkHost('ff02::1') && isPrivateNetworkHost('2001:db8::1'), 'reserved non-public IPv6 ranges were not blocked');
  assert(!isPrivateNetworkHost('8.8.8.8'), 'public IPv4 address was classified as private');
  assert(isPrivateNetworkHost('198.18.0.1') && isPrivateNetworkHost('203.0.113.9'), 'reserved non-public IPv4 ranges were not blocked');
  let hiddenPrivateRejected = false;
  try { await assertHiddenBrowserUrl('https://public.example/page', { resolve: async () => ['127.0.0.1'] }); }
  catch (error) { hiddenPrivateRejected = /private-network/.test(error.message); }
  assert(hiddenPrivateRejected, 'DNS-to-private hidden-browser request was accepted');
  const publicHiddenUrl = await assertHiddenBrowserUrl('https://public.example/page', { resolve: async () => ['8.8.8.8'] });
  assert(publicHiddenUrl.hostname === 'public.example', 'public hidden-browser URL was rejected');
  const approvedPrivate = await assertHiddenBrowserUrl('http://approved.internal/page', { allowPrivate: true, allowedPrivateHosts: ['approved.internal'], resolve: async () => ['192.168.1.5'] });
  assert(approvedPrivate.hostname === 'approved.internal', 'explicitly approved private host was rejected');
  let unrelatedPrivateRejected = false;
  try { await assertHiddenBrowserUrl('http://other.internal/page', { allowPrivate: true, allowedPrivateHosts: ['approved.internal'], resolve: async () => ['192.168.1.6'] }); } catch { unrelatedPrivateRejected = true; }
  assert(unrelatedPrivateRejected, 'approval for one private host opened unrelated private hosts');
  assert(isAllowedApiOrigin('', 'http://127.0.0.1:17391'), 'origin-less Agent request was rejected');
  assert(!isAllowedApiOrigin('https://example.com', 'http://127.0.0.1:17391'), 'cross-origin browser request was accepted');

  const api = new ApiServer({ store: {}, toolRunner: {}, getToolHealth: () => [] });
  await api.start(0);
  try {
    const health = await fetch(`${api.url()}/api/health`);
    assert(health.ok, 'origin-less API health request failed');
    assert(health.headers.get('access-control-allow-origin') === null, 'wildcard CORS header is still present');
    const crossOrigin = await fetch(`${api.url()}/api/health`, { headers: { origin: 'https://example.com' } });
    assert(crossOrigin.status === 403, `cross-origin request returned ${crossOrigin.status}`);
    const oversized = await fetch(`${api.url()}/api/workers/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'test', model: 'test', metadata: { payload: 'x'.repeat(MAX_JSON_BODY_BYTES) } })
    });
    assert(oversized.status === 413, `oversized JSON request returned ${oversized.status}`);
  } finally {
    api.stop();
  }

  const validationRoot = path.join(__dirname, '..', '.cache', 'security-validation-test');
  fs.rmSync(validationRoot, { recursive: true, force: true });
  fs.mkdirSync(validationRoot, { recursive: true });
  const largeMarkdown = path.join(validationRoot, 'large.md');
  const metadata = path.join(validationRoot, 'info.json');
  fs.writeFileSync(largeMarkdown, 'x');
  fs.truncateSync(largeMarkdown, MAX_MARKDOWN_BYTES + 1);
  fs.writeFileSync(metadata, '{}');
  const validation = validateSubmission({ allowedRoot: validationRoot, artifactDir: validationRoot }, { artifactDir: validationRoot, markdownFile: largeMarkdown, metadataFile: metadata });
  assert(validation.errors.some((error) => error.includes('Markdown file exceeds')), 'oversized Markdown artifact was accepted');
  const outsideRoot = path.join(__dirname, '..', '.cache', 'security-validation-outside');
  const linkedArtifact = path.join(validationRoot, 'linked-artifact');
  fs.mkdirSync(outsideRoot, { recursive: true });
  fs.writeFileSync(path.join(outsideRoot, 'summary.md'), '# linked');
  fs.writeFileSync(path.join(outsideRoot, 'info.json'), '{}');
  try {
    fs.symlinkSync(outsideRoot, linkedArtifact, process.platform === 'win32' ? 'junction' : 'dir');
    const linked = validateSubmission({ allowedRoot: validationRoot, artifactDir: linkedArtifact }, { artifactDir: linkedArtifact, markdownFile: path.join(linkedArtifact, 'summary.md'), metadataFile: path.join(linkedArtifact, 'info.json') });
    assert(linked.errors.some((error) => /boundary|symbolic link/i.test(error)), 'linked artifact directory escaped the assigned workspace boundary');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error;
  }
  fs.rmSync(validationRoot, { recursive: true, force: true });
  fs.rmSync(outsideRoot, { recursive: true, force: true });
  console.log('security policy integration test passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
