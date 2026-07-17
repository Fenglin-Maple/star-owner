const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, safeStorage, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const MarkdownIt = require('markdown-it');
const { buildAnalytics } = require('./core/analytics');
const { ApiServer } = require('./core/api-server');
const { BiliClient, assertBilibiliImageUrl, isBilibiliCookieDomain, normalizeBilibiliAssetUrl } = require('./core/bili');
const { CollectionSyncService } = require('./core/collection-sync-service');
const { DependencyManager } = require('./core/dependency-manager');
const { secureMainWindow } = require('./core/desktop-security');
const { deleteCompletedDocument } = require('./core/document-lifecycle');
const { ensurePortableDesktopShortcut } = require('./core/desktop-shortcut');
const { assertHiddenBrowserUrl, installHiddenBrowserRequestGuard } = require('./core/hidden-browser-policy');
const { InternalAgentManager } = require('./core/internal-agent-manager');
const { loadClipboardImage } = require('./core/image-clipboard');
const { promoteMindMap, wrapMarkdownTables } = require('./core/markdown');
const { isPrivateNetworkHost } = require('./core/network-policy');
const { repairPortablePythonHome } = require('./core/portable-runtime');
const { RagAssistant } = require('./core/rag-assistant');
const { Store } = require('./core/store');
const { recoverPendingSubmissionFinalizations } = require('./core/submission-artifacts');
const { ToolRunner } = require('./core/tool-runner');
const { VideoCacheManager } = require('./core/video-cache-manager');
const { initWorkspace, timestampForFile, videoArtifactName, WORKSPACE_ROOT } = require('./core/workspace');

const BILI_SESSION = 'persist:bili-orchestrator';
const PRODUCT_NAME = '星藏家';
const PACKAGE_VERSION = require('../package.json').version;
const DEFAULT_WINDOW = { width: 1350, height: 836 };
const README_FILE = path.join(__dirname, '..', 'README.md');
const RENDERER_FILE = path.join(__dirname, 'renderer', 'index.html');
const markdownRenderer = new MarkdownIt({ html: false, linkify: true, typographer: false });

try {
  repairPortablePythonHome(path.join(__dirname, '..'));
} catch (error) {
  console.warn(`[portable-runtime] ${error.message || String(error)}`);
}

app.setName(PRODUCT_NAME);
app.setAppUserModelId('com.fenglin-maple.star-owner');

let mainWindow = null;
let apiServer = null;
let store = null;
let bili = null;
let toolRunner = null;
let ragAssistant = null;
let internalAgentManager = null;
let dependencyManager = null;
let videoCacheManager = null;
let collectionSyncService = null;
let currentUser = null;
let biliAccountGeneration = 0;
let biliRefreshGeneration = -1;
let biliRefreshPromise = null;
let backendReady = false;
let toolHealth = [];
let bootstrapStarted = false;
const VOLATILE_ACTIVITY_TYPES = new Set(['collection-sync-progress', 'asr-progress', 'asr-service-log', 'video-cache-job-updated', 'video-cache-queue-updated']);
const pendingRagApprovals = new Map();
const taskDisplayCoverCache = new Map();
let bootstrapState = {
  phase: 'starting',
  progress: 0.04,
  message: 'Starting desktop shell...'
};

