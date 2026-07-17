const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');
const { recoverAtomicFile, restoreAtomicBackup, writeFileRecoverable } = require('./atomic-file');
const { DEFAULT_FILENAME_METADATA, WORKSPACE_ROOT, ensureDir, normalizeFilenameMetadata, normalizeTags } = require('./workspace');

const DB_FILE = path.join(WORKSPACE_ROOT, 'orchestrator.sqlite');

class Store {
  constructor(SQL, file = DB_FILE) {
    this.SQL = SQL;
    this.file = file;
    ensureDir(path.dirname(file));
    recoverAtomicFile(file);
    try {
      this.db = fs.existsSync(file) ? new SQL.Database(fs.readFileSync(file)) : new SQL.Database();
    } catch (error) {
      if (!restoreAtomicBackup(file)) throw error;
      this.db = new SQL.Database(fs.readFileSync(file));
    }
    this.initSchema();
    this.initDefaultWorkspace();
    this.initDefaultTools();
    this.migrateLegacyTasks();
    this.migrateCompletedTaskMetadata();
    this.save();
  }

  static async open(file = DB_FILE) {
    const SQL = await initSqlJs({
      locateFile: (name) => path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', name)
    });
    return new Store(SQL, file);
  }

  initSchema() {
    this.db.run(`
      PRAGMA user_version = 1;
      CREATE TABLE IF NOT EXISTS kv (
        scope TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, id)
      );
      CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv(scope);
    `);
  }

  save() {
    writeFileRecoverable(this.file, Buffer.from(this.db.export()));
  }

  transaction(callback) {
    const before = Buffer.from(this.db.export());
    this.db.run('BEGIN IMMEDIATE TRANSACTION');
    try {
      const result = callback();
      if (result && typeof result.then === 'function') throw new Error('Store.transaction callback must be synchronous.');
      this.db.run('COMMIT');
      try {
        this.save();
      } catch (error) {
        this.db.close();
        this.db = new this.SQL.Database(before);
        this.save();
        throw error;
      }
      return result;
    } catch (error) {
      try { this.db.run('ROLLBACK'); } catch {}
      throw error;
    }
  }

  set(scope, id, value) {
    const updatedAt = new Date().toISOString();
    const stmt = this.db.prepare('INSERT OR REPLACE INTO kv(scope, id, data, updated_at) VALUES (?, ?, ?, ?)');
    stmt.run([scope, String(id), JSON.stringify(value), updatedAt]);
    stmt.free();
  }

  get(scope, id) {
    const stmt = this.db.prepare('SELECT data FROM kv WHERE scope = ? AND id = ?');
    stmt.bind([scope, String(id)]);
    const row = stmt.step() ? JSON.parse(stmt.getAsObject().data) : null;
    stmt.free();
    return row;
  }

  list(scope) {
    const stmt = this.db.prepare('SELECT data FROM kv WHERE scope = ? ORDER BY id ASC');
    stmt.bind([scope]);
    const rows = [];
    while (stmt.step()) rows.push(JSON.parse(stmt.getAsObject().data));
    stmt.free();
    return rows;
  }

  delete(scope, id) {
    const stmt = this.db.prepare('DELETE FROM kv WHERE scope = ? AND id = ?');
    stmt.run([scope, String(id)]);
    stmt.free();
  }

  listRecent(scope, limit = 200) {
    const safeLimit = Math.max(1, Math.min(2000, Number(limit) || 200));
    const stmt = this.db.prepare('SELECT data FROM kv WHERE scope = ? ORDER BY updated_at DESC LIMIT ?');
    stmt.bind([scope, safeLimit]);
    const rows = [];
    while (stmt.step()) rows.push(JSON.parse(stmt.getAsObject().data));
    stmt.free();
    return rows;
  }

  upsertUser(user) {
    const id = String(user.mid || user.name || user.id || 'unknown-user');
    const current = this.get('users', id) || {};
    const next = { ...current, ...user, id };
    this.set('users', id, next);
    this.save();
    return next;
  }

  upsertCollection(collection) {
    const current = this.get('collections', collection.id) || {};
    const next = { ...current, ...collection };
    this.set('collections', collection.id, next);
    this.save();
    return next;
  }

