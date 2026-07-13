const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, safeStorage, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const MarkdownIt = require('markdown-it');
const { buildAnalytics } = require('./core/analytics');
const { ApiServer } = require('./core/api-server');
const { BiliClient } = require('./core/bili');
const { CollectionSyncService } = require('./core/collection-sync-service');
const { DependencyManager } = require('./core/dependency-manager');
const { secureMainWindow } = require('./core/desktop-security');
const { InternalAgentManager } = require('./core/internal-agent-manager');
const { loadClipboardImage } = require('./core/image-clipboard');
const { promoteMindMap, wrapMarkdownTables } = require('./core/markdown');
const { isPrivateNetworkHost } = require('./core/network-policy');
const { repairPortablePythonHome } = require('./core/portable-runtime');
const { RagAssistant } = require('./core/rag-assistant');
const { Store } = require('./core/store');
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
let backendReady = false;
let toolHealth = [];
const pendingRagApprovals = new Map();
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
  mainWindow.loadFile(RENDERER_FILE);
  mainWindow.webContents.once('did-finish-load', () => {
    sendBootstrap();
    sendRuntime();
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
  ragAssistant = new RagAssistant({
    store,
    workspaceRoot: store.getDefaultWorkspace()?.root || WORKSPACE_ROOT,
    encryptSecret,
    decryptSecret,
    emit: (event) => mainWindow?.webContents.send('rag:event', event),
    requestApproval: requestRagApproval,
    browseHidden,
    openExternal: (url) => shell.openExternal(url)
  });
  emitBootstrap('Preparing Bilibili session...', 0.52);
  bili = new BiliClient(biliSession);
  collectionSyncService = new CollectionSyncService({
    store,
    bili,
    getCurrentUser: () => currentUser,
    onEvent: publishEvent
  });
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
  emitBootstrap('Starting resource pools and local Agent API...', 0.92);
  apiServer = new ApiServer({
    store,
    toolRunner,
    getToolHealth: () => toolHealth,
    onEvent: publishEvent
  });
  const apiUrl = await apiServer.start();
  backendReady = true;
  emitBootstrap('Ready.', 1, 'ready');
  sendRuntime();
}

app.whenReady().then(() => {
  createWindow();
  mainWindow.webContents.once('did-finish-load', () => {
    bootstrap().catch((error) => {
      backendReady = false;
      emitBootstrap(error.message || String(error), 1, 'error');
    });
  });
});

app.on('window-all-closed', () => {
  apiServer?.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  apiServer?.stop();
  internalAgentManager?.shutdown();
  videoCacheManager?.shutdown();
  toolRunner?.shutdown();
  for (const pending of pendingRagApprovals.values()) pending.resolve({ approved: false });
  pendingRagApprovals.clear();
});

ipcMain.handle('app:get-runtime', async () => ({
  apiUrl: apiServer?.url(),
  workspaceRoot: store?.getDefaultWorkspace()?.root || WORKSPACE_ROOT,
  defaultWorkspace: store?.getDefaultWorkspace() || null,
  currentUser,
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
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) links can be opened externally.');
  await shell.openExternal(url.toString());
  return { url: url.toString() };
});

ipcMain.handle('docs:open-project-path', async (_event, value) => {
  const projectRoot = path.resolve(__dirname, '..');
  const target = path.resolve(projectRoot, String(value || ''));
  if (target !== projectRoot && !target.startsWith(`${projectRoot}${path.sep}`)) throw new Error('Document path is outside the project.');
  if (!fs.existsSync(target)) throw new Error(`Document does not exist: ${value}`);
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
  return { path: target };
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

ipcMain.handle('bili:check-login', async () => {
  assertBackendReady();
  const previousLogin = Boolean(currentUser?.isLogin);
  const info = await bili.nav();
  currentUser = info;
  if (info.isLogin) {
    const user = store.upsertUser({ id: String(info.mid), mid: String(info.mid), name: info.name, face: info.face });
    const cookieFile = await bili.exportCookies(info.name || String(info.mid));
    currentUser = { ...info, id: user.id, cookieFile };
  }
  if (info.isLogin || previousLogin !== Boolean(info.isLogin)) sendRuntime();
  return currentUser;
});

ipcMain.handle('bili:prepare-account-switch', async () => {
  assertBackendReady();
  const biliPartition = biliSession();
  const cookies = await biliPartition.cookies.get({});
  for (const cookie of cookies) {
    if (!String(cookie.domain || '').includes('bilibili.com')) continue;
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
  return { ok: true, removedCookies: cookies.filter((cookie) => String(cookie.domain || '').includes('bilibili.com')).length };
});

ipcMain.handle('bili:list-folders', async () => {
  assertBackendReady();
  if (!currentUser?.isLogin) currentUser = await bili.nav();
  if (!currentUser?.isLogin) throw new Error('Not logged in.');
  return bili.listFolders(currentUser.mid);
});

ipcMain.handle('store:snapshot', async () => {
  if (!store) return { users: [], collections: [], tasks: [], tools: [], toolRuns: [], workspaces: [], videoCache: { collections: [], videos: [], jobs: [] }, analytics: { collections: {}, tools: [] }, activities: [] };
  return {
    users: store.list('users'),
    collections: store.listCollections(),
    tasks: buildTaskSnapshot(store),
    tools: store.listTools(),
    toolRuns: store.listToolRuns(),
    workspaces: store.listWorkspaces(),
    workers: store.listWorkers(),
    internalAgentSessions: internalAgentManager?.state().sessions || [],
    activeCollection: store.getActiveCollection(),
    videoCache: videoCacheManager?.state() || { collections: [], videos: [], jobs: [] },
    analytics: buildAnalytics(store),
    scheduler: toolRunner?.getState() || null,
    settings: { filenameMetadata: store.getFilenameMetadata() },
    activities: store.listRecent('activities', 500),
    taskEvents: store.listRecent('taskEvents', 500)
  };
});

ipcMain.handle('collections:set-active', async (_event, collectionId) => {
  assertBackendReady();
  const collection = store.setActiveCollection(collectionId);
  publishEvent({ type: 'active-collection-changed', collectionId: collection.id, userName: collection.userName, collectionName: collection.name });
  return collection;
});

ipcMain.handle('tasks:set-enabled', async (_event, payload) => {
  assertBackendReady();
  const tasks = store.updateTasksEnabled(payload?.taskIds || [], Boolean(payload?.enabled));
  publishEvent({ type: 'tasks-enabled-changed', taskIds: tasks.map((task) => task.id), enabled: Boolean(payload?.enabled) });
  return { updated: tasks.length, tasks };
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
  if (selectedRecord && selectedId !== id) {
    store.db.run('DELETE FROM kv WHERE scope = ? AND id = ?', ['credentials', selectedId]);
  }
  if (existingRecord && selectedRecord && existingRecord.id !== selectedRecord.id) {
    store.db.run('DELETE FROM kv WHERE scope = ? AND id = ?', ['credentials', existingRecord.id]);
  }
  const encryptedPassword = encryptSecret(password);
  const record = {
    id,
    username,
    note: String(payload?.note || '').trim(),
    encryptedPassword,
    updatedAt: new Date().toISOString()
  };
  store.set('credentials', id, record);
  store.commit();
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
  store.db.run('DELETE FROM kv WHERE scope = ? AND id = ?', ['credentials', String(id)]);
  store.commit();
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
  return secret.value || '';
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
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Hidden browser only supports HTTP(S).');
  const browser = new BrowserWindow({
    show: false,
    width: 1180,
    height: 820,
    webPreferences: {
      partition: 'persist:rag-hidden-browser',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      images: false
    }
  });
  browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const blockPrivateNavigation = (event) => {
    try {
      const candidate = new URL(event.url || '');
      if (!options.allowPrivate && isPrivateNetworkHost(candidate.hostname)) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  };
  browser.webContents.on('will-navigate', blockPrivateNavigation);
  browser.webContents.on('will-redirect', blockPrivateNavigation);
  try {
    await Promise.race([
      browser.loadURL(url.toString()),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Hidden browser timed out.')), 25000))
    ]);
    const result = await browser.webContents.executeJavaScript(`(() => {
      const title = document.title || '';
      const text = (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 50000);
      const links = [...document.querySelectorAll('a[href]')].slice(0, 40).map((a) => ({ text: (a.innerText || '').trim().slice(0, 160), href: a.href })).filter((item) => item.text && /^https?:/.test(item.href));
      return { title, url: location.href, text, links };
    })()`, true);
    return JSON.stringify(result, null, 2);
  } finally {
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
    currentUser,
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
  if (store && event.type !== 'collection-sync-progress') store.recordActivity(record);
  mainWindow?.webContents.send('app:event', record);
}

function buildTaskSnapshot(activeStore) {
  return activeStore.listTasks().map((task) => task.status === 'done'
    ? { ...task, displayCover: resolveTaskDisplayCover(task) }
    : task);
}

function resolveTaskDisplayCover(task) {
  const artifactDir = path.resolve(task.artifactDir || path.dirname(task.outputMarkdown || '.'));
  let info = {};
  try { info = JSON.parse(fs.readFileSync(path.join(artifactDir, 'info.json'), 'utf8')); } catch {}
  const localCandidates = [task.coverFile, info.coverFile].filter(Boolean).map((value) => {
    const text = String(value);
    return path.isAbsolute(text) ? text : path.join(artifactDir, text);
  });
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
  const local = localCandidates.find((file) => {
    try { return fs.statSync(file).isFile(); } catch { return false; }
  });
  if (local) return pathToFileURL(local).href;
  const remote = String(task.cover || info.pic || info.thumbnail || '');
  if (remote.startsWith('//')) return `https:${remote}`;
  if (remote.startsWith('http://')) return `https://${remote.slice('http://'.length)}`;
  return /^https:\/\//i.test(remote) ? remote : '';
}

function publishInternalAgentEvent(event) {
  const record = { createdAt: new Date().toISOString(), ...event };
  if (store && event.type !== 'stream' && event.type !== 'session-updated') {
    store.recordActivity({ ...record, type: `internal-agent-${event.type}` });
  }
  mainWindow?.webContents.send('internal-agent:event', record);
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
    fs.copyFileSync(task.outputMarkdown, targetFile);
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
      filename
    });
  }

  const manifestFile = path.join(targetRoot, `star-owner-rag-manifest-${timestampForFile()}.json`);
  fs.writeFileSync(manifestFile, `${JSON.stringify({ exportedAt: new Date().toISOString(), filenameMetadata, exported, skipped }, null, 2)}\n`, 'utf8');
  return { directory: targetRoot, manifestFile, exported, skipped };
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
    if (src && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('#')) {
      try {
        const decoded = decodeURIComponent(src.split('#')[0].split('?')[0]);
        const resolved = path.resolve(path.dirname(sourceFile), decoded);
        const root = path.resolve(path.dirname(sourceFile));
        if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) token.attrSet('src', pathToFileURL(resolved).href);
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
    }
    return defaultImage(tokens, index, options, env, self);
  };
  return renderer.render(String(markdown || ''));
}