function createWindow() {
  mainWindow = new BrowserWindow({
    ...DEFAULT_WINDOW,
    minWidth: 980,
    minHeight: 680,
    show: false,
    title: PRODUCT_NAME,
    icon: path.join(__dirname, '..', 'assets', 'star-note.ico'),
    frame: false,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true
    }
  });
  secureMainWindow(mainWindow, RENDERER_FILE);
  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    mainWindow.setSize(DEFAULT_WINDOW.width, DEFAULT_WINDOW.height, false);
    mainWindow.center();
    mainWindow.show();
  });
  mainWindow.loadFile(RENDERER_FILE).catch((error) => console.error(`[renderer-load] ${error.message || String(error)}`));
  mainWindow.webContents.once('did-finish-load', () => {
    sendBootstrap();
    sendRuntime();
    if (!bootstrapStarted) {
      bootstrapStarted = true;
      bootstrap().catch((error) => {
        backendReady = false;
        emitBootstrap(error.message || String(error), 1, 'error');
      });
    }
  });
  mainWindow.webContents.on('console-message', (details) => {
    if (details.level === 'error') console.error(`[renderer] ${details.message} (${details.sourceId}:${details.lineNumber})`);
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[renderer-load] ${code} ${description} ${url}`);
  });
}

function biliSession() {
  return session.fromPartition(BILI_SESSION);
}

async function bootstrap() {
  emitBootstrap('Preparing workspace...', 0.14);
  initWorkspace();
  emitBootstrap('Opening SQLite database...', 0.32);
  store = await Store.open();
  const recoveredSubmissions = recoverPendingSubmissionFinalizations(store);
  for (const result of recoveredSubmissions) {
    if (!result.ok) console.warn(`[submission-recovery] ${result.taskId}: ${result.error}`);
  }
  ragAssistant = new RagAssistant({
    store,
    workspaceRoot: store.getDefaultWorkspace()?.root || WORKSPACE_ROOT,
    encryptSecret,
    decryptSecret,
    emit: (event) => mainWindow?.webContents.send('rag:event', event),
    requestApproval: requestRagApproval,
    browseHidden,
    openExternal: (url) => openExternalUrl(url)
  });
  emitBootstrap('Preparing Bilibili session...', 0.52);
  bili = new BiliClient(biliSession);
  emitBootstrap('Registering tool runner...', 0.66);
  toolRunner = new ToolRunner({
    store,
    onEvent: publishEvent,
    onState: () => sendRuntime()
  });
  internalAgentManager = new InternalAgentManager({
    store,
    toolRunner,
    ragAssistant,
    bili,
    getCurrentUser: () => currentUser,
    emit: publishInternalAgentEvent
  });
  collectionSyncService = new CollectionSyncService({
    store,
    bili,
    toolRunner,
    internalAgentManager,
    getCurrentUser: () => currentUser,
    onEvent: publishEvent
  });
  videoCacheManager = new VideoCacheManager({
    store,
    toolRunner,
    bili,
    getCurrentUser: () => currentUser,
    emit: publishEvent
  });
  dependencyManager = new DependencyManager({
    store,
    projectRoot: path.resolve(__dirname, '..'),
    version: PACKAGE_VERSION,
    emit: publishDependencyEvent,
    acquireInstall: (packageId, onWait) => toolRunner.acquireMaintenance(`dependency package ${packageId}`, onWait),
    onInstalled: async (packageId) => {
      if (packageId === 'model-small' || packageId === 'model-medium' || packageId === 'runtime-base') {
        try { await toolRunner.ensureGpuAsr(); } catch (error) { publishEvent({ type: 'asr-reload-required', error: error.message }); }
      }
      sendRuntime();
    }
  });
  const registeredTools = store.listTools();
  toolHealth = registeredTools.map((tool) => ({
    toolId: tool.id,
    toolName: tool.name,
    action: tool.action,
    order: tool.order,
    enabled: tool.enabled !== false,
    apiUsage: tool.apiUsage,
    status: 'checking',
    responded: false,
    message: '等待健康检查',
    dependencies: []
  }));
  emitBootstrap('Checking tool interfaces...', 0.7);
  sendRuntime();
  let checkedTools = 0;
  await toolRunner.probeTools(registeredTools, (result) => {
    toolHealth = toolHealth.map((item) => item.toolId === result.toolId ? result : item);
    checkedTools += 1;
    emitBootstrap(`Checking tools ${checkedTools}/${registeredTools.length}: ${result.toolName}`, 0.7 + (0.11 * checkedTools / Math.max(1, registeredTools.length)));
    sendRuntime();
  });
  emitBootstrap('Loading persistent GPU ASR service...', 0.84);
  await toolRunner.initialize();
  videoCacheManager.initialize();
  emitBootstrap('Starting resource pools and read-only knowledge API...', 0.92);
  apiServer = new ApiServer({
    store,
    toolRunner,
    getToolHealth: () => toolHealth,
    onEvent: publishEvent
  });
  const apiUrl = await apiServer.start();
  backendReady = true;
  emitBootstrap('Ready.', 1, 'ready');
  try {
    const shortcut = ensurePortableDesktopShortcut({
      projectRoot: path.resolve(__dirname, '..'),
      desktopPath: app.getPath('desktop'),
      executablePath: process.execPath,
      version: PACKAGE_VERSION,
      store,
      writeShortcutLink: (shortcutPath, operation, details) => shell.writeShortcutLink(shortcutPath, operation, details)
    });
    if (shortcut.status === 'created') publishEvent({ type: 'desktop-shortcut-created', shortcutPath: shortcut.shortcutPath });
  } catch (error) {
    console.warn(`[desktop-shortcut] ${error.message || String(error)}`);
    publishEvent({ type: 'desktop-shortcut-failed', error: error.message || String(error) });
  }
  sendRuntime();
}

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  apiServer?.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  apiServer?.stop();
  ragAssistant?.shutdown();
  internalAgentManager?.shutdown();
  videoCacheManager?.shutdown();
  toolRunner?.shutdown();
  for (const pending of pendingRagApprovals.values()) {
    clearTimeout(pending.timer);
    pending.resolve({ approved: false });
  }
  pendingRagApprovals.clear();
});

ipcMain.handle('app:get-runtime', async () => ({
  apiUrl: apiServer?.url(),
  workspaceRoot: store?.getDefaultWorkspace()?.root || WORKSPACE_ROOT,
  defaultWorkspace: store?.getDefaultWorkspace() || null,
  currentUser: publicCurrentUser(currentUser),
  toolHealth,
  scheduler: toolRunner?.getState() || null,
  filenameMetadata: store?.getFilenameMetadata() || null,
  dependencies: dependencyManager?.state() || null,
  videoCache: videoCacheManager?.state() || null,
  backendReady,
  bootstrap: bootstrapState
}));

ipcMain.handle('docs:read-readme', async () => {
  const markdown = fs.readFileSync(README_FILE, 'utf8');
  return { path: README_FILE, markdown, html: markdownRenderer.render(markdown) };
});

ipcMain.handle('docs:open-readme', async () => {
  const error = await shell.openPath(README_FILE);
  if (error) throw new Error(error);
  return { path: README_FILE };
});

ipcMain.handle('app:open-external', async (_event, value) => {
  const url = await openExternalUrl(value);
  return { url };
});

ipcMain.handle('docs:open-project-path', async (_event, value) => {
  const projectRoot = path.resolve(__dirname, '..');
  const target = path.resolve(projectRoot, String(value || ''));
  if (target !== projectRoot && !target.startsWith(`${projectRoot}${path.sep}`)) throw new Error('Document path is outside the project.');
  if (!fs.existsSync(target)) throw new Error(`Document does not exist: ${value}`);
  const realProjectRoot = fs.realpathSync(projectRoot);
  const realTarget = fs.realpathSync(target);
  const relative = path.relative(realProjectRoot, realTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Document path resolves outside the project.');
  const error = await shell.openPath(realTarget);
  if (error) throw new Error(error);
  return { path: realTarget };
});

ipcMain.handle('documents:read', async (_event, taskId) => {
  assertBackendReady();
  const task = store.getTask(String(taskId || ''));
  if (!task || task.status !== 'done' || !task.outputMarkdown) throw new Error('Completed Markdown document not found.');
  if (!fs.existsSync(task.outputMarkdown)) throw new Error(`Markdown file does not exist: ${task.outputMarkdown}`);
  const markdown = fs.readFileSync(task.outputMarkdown, 'utf8');
  return {
    task,
    collection: store.getCollectionById(task.collectionId) || null,
    path: task.outputMarkdown,
    markdown,
    html: renderMarkdownPreview(markdown, task.outputMarkdown)
  };
});

ipcMain.handle('documents:open', async (_event, taskId) => {
  assertBackendReady();
  const task = store.getTask(String(taskId || ''));
  if (!task?.outputMarkdown || !fs.existsSync(task.outputMarkdown)) throw new Error('Completed Markdown document not found.');
  const error = await shell.openPath(task.outputMarkdown);
  if (error) throw new Error(error);
  return { path: task.outputMarkdown };
});

ipcMain.handle('documents:delete', async (_event, taskId) => {
  assertBackendReady();
  const result = deleteCompletedDocument({ store, taskId, source: 'document-library' });
  taskDisplayCoverCache.delete(String(taskId || ''));
  publishEvent({ type: 'document-deleted', ...result });
  return result;
});

ipcMain.handle('bili:check-login', async () => {
  assertBackendReady();
  return publicCurrentUser(await refreshBilibiliUser());
});

ipcMain.handle('bili:prepare-account-switch', async () => {
  assertBackendReady();
  biliAccountGeneration += 1;
  const biliPartition = biliSession();
  const cookies = await biliPartition.cookies.get({});
  for (const cookie of cookies) {
    if (!isBilibiliCookieDomain(cookie.domain)) continue;
    const host = String(cookie.domain).replace(/^\./, '');
    const protocol = cookie.secure ? 'https' : 'http';
    await biliPartition.cookies.remove(`${protocol}://${host}${cookie.path || '/'}`, cookie.name);
  }
  for (const origin of ['https://www.bilibili.com', 'https://passport.bilibili.com', 'https://account.bilibili.com']) {
    await biliPartition.clearStorageData({
      origin,
      storages: ['localstorage', 'indexdb', 'cachestorage', 'serviceworkers']
    });
  }
  currentUser = null;
  sendRuntime();
  return { ok: true, removedCookies: cookies.filter((cookie) => isBilibiliCookieDomain(cookie.domain)).length };
});

