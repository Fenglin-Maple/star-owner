const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const vm = require('vm');
const { ApiServer } = require('../src/core/api-server');
const { isAllowedBilibiliNavigation, isBilibiliVideoNavigation } = require('../src/core/desktop-security');
const { assertHiddenBrowserUrl } = require('../src/core/hidden-browser-policy');
const { buildHiddenPageExtractionScript } = require('../src/core/hidden-page-extractor');
const { assertBilibiliUrl, isAllowedApiOrigin, isPrivateNetworkHost } = require('../src/core/network-policy');
const { startPinnedDnsProxy } = require('../src/core/pinned-dns-proxy');
const { resolveReadmeImage } = require('../src/core/readme-assets');
const { MAX_MARKDOWN_BYTES, validateSubmission } = require('../src/core/validation');
const { normalizeVideoUrl } = require('../tools/video-tool');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function requestThroughProxy(proxy, target) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: proxy.host, port: proxy.port, path: target, method: 'GET', agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.once('error', reject);
    request.end();
  });
}

function abortRequestThroughProxy(proxy, target) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Timed out waiting for the aborted proxy request to close.')), 5000);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const request = http.request({ host: proxy.host, port: proxy.port, path: target, method: 'GET', agent: false }, (response) => {
      response.once('data', () => request.destroy());
      response.once('close', () => finish());
      response.once('error', (error) => {
        if (!['ECONNRESET', 'ECONNABORTED', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code)) finish(error);
        else finish();
      });
    });
    request.once('error', (error) => {
      if (!['ECONNRESET', 'ECONNABORTED'].includes(error.code)) finish(error);
      else finish();
    });
    request.end();
  });
}