  upsertVideo(video) {
    const current = this.get('videos', video.key) || {};
    this.set('videos', video.key, { ...current, ...video });
  }

  upsertTask(task) {
    const current = this.get('tasks', task.id) || {};
    this.set('tasks', task.id, {
      enabled: current.enabled !== false,
      ...current,
      ...task,
      enabled: task.enabled === undefined ? current.enabled !== false : Boolean(task.enabled)
    });
  }

  updateTasksEnabled(ids, enabled) {
    const changed = [];
    const now = new Date().toISOString();
    for (const id of [...new Set((ids || []).map(String))]) {
      const task = this.getTask(id);
      if (!task) continue;
      if (enabled && task.unsupportedVideo) continue;
      task.enabled = Boolean(enabled);
      task.updatedAt = now;
      this.upsertTask(task);
      changed.push(task);
    }
    this.save();
    return changed;
  }

  updateTool(id, patch) {
    const current = this.get('tools', id);
    if (!current) throw new Error(`Tool not found: ${id}`);
    const next = { ...current, ...patch, id, updatedAt: new Date().toISOString() };
    this.set('tools', id, next);
    this.save();
    return next;
  }

  createToolRun(run) {
    this.set('toolRuns', run.id, run);
    this.save();
    return run;
  }

  updateToolRun(id, patch) {
    const current = this.get('toolRuns', id);
    if (!current) throw new Error(`Tool run not found: ${id}`);
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.set('toolRuns', id, next);
    this.save();
    return next;
  }

  getToolRun(id) {
    return this.get('toolRuns', id);
  }

  listToolRuns(filter = {}) {
    return this.list('toolRuns')
      .filter((run) => !filter.taskId || run.taskId === filter.taskId)
      .filter((run) => !filter.status || run.status === filter.status)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }

  commit() {
    this.save();
  }

  listCollections() {
    return this.list('collections').sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
  }

  listVideoCacheCollections() {
    return this.listCollections().filter((collection) => collection.collectionKind === 'video-cache');
  }

  upsertVideoCache(record) {
    const current = this.get('videoCaches', record.id) || {};
    const next = { ...current, ...record, id: String(record.id) };
    this.set('videoCaches', next.id, next);
    this.save();
    return next;
  }

  getVideoCache(id) {
    return this.get('videoCaches', id);
  }

  listVideoCaches(filter = {}) {
    return this.list('videoCaches')
      .filter((item) => !filter.collectionId || item.collectionId === filter.collectionId)
      .sort((a, b) => String(b.downloadedAt || b.createdAt || '').localeCompare(String(a.downloadedAt || a.createdAt || '')));
  }

  deleteVideoCache(id) {
    const current = this.getVideoCache(id);
    if (!current) return null;
    this.delete('videoCaches', id);
    this.save();
    return current;
  }

  upsertVideoCacheJob(job) {
    const current = this.get('videoCacheJobs', job.id) || {};
    const next = { ...current, ...job, id: String(job.id) };
    this.set('videoCacheJobs', next.id, next);
    this.save();
    return next;
  }

  getVideoCacheJob(id) {
    return this.get('videoCacheJobs', id);
  }

  listVideoCacheJobs() {
    return this.list('videoCacheJobs').sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }

  deleteVideoCacheJobsForCollection(collectionId) {
    const jobs = this.listVideoCacheJobs().filter((item) => item.collectionId === String(collectionId || ''));
    for (const job of jobs) this.delete('videoCacheJobs', job.id);
    if (jobs.length) this.save();
    return jobs;
  }

  deleteVideoCacheCollection(id) {
    const collection = this.getCollectionById(id);
    if (!collection) return null;
    if (collection.protected) throw new Error('默认内置视频缓存收藏夹不能删除。');
    this.delete('collections', id);
    this.save();
    return collection;
  }