ipcMain.handle('bili:list-folders', async () => {
  assertBackendReady();
  if (!currentUser?.isLogin || !currentUser.id || !currentUser.cookieFile) await refreshBilibiliUser();
  if (!currentUser?.isLogin) throw new Error('Not logged in.');
  const generation = biliAccountGeneration;
  const user = { ...currentUser };
  const folders = await bili.listFolders(user.mid);
  if (generation !== biliAccountGeneration || String(currentUser?.mid || '') !== String(user.mid || '')) {
    throw new Error('Bilibili account changed while favorites were loading. Retry for the current account.');
  }
  await collectionSyncService.reconcileFolders(folders, user);
  return folders;
});

function refreshBilibiliUser() {
  const generation = biliAccountGeneration;
  if (biliRefreshPromise && biliRefreshGeneration === generation) return biliRefreshPromise;
  biliRefreshGeneration = generation;
  const operation = (async () => {
    const previousLogin = Boolean(currentUser?.isLogin);
    const info = await bili.nav();
    if (generation !== biliAccountGeneration) return currentUser;
    if (!info.isLogin) {
      currentUser = info;
    } else {
      const previousUser = store.get('users', String(info.mid)) || {};
      const cookieFile = await bili.exportCookies(info.name || String(info.mid));
      if (generation !== biliAccountGeneration) return currentUser;
      let faceDataUrl = String(previousUser.faceDataUrl || '');
      try { faceDataUrl = await bili.fetchImageDataUrl(info.face); } catch (error) { console.warn(`[bili-avatar] ${error.message || String(error)}`); }
      if (generation !== biliAccountGeneration) return currentUser;
      const user = store.upsertUser({ id: String(info.mid), mid: String(info.mid), name: info.name, face: info.face, faceDataUrl });
      currentUser = { ...info, id: user.id, cookieFile, faceDataUrl };
    }
    if (info.isLogin || previousLogin !== Boolean(info.isLogin)) sendRuntime();
    return currentUser;
  })().finally(() => {
    if (biliRefreshPromise === operation) {
      biliRefreshPromise = null;
      biliRefreshGeneration = -1;
    }
  });
  biliRefreshPromise = operation;
  return operation;
}

ipcMain.handle('store:snapshot', async () => {
  if (!store) return { users: [], collections: [], tasks: [], tools: [], toolRuns: [], workspaces: [], videoCache: { collections: [], videos: [], jobs: [] }, analytics: { collections: {}, tools: [] }, activities: [] };
  return {
    users: store.list('users'),
    collections: store.listCollections().map(rendererCollection),
    tasks: buildTaskSnapshot(store).map(rendererTask),
    tools: store.listTools(),
    toolRuns: store.listToolRuns(),
    workspaces: store.listWorkspaces(),
    workers: store.listWorkers(),
    internalAgentSessions: internalAgentManager?.state().sessions || [],
    videoCache: videoCacheManager?.state() || { collections: [], videos: [], jobs: [] },
    analytics: buildAnalytics(store),
    scheduler: toolRunner?.getState() || null,
    settings: { filenameMetadata: store.getFilenameMetadata() },
    activities: store.listRecent('activities', 500),
    taskEvents: store.listRecent('taskEvents', 500)
  };
});

ipcMain.handle('tasks:set-enabled', async (_event, payload) => {
  assertBackendReady();
  const tasks = store.updateTasksEnabled(payload?.taskIds || [], Boolean(payload?.enabled));
  publishEvent({ type: 'tasks-enabled-changed', taskIds: tasks.map((task) => task.id), enabled: Boolean(payload?.enabled) });
  return { updated: tasks.length, taskIds: tasks.map((task) => task.id) };
});

ipcMain.handle('video-cache:state', async () => videoCacheManager?.state() || { collections: [], videos: [], jobs: [] });

ipcMain.handle('video-cache:collection-create', async (_event, name) => {
  assertBackendReady();
  const collection = videoCacheManager.createCollection(name);
  publishEvent({ type: 'video-cache-collection-created', collectionId: collection.id, collectionName: collection.name });
  return collection;
});

ipcMain.handle('video-cache:submit', async (_event, payload = {}) => {
  assertBackendReady();
  return videoCacheManager.submit(payload);
});

ipcMain.handle('video-cache:resume-login', async () => {
  assertBackendReady();
  return videoCacheManager.resumeWaitingForLogin();
});

ipcMain.handle('video-cache:open', async (_event, id) => {
  assertBackendReady();
  const record = store.getVideoCache(String(id || ''));
  if (!record?.videoFile || !fs.existsSync(record.videoFile)) throw new Error('缓存视频文件不存在。');
  shell.showItemInFolder(record.videoFile);
  return { path: record.videoFile };
});

