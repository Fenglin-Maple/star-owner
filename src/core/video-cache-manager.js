const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { isLoginRequiredMessage, isVideoUnavailableMessage, unsupportedVideoError } = require('./media-errors');
const { assertBilibiliUrl } = require('./network-policy');
const { inspectVideoSupport, unsupportedBilibiliUrlReason } = require('./video-support');
const { assertInside, collectionDirs, ensureDir, normalizeTags, safeName } = require('./workspace');

const CACHE_USER_ID = 'builtin-agent-user';
const CACHE_USER_NAME = '内置用户';
const DEFAULT_CACHE_COLLECTION_ID = 'builtin-video-cache:default';
const DEFAULT_CACHE_COLLECTION_NAME = '内置视频缓存';
const TERMINAL_RUNS = new Set(['succeeded', 'failed', 'cancelled', 'timeout', 'skipped']);
const ACTIVE_CACHE_JOBS = new Set(['queued', 'running', 'waiting-login']);

class VideoCacheManager {
  constructor({ store, toolRunner, bili, getCurrentUser, emit, fetchImpl, maxConcurrent = 3, pollMs = 250 }) {
    this.store = store;
    this.toolRunner = toolRunner;
    this.bili = bili;
    this.getCurrentUser = getCurrentUser || (() => null);
    this.emit = emit || (() => {});
    this.fetch = fetchImpl || global.fetch;
    this.maxConcurrent = Math.max(1, Math.min(4, Number(maxConcurrent) || 3));
    this.pollMs = Math.max(25, Number(pollMs) || 250);
    this.running = new Map();
    this.stopped = false;
    this.ensureDefaultCollection();
  }

  initialize() {
    this.stopped = false;
    for (const job of this.store.listVideoCacheJobs()) {
      if (['running', 'queued'].includes(job.status)) {
        const run = job.currentRunId ? this.store.getToolRun(job.currentRunId) : null;
        if (run && ['queued', 'running'].includes(run.status)) {
          try { this.toolRunner.cancel(run.id); } catch {}
        }
        this.store.upsertVideoCacheJob({ ...job, status: 'queued', phase: '等待恢复', currentRunId: '', updatedAt: new Date().toISOString() });
      }
    }
    this.dispatch();
    return this.state();
  }

  shutdown() {
    this.stopped = true;
  }

  ensureDefaultCollection() {
    this.store.upsertUser({ id: CACHE_USER_ID, mid: CACHE_USER_ID, name: CACHE_USER_NAME, internal: true });
    const existing = this.store.getCollectionById(DEFAULT_CACHE_COLLECTION_ID);
    if (existing) {
      if (!existing.protected || existing.collectionKind !== 'video-cache') {
        this.store.upsertCollection({ ...existing, protected: true, collectionKind: 'video-cache', internal: true });
      }
      return this.store.getCollectionById(DEFAULT_CACHE_COLLECTION_ID);
    }
    return this.createCollection(DEFAULT_CACHE_COLLECTION_NAME, { id: DEFAULT_CACHE_COLLECTION_ID, protected: true });
  }