  listTasks(filter = {}) {
    return this.list('tasks')
      .filter((task) => !filter.collectionId || task.collectionId === filter.collectionId)
      .filter((task) => !filter.status || task.status === filter.status)
      .sort((a, b) => {
        const aFavorite = Date.parse(a.favoriteAddedAt || a.createdAt || '') || 0;
        const bFavorite = Date.parse(b.favoriteAddedAt || b.createdAt || '') || 0;
        return bFavorite - aFavorite || String(a.title || a.bvid || '').localeCompare(String(b.title || b.bvid || ''), 'zh-Hans-CN');
      });
  }

  listTools(filter = {}) {
    return this.list('tools')
      .filter((tool) => filter.enabled === undefined || Boolean(tool.enabled) === Boolean(filter.enabled))
      .sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
  }

  getTask(id) {
    return this.get('tasks', id);
  }

  registerWorker({ tool, model, sessionLabel = '', metadata = {} }) {
    const workerTool = String(tool || '').trim();
    const workerModel = String(model || '').trim();
    if (!workerTool) throw new Error('tool is required. Examples: codex, claude-code, cursor.');
    if (!workerModel) throw new Error('model is required.');
    const now = new Date().toISOString();
    const id = `worker-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const worker = {
      id,
      tool: workerTool.slice(0, 80),
      model: workerModel.slice(0, 120),
      sessionLabel: String(sessionLabel || '').trim().slice(0, 120),
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      pausedAt: '',
      pauseReason: ''
    };
    this.set('workers', id, worker);
    this.save();
    return worker;
  }

  getWorker(id) {
    return this.get('workers', id);
  }

  listWorkers() {
    return this.list('workers').sort((a, b) => String(b.lastSeenAt || b.createdAt || '').localeCompare(String(a.lastSeenAt || a.createdAt || '')));
  }

  touchWorker(id) {
    const worker = this.getWorker(id);
    if (!worker) throw new Error(`Unknown workerId: ${id}. Register this agent session first.`);
    const next = { ...worker, lastSeenAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.set('workers', id, next);
    this.save();
    return next;
  }

  updateWorker(id, patch = {}) {
    const worker = this.getWorker(id);
    if (!worker) throw new Error(`Unknown workerId: ${id}`);
    const status = patch.status === undefined ? worker.status : String(patch.status);
    if (!['active', 'paused'].includes(status)) throw new Error('Worker status must be active or paused.');
    const now = new Date().toISOString();
    const next = {
      ...worker,
      status,
      pauseReason: status === 'paused' ? String(patch.pauseReason || worker.pauseReason || 'Paused by user.').slice(0, 500) : '',
      pausedAt: status === 'paused' ? (worker.pausedAt || now) : '',
      updatedAt: now
    };
    this.set('workers', id, next);
    this.save();
    return next;
  }

  getCollectionByName(name) {
    return this.list('collections').find((item) => item.name === name || item.id === name) || null;
  }

  findCollection(identifier, userName = '') {
    const matches = this.list('collections').filter((item) => {
      const matchesCollection = item.id === identifier || item.name === identifier || String(item.mediaId || '') === String(identifier || '');
      const matchesUser = !userName || item.userName === userName || String(item.userId || '') === String(userName);
      return matchesCollection && matchesUser;
    });
    if (matches.length > 1) throw new Error(`Collection name is ambiguous; provide collectionId or userName: ${identifier}`);
    return matches[0] || null;
  }

  getCollectionById(id) {
    return this.get('collections', id);
  }

  getFilenameMetadata() {
    return normalizeFilenameMetadata(this.get('settings', 'filenameMetadata') || {}, DEFAULT_FILENAME_METADATA);
  }

  setFilenameMetadata(value = {}) {
    const next = {
      id: 'filenameMetadata',
      ...normalizeFilenameMetadata(value, this.getFilenameMetadata()),
      updatedAt: new Date().toISOString()
    };
    this.set('settings', next.id, next);
    this.save();
    return this.getFilenameMetadata();
  }

  recordSubmission(taskId, submission) {
    const id = `${taskId}:${Date.now()}`;
    const record = { id, taskId, ...submission };
    this.set('submissions', id, record);
    this.save();
    return record;
  }

  recordTaskEvent(taskId, type, data = {}) {
    const now = new Date().toISOString();
    const id = `${now}:${taskId}:${type}:${Math.random().toString(16).slice(2, 8)}`;
    const event = { id, taskId, type, createdAt: now, ...data };
    this.set('taskEvents', id, event);
    this.save();
    return event;
  }

  recordActivity(event = {}) {
    const now = new Date().toISOString();
    const id = `${now}:${Math.random().toString(16).slice(2, 10)}`;
    const record = { id, createdAt: now, ...event };
    this.set('activities', id, record);
    this.save();
    return record;
  }

  initDefaultWorkspace() {
    const workspaces = this.list('workspaces');
    if (!workspaces.length) {
      const now = new Date().toISOString();
      this.set('workspaces', 'default', {
        id: 'default',
        name: '默认工作库',
        root: WORKSPACE_ROOT,
        isDefault: true,
        createdAt: now,
        updatedAt: now
      });
      return;
    }
    if (!workspaces.some((item) => item.isDefault)) {
      const first = workspaces[0];
      this.set('workspaces', first.id, { ...first, isDefault: true, updatedAt: new Date().toISOString() });
    }
  }

  listWorkspaces() {
    return this.list('workspaces').sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)) || String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
  }

  getDefaultWorkspace() {
    return this.listWorkspaces().find((item) => item.isDefault) || null;
  }

  addWorkspace({ name, root }) {
    const rawRoot = String(root || '').trim();
    if (!rawRoot) throw new Error('Workspace root is required.');
    const resolvedRoot = path.resolve(rawRoot);
    ensureDir(resolvedRoot);
    const duplicate = this.listWorkspaces().find((item) => path.resolve(item.root).toLowerCase() === resolvedRoot.toLowerCase());
    if (duplicate) return duplicate;
    const now = new Date().toISOString();
    const id = `workspace-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
    const record = {
      id,
      name: String(name || path.basename(resolvedRoot) || '工作库').trim(),
      root: resolvedRoot,
      isDefault: false,
      createdAt: now,
      updatedAt: now
    };
    this.set('workspaces', id, record);
    this.save();
    return record;
  }