ipcMain.handle('video-cache:delete-videos', async (_event, ids) => {
  assertBackendReady();
  return videoCacheManager.deleteVideos(Array.isArray(ids) ? ids : []);
});

ipcMain.handle('video-cache:delete-collection', async (_event, id) => {
  assertBackendReady();
  return videoCacheManager.deleteCollection(String(id || ''));
});

ipcMain.handle('settings:filename-metadata', async (_event, value) => {
  assertBackendReady();
  const filenameMetadata = store.setFilenameMetadata(value || {});
  publishEvent({ type: 'filename-metadata-changed', filenameMetadata });
  sendRuntime();
  return filenameMetadata;
});

ipcMain.handle('workers:update', async (_event, payload) => {
  assertBackendReady();
  const worker = store.updateWorker(payload?.workerId, payload?.patch || {});
  publishEvent({ type: worker.status === 'paused' ? 'worker-paused' : 'worker-activated', workerId: worker.id, pauseReason: worker.pauseReason });
  return worker;
});

ipcMain.handle('exports:markdown', async (_event, payload = {}) => {
  assertBackendReady();
  const taskIds = [...new Set((payload.taskIds || []).map(String))];
  if (!taskIds.length) throw new Error('请先把已完成视频加入导出列表。');
  const chosen = await dialog.showOpenDialog(mainWindow, {
    title: '选择 Markdown 导出目录',
    properties: ['openDirectory', 'createDirectory']
  });
  if (chosen.canceled || !chosen.filePaths[0]) return { canceled: true };
  const result = exportMarkdownTasks(chosen.filePaths[0], taskIds, payload.filenameMetadata || {});
  publishEvent({ type: 'markdown-exported', directory: result.directory, count: result.exported.length, skipped: result.skipped.length });
  return { canceled: false, ...result };
});

ipcMain.handle('workspaces:list', async () => store ? store.listWorkspaces() : []);
ipcMain.handle('workspaces:add', async (_event, payload = {}) => {
  assertBackendReady();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择工作库目录',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const workspace = store.addWorkspace({ name: payload.name, root: result.filePaths[0] });
  publishEvent({ type: 'workspace-added', workspaceId: workspace.id, root: workspace.root });
  return { canceled: false, workspace };
});

ipcMain.handle('workspaces:set-default', async (_event, id) => {
  assertBackendReady();
  const workspace = store.setDefaultWorkspace(id);
  ragAssistant?.setWorkspaceRoot(workspace.root);
  publishEvent({ type: 'workspace-default-changed', workspaceId: workspace.id, root: workspace.root });
  sendRuntime();
  return workspace;
});

ipcMain.handle('workspaces:remove', async (_event, id) => {
  assertBackendReady();
  const workspace = store.removeWorkspace(id);
  if (workspace) publishEvent({ type: 'workspace-removed', workspaceId: workspace.id });
  return { removed: Boolean(workspace) };
});

ipcMain.handle('clipboard:write', async (_event, value) => {
  clipboard.writeText(String(value || ''));
  return { ok: true };
});

ipcMain.handle('clipboard:write-image', async (_event, source) => {
  const trustedRoots = [WORKSPACE_ROOT, ...(store?.listWorkspaces?.() || []).map((item) => item.root)];
  const { buffer } = await loadClipboardImage(source, { trustedRoots });
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) throw new Error('图片格式无法读取或内容已经损坏。');
  clipboard.writeImage(image);
  return { ok: true, size: image.getSize() };
});

ipcMain.handle('credentials:list', async () => store ? store.list('credentials').map((item) => ({
  id: item.id,
  username: item.username,
  note: item.note || '',
  updatedAt: item.updatedAt || ''
})) : []);

ipcMain.handle('credentials:save', async (_event, payload) => {
  assertBackendReady();
  const username = String(payload?.username || '').trim();
  const password = String(payload?.password || '');
  if (!username) throw new Error('username is required');
  if (!password) throw new Error('password is required');
  const normalizedId = username.toLowerCase();
  const selectedId = String(payload?.id || '').trim();
  const selectedRecord = selectedId ? store.get('credentials', selectedId) : null;
  const existingRecord = store.get('credentials', normalizedId);
  const id = normalizedId;
  const encryptedPassword = encryptSecret(password);
  const record = {
    id,
    username,
    note: String(payload?.note || '').trim(),
    encryptedPassword,
    updatedAt: new Date().toISOString()
  };
  store.transaction(() => {
    if (selectedRecord && selectedId !== id) store.delete('credentials', selectedId);
    if (existingRecord && selectedRecord && existingRecord.id !== selectedRecord.id) {
      store.delete('credentials', existingRecord.id);
    }
    store.set('credentials', id, record);
  });
  return { id, username: record.username, note: record.note, updatedAt: record.updatedAt };
});

ipcMain.handle('credentials:get', async (_event, id) => {
  assertBackendReady();
  const record = store.get('credentials', id);
  if (!record) throw new Error(`credential not found: ${id}`);
  return {
    id: record.id,
    username: record.username,
    password: decryptSecret(record.encryptedPassword),
    note: record.note || ''
  };
});

ipcMain.handle('credentials:delete', async (_event, id) => {
  assertBackendReady();
  if (!id) return { ok: true };
  store.transaction(() => store.delete('credentials', String(id)));
  return { ok: true };
});

ipcMain.handle('api:sync-collection', async (_event, payload) => {
  assertBackendReady();
  return collectionSyncService.sync(payload || {});
});

ipcMain.handle('tools:list', async () => store ? store.listTools() : []);

ipcMain.handle('tools:update', async (_event, payload) => {
  assertBackendReady();
  const tool = store.updateTool(payload.id, payload.patch || {});
  mainWindow?.webContents.send('app:event', { type: 'tool-updated', tool });
  return tool;
});

ipcMain.handle('scheduler:get', async () => toolRunner?.getState() || null);

ipcMain.handle('scheduler:update', async (_event, patch = {}) => {
  assertBackendReady();
  const state = await toolRunner.updateConfig(patch);
  sendRuntime();
  return state;
});

