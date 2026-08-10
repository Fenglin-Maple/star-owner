const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Store } = require('../src/core/store');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CACHE_ROOT = path.join(PROJECT_ROOT, '.cache');
const APP_ROOT = path.join(CACHE_ROOT, `library-auth-ui-flow-app-${process.pid}-${Date.now().toString(36)}`);

(async () => {
  prepareFixtureApp();
  const fixture = await seedFixtureStore();
  const port = await freePort();
  const electron = require('electron');
  const output = [];
  const child = spawn(electron, [
    `--remote-debugging-port=${port}`,
    '--disable-gpu',
    '--headless',
    `--user-data-dir=${path.join(APP_ROOT, 'user-data')}`,
    APP_ROOT
  ], {
    cwd: APP_ROOT,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.stdout.on('data', (chunk) => rememberOutput(output, chunk));
  child.stderr.on('data', (chunk) => rememberOutput(output, chunk));

  let cdp;
  try {
    const target = await waitForTarget(port, child, output);
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await waitFor(async () => (await cdp.evaluate('window.orchestrator?.getRuntime().then((state) => Boolean(state.backendReady))')) === true, 45000, 'application backend');

    await cdp.evaluate(`document.querySelector('[data-page="cache-download"]').click()`);
    await waitFor(async () => (await cdp.evaluate('document.querySelectorAll("#cacheDownloadCollection option").length')) > 0, 10000, 'download collection options');
    const downloadPage = await cdp.evaluate(`(() => ({
      text: document.querySelector('#page-cache-download .page-head p')?.textContent || '',
      targets: [...document.querySelectorAll('#cacheDownloadCollection option')].map((item) => item.value)
    }))()`);
    assert(downloadPage.text.includes('B站登录 Cookie') && !downloadPage.text.includes('公开访问优先'), 'download page retained stale anonymous-access wording');
    assert(downloadPage.targets.includes(fixture.downloadCollectionId), 'ordinary cache collection disappeared from download targets');
    assert(!downloadPage.targets.includes(fixture.localCollectionId), 'local media import collection remained selectable as a B站 download target');

    await cdp.evaluate(`document.querySelector('[data-page="video-library"]').click()`);
    await waitFor(async () => (await cdp.evaluate(`document.querySelectorAll('[data-cache-video]').length`)) > 0, 10000, 'video library records');
    const videoLibrary = await cdp.evaluate(`(() => ({
      records: [...document.querySelectorAll('[data-cache-video]')].map((item) => item.dataset.cacheVideo),
      collections: [...document.querySelectorAll('#videoLibraryCollection option')].map((item) => item.value)
    }))()`);
    assert(videoLibrary.records.includes(fixture.videoId), 'video library hid an existing file whose task was disabled');
    assert(videoLibrary.collections.includes(fixture.localCollectionId), 'local media collection was removed from the video-library selector');

    await cdp.evaluate(`document.querySelector('[data-page="documents"]').click()`);
    await waitFor(async () => (await cdp.evaluate(`document.querySelectorAll('#documentList [data-document-id]').length`)) > 0, 10000, 'document library records');
    const documents = await cdp.evaluate(`[...document.querySelectorAll('#documentList [data-document-id]')].map((item) => item.dataset.documentId)`);
    assert(documents.includes(fixture.documentTaskId), 'document library hid a completed Markdown whose task was disabled');

    await cdp.evaluate(`document.querySelector('[data-page="cache-download"]').click()`);
    await cdp.evaluate(`(() => {
      document.querySelector('#cacheDownloadInputs').value = 'BV1234567890';
      document.querySelector('#cacheDownloadCollection').value = ${JSON.stringify(fixture.downloadCollectionId)};
      document.querySelector('#cacheSubmitDownloads').click();
    })()`);
    await waitFor(async () => String(await cdp.evaluate(`[...document.querySelectorAll('#toastViewport .toast')].map((item) => item.textContent).join(' | ')`)).includes('B站登录'), 10000, 'Bilibili login toast');
    const toast = await cdp.evaluate(`[...document.querySelectorAll('#toastViewport .toast')].map((item) => item.textContent).join(' | ')`);
    assert(toast.includes('应用内部') && toast.includes('完成登录后重试'), 'missing-Cookie flow did not direct the user to the internal B站 login');

    console.log('library and Bilibili auth Electron UI flow test passed');
  } catch (error) {
    if (output.length) error.message += `\nElectron output:\n${output.join('')}`;
    throw error;
  } finally {
    cdp?.close();
    await stopChild(child);
    await removeFixtureRoot({ strict: false });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function prepareFixtureApp() {
  fs.mkdirSync(APP_ROOT, { recursive: true });
  for (const directory of ['assets', 'src', 'templates', 'tools']) {
    fs.cpSync(path.join(PROJECT_ROOT, directory), path.join(APP_ROOT, directory), { recursive: true });
  }
  for (const file of ['package.json', 'README.md']) fs.copyFileSync(path.join(PROJECT_ROOT, file), path.join(APP_ROOT, file));
  fs.symlinkSync(path.join(PROJECT_ROOT, 'node_modules'), path.join(APP_ROOT, 'node_modules'), 'junction');
}

async function seedFixtureStore() {
  const workspaceRoot = path.join(APP_ROOT, 'workspace');
  const libraryRoot = path.join(APP_ROOT, 'library');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(libraryRoot, { recursive: true });
  const store = await Store.open(path.join(workspaceRoot, 'orchestrator.sqlite'));
  const workspace = store.addWorkspace({ name: 'UI flow fixture', root: libraryRoot });
  store.setDefaultWorkspace(workspace.id);
  store.upsertUser({ id: 'builtin-agent-user', mid: 'builtin-agent-user', name: '内置用户', internal: true });

  const downloadCollectionId = 'fixture:download-cache';
  const localCollectionId = 'fixture:local-media';
  const documentCollectionId = 'fixture:documents';
  const downloadRoot = path.join(libraryRoot, '内置用户', '普通下载缓存');
  const localRoot = path.join(libraryRoot, '内置用户', '本地媒体');
  const documentRoot = path.join(libraryRoot, '内置用户', '完成文档');
  for (const root of [downloadRoot, localRoot, documentRoot]) fs.mkdirSync(root, { recursive: true });

  store.upsertCollection({ id: downloadCollectionId, userId: 'builtin-agent-user', userName: '内置用户', name: '普通下载缓存', collectionKind: 'video-cache', internal: true, workspaceId: workspace.id, workspaceRoot: libraryRoot, collectionRoot: downloadRoot, cacheRoot: downloadRoot, videoCount: 0 });
  store.upsertCollection({ id: localCollectionId, userId: 'builtin-agent-user', userName: '内置用户', name: '本地视频导入', collectionKind: 'video-cache', videoCacheSource: 'local-media', internal: true, workspaceId: workspace.id, workspaceRoot: libraryRoot, collectionRoot: localRoot, cacheRoot: localRoot, videoCount: 1 });
  store.upsertCollection({ id: documentCollectionId, userId: 'builtin-agent-user', userName: '内置用户', name: '完成文档', collectionKind: 'multimodal-document', internal: true, workspaceId: workspace.id, workspaceRoot: libraryRoot, collectionRoot: documentRoot, videoCount: 1, documentCount: 1 });

  const videoId = 'fixture:disabled-video';
  const videoTaskId = 'fixture:disabled-video-task';
  const videoFile = path.join(localRoot, 'merged.mp4');
  fs.writeFileSync(videoFile, 'fixture video');
  store.upsertVideoCache({ id: videoId, collectionId: localCollectionId, taskId: videoTaskId, bvid: 'LOCALFIXTURE01', title: '关闭任务仍显示的视频', owner: '本地视频', duration: 12, sourceType: 'local-video', localImported: true, videoFile, artifactDir: localRoot, downloadedAt: new Date().toISOString() });
  store.upsertTask({ id: videoTaskId, collectionId: localCollectionId, bvid: 'LOCALFIXTURE01', title: '关闭任务仍显示的视频', status: 'pending', enabled: false, sourceType: 'local-video', localImported: true, cachedVideoId: videoId, cachedVideoFile: videoFile, artifactDir: localRoot, allowedRoot: localRoot });

  const documentTaskId = 'fixture:disabled-document-task';
  const documentArtifact = path.join(documentRoot, 'document');
  const outputMarkdown = path.join(documentArtifact, 'summary.md');
  fs.mkdirSync(documentArtifact, { recursive: true });
  fs.writeFileSync(outputMarkdown, '# 关闭任务仍显示的文档\n', 'utf8');
  store.upsertTask({ id: documentTaskId, collectionId: documentCollectionId, bvid: 'BVDOCUMENT01', title: '关闭任务仍显示的文档', owner: '测试作者', duration: 30, status: 'done', enabled: false, knowledgeActive: true, outputMarkdown, artifactDir: documentArtifact, allowedRoot: documentRoot, completedAt: new Date().toISOString() });
  store.commit();
  return { documentTaskId, downloadCollectionId, localCollectionId, videoId };
}

class Cdp {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => resolve(new Cdp(socket)), { once: true });
      socket.addEventListener('error', () => reject(new Error('Could not connect to Electron DevTools.')), { once: true });
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed.');
    return result.result?.value;
  }

  close() {
    try { this.socket.close(); } catch {}
  }
}

async function waitForTarget(port, child, output) {
  let lastError;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Electron exited before its renderer was ready (${child.exitCode}).\n${output.join('')}`);
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
      const target = targets.find((item) => item.type === 'page' && String(item.url || '').includes('/src/renderer/index.html'));
      if (target?.webSocketDebuggerUrl) return target;
    } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`Timed out waiting for Electron renderer: ${lastError?.message || 'no DevTools target'}`);
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { if (await predicate()) return; } catch {}
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    const result = spawnSync(taskkill, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    if (result.error) child.kill();
  } else {
    child.kill();
  }
  await Promise.race([exited, delay(5000)]);
}

async function removeFixtureRoot({ strict = true } = {}) {
  const resolved = path.resolve(APP_ROOT);
  if (path.dirname(resolved) !== path.resolve(CACHE_ROOT) || !/^library-auth-ui-flow-app-\d+-[a-z0-9]+$/i.test(path.basename(resolved))) {
    throw new Error('Refusing to remove an unexpected UI fixture path.');
  }
  let lastError = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const nodeModules = path.join(resolved, 'node_modules');
    try { if (fs.lstatSync(nodeModules).isSymbolicLink()) fs.unlinkSync(nodeModules); } catch {}
    try {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return true;
    } catch (error) {
      lastError = error;
      if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
      await delay(250);
    }
  }
  if (strict) throw lastError;
  console.warn(`UI fixture cleanup will be retried on a later maintenance pass: ${lastError?.message || 'unknown error'}`);
  return false;
}

function rememberOutput(output, chunk) {
  output.push(String(chunk));
  while (output.join('').length > 16000) output.shift();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