  setDefaultWorkspace(id) {
    const wanted = this.get('workspaces', id);
    if (!wanted) throw new Error(`Workspace not found: ${id}`);
    const now = new Date().toISOString();
    for (const workspace of this.listWorkspaces()) {
      this.set('workspaces', workspace.id, { ...workspace, isDefault: workspace.id === id, updatedAt: now });
    }
    this.save();
    return this.get('workspaces', id);
  }

  removeWorkspace(id) {
    const workspace = this.get('workspaces', id);
    if (!workspace) return null;
    if (workspace.isDefault) throw new Error('Default workspace cannot be removed. Set another default first.');
    const referencedCollection = this.listCollections().find((item) => item.workspaceId === workspace.id);
    const referencedTask = this.listTasks().find((item) => item.workspaceId === workspace.id);
    const referencedCache = this.listVideoCaches().find((item) => item.workspaceId === workspace.id || isPathInside(workspace.root, item.artifactDir));
    const referencedCacheJob = this.listVideoCacheJobs().find((item) => isPathInside(workspace.root, item.outputRoot));
    const workspaceRoot = path.resolve(workspace.root);
    const referencedSession = this.list('ragSessions').find((item) => isPathInside(workspaceRoot, item.sandboxDir));
    if (referencedCollection || referencedTask || referencedCache || referencedCacheJob || referencedSession) {
      throw new Error('Workspace is still referenced by a collection, task, document, cache, or RAG sandbox and cannot be removed.');
    }
    this.db.run('DELETE FROM kv WHERE scope = ? AND id = ?', ['workspaces', String(id)]);
    this.save();
    return workspace;
  }

  migrateLegacyTasks() {
    let changed = false;
    for (const task of this.list('tasks')) {
      if (task.enabled !== undefined) continue;
      this.set('tasks', task.id, { ...task, enabled: true });
      changed = true;
    }
    return changed;
  }