ipcMain.handle('rag:state', async (_event, sessionId) => {
  if (ragAssistant) return ragAssistant.state(sessionId);
  return { loading: true, providers: [], sessions: [], activeSession: null, knowledgeCatalog: [], modelUsage: [] };
});

ipcMain.handle('rag:provider-save', async (_event, payload) => {
  assertBackendReady();
  const provider = ragAssistant.saveProvider(payload || {});
  internalAgentManager?.reconcileModelAvailability(provider.id);
  return provider;
});

ipcMain.handle('rag:provider-delete', async (_event, providerId) => {
  assertBackendReady();
  const result = ragAssistant.deleteProvider(providerId);
  internalAgentManager?.reconcileModelAvailability(providerId);
  return result;
});

ipcMain.handle('rag:models-fetch', async (_event, providerId) => {
  assertBackendReady();
  return ragAssistant.fetchModels(providerId);
});

ipcMain.handle('rag:models-update', async (_event, payload) => {
  assertBackendReady();
  const provider = ragAssistant.updateProviderModels(payload?.providerId, payload?.models || []);
  internalAgentManager?.reconcileModelAvailability(payload?.providerId);
  return provider;
});

ipcMain.handle('rag:session-create', async (_event, payload) => {
  assertBackendReady();
  return ragAssistant.createSession(payload || {});
});

ipcMain.handle('rag:session-update', async (_event, payload) => {
  assertBackendReady();
  return ragAssistant.updateSession(payload?.sessionId, payload?.patch || {});
});

ipcMain.handle('rag:session-delete', async (_event, sessionId) => {
  assertBackendReady();
  return ragAssistant.deleteSession(sessionId);
});

ipcMain.handle('rag:session-compact', async (_event, sessionId) => {
  assertBackendReady();
  return ragAssistant.compact(sessionId);
});

ipcMain.handle('rag:send', async (_event, payload) => {
  assertBackendReady();
  return ragAssistant.send(payload?.sessionId, payload || {});
});

ipcMain.handle('rag:stop', async (_event, sessionId) => {
  assertBackendReady();
  return ragAssistant.cancel(sessionId);
});

ipcMain.handle('rag:choose-sandbox', async () => {
  assertBackendReady();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 RAG 会话沙盒目录',
    properties: ['openDirectory', 'createDirectory']
  });
  return { canceled: result.canceled, path: result.filePaths[0] || '' };
});

ipcMain.handle('rag:create-sandbox', async () => {
  assertBackendReady();
  const root = store.getDefaultWorkspace()?.root || WORKSPACE_ROOT;
  const directory = path.join(root, '.star-note', 'rag-sandboxes', `sandbox-${timestampForFile()}`);
  fs.mkdirSync(directory, { recursive: true });
  return { path: directory };
});

ipcMain.handle('rag:attachments-import', async (_event, sessionId) => {
  assertBackendReady();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '添加到 RAG 对话',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '支持的资料与媒体', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm', 'mov', 'mp3', 'wav', 'm4a', 'ogg', 'flac', 'pdf', 'md', 'txt', 'docx', 'json', 'csv'] },
      { name: '全部文件', extensions: ['*'] }
    ]
  });
  if (result.canceled) return { canceled: true, attachments: [] };
  return { canceled: false, attachments: await ragAssistant.importFiles(sessionId, result.filePaths) };
});

ipcMain.handle('rag:clipboard-image-import', async (_event, sessionId) => {
  assertBackendReady();
  const image = clipboard.readImage();
  if (image.isEmpty()) throw new Error('剪贴板中没有可读取的图片。');
  const attachment = await ragAssistant.importBuffer(sessionId, {
    buffer: image.toPNG(),
    mimeType: 'image/png',
    name: `clipboard-${timestampForFile()}.png`
  });
  return { attachment };
});

ipcMain.handle('rag:attachment-discard', async (_event, payload = {}) => {
  assertBackendReady();
  return ragAssistant.discardAttachment(payload.sessionId, payload.attachmentId);
});

ipcMain.handle('rag:approval-resolve', async (_event, payload = {}) => {
  const pending = pendingRagApprovals.get(String(payload.id || ''));
  if (!pending) return { resolved: false };
  pendingRagApprovals.delete(String(payload.id));
  clearTimeout(pending.timer);
  pending.resolve({ approved: Boolean(payload.approved), fullAccess: Boolean(payload.fullAccess) });
  return { resolved: true };
});

ipcMain.handle('rag:render-markdown', async (_event, payload = {}) => renderRagMarkdown(payload?.markdown, payload?.sessionId));

ipcMain.handle('internal-agent:state', async () => internalAgentManager ? internalAgentManager.state() : { providers: [], sessions: [], collections: [], internalCollections: [] });

ipcMain.handle('internal-agent:collection-create', async (_event, name) => {
  assertBackendReady();
  const collection = internalAgentManager.createInternalCollection(name);
  publishEvent({ type: 'internal-collection-created', collectionId: collection.id, collectionName: collection.name });
  return collection;
});

ipcMain.handle('internal-agent:collection-open', async (_event, collectionId) => {
  assertBackendReady();
  const target = internalAgentManager.collectionOutputDirectory(collectionId);
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
  return { opened: true, path: target };
});

ipcMain.handle('internal-agent:output-open', async (_event, sessionId) => {
  assertBackendReady();
  const target = internalAgentManager.sessionOutputDirectory(sessionId);
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
  return { opened: true, path: target };
});

ipcMain.handle('internal-agent:session-create', async (_event, payload) => {
  assertBackendReady();
  return internalAgentManager.createSession(payload || {});
});

ipcMain.handle('internal-agent:single-create', async (_event, payload) => {
  assertBackendReady();
  return internalAgentManager.createSingleTask(payload || {});
});

ipcMain.handle('internal-agent:single-inspect', async (_event, payload) => {
  assertBackendReady();
  return internalAgentManager.inspectSingleTask(payload || {});
});

ipcMain.handle('internal-agent:start', async (_event, sessionId) => {
  assertBackendReady();
  return internalAgentManager.start(sessionId);
});