function openAndAbortTunnel(proxy, target) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let established = false;
    const timer = setTimeout(() => finish(new Error('Timed out waiting for the aborted HTTPS tunnel to close.')), 5000);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const socket = net.connect(proxy.port, proxy.host);
    socket.on('error', (error) => {
      if (!['ECONNRESET', 'ECONNABORTED', 'EPIPE'].includes(error.code)) finish(error);
      else finish();
    });
    socket.on('close', () => finish());
    socket.on('data', (chunk) => {
      const text = chunk.toString('latin1');
      if (!established && text.includes('200 Connection Established')) {
        established = true;
        socket.write('abort-test');
        setTimeout(() => socket.destroy(), 20);
      }
    });
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nConnection: keep-alive\r\n\r\n`);
  });
}

(async () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const rendererIndex = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const readmeAllowedAttributes = /const README_ALLOWED_ATTRIBUTES = \[([^\]]*)\]/.exec(rendererSource)?.[1] || '';
  assert(mainSource.includes("readmeMarkdownRenderer = new MarkdownIt({ html: true") && (mainSource.match(/new MarkdownIt\(\{ html: false/g) || []).length >= 2, 'README HTML support weakened document or RAG raw-HTML isolation');
  assert(mainSource.includes('buildHiddenPageExtractionScript') && mainSource.includes('executeJavaScript(buildHiddenPageExtractionScript'), 'hidden browser stopped using the bounded dynamic-page extraction path');
  assert(rendererSource.includes('window.DOMPurify.sanitize') && rendererSource.includes('FORBID_TAGS') && rendererSource.includes('ALLOW_DATA_ATTR: false') && !readmeAllowedAttributes.includes("'class'") && rendererIndex.indexOf('dompurify/dist/purify.min.js') < rendererIndex.indexOf('src="./app.js"'), 'README HTML is inserted without a strict tag and attribute sanitizer');
  assert(mainSource.includes("ipcMain.handle('docs:resolve-readme-image'") && preloadSource.includes("ipcRenderer.invoke('docs:resolve-readme-image', source)") && rendererSource.includes('window.orchestrator.resolveReadmeImage(source)'), 'README local images bypass the main-process resolver');
  const readmeAssetRoot = path.join(__dirname, '..', '.cache', 'security-readme-assets');
  const readmeAssetOutside = path.join(__dirname, '..', '.cache', 'security-readme-outside');
  fs.rmSync(readmeAssetRoot, { recursive: true, force: true });
  fs.rmSync(readmeAssetOutside, { recursive: true, force: true });
  fs.mkdirSync(path.join(readmeAssetRoot, 'assets'), { recursive: true });
  fs.mkdirSync(readmeAssetOutside, { recursive: true });
  fs.writeFileSync(path.join(readmeAssetRoot, 'assets', 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  fs.writeFileSync(path.join(readmeAssetRoot, 'assets', 'unsafe.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  fs.writeFileSync(path.join(readmeAssetOutside, 'outside.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  try {
    assert(resolveReadmeImage(readmeAssetRoot, 'assets/icon.png').startsWith('file:'), 'project-contained README raster image was rejected');
    assert(!resolveReadmeImage(readmeAssetRoot, '../security-readme-outside/outside.png'), 'README image traversal escaped the project root');
    assert(!resolveReadmeImage(readmeAssetRoot, 'assets/unsafe.svg'), 'unvalidated README image content was accepted');
    assert(!resolveReadmeImage(readmeAssetRoot, 'https://example.com/image.png'), 'remote README image was accepted by the local-file resolver');
    const linkedOutside = path.join(readmeAssetRoot, 'linked-outside');
    try {
      fs.symlinkSync(readmeAssetOutside, linkedOutside, process.platform === 'win32' ? 'junction' : 'dir');
      assert(!resolveReadmeImage(readmeAssetRoot, 'linked-outside/outside.png'), 'README image directory link escaped the project root');
    } catch (error) {
      if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error;
    }
  } finally {
    fs.rmSync(readmeAssetRoot, { recursive: true, force: true });
    fs.rmSync(readmeAssetOutside, { recursive: true, force: true });
  }
  assert(isAllowedBilibiliNavigation('https://passport.bilibili.com/login'), 'Bilibili login navigation was rejected');
  assert(isAllowedBilibiliNavigation('https://b23.tv/abc'), 'Bilibili short link was rejected');
  assert(!isAllowedBilibiliNavigation('https://example.com/?bilibili=1'), 'non-Bilibili navigation was accepted');
  assert(isBilibiliVideoNavigation('https://www.bilibili.com/video/BV1234567890'), 'ordinary Bilibili video navigation was not recognized');
  assert(isBilibiliVideoNavigation('https://www.bilibili.com/bangumi/play/ep123456'), 'Bilibili episode navigation was not recognized');
  assert(isBilibiliVideoNavigation('https://b23.tv/abc'), 'Bilibili short video navigation was not recognized');
  assert(!isBilibiliVideoNavigation('https://www.bilibili.com/v/popular/all'), 'non-video Bilibili page was classified as a video navigation');
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
  let originHits = 0;
  const origin = http.createServer((_request, response) => { originHits += 1; response.end('pinned proxy ok'); });
  const originAddress = await listen(origin);
  const approvedProxy = await startPinnedDnsProxy({ allowPrivate: true, allowedPrivateHosts: ['approved.internal'], resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
  try {
    const approvedResponse = await requestThroughProxy(approvedProxy, `http://approved.internal:${originAddress.port}/page`);
    assert(approvedResponse.status === 200 && approvedResponse.body === 'pinned proxy ok', 'approved pinned proxy request did not reach its exact resolved endpoint');
  } finally {
    await approvedProxy.close();
  }
  const blockedProxy = await startPinnedDnsProxy({ resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
  try {
    const blockedResponse = await requestThroughProxy(blockedProxy, `http://rebinding.example:${originAddress.port}/private`);
    assert(blockedResponse.status === 502, 'DNS rebinding to a private address was not blocked by the connection proxy');
    assert(originHits === 1, 'blocked DNS rebinding request reached the private origin');
  } finally {
    await blockedProxy.close();
    await new Promise((resolve) => origin.close(resolve));
  }

  let uncaughtProxyError = null;
  const onUncaughtProxyError = (error) => { uncaughtProxyError = error; };
  process.on('uncaughtException', onUncaughtProxyError);
  const slowOrigin = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('first chunk');
    const interval = setInterval(() => response.write('next chunk'), 10);
    response.once('close', () => clearInterval(interval));
  });
  const slowOriginAddress = await listen(slowOrigin);
  const tunnelOrigin = net.createServer((socket) => socket.on('data', (chunk) => socket.write(chunk)));
  const tunnelOriginAddress = await listen(tunnelOrigin);
  const abortProxy = await startPinnedDnsProxy({ allowPrivate: true, allowedPrivateHosts: ['slow.internal', 'tunnel.internal'], resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
  try {
    await abortRequestThroughProxy(abortProxy, `http://slow.internal:${slowOriginAddress.port}/slow`);
    await openAndAbortTunnel(abortProxy, `tunnel.internal:${tunnelOriginAddress.port}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert(!uncaughtProxyError, `proxy client disconnect raised an uncaught exception: ${uncaughtProxyError?.message || uncaughtProxyError}`);
  } finally {
    process.off('uncaughtException', onUncaughtProxyError);
    await abortProxy.close();
    await new Promise((resolve) => slowOrigin.close(resolve));
    await new Promise((resolve) => tunnelOrigin.close(resolve));
  }

  let dynamicText = 'shell content';
  const dynamicDocument = {
    title: 'Delayed page',
    body: { get innerText() { return dynamicText; }, childElementCount: 1 },
    querySelectorAll: () => []
  };
  setTimeout(() => { dynamicText = 'shell content\nloaded async content'; }, 1500);
  const dynamicResult = await vm.runInNewContext(buildHiddenPageExtractionScript(), {
    document: dynamicDocument,
    location: { href: 'https://dynamic.example/page' },
    performance: { getEntriesByType: () => [] },
    Promise,
    Date,
    setTimeout
  });
  assert(dynamicResult.text.includes('loaded async content'), 'hidden-page extraction returned the shell before delayed DOM content stabilized');

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
    const retiredWorkflow = await fetch(`${api.url()}/api/workers/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'test', model: 'test' })
    });
    const retiredPayload = await retiredWorkflow.json();
    assert(retiredWorkflow.status === 410 && retiredPayload.code === 'EXTERNAL_VIDEO_WORKFLOW_DISABLED', `retired video workflow returned ${retiredWorkflow.status}`);
    const knowledgeWrite = await fetch(`${api.url()}/api/knowledge/catalog`, { method: 'POST' });
    const knowledgeWritePayload = await knowledgeWrite.json();
    assert(knowledgeWrite.status === 405 && knowledgeWritePayload.code === 'METHOD_NOT_ALLOWED', 'read-only knowledge API accepted a write method');
    assert(knowledgeWrite.headers.get('x-content-type-options') === 'nosniff', 'knowledge API response omitted MIME sniffing protection');
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