  migrateCompletedTaskMetadata() {
    let changed = false;
    for (const task of this.list('tasks')) {
      if (Array.isArray(task.tags) || !task.metadataFile || !fs.existsSync(task.metadataFile)) continue;
      try {
        const metadata = JSON.parse(fs.readFileSync(task.metadataFile, 'utf8'));
        this.set('tasks', task.id, { ...task, tags: normalizeTags(metadata.tags) });
        changed = true;
      } catch {
        // A malformed legacy metadata file stays visible; it can be refreshed by a later agent run.
      }
    }
    return changed;
  }

  initDefaultTools() {
    for (const tool of defaultTools()) {
      const existing = this.get('tools', tool.id);
      this.set('tools', tool.id, {
        ...tool,
        enabled: existing?.enabled ?? tool.enabled,
        updatedAt: existing?.updatedAt || new Date().toISOString()
      });
    }
  }
}

function isPathInside(root, candidate) {
  if (!candidate) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function defaultTools() {
  return [
    {
      id: 'video-info',
      action: 'info',
      name: '视频元数据读取',
      category: 'metadata',
      enabled: true,
      order: 10,
      description: '读取单个 Bilibili 视频的完整属性，生成 info.json。',
      apiUsage: 'app://tools/video-info (internal workflow only)',
      internalCommand: 'node tools/video-tool.js info <videoUrl> --out <artifactDir> --cookies <cookieFile>',
      agentPrompt: '通过工具运行 API 调用本模块。成功后检查 artifactDir/info.json，并把关键元数据用于 Markdown。',
      outputs: ['info.json'],
      projects: [
        { name: 'yt-dlp', url: 'https://github.com/yt-dlp/yt-dlp', role: '视频站点元数据与下载能力' },
        { name: 'Bilibili Web API', url: 'https://api.bilibili.com', role: '补充 B 站视频属性' }
      ]
    },
    {
      id: 'material-bundle',
      action: 'bundle',
      name: '一键素材包',
      category: 'bundle',
      enabled: true,
      order: 20,
      description: '一次性准备总结素材：元数据、站内字幕、合轨视频、关键帧、ASR 字幕、热评前三条和 manifest。',
      apiUsage: 'app://tools/material-bundle (internal workflow only)',
      internalCommand: 'node tools/video-tool.js bundle <videoUrl> --out <artifactDir> --cookies <cookieFile> --frames 12 --asr --comments --comment-limit 3',
      agentPrompt: '通过工具运行 API 优先调用本模块。ASR 完成后优先读取 asr/transcript.srt 或 asr/asr-result.json 的真实起止时间，不要根据纯文本顺序猜测视频位置。若 asr-result.json 标记 noAudioStream=true，表示源视频没有音轨，应使用站内字幕与关键帧继续总结。失败时查看 run.log，再拆分调用其它模块。',
      outputs: ['manifest.json', 'info.json', 'subtitles/', 'merged.mp4', 'frames/', 'asr/transcript.srt', 'asr/asr-transcript.txt', 'asr/asr-result.json', 'comments/comments.json'],
      projects: [
        { name: 'yt-dlp', url: 'https://github.com/yt-dlp/yt-dlp', role: '下载视频/字幕/元数据' },
        { name: 'FFmpeg', url: 'https://ffmpeg.org/', github: 'https://github.com/FFmpeg/FFmpeg', role: '合轨、抽帧、音频处理' },
        { name: 'faster-whisper', url: 'https://github.com/SYSTRAN/faster-whisper', role: '本地语音转文字' }
      ]
    },
    {
      id: 'merged-video',
      action: 'merged',
      name: '合轨视频下载',
      category: 'media',
      enabled: true,
      order: 30,
      description: '下载并生成可播放的合轨 mp4，供多模态检查、字幕校验或关键帧抽取使用。',
      apiUsage: 'app://tools/merged-video (internal workflow only)',
      internalCommand: 'node tools/video-tool.js merged <videoUrl> --out <artifactDir> --cookies <cookieFile> --height 720',
      agentPrompt: '通过工具运行 API 调用。完成 Markdown 后再调用 clean-cache 清理临时音视频。',
      outputs: ['merged.mp4'],
      projects: [
        { name: 'yt-dlp', url: 'https://github.com/yt-dlp/yt-dlp', role: '下载视频/音频流' },
        { name: 'FFmpeg', url: 'https://ffmpeg.org/', github: 'https://github.com/FFmpeg/FFmpeg', role: '音视频合轨' }
      ]
    },
    {
      id: 'asr',
      action: 'asr',
      name: '语音转字幕 ASR',
      category: 'transcript',
      enabled: true,
      order: 40,
      description: '不管是否存在官方字幕，都检查并运行一次多语言 ASR；有音轨时生成带真实分段起止时间的 SRT、时间轴文本和 JSON，无音轨时生成明确的空诊断，供 Agent 改用字幕与关键帧。',
      apiUsage: 'app://tools/asr (internal workflow only)',
      internalCommand: 'node tools/video-tool.js asr <videoUrl> --out <artifactDir> --cookies <cookieFile>',
      agentPrompt: '必须通过工具运行 API 调用，并在 Markdown 的“字幕比对”章节说明采用哪份字幕。默认自动检测中文、英文、日语等语言；优先读取 asr/transcript.srt，也要检查 asr/asr-result.json 的 language、languageProbability、diagnostics 与 start/end。若 noAudioStream=true，应明确说明视频没有音轨并改用站内字幕、关键帧和多模态画面，不得猜测内容位置。',
      outputs: ['asr/transcript.srt', 'asr/asr-transcript.txt', 'asr/asr-result.json'],
      projects: [
        { name: 'faster-whisper', url: 'https://github.com/SYSTRAN/faster-whisper', role: '本地 Whisper ASR' },
        { name: 'FFmpeg', url: 'https://ffmpeg.org/', github: 'https://github.com/FFmpeg/FFmpeg', role: '音频抽取' }
      ]
    },
    {
      id: 'bili-subtitles',
      action: 'subtitles',
      name: 'B站字幕提取',
      category: 'transcript',
      enabled: true,
      order: 45,
      description: '读取视频各分 P 的站内人工/自动字幕，输出索引、原始 JSON、SRT 和纯文本；没有字幕时也写入明确的空索引。',
      apiUsage: 'app://tools/bili-subtitles (internal workflow only)',
      internalCommand: 'node tools/video-tool.js subtitles <videoUrl> --out <artifactDir> --cookies <cookieFile>',
      agentPrompt: '通过工具运行 API 调用，并将站内字幕与本次 ASR 字幕比较；index.json 的 available=false 表示站内未提供字幕。',
      outputs: ['subtitles/index.json', 'subtitles/*.json', 'subtitles/*.srt', 'subtitles/*.txt'],
      projects: [
        { name: 'Bilibili Web API', url: 'https://api.bilibili.com', role: '播放器字幕清单与字幕正文' }
      ]
    },
    {
      id: 'comments-top3',
      action: 'comments',
      name: '热评前三条',
      category: 'comments',
      enabled: true,
      order: 50,
      description: '获取热评前三条，供最终 Markdown 的评论分析栏目使用。',
      apiUsage: 'app://tools/comments-top3 (internal workflow only)',
      internalCommand: 'node tools/video-tool.js comments <videoUrl> --out <artifactDir> --cookies <cookieFile> --comment-limit 3',
      agentPrompt: '通过工具运行 API 调用。只需要分析热评前三条；不可用时在评论分析栏目说明原因。',
      outputs: ['comments/comments.json'],
      projects: [
        { name: 'Bilibili Web API', url: 'https://api.bilibili.com', role: '评论读取' }
      ]
    },
    {
      id: 'clean-cache',
      action: 'clean-cache',
      name: '清理视频缓存',
      category: 'cleanup',
      enabled: true,
      order: 60,
      description: '删除临时视频/音频缓存，保留 Markdown、图片、字幕、评论和 JSON 记录。',
      apiUsage: 'app://tools/clean-cache (internal workflow only)',
      internalCommand: 'node tools/video-tool.js clean-cache <artifactDir>',
      agentPrompt: '提交前确认最终产物完整，再通过工具运行 API 调用本模块。',
      outputs: ['removed media cache list'],
      projects: [
        { name: 'Local file manager', role: '本地缓存清理' }
      ]
    }
  ];
}

module.exports = { Store, defaultTools };