ipcMain.handle('internal-agent:pause', async (_event, sessionId) => {
  assertBackendReady();
  return internalAgentManager.pause(sessionId);
});

ipcMain.handle('internal-agent:stop', async (_event, sessionId) => {
  assertBackendReady();
  return internalAgentManager.stop(sessionId);
});

ipcMain.handle('internal-agent:delete', async (_event, sessionId) => {
  assertBackendReady();
  return internalAgentManager.deleteSession(sessionId);
});

ipcMain.handle('dependencies:state', async () => dependencyManager?.state() || null);

ipcMain.handle('dependencies:acknowledge', async (_event, payload = {}) => {
  assertBackendReady();
  const state = dependencyManager.acknowledgePrompt(Boolean(payload.download));
  if (payload.download) dependencyManager.downloadRequired().catch((error) => publishDependencyEvent({ type: 'dependency-error', error: error.message }));
  sendRuntime();
  return state;
});

ipcMain.handle('dependencies:download', async (_event, packageId) => {
  assertBackendReady();
  return dependencyManager.download(packageId);
});

ipcMain.handle('window:minimize', async () => mainWindow?.minimize());
ipcMain.handle('window:maximize-toggle', async () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});
ipcMain.handle('window:close', async () => mainWindow?.close());

function encryptSecret(value) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储当前不可用，已拒绝以明文保存密码。');
  return { mode: 'safeStorage', value: safeStorage.encryptString(value).toString('base64') };
}

function decryptSecret(secret) {
  if (!secret) return '';
  if (secret.mode === 'safeStorage') return safeStorage.decryptString(Buffer.from(secret.value, 'base64'));
  throw new Error('检测到旧版未加密密钥记录。为保护账户安全，请删除该记录并重新输入。');
}

async function openExternalUrl(value) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) links can be opened externally.');
  if (url.username || url.password) throw new Error('External links cannot contain embedded account credentials.');
  await shell.openExternal(url.toString());
  return url.toString();
}

function requestRagApproval(request) {
  const id = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRagApprovals.delete(id);
      resolve({ approved: false, reason: 'approval timeout' });
    }, 120000);
    pendingRagApprovals.set(id, { resolve, timer });
    mainWindow?.webContents.send('rag:event', { type: 'approval-request', approval: { id, ...request } });
  });
}

async function browseHidden(value, options = {}) {
  const partition = `rag-hidden-browser-${crypto.randomUUID()}`;
  const isolatedSession = session.fromPartition(partition, { cache: false });
  const resolve = async (hostname) => {
    const result = await isolatedSession.resolveHost(hostname);
    return (result.endpoints || []).map((item) => item.address);
  };
  const policy = {
    allowPrivate: Boolean(options.allowPrivate),
    allowedPrivateHosts: Array.isArray(options.allowedPrivateHosts) ? options.allowedPrivateHosts : undefined,
    resolve
  };
  const url = await assertHiddenBrowserUrl(value, policy);
  installHiddenBrowserRequestGuard(isolatedSession.webRequest, policy);
  isolatedSession.setPermissionCheckHandler(() => false);
  isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  isolatedSession.on('will-download', (event) => event.preventDefault());
  const browser = new BrowserWindow({
    show: false,
    width: 1180,
    height: 820,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      images: false
    }
  });
  browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const blockPrivateNavigation = (event, details) => {
    try {
      const target = typeof details === 'string' ? details : details?.url;
      const candidate = new URL(target || event?.url || '');
      if (!options.allowPrivate && isPrivateNetworkHost(candidate.hostname)) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  };
  browser.webContents.on('will-navigate', blockPrivateNavigation);
  browser.webContents.on('will-redirect', blockPrivateNavigation);
  let timeout = null;
  try {
    await Promise.race([
      browser.loadURL(url.toString()),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Hidden browser timed out.')), 25000);
      })
    ]);
    const result = await browser.webContents.executeJavaScript(`(() => {
      const title = document.title || '';
      const text = (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 50000);
      const links = [...document.querySelectorAll('a[href]')].slice(0, 40).map((a) => ({ text: (a.innerText || '').trim().slice(0, 160), href: a.href })).filter((item) => item.text && /^https?:/.test(item.href));
      return { title, url: location.href, text, links };
    })()`, true);
    return JSON.stringify(result, null, 2);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (!browser.isDestroyed()) browser.destroy();
  }
}

function assertBackendReady() {
  if (!backendReady || !store || !bili || !apiServer) throw new Error('Backend is still starting.');
}

function emitBootstrap(message, progress, phase = 'loading') {
  bootstrapState = { phase, progress, message, updatedAt: new Date().toISOString() };
  sendBootstrap();
}

function sendBootstrap() {
  if (!mainWindow || mainWindow.webContents.isLoading()) return;
  mainWindow.webContents.send('app:bootstrap', bootstrapState);
}

function sendRuntime() {
  if (!mainWindow || mainWindow.webContents.isLoading()) return;
  mainWindow.webContents.send('app:runtime', {
    apiUrl: apiServer?.url(),
    workspaceRoot: store?.getDefaultWorkspace()?.root || WORKSPACE_ROOT,
    defaultWorkspace: store?.getDefaultWorkspace() || null,
    currentUser: publicCurrentUser(currentUser),
    toolHealth,
    scheduler: toolRunner?.getState() || null,
    filenameMetadata: store?.getFilenameMetadata() || null,
    dependencies: dependencyManager?.state() || null,
    videoCache: videoCacheManager?.state() || null,
    backendReady,
    bootstrap: bootstrapState
  });
}

function publishEvent(event) {
  const record = { createdAt: new Date().toISOString(), ...event };
  if (store && !VOLATILE_ACTIVITY_TYPES.has(event.type)) {
    const { cacheState, ...activity } = record;
    store.recordActivity(activity);
  }
  mainWindow?.webContents.send('app:event', record);
}

function buildTaskSnapshot(activeStore) {
  const tasks = activeStore.listTasks();
  const liveIds = new Set(tasks.map((task) => task.id));
  for (const id of taskDisplayCoverCache.keys()) {
    if (!liveIds.has(id)) taskDisplayCoverCache.delete(id);
  }
  return tasks.map((task) => task.status === 'done'
    ? { ...task, displayCover: resolveTaskDisplayCover(task) }
    : task);
}