  createCollection(name, options = {}) {
    const collectionName = String(name || '').trim();
    if (!collectionName) throw new Error('缓存视频收藏夹名称不能为空。');
    const duplicate = this.store.listVideoCacheCollections().find((item) => item.name === collectionName);
    if (duplicate) return duplicate;
    const workspace = this.requireWorkspace();
    const dirs = collectionDirs(workspace.root, CACHE_USER_NAME, collectionName);
    const cacheRoot = ensureDir(path.join(dirs.root, '视频缓存'));
    const now = new Date().toISOString();
    return this.store.upsertCollection({
      id: options.id || `builtin-video-cache:${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      userId: CACHE_USER_ID,
      userName: CACHE_USER_NAME,
      name: collectionName,
      label: 'video-cache',
      internal: true,
      collectionKind: 'video-cache',
      protected: Boolean(options.protected),
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      collectionRoot: dirs.root,
      cacheRoot,
      videosDir: cacheRoot,
      exportDir: dirs.exports,
      videoCount: 0,
      createdAt: now,
      updatedAt: now
    });
  }

  async submit({ inputs, collectionId } = {}) {
    const collection = this.requireCacheCollection(collectionId);
    const parsed = parseInputs(inputs);
    const rawItems = parsed.valid;
    if (!rawItems.length) throw new Error('请至少输入一个 BV 号或 Bilibili 视频链接。');
    const targetRoot = ensureDir(collection.cacheRoot);
    const jobs = [];
    const seen = new Set();
    const resolvedItems = [];
    for (const rawInput of rawItems) {
      const bvid = await resolveBvid(rawInput, this.fetch);
      if (seen.has(bvid)) continue;
      seen.add(bvid);
      const task = this.store.getTask(`cache-task:${collection.id}:${bvid}`);
      if (task && ['claimed', 'rejected'].includes(task.status) && (task.workId || task.claimedBy)) {
        throw new Error(`视频 ${bvid} 正在被 Agent 处理，不能同时重新下载缓存。`);
      }
      resolvedItems.push({ rawInput, bvid });
    }
    for (const { rawInput, bvid } of resolvedItems) {
      const activeJob = this.store.listVideoCacheJobs().find((item) => item.collectionId === collection.id && item.bvid === bvid && ACTIVE_CACHE_JOBS.has(item.status));
      if (activeJob) {
        jobs.push(activeJob);
        continue;
      }
      const existing = this.store.listVideoCaches({ collectionId: collection.id }).find((item) => item.bvid === bvid);
      const existingFile = existing?.videoFile && fs.existsSync(existing.videoFile);
      const now = new Date().toISOString();
      const job = this.store.upsertVideoCacheJob({
        id: `cache-job-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
        collectionId: collection.id,
        input: rawInput,
        bvid,
        status: existingFile ? 'completed' : 'queued',
        phase: existingFile ? '缓存已存在' : '等待下载',
        progress: existingFile ? 1 : 0,
        outputRoot: targetRoot,
        cacheId: existingFile ? existing.id : '',
        publicAttempt: true,
        currentRunId: '',
        error: '',
        createdAt: now,
        updatedAt: now,
        completedAt: existingFile ? now : ''
      });
      jobs.push(job);
    }
    this.emitState('video-cache-jobs-submitted', { count: jobs.length, collectionId: collection.id });
    this.dispatch();
    return { jobs, invalidInputs: parsed.invalid, state: this.state() };
  }

  async resumeWaitingForLogin() {
    const user = this.getCurrentUser();
    if (!user?.isLogin) throw new Error('请先完成 Bilibili 登录。');
    const cookieFile = await this.bili.exportCookies(user.name || String(user.mid));
    let resumed = 0;
    const affectedCollections = new Set();
    for (const job of this.store.listVideoCacheJobs()) {
      if (job.status !== 'waiting-login') continue;
      this.store.upsertVideoCacheJob({ ...job, status: 'queued', phase: '已同步登录状态，等待重试', publicAttempt: false, cookieFile, error: '', updatedAt: new Date().toISOString() });
      affectedCollections.add(job.collectionId);
      resumed += 1;
    }
    for (const collectionId of affectedCollections) {
      const collection = this.store.getCollectionById(collectionId);
      if (collection) this.store.upsertCollection({ ...collection, cookieFile, cookieExportedAt: new Date().toISOString() });
    }
    this.emitState('video-cache-login-resumed', { resumed });
    this.dispatch();
    return { resumed, state: this.state() };
  }

  state() {
    const collections = this.store.listVideoCacheCollections().map((collection) => {
      const { cookieFile, ...safeCollection } = collection;
      return {
      ...safeCollection,
      videoCount: this.store.listVideoCaches({ collectionId: collection.id }).length
      };
    });
    const videos = this.store.listVideoCaches().map((record) => {
      const task = record.taskId ? this.store.getTask(record.taskId) : null;
      const videoExists = Boolean(record.videoFile && fs.existsSync(record.videoFile));
      return {
        ...record,
        cover: resolveCoverUrl(record, task),
        fileExists: videoExists,
        playbackUrl: videoExists ? pathToFileURL(record.videoFile).href : ''
      };
    });
    const jobs = this.store.listVideoCacheJobs().slice(0, 300).map((job) => {
      const { cookieFile, ...safeJob } = job;
      const run = job.currentRunId ? this.store.getToolRun(job.currentRunId) : null;
      const download = run?.downloadProgress || null;
      return {
        ...safeJob,
        progress: download ? Math.max(Number(job.progress || 0), 0.28 + Number(download.progress || 0) * 0.66) : Number(job.progress || 0),
        queuePosition: run?.queuePosition ?? null,
        queueReason: run?.queueReason || '',
        speed: download?.speed || '',
        eta: download?.eta || ''
      };
    });
    return { collections, videos, jobs, defaultCollectionId: DEFAULT_CACHE_COLLECTION_ID, running: this.running.size, maxConcurrent: this.maxConcurrent };
  }

  deleteVideos(ids = []) {
    const records = [...new Set(ids.map(String))].map((id) => this.store.getVideoCache(id)).filter(Boolean);
    const activeDownloads = this.store.listVideoCacheJobs().filter((job) => ACTIVE_CACHE_JOBS.has(job.status)
      && records.some((record) => record.collectionId === job.collectionId && record.bvid === job.bvid));
    if (activeDownloads.length) {
      throw new Error(`有 ${activeDownloads.length} 个所选视频仍在下载或等待登录，请等待下载任务结束后再删除缓存。`);
    }
    const active = records.map((record) => record.taskId ? this.store.getTask(record.taskId) : null)
      .find((task) => task && ['claimed', 'rejected'].includes(task.status) && (task.workId || task.claimedBy));
    if (active) throw new Error(`视频 ${active.bvid || active.id} 正在被 Agent 处理，请先停止对应工作流再删除缓存。`);
    const deleted = [];
    const preservedDocuments = [];
    for (const record of records) {
      const task = record.taskId ? this.store.getTask(record.taskId) : null;
      if (task?.status === 'done' && task.outputMarkdown && fs.existsSync(task.outputMarkdown)) {
        this.removeCachedVideoOnly(record);
        this.store.upsertTask({
          ...task,
          cachedVideoId: '',
          cachedVideoFile: '',
          reuseCachedMedia: false,
          keepVideoCache: false,
          updatedAt: new Date().toISOString()
        });
        preservedDocuments.push(task.id);
      } else {
        this.safeRemoveArtifact(record);
        if (record.taskId) this.store.delete('tasks', record.taskId);
      }
      this.store.deleteVideoCache(record.id);
      deleted.push(record.id);
    }
    this.refreshCollectionCounts();
    this.store.commit();
    this.emitState('video-cache-videos-deleted', { ids: deleted, preservedDocuments });
    return { deleted, preservedDocuments, state: this.state() };
  }

  deleteCollection(id) {
    const collection = this.requireCacheCollection(id);
    if (collection.protected) throw new Error('默认内置视频缓存收藏夹必须保留，不能删除。');
    const activeJobs = this.store.listVideoCacheJobs().filter((job) => job.collectionId === collection.id && ACTIVE_CACHE_JOBS.has(job.status));
    if (activeJobs.length) throw new Error(`该缓存收藏夹仍有 ${activeJobs.length} 个下载任务，请等待完成或失败后再删除。`);
    const activeTask = this.store.listTasks({ collectionId: collection.id }).find((task) => ['claimed', 'rejected'].includes(task.status) && (task.workId || task.claimedBy));
    if (activeTask) throw new Error(`Video ${activeTask.bvid || activeTask.id} is being processed by an Agent. Stop that workflow before deleting the cache collection.`);
    const records = this.store.listVideoCaches({ collectionId: collection.id });
    this.deleteVideos(records.map((item) => item.id));
    this.store.deleteVideoCacheJobsForCollection(collection.id);
    for (const task of this.store.listTasks({ collectionId: collection.id })) {
      if (task.status === 'done' && task.outputMarkdown && fs.existsSync(task.outputMarkdown)) continue;
      this.safeRemoveTaskArtifact(task, collection);
      this.store.delete('tasks', task.id);
      this.store.delete('videos', task.id);
    }
    this.store.commit();
    const preservedTasks = this.store.listTasks({ collectionId: collection.id }).filter((task) => task.status === 'done' && task.outputMarkdown && fs.existsSync(task.outputMarkdown));
    if (preservedTasks.length) {
      const archived = this.store.upsertCollection({
        ...collection,
        name: this.uniqueArchivedCollectionName(`${collection.name}（缓存已删除）`, collection.id),
        collectionKind: 'document-archive',
        cacheRoot: '',
        videosDir: collection.collectionRoot,
        protected: false,
        videoCount: preservedTasks.length,
        archivedFromVideoCache: true,
        updatedAt: new Date().toISOString()
      });
      this.ensureDefaultCollection();
      this.emitState('video-cache-collection-archived', { collectionId: collection.id, archivedCollectionId: archived.id, preservedDocuments: preservedTasks.length });
      return this.state();
    }
    if (collection.cacheRoot && fs.existsSync(collection.cacheRoot)) {
      const root = assertInside(collection.collectionRoot, collection.cacheRoot);
      if (root !== path.resolve(collection.collectionRoot)) fs.rmSync(root, { recursive: true, force: true });
    }
    this.store.deleteVideoCacheCollection(collection.id);
    this.ensureDefaultCollection();
    this.emitState('video-cache-collection-deleted', { collectionId: collection.id });
    return this.state();
  }

  async runJob(jobId) {
    let job = this.store.getVideoCacheJob(jobId);
    if (!job || job.status !== 'queued') return;
    const collection = this.requireCacheCollection(job.collectionId);
    const baseDir = ensureDir(path.join(job.outputRoot, safeName(`[BV-${job.bvid}]`, job.bvid, 120)));
    const now = new Date().toISOString();
    const taskId = `cache-task:${collection.id}:${job.bvid}`;
    let task = this.store.getTask(taskId) || {};
    const acceptedDocument = captureAcceptedDocument(task);
    task = {
      ...task,
      id: taskId,
      collectionId: collection.id,
      bvid: job.bvid,
      title: task.title || job.bvid,
      owner: task.owner || '',
      duration: Number(task.duration || 0),
      tags: task.tags || [],
      url: `https://www.bilibili.com/video/${job.bvid}`,
      favoriteAddedAt: task.favoriteAddedAt || job.createdAt,
      status: task.status === 'done' ? 'done' : 'pending',
      enabled: false,
      claimedBy: '',
      workspaceId: collection.workspaceId,
      workspaceRoot: collection.workspaceRoot,
      allowedRoot: job.outputRoot,
      artifactDir: baseDir,
      cachedVideoId: task.cachedVideoId || '',
      reuseCachedMedia: true,
      internal: true,
      createdAt: task.createdAt || now,
      updatedAt: now
    };
    this.store.upsertTask(task);
    this.store.commit();
    job = this.updateJob(job, { status: 'running', phase: '读取公开元数据', progress: 0.06, error: '' });
    try {
      const runCollection = { ...collection, cookieFile: job.publicAttempt ? '' : job.cookieFile };
      const infoRun = this.toolRunner.start({ task, tool: this.store.get('tools', 'video-info'), collection: runCollection, workerId: 'video-cache-manager', options: { timeoutMs: 30 * 60 * 1000 } });
      job = this.updateJob(job, { currentRunId: infoRun.id, phase: '读取视频元数据', progress: 0.1 });
      await this.waitForRun(infoRun.id);
      const info = readJson(path.join(baseDir, 'info.json'));
      const support = inspectVideoSupport(info);
      if (!support.supported) throw unsupportedVideoError(support.reason, support.kind);
      const metadata = normalizeInfo(info, job.bvid, baseDir);
      Object.assign(task, metadata, { updatedAt: new Date().toISOString() });
      this.store.upsertTask(task);
      this.store.commit();
      job = this.updateJob(job, { phase: '下载并合轨视频', progress: 0.28 });
      const mediaRun = this.toolRunner.start({ task, tool: this.store.get('tools', 'merged-video'), collection: runCollection, workerId: 'video-cache-manager', options: { height: 720, timeoutMs: 12 * 60 * 60 * 1000 } });
      job = this.updateJob(job, { currentRunId: mediaRun.id });
      await this.waitForRun(mediaRun.id);
      const videoFile = findMerged(baseDir);
      if (!videoFile) throw new Error('下载完成后未找到合轨视频文件。');
      const cacheId = `cache:${collection.id}:${job.bvid}`;
      const downloadedAt = new Date().toISOString();
      const record = this.store.upsertVideoCache({
        id: cacheId,
        collectionId: collection.id,
        taskId,
        bvid: job.bvid,
        url: task.url,
        title: task.title,
        owner: task.owner,
        duration: task.duration,
        tags: task.tags,
        cover: task.cover,
        coverFile: task.coverFile || '',
        width: task.width || 0,
        height: task.height || 0,
        orientation: task.orientation || '',
        publishedAt: task.publishedAt || '',
        downloadedAt,
        artifactDir: baseDir,
        videoFile,
        metadataFile: path.join(baseDir, 'info.json'),
        allowedRoot: job.outputRoot,
        status: 'ready',
        createdAt: this.store.getVideoCache(cacheId)?.createdAt || downloadedAt,
        updatedAt: downloadedAt
      });
      Object.assign(task, { cachedVideoId: record.id, cachedVideoFile: videoFile, enabled: true, status: task.status === 'done' ? 'done' : 'pending', artifactDir: baseDir, allowedRoot: job.outputRoot, updatedAt: downloadedAt });
      restoreAcceptedDocument(task, acceptedDocument);
      this.store.upsertTask(task);
      fs.writeFileSync(path.join(baseDir, 'cache-record.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      this.refreshCollectionCounts();
      this.store.commit();
      this.updateJob(job, { status: 'completed', phase: '缓存可用', progress: 1, cacheId: record.id, currentRunId: '', completedAt: downloadedAt });
      this.emitState('video-cache-download-completed', { jobId: job.id, cacheId: record.id, collectionId: collection.id, bvid: job.bvid });
    } catch (error) {
      if (acceptedDocument) {
        restoreAcceptedDocument(task, acceptedDocument);
        this.store.upsertTask(task);
        this.store.commit();
      }
      const detail = error.message || String(error);
      if (this.stopped) {
        this.updateJob(job, { status: 'queued', phase: '应用已关闭，等待下次启动恢复', currentRunId: '', error: '', updatedAt: new Date().toISOString() }, false);
      } else if (error.code === 'UNSUPPORTED_VIDEO_TYPE') {
        if (!acceptedDocument) {
          try { this.safeRemoveTaskArtifact(task, collection); } catch {}
          Object.assign(task, {
            status: 'pending',
            enabled: false,
            workId: '',
            claimedBy: '',
            artifactDir: '',
            unsupportedVideo: true,
            unsupportedKind: error.unsupportedKind || 'unsupported-video',
            unsupportedReason: detail.slice(0, 1200),
            unsupportedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
          this.store.upsertTask(task);
          this.store.commit();
        }
        this.updateJob(job, { status: 'skipped', phase: '当前版本暂不支持该视频类型', currentRunId: '', error: detail.slice(0, 2000), finishedAt: new Date().toISOString() });
        this.emitState('video-cache-download-skipped', { jobId: job.id, bvid: job.bvid, reason: detail.slice(0, 500), unsupported: true });
      } else if (error.code === 'BILIBILI_VIDEO_UNAVAILABLE' || isVideoUnavailableMessage(detail)) {
        this.updateJob(job, { status: 'skipped', phase: '视频已删除、下架或不可用', currentRunId: '', error: detail.slice(0, 2000), finishedAt: new Date().toISOString() });
        this.emitState('video-cache-download-skipped', { jobId: job.id, bvid: job.bvid, reason: detail.slice(0, 500) });
      } else if (job.publicAttempt && isLoginRequiredMessage(detail)) {
        this.updateJob(job, { status: 'waiting-login', phase: '等待 Bilibili 登录', progress: Math.max(0.04, Number(job.progress || 0)), currentRunId: '', error: detail.slice(0, 1200) });
        this.emitState('video-cache-login-required', { jobId: job.id, bvid: job.bvid, reason: detail.slice(0, 500) });
      } else {
        this.updateJob(job, { status: 'failed', phase: '下载失败', currentRunId: '', error: detail.slice(0, 2000), finishedAt: new Date().toISOString() });
        this.emitState('video-cache-download-failed', { jobId: job.id, bvid: job.bvid, error: detail.slice(0, 500) });
      }
    }
  }

  dispatch() {
    if (this.stopped) return;
    while (this.running.size < this.maxConcurrent) {
      const job = this.store.listVideoCacheJobs().reverse().find((item) => item.status === 'queued' && !this.running.has(item.id));
      if (!job) break;
      const promise = this.runJob(job.id).catch((error) => {
        const latest = this.store.getVideoCacheJob(job.id);
        if (latest && ACTIVE_CACHE_JOBS.has(latest.status)) {
          this.updateJob(latest, { status: 'failed', phase: '下载任务异常中止', currentRunId: '', error: String(error?.message || error).slice(0, 2000), finishedAt: new Date().toISOString() });
        }
      }).finally(() => {
        this.running.delete(job.id);
        this.dispatch();
        this.emitState('video-cache-queue-updated', {});
      });
      this.running.set(job.id, promise);
    }
  }

  async waitForRun(runId) {
    let missingSince = 0;
    while (!this.stopped) {
      const run = this.store.getToolRun(runId);
      if (!run) {
        missingSince ||= Date.now();
        if (Date.now() - missingSince > 5000) throw new Error(`工具运行记录已丢失：${runId}`);
      } else {
        missingSince = 0;
      }
      if (run && TERMINAL_RUNS.has(run.status)) {
        if (run.status === 'succeeded') return run;
        const log = readTail(run.logFile, 12000);
        const error = new Error([run.error || `工具运行状态：${run.status}`, log].filter(Boolean).join('\n'));
        error.code = run.errorCode || (run.status === 'skipped' ? 'BILIBILI_VIDEO_UNAVAILABLE' : '');
        throw error;
      }
      const job = this.store.listVideoCacheJobs().find((item) => item.currentRunId === runId);
      if (job && run) {
        const stageProgress = run.downloadProgress ? 0.28 + Number(run.downloadProgress.progress || 0) * 0.66 : Number(job.progress || 0);
        const phase = run.status === 'queued' ? '等待下载资源' : (run.stage === 'complete' ? job.phase : run.stage);
        if (Math.abs(stageProgress - Number(job.progress || 0)) >= 0.01 || phase !== job.phase) {
          this.updateJob(job, { progress: Math.min(0.94, stageProgress), phase }, false);
        }
      }
      await delay(this.pollMs);
    }
    throw new Error('应用正在关闭，缓存下载已暂停。');
  }

  updateJob(job, patch, shouldEmit = true) {
    const next = this.store.upsertVideoCacheJob({ ...job, ...patch, updatedAt: new Date().toISOString() });
    if (shouldEmit) this.emitState('video-cache-job-updated', { jobId: next.id });
    return next;
  }

  refreshCollectionCounts() {
    for (const collection of this.store.listVideoCacheCollections()) {
      this.store.upsertCollection({ ...collection, videoCount: this.store.listVideoCaches({ collectionId: collection.id }).length, updatedAt: new Date().toISOString() });
    }
  }

  safeRemoveArtifact(record) {
    if (!record.artifactDir || !fs.existsSync(record.artifactDir)) return;
    const root = path.resolve(record.allowedRoot || path.dirname(record.artifactDir));
    const artifact = assertInside(root, record.artifactDir);
    if (artifact === root) throw new Error('拒绝删除缓存根目录本身。');
    fs.rmSync(artifact, { recursive: true, force: true });
  }

  safeRemoveTaskArtifact(task, collection) {
    if (!task?.artifactDir || !fs.existsSync(task.artifactDir)) return;
    const root = path.resolve(task.allowedRoot || collection.cacheRoot || collection.collectionRoot || path.dirname(task.artifactDir));
    const artifact = assertInside(root, task.artifactDir);
    if (artifact === root) throw new Error('Refusing to delete the cache collection root itself.');
    fs.rmSync(artifact, { recursive: true, force: true });
  }

  removeCachedVideoOnly(record) {
    if (!record.artifactDir) throw new Error('缓存记录缺少 artifactDir，拒绝执行文件删除。');
    const allowedRoot = path.resolve(record.allowedRoot || path.dirname(record.artifactDir));
    const artifactRoot = assertInside(allowedRoot, record.artifactDir);
    if (record.videoFile && fs.existsSync(record.videoFile)) {
      const video = assertInside(artifactRoot, record.videoFile);
      if (video !== artifactRoot) fs.rmSync(video, { force: true });
    }
    const cacheRecord = path.join(artifactRoot, 'cache-record.json');
    if (fs.existsSync(cacheRecord)) fs.rmSync(cacheRecord, { force: true });
  }

  uniqueArchivedCollectionName(baseName, currentId) {
    const names = new Set(this.store.listCollections().filter((item) => item.id !== currentId).map((item) => item.name));
    if (!names.has(baseName)) return baseName;
    let index = 2;
    while (names.has(`${baseName} (${index})`)) index += 1;
    return `${baseName} (${index})`;
  }

  requireWorkspace() {
    const workspace = this.store.getDefaultWorkspace();
    if (!workspace) throw new Error('请先在设置中指定默认 Workspace。');
    return workspace;
  }

  requireCacheCollection(id) {
    const collection = this.store.getCollectionById(String(id || ''));
    if (!collection || collection.collectionKind !== 'video-cache') throw new Error('请选择一个内置缓存视频收藏夹。');
    return collection;
  }

  emitState(type, detail) {
    this.emit({ type, ...detail, cacheState: this.state() });
  }
}

function splitInputs(value) {
  return parseInputs(value).valid;
}

function parseInputs(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[\r\n,，;；\s]+/);
  const valid = [];
  const invalid = [];
  for (const raw of source.map((item) => String(item || '').trim()).filter(Boolean)) {
    let accepted = false;
    const item = raw;
    if (/BV[0-9A-Za-z]{10}/i.test(item)) accepted = true;
    else try { assertBilibiliUrl(item); accepted = true; } catch {}
    (accepted ? valid : invalid).push(item);
  }
  return { valid, invalid };
}

async function resolveBvid(value, fetchImpl = global.fetch) {
  const inputReason = unsupportedBilibiliUrlReason(value);
  if (inputReason) throw unsupportedVideoError(inputReason, 'special-video');
  const direct = String(value || '').match(/BV[0-9A-Za-z]{10}/i)?.[0];
  if (direct) return direct;
  let url = assertBilibiliUrl(value);
  const normalizedReason = unsupportedBilibiliUrlReason(url);
  if (normalizedReason) throw unsupportedVideoError(normalizedReason, 'special-video');
  let response;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    response = await fetchImpl(url.toString(), { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 StarOwner/0.8' }, signal: AbortSignal.timeout(20000) });
    if (![301, 302, 303, 307, 308].includes(Number(response.status || 0))) break;
    const location = response.headers?.get?.('location');
    if (!location) throw new Error('Bilibili 短链接返回了无目标的重定向。');
    url = assertBilibiliUrl(new URL(location, url).toString());
    const redirectReason = unsupportedBilibiliUrlReason(url);
    if (redirectReason) throw unsupportedVideoError(redirectReason, 'special-video');
    if (redirects === 5) throw new Error('Bilibili 链接重定向次数过多。');
  }
  if (!response) throw new Error(`无法读取视频链接：${value}`);
  if (response.ok === false) throw new Error(`Bilibili 链接请求失败：HTTP ${response.status}`);
  const responseReason = unsupportedBilibiliUrlReason(response.url || url);
  if (responseReason) throw unsupportedVideoError(responseReason, 'special-video');
  const fromUrl = String(response.url || '').match(/BV[0-9A-Za-z]{10}/i)?.[0];
  if (fromUrl) return fromUrl;
  const body = await response.text();
  const fromBody = body.match(/BV[0-9A-Za-z]{10}/i)?.[0];
  if (fromBody) return fromBody;
  throw new Error(`链接中没有找到 BV 号：${value}`);
}

function normalizeInfo(info, bvid, artifactDir = '') {
  const owner = typeof info.owner === 'string' ? info.owner : (info.owner?.name || '');
  const published = Number(info.pubdate || info.timestamp || 0);
  const dimensions = normalizeDimensions(info.dimension);
  const coverFile = resolveLocalCover(artifactDir, info.coverFile);
  return {
    bvid: info.bvid || bvid,
    title: info.title || bvid,
    owner,
    ownerMid: info.owner?.mid || '',
    duration: Number(info.duration || 0),
    tags: normalizeTags(info.tags),
    cover: normalizeRemoteCover(info.pic || info.thumbnail || ''),
    coverFile,
    ...dimensions,
    publishedAt: published ? new Date(published * 1000).toISOString() : '',
    pages: info.pages || []
  };
}

function captureAcceptedDocument(task = {}) {
  if (task.status !== 'done' || !task.outputMarkdown) return null;
  return {
    status: 'done',
    enabled: task.enabled !== false,
    artifactDir: path.dirname(path.resolve(task.outputMarkdown)),
    outputMarkdown: task.outputMarkdown,
    metadataFile: task.metadataFile || '',
    coverFile: task.coverFile || '',
    completedAt: task.completedAt || '',
    workspaceId: task.workspaceId || '',
    workspaceRoot: task.workspaceRoot || '',
    allowedRoot: task.allowedRoot || ''
  };
}

function restoreAcceptedDocument(task, accepted) {
  if (!accepted) return task;
  Object.assign(task, accepted, { claimedBy: '', claimedAt: '', leaseExpiresAt: '', workId: '' });
  return task;
}

function normalizeDimensions(value) {
  let width = Math.max(0, Number(value?.width || 0));
  let height = Math.max(0, Number(value?.height || 0));
  if (Math.abs(Number(value?.rotate || 0)) % 180 === 90) [width, height] = [height, width];
  return { width, height, orientation: width && height ? (height > width ? 'portrait' : 'landscape') : '' };
}

function resolveLocalCover(artifactDir, value) {
  if (!artifactDir || !value) return '';
  try {
    const candidate = assertInside(artifactDir, path.resolve(artifactDir, String(value)));
    const stat = fs.lstatSync(candidate);
    return stat.isFile() && !stat.isSymbolicLink() && isRasterImage(candidate) ? candidate : '';
  } catch { return ''; }
}

function isRasterImage(file) {
  const buffer = fs.readFileSync(file);
  const extension = path.extname(file).toLowerCase();
  if (extension === '.png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (['.jpg', '.jpeg'].includes(extension)) return buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9;
  if (extension === '.gif') return buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'));
  if (extension === '.webp') return buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (extension === '.avif') return buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp' && /avi[fs]/.test(buffer.subarray(8, Math.min(buffer.length, 40)).toString('ascii'));
  return false;
}

function resolveCoverUrl(record, task) {
  const local = resolveLocalCover(record.artifactDir || path.dirname(record.videoFile || ''), record.coverFile || task?.coverFile);
  if (local) return pathToFileURL(local).href;
  return normalizeRemoteCover(record.cover || task?.cover || '');
}

function normalizeRemoteCover(value) {
  const source = String(value || '').trim();
  if (!source) return '';
  try {
    const url = new URL(source.startsWith('//') ? `https:${source}` : source.replace(/^http:\/\//i, 'https://'));
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    if (!['hdslb.com', 'biliimg.com', 'bilibili.com'].some((domain) => host === domain || host.endsWith(`.${domain}`))) return '';
    return url.toString();
  } catch { return ''; }
}

function findMerged(directory) {
  if (!fs.existsSync(directory)) return '';
  const name = fs.readdirSync(directory).find((item) => /^merged\.(mp4|mkv|webm)$/i.test(item));
  return name ? path.join(directory, name) : '';
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function readTail(file, length) {
  try {
    const maximum = Math.max(1000, Number(length) || 12000);
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maximum);
    const descriptor = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(descriptor, buffer, 0, buffer.length, start);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(descriptor);
    }
  } catch { return ''; }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  CACHE_USER_ID,
  CACHE_USER_NAME,
  DEFAULT_CACHE_COLLECTION_ID,
  DEFAULT_CACHE_COLLECTION_NAME,
  VideoCacheManager,
  normalizeInfo,
  resolveBvid,
  splitInputs
};