function publicCurrentUser(user) {
  if (!user) return null;
  const { cookieFile, ...safe } = user;
  return safe;
}

function rendererCollection(collection) {
  if (!collection) return null;
  const { cookieFile, ...safe } = collection;
  return safe;
}

function rendererTask(task) {
  if (!task) return null;
  const { cookieFile, workId, cover, ...safe } = task;
  let publicCover = '';
  try { publicCover = assertBilibiliImageUrl(normalizeBilibiliAssetUrl(cover || '')); } catch {}
  return { ...safe, cover: publicCover };
}

function resolveTaskDisplayCover(task) {
  const cacheKey = [task.updatedAt, task.artifactDir, task.outputMarkdown, task.coverFile, task.cover].map((item) => String(item || '')).join('|');
  const cached = taskDisplayCoverCache.get(task.id);
  if (cached?.key === cacheKey && (!cached.localFile || fs.existsSync(cached.localFile))) return cached.value;
  const artifactDir = path.resolve(task.artifactDir || path.dirname(task.outputMarkdown || '.'));
  let info = {};
  try { info = JSON.parse(fs.readFileSync(path.join(artifactDir, 'info.json'), 'utf8')); } catch {}
  const localCandidates = [task.coverFile, info.coverFile].filter(Boolean).map((value) => path.isAbsolute(String(value)) ? String(value) : path.join(artifactDir, String(value)));
  try {
    for (const name of fs.readdirSync(artifactDir)) {
      if (/^(cover|thumbnail|poster)\.(jpe?g|png|webp|avif)$/i.test(name)) localCandidates.push(path.join(artifactDir, name));
    }
    const framesDir = path.join(artifactDir, 'frames');
    if (fs.existsSync(framesDir)) {
      const frame = fs.readdirSync(framesDir).find((name) => /\.(jpe?g|png|webp)$/i.test(name));
      if (frame) localCandidates.push(path.join(framesDir, frame));
    }
  } catch {}
  const local = localCandidates.map((file) => safeLocalDisplayAsset(artifactDir, file)).find(Boolean);
  if (local) {
    const value = pathToFileURL(local).href;
    taskDisplayCoverCache.set(task.id, { key: cacheKey, value, localFile: local });
    return value;
  }
  const remote = normalizeBilibiliAssetUrl(task.cover || info.pic || info.thumbnail || '');
  let value = '';
  try { value = assertBilibiliImageUrl(remote); } catch {}
  taskDisplayCoverCache.set(task.id, { key: cacheKey, value, localFile: '' });
  return value;
}

function publishInternalAgentEvent(event) {
  const record = { createdAt: new Date().toISOString(), ...event };
  if (store && event.type !== 'stream' && event.type !== 'session-updated') {
    store.recordActivity({ ...record, type: `internal-agent-${event.type}` });
  }
  mainWindow?.webContents.send('internal-agent:event', record);
  if (['task-completed', 'task-attempt-aborted', 'video-unavailable'].includes(event.type)) {
    mainWindow?.webContents.send('app:event', {
      createdAt: record.createdAt,
      type: 'snapshot-invalidated',
      reason: event.type,
      taskId: event.taskId || '',
      collectionId: event.collectionId || '',
      internalAgent: true
    });
  }
}

function publishDependencyEvent(event) {
  const record = { createdAt: new Date().toISOString(), ...event };
  mainWindow?.webContents.send('dependency:event', record);
  if (event.type === 'dependency-error') publishEvent(event);
}

function exportMarkdownTasks(directory, taskIds, filenameMetadata) {
  const targetRoot = path.resolve(directory);
  fs.mkdirSync(targetRoot, { recursive: true });
  const exported = [];
  const skipped = [];
  const usedNames = new Set();

  for (const taskId of taskIds) {
    const task = store.getTask(taskId);
    if (!task || task.status !== 'done' || !task.outputMarkdown || !fs.existsSync(task.outputMarkdown)) {
      skipped.push({ taskId, reason: '任务未完成或 Markdown 文件不存在' });
      continue;
    }
    const collection = store.getCollectionById(task.collectionId) || {};
    const base = videoArtifactName(task, collection, filenameMetadata);
    const filename = uniqueMarkdownName(base, targetRoot, usedNames);
    const targetFile = path.join(targetRoot, filename);
    try {
      const copied = copyMarkdownForExport(task.outputMarkdown, targetFile, targetRoot);
      exported.push({
        taskId: task.id,
        bvid: task.bvid,
        title: task.title,
        owner: task.owner,
        userName: collection.userName || '',
        collectionName: collection.name || '',
        publishedAt: task.publishedAt || '',
        favoriteAddedAt: task.favoriteAddedAt || '',
        tags: task.tags || [],
        videoUrl: task.url || '',
        sourceMarkdown: task.outputMarkdown,
        exportedFile: targetFile,
        filename,
        assets: copied.assets
      });
    } catch (error) {
      skipped.push({ taskId, reason: error.message || String(error) });
    }
  }

  const manifestFile = uniqueExportManifest(targetRoot);
  fs.writeFileSync(manifestFile, `${JSON.stringify({ exportedAt: new Date().toISOString(), filenameMetadata, exported, skipped }, null, 2)}\n`, 'utf8');
  return { directory: targetRoot, manifestFile, exported, skipped };
}

function copyMarkdownForExport(sourceFile, targetFile, targetRoot) {
  const sourceRoot = path.dirname(sourceFile);
  const source = fs.readFileSync(sourceFile, 'utf8');
  const assetFolderName = path.basename(targetFile, path.extname(targetFile));
  const assetRoot = path.join(targetRoot, '.star-owner-assets', assetFolderName);
  const used = new Set();
  const assets = [];
  const rewritten = source.replace(/(!\[[^\]]*]\()([^)]+)(\))/g, (match, opening, rawReference, closing) => {
    const reference = String(rawReference || '').trim().replace(/^<|>$/g, '');
    if (!reference || /^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith('#')) return match;
    let decoded;
    try { decoded = decodeURIComponent(reference.split('#')[0].split('?')[0]); } catch { return match; }
    const local = safeLocalDisplayAsset(sourceRoot, path.resolve(sourceRoot, decoded));
    if (!local) return match;
    fs.mkdirSync(assetRoot, { recursive: true });
    const targetName = uniqueAssetName(path.basename(local), assetRoot, used);
    const target = path.join(assetRoot, targetName);
    fs.copyFileSync(local, target);
    const relative = path.relative(targetRoot, target).split(path.sep).join('/');
    assets.push({ source: local, exported: target, relative });
    return `${opening}<${relative}>${closing}`;
  });
  fs.writeFileSync(targetFile, rewritten, 'utf8');
  return { assets };
}

function uniqueAssetName(name, directory, used) {
  const extension = path.extname(name);
  const base = path.basename(name, extension);
  let index = 1;
  let candidate = name;
  while (used.has(candidate.toLowerCase()) || fs.existsSync(path.join(directory, candidate))) candidate = `${base}-${++index}${extension}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

function uniqueExportManifest(directory) {
  const stem = `star-owner-rag-manifest-${timestampForFile()}`;
  let candidate = path.join(directory, `${stem}.json`);
  let index = 2;
  while (fs.existsSync(candidate)) candidate = path.join(directory, `${stem}-${index++}.json`);
  return candidate;
}

function uniqueMarkdownName(base, directory, usedNames) {
  let counter = 1;
  let filename = `${base}.md`;
  while (usedNames.has(filename.toLowerCase()) || fs.existsSync(path.join(directory, filename))) {
    counter += 1;
    filename = `${base} (${counter}).md`;
  }
  usedNames.add(filename.toLowerCase());
  return filename;
}

function renderMarkdownPreview(markdown, sourceFile) {
  const renderer = new MarkdownIt({ html: false, linkify: true, typographer: false });
  const defaultImage = renderer.renderer.rules.image;
  renderer.renderer.rules.image = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const src = token.attrGet('src') || '';
    if (/^https?:/i.test(src)) {
      try {
        const remote = new URL(src);
        if (remote.protocol !== 'https:' || remote.username || remote.password || !isTrustedBilibiliImageHost(remote.hostname)) throw new Error('unsupported remote image host');
        token.attrSet('src', remote.toString());
      } catch {
        token.attrSet('src', '');
        token.attrSet('alt', `${token.attrGet('alt') || '图片'}（远程来源不受支持）`);
      }
    } else if (src && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('#')) {
      try {
        const decoded = decodeURIComponent(src.split('#')[0].split('?')[0]);
        const resolved = path.resolve(path.dirname(sourceFile), decoded);
        const root = path.resolve(path.dirname(sourceFile));
        const local = safeLocalDisplayAsset(root, resolved);
        if (local) token.attrSet('src', pathToFileURL(local).href);
      } catch {
        // Keep the original source so the preview shows a normal broken-image state.
      }
    }
    return defaultImage(tokens, index, options, env, self);
  };
  const defaultLinkOpen = renderer.renderer.rules.link_open || ((tokens, index, options, env, self) => self.renderToken(tokens, index, options));
  renderer.renderer.rules.link_open = (tokens, index, options, env, self) => {
    tokens[index].attrSet('rel', 'noreferrer');
    return defaultLinkOpen(tokens, index, options, env, self);
  };
  const withoutFrontMatter = String(markdown || '').replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/, '');
  const content = promoteMindMap(withoutFrontMatter);
  return renderer.render(content);
}

function isTrustedBilibiliImageHost(value) {
  const host = String(value || '').toLowerCase().replace(/\.$/, '');
  return ['hdslb.com', 'biliimg.com', 'bilibili.com'].some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function renderRagMarkdown(markdown, sessionId) {
  const renderer = wrapMarkdownTables(new MarkdownIt({ html: false, linkify: true, typographer: false }));
  const defaultImage = renderer.renderer.rules.image;
  renderer.renderer.rules.image = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const src = token.attrGet('src') || '';
    if (src.startsWith('star-rag-image:')) {
      try {
        const imagePath = ragAssistant?.resolveKnowledgeImage(String(sessionId || ''), src);
        if (!imagePath) throw new Error('Knowledge image is unavailable.');
        token.attrSet('src', pathToFileURL(imagePath).href);
        token.attrSet('data-knowledge-image', 'true');
      } catch {
        token.attrSet('src', '');
        token.attrSet('alt', `${token.attrGet('alt') || '知识库图片'}（不可用）`);
      }
    } else if (/^https?:\/\//i.test(src)) {
      try {
        token.attrSet('src', assertBilibiliImageUrl(src));
      } catch {
        token.attrSet('src', '');
        token.attrSet('alt', `${token.attrGet('alt') || '图片'}（远程来源不受支持）`);
      }
    } else if (/^data:/i.test(src)) {
      const supported = /^data:image\/(?:avif|gif|jpe?g|png|webp);base64,[a-z0-9+/=\s]+$/i.test(src)
        && src.length <= 20 * 1024 * 1024;
      if (!supported) {
        token.attrSet('src', '');
        token.attrSet('alt', `${token.attrGet('alt') || '图片'}（Data URL 不受支持或过大）`);
      }
    } else if (src) {
      token.attrSet('src', '');
      token.attrSet('alt', `${token.attrGet('alt') || '图片'}（来源不受支持）`);
    }
    return defaultImage(tokens, index, options, env, self);
  };
  return renderer.render(String(markdown || ''));
}

function safeLocalDisplayAsset(root, candidate) {
  try {
    const resolvedRoot = fs.realpathSync(path.resolve(root));
    const resolvedFile = fs.realpathSync(path.resolve(candidate));
    const rootForCompare = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;
    const fileForCompare = process.platform === 'win32' ? resolvedFile.toLowerCase() : resolvedFile;
    if (fileForCompare !== rootForCompare && !fileForCompare.startsWith(`${rootForCompare}${path.sep}`)) return '';
    const stat = fs.lstatSync(resolvedFile);
    return stat.isFile() && !stat.isSymbolicLink() ? resolvedFile : '';
  } catch {
    return '';
  }
}
