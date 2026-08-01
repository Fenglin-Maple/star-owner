const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CACHE_USER_ID, CACHE_USER_NAME } = require('./video-cache-manager');
const { importDocument, inspectDocument, stableDocumentId } = require('./local-document-importer');
const { compressMedia, extractAudio, extractCover, inspectMedia, mediaKind, writeSubtitleFormats } = require('./local-media-runtime');
const { assertInside, collectionDirs, ensureDir, fitArtifactName, safeName } = require('./workspace');

const ACTIVE_JOB_STATUSES = new Set(['queued', 'running']);
const MAX_SELECTIONS = 20;
const MAX_SELECTED_FILES = 2000;
const MULTIMODAL_COLLECTION_KIND = 'multimodal-document';
const IMPORT_MANIFEST_NAME = '.star-owner-import.json';

class LocalToolboxManager {
  constructor({ store, toolRunner, videoCacheManager, emit }) {
    this.store = store;
    this.toolRunner = toolRunner;
    this.videoCacheManager = videoCacheManager;
    this.emit = emit || (() => {});
    this.selections = new Map();
    this.running = new Map();
    this.cancelRequested = new Set();
    this.stopped = false;
  }

  initialize() {
    this.stopped = false;
    this.recoverImportTransactions();
    const now = new Date().toISOString();
    for (const job of this.store.list('localToolJobs')) {
      if (!ACTIVE_JOB_STATUSES.has(job.status)) continue;
      this.store.set('localToolJobs', job.id, {
        ...job,
        status: 'interrupted',
        phase: '应用上次关闭时任务中断',
        error: '应用关闭或崩溃导致本地工具任务中断；已完成条目保留，未完成条目已回退。',
        items: interruptedItems(job.items, '应用上次关闭时中断'),
        updatedAt: now,
        finishedAt: now
      });
      this.cleanupJobWorkspace(job);
    }
    this.store.commit();
    return this.state();
  }

  shutdown() {
    this.stopped = true;
    for (const [jobId, active] of this.running.entries()) {
      this.cancelRequested.add(jobId);
      active.controller.abort();
      active.handle?.cancel?.();
      const job = this.store.get('localToolJobs', jobId);
      if (job && ACTIVE_JOB_STATUSES.has(job.status)) {
        this.updateJob(job, { status: 'interrupted', phase: '应用已关闭', error: '应用关闭导致任务中断；已完成条目保留。', items: interruptedItems(job.items, '应用关闭时中断'), finishedAt: new Date().toISOString() }, false);
      }
    }
    this.store.commit();
  }

  state() {
    return {
      jobs: this.store.list('localToolJobs').sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 100).map(publicJob),
      videoCollections: this.store.listVideoCacheCollections().map((item) => publicCollection(item)),
      documentCollections: this.store.listCollections().filter((item) => item.collectionKind === MULTIMODAL_COLLECTION_KIND).map((item) => publicCollection(item)),
      running: this.running.size
    };
  }

  async inspectSubtitleFile(filePath) {
    const source = path.resolve(String(filePath || ''));
    let file;
    try {
      file = await inspectMedia(source);
    } catch (error) {
      throw error;
    }
    return this.rememberSelection({
      type: 'subtitles',
      roots: [source],
      outputDirectory: path.dirname(source),
      defaultCollectionName: path.basename(path.dirname(source)),
      files: [file],
      rejected: []
    });
  }

  async inspectVideoSelection(paths) {
    const roots = normalizePaths(paths);
    const candidates = walkSelectedFiles(roots, (file) => Boolean(mediaKind(file)));
    const { accepted, rejected } = await inspectFiles(candidates, async (file) => inspectMedia(file));
    if (!accepted.length) throw new Error('没有找到 FFmpeg 可以读取的视频或音频文件。');
    const defaultCollectionName = defaultSelectionName(roots, accepted);
    return this.rememberSelection({ type: 'video-import', roots, defaultCollectionName, files: accepted, rejected });
  }

  inspectDocumentSelection(paths) {
    const roots = normalizePaths(paths);
    const candidates = walkSelectedFiles(roots, (file) => {
      try { return Boolean(inspectDocument(file)); } catch { return false; }
    });
    const accepted = [];
    const rejected = [];
    for (const file of candidates) {
      try { accepted.push(inspectDocument(file)); }
      catch (error) { rejected.push({ path: file, name: path.basename(file), error: error.message || String(error) }); }
    }
    if (!accepted.length) throw new Error('没有找到可导入的图片、PDF、Office、Markdown 或文本文件。');
    return this.rememberSelection({ type: 'document-import', roots, defaultCollectionName: defaultSelectionName(roots, accepted), files: accepted, rejected });
  }

  previewVideoImport(selectionId, input = {}) {
    const selection = this.requireSelection(selectionId, 'video-import');
    const collection = this.resolveCollection('video-cache', input);
    const records = collection ? this.store.listVideoCaches({ collectionId: collection.id }) : [];
    return {
      ...publicSelection(selection),
      collection: collection ? publicCollection(collection) : null,
      collectionName: collection?.name || normalizeCollectionName(input.collectionName || selection.defaultCollectionName),
      files: selection.files.map((file) => ({ ...publicFile(file), existing: findVideoCollision(records, file) ? publicVideoCollision(findVideoCollision(records, file)) : null }))
    };
  }

  previewDocumentImport(selectionId, input = {}) {
    const selection = this.requireSelection(selectionId, 'document-import');
    const collection = this.resolveCollection(MULTIMODAL_COLLECTION_KIND, input);
    const tasks = collection ? this.store.listTasks({ collectionId: collection.id }).filter((item) => item.sourceType === 'local-document') : [];
    return {
      ...publicSelection(selection),
      collection: collection ? publicCollection(collection) : null,
      collectionName: collection?.name || normalizeCollectionName(input.collectionName || selection.defaultCollectionName),
      files: selection.files.map((file) => ({ ...publicFile(file), existing: findDocumentCollision(tasks, file) ? publicDocumentCollision(findDocumentCollision(tasks, file)) : null }))
    };
  }

  startSubtitleJob(selectionId, formats) {
    const selection = this.requireSelection(selectionId, 'subtitles');
    const selectedFormats = [...new Set((formats || []).map((item) => String(item).toLowerCase()))];
    if (!selectedFormats.length) throw new Error('请至少选择一种字幕输出格式。');
    const job = this.createJob('subtitles', selection, {
      title: `字幕生成 · ${path.basename(selection.outputDirectory)}`,
      formats: selectedFormats,
      outputDirectories: [selection.outputDirectory]
    });
    this.runBackground(job.id, (signal) => this.runSubtitleJob(job.id, selection, selectedFormats, signal));
    return publicJob(job);
  }

  startVideoImport(selectionId, input = {}) {
    const selection = this.requireSelection(selectionId, 'video-import');
    const collection = this.requireOrCreateCollection('video-cache', input.collectionId, input.collectionName || selection.defaultCollectionName);
    const records = this.store.listVideoCaches({ collectionId: collection.id });
    const choices = normalizeChoices(input.choices);
    this.assertVideoConflictsIdle(selection.files, records, choices);
    const job = this.createJob('video-import', selection, {
      title: `本地视频/音频导入 · ${collection.name}`,
      collectionId: collection.id,
      collectionName: collection.name,
      workspaceId: collection.workspaceId,
      workspaceRoot: collection.workspaceRoot,
      choices,
      outputDirectories: [collection.cacheRoot]
    });
    this.runBackground(job.id, (signal) => this.runVideoImport(job.id, selection, collection, choices, signal));
    return publicJob(job);
  }

  startDocumentImport(selectionId, input = {}) {
    const selection = this.requireSelection(selectionId, 'document-import');
    const collection = this.requireOrCreateCollection(MULTIMODAL_COLLECTION_KIND, input.collectionId, input.collectionName || selection.defaultCollectionName);
    const choices = normalizeChoices(input.choices);
    const job = this.createJob('document-import', selection, {
      title: `多模态文档导入 · ${collection.name}`,
      collectionId: collection.id,
      collectionName: collection.name,
      workspaceId: collection.workspaceId,
      workspaceRoot: collection.workspaceRoot,
      choices,
      outputDirectories: [collection.collectionRoot]
    });
    this.runBackground(job.id, (signal) => this.runDocumentImport(job.id, selection, collection, choices, signal));
    return publicJob(job);
  }

  cancel(jobId) {
    const id = String(jobId || '');
    const job = this.store.get('localToolJobs', id);
    if (!job) throw new Error('本地工具任务不存在。');
    if (!ACTIVE_JOB_STATUSES.has(job.status)) return job;
    this.cancelRequested.add(id);
    const active = this.running.get(id);
    active?.controller.abort();
    active?.handle?.cancel?.();
    return this.updateJob(job, { status: 'cancelled', phase: '正在停止并清理当前条目', error: '', finishedAt: new Date().toISOString() });
  }

  outputDirectory(jobId) {
    const job = this.store.get('localToolJobs', String(jobId || ''));
    const directory = job?.outputDirectories?.find((item) => item && fs.existsSync(item));
    if (!directory) throw new Error('任务输出目录不存在。');
    return directory;
  }

  async runSubtitleJob(jobId, selection, formats, signal) {
    const tempRoot = this.jobWorkspace(jobId);
    let handled = 0;
    for (let index = 0; index < selection.files.length; index += 1) {
      this.assertNotCancelled(jobId, signal);
      const file = selection.files[index];
      const item = this.jobItem(jobId, file.id);
      const workDir = ensureDir(path.join(tempRoot, file.id));
      const audioFile = path.join(workDir, 'audio.wav');
      const asrDir = ensureDir(path.join(workDir, 'asr'));
      try {
        this.updateItem(jobId, file.id, { status: 'running', phase: '等待音频处理资源', progress: 0.02 });
        await this.runScheduledMedia(jobId, file.id, signal, () => extractAudio(file.path, audioFile, {
          signal,
          duration: file.duration,
          onProgress: (progress) => this.updateItemProgress(jobId, file.id, '提取 ASR 音频', progress * 0.25)
        }));
        this.updateItem(jobId, file.id, { phase: '等待 ASR 资源', progress: 0.26 });
        const asr = this.toolRunner.transcribePreparedAudio({
          id: `local-subtitle:${jobId}:${file.id}`,
          audioFile,
          outputDir: asrDir,
          workerId: `local-toolbox:${jobId}`,
          signal,
          onQueued: (queue) => this.updateItem(jobId, file.id, { phase: `等待 ASR 资源（队列 ${queue.position}）` }, false),
          onStart: () => this.updateItem(jobId, file.id, { phase: 'ASR 正在识别' }, false),
          onProgress: (progress) => this.updateItemProgress(jobId, file.id, 'ASR 正在识别', 0.26 + Number(progress.progress || 0) * 0.68)
        });
        this.setActiveHandle(jobId, asr);
        try { await asr.promise; }
        finally { this.setActiveHandle(jobId, null); }
        this.assertNotCancelled(jobId, signal);
        const outputs = writeSubtitleFormats(path.join(asrDir, 'asr-result.json'), path.dirname(file.path), file.name, formats);
        handled += 1;
        this.updateItem(jobId, file.id, { status: 'completed', phase: '字幕已写入原目录', progress: 1, outputs, completedAt: new Date().toISOString() });
        this.updateBatchProgress(jobId, handled, selection.files.length, `已处理 ${handled}/${selection.files.length}`);
      } catch (error) {
        this.assertNotCancelled(jobId, signal);
        handled += 1;
        this.updateItem(jobId, file.id, { status: 'failed', phase: '生成失败', error: error.message || String(error), progress: 1 });
        this.updateBatchProgress(jobId, handled, selection.files.length, `已处理 ${handled}/${selection.files.length}`);
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    }
    this.assertNotCancelled(jobId, signal);
    const latest = this.store.get('localToolJobs', jobId);
    const failed = latest.items.filter((item) => item.status === 'failed').length;
    return this.updateJob(latest, { status: failed === latest.items.length ? 'failed' : 'completed', phase: failed ? `完成，${failed} 个文件失败` : '全部字幕已生成', progress: 1, finishedAt: new Date().toISOString() });
  }

  async runVideoImport(jobId, selection, collection, choices, signal) {
    const records = () => this.store.listVideoCaches({ collectionId: collection.id });
    let handled = 0;
    for (const file of selection.files) {
      this.assertNotCancelled(jobId, signal);
      const existing = findVideoCollision(records(), file);
      const action = existing ? (choices[file.id] || 'skip') : 'import';
      if (existing && action !== 'overwrite') {
        handled += 1;
        this.updateItem(jobId, file.id, { status: 'skipped', phase: '已存在同名缓存，按设置跳过', progress: 1, existingId: existing.id });
        this.updateBatchProgress(jobId, handled, selection.files.length, `已处理 ${handled}/${selection.files.length}`);
        continue;
      }
      const workDir = ensureDir(path.join(this.jobWorkspace(jobId), file.id));
      const mediaLabel = file.kind === 'audio' ? '音频' : '视频';
      try {
        this.updateItem(jobId, file.id, { status: 'running', phase: `等待${mediaLabel}压缩资源`, progress: 0.01 });
        const compressed = path.join(workDir, 'merged.mp4');
        await this.runScheduledMedia(jobId, file.id, signal, () => compressMedia(file.path, compressed, file, {
          jobId: `${jobId}-${file.id}`,
          signal,
          onProgress: (progress) => this.updateItemProgress(jobId, file.id, `压缩并规范化${mediaLabel}`, Number(progress) * 0.9)
        }));
        const cover = file.hasVideo
          ? await this.runScheduledMedia(jobId, `${file.id}:cover`, signal, () => extractCover(compressed, path.join(workDir, 'cover.jpg'), { signal, duration: file.duration }))
          : '';
        this.assertNotCancelled(jobId, signal);
        this.updateItem(jobId, file.id, { phase: '写入内置缓存收藏夹', progress: 0.94 });
        const record = this.commitVideoImport({ jobId, file, workDir, cover, collection, existing });
        this.assertNotCancelled(jobId, signal);
        this.emit({ type: 'video-cache-local-imported', cacheId: record.id, collectionId: collection.id, localToolbox: this.state() });
        handled += 1;
        this.updateItem(jobId, file.id, { status: 'completed', phase: '已导入内置缓存收藏夹', progress: 1, output: record.videoFile, cacheId: record.id, completedAt: new Date().toISOString() });
        this.updateBatchProgress(jobId, handled, selection.files.length, `已导入 ${handled}/${selection.files.length}`);
      } catch (error) {
        this.assertNotCancelled(jobId, signal);
        handled += 1;
        this.updateItem(jobId, file.id, { status: 'failed', phase: '导入失败', error: error.message || String(error), progress: 1 });
        this.updateBatchProgress(jobId, handled, selection.files.length, `已处理 ${handled}/${selection.files.length}`);
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    }
    this.assertNotCancelled(jobId, signal);
    this.refreshCollectionCount(collection.id);
    const latest = this.store.get('localToolJobs', jobId);
    const failed = latest.items.filter((item) => item.status === 'failed').length;
    return this.updateJob(latest, { status: failed === latest.items.length ? 'failed' : 'completed', phase: failed ? `导入结束，${failed} 个文件失败` : '本地视频/音频导入完成', progress: 1, finishedAt: new Date().toISOString() });
  }

  async runDocumentImport(jobId, selection, collection, choices, signal) {
    let handled = 0;
    for (const file of selection.files) {
      this.assertNotCancelled(jobId, signal);
      const existing = findDocumentCollision(this.store.listTasks({ collectionId: collection.id }), file);
      const action = existing ? (choices[file.id] || 'skip') : 'import';
      if (existing && action !== 'overwrite') {
        handled += 1;
        this.updateItem(jobId, file.id, { status: 'skipped', phase: '已存在同名同格式文档，按设置跳过', progress: 1, existingId: existing.id });
        this.updateBatchProgress(jobId, handled, selection.files.length, `已处理 ${handled}/${selection.files.length}`);
        continue;
      }
      const workDir = ensureDir(path.join(this.jobWorkspace(jobId), file.id));
      try {
        this.updateItem(jobId, file.id, { status: 'running', phase: '解析文档并复制资源', progress: 0.15 });
        const importedAt = new Date().toISOString();
        const result = await importDocument(file.path, workDir, { importedAt, signal });
        this.assertNotCancelled(jobId, signal);
        this.updateItem(jobId, file.id, { phase: '建立知识库索引', progress: 0.82 });
        const task = this.commitDocumentImport({ jobId, file, workDir, result, collection, existing, importedAt });
        this.assertNotCancelled(jobId, signal);
        handled += 1;
        this.updateItem(jobId, file.id, { status: 'completed', phase: '已加入多模态知识库', progress: 1, taskId: task.id, output: task.outputMarkdown, warnings: result.warnings, completedAt: importedAt });
        this.updateBatchProgress(jobId, handled, selection.files.length, `已导入 ${handled}/${selection.files.length}`);
      } catch (error) {
        this.assertNotCancelled(jobId, signal);
        handled += 1;
        this.updateItem(jobId, file.id, { status: 'failed', phase: '导入失败', error: error.message || String(error), progress: 1 });
        this.updateBatchProgress(jobId, handled, selection.files.length, `已处理 ${handled}/${selection.files.length}`);
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    }
    this.assertNotCancelled(jobId, signal);
    this.refreshCollectionCount(collection.id);
    const latest = this.store.get('localToolJobs', jobId);
    const failed = latest.items.filter((item) => item.status === 'failed').length;
    const result = this.updateJob(latest, { status: failed === latest.items.length ? 'failed' : 'completed', phase: failed ? `导入结束，${failed} 个文档失败` : '多模态文档导入完成', progress: 1, finishedAt: new Date().toISOString() });
    this.emit({ type: 'local-knowledge-catalog-changed', collectionId: collection.id });
    return result;
  }

  commitVideoImport({ jobId, file, workDir, cover, collection, existing }) {
    this.assertNotCancelled(jobId);
    const latestExisting = findVideoCollision(this.store.listVideoCaches({ collectionId: collection.id }), file);
    if (!existing && latestExisting) throw new Error('同名视频在等待期间已被其它导入任务写入，请重新选择“覆盖”或“跳过”。');
    if (existing && !latestExisting) throw new Error('准备覆盖的视频记录已经变化，请重新选择文件后再试。');
    existing = latestExisting || existing;
    const importedAt = new Date().toISOString();
    const localId = existing?.localVideoId || localVideoId(collection.id, file.name);
    const bvid = existing?.bvid || syntheticLocalBvid(collection.id, file.name);
    const cacheId = existing?.id || `cache:${collection.id}:${localId}`;
    const taskId = existing?.taskId || `cache-task:${collection.id}:${localId}`;
    const currentTask = this.store.getTask(taskId) || {};
    if (['claimed', 'rejected'].includes(currentTask.status) && (currentTask.workId || currentTask.claimedBy)) throw new Error('同名缓存视频正在被 Agent 处理，不能覆盖。');
    const targetName = existing?.artifactDir
      ? path.basename(existing.artifactDir)
      : fitArtifactName(collection.cacheRoot, `本地-${safeName(file.title, localId, 72)}-${localId.slice(-8)}`);
    const targetDir = existing?.artifactDir || path.join(collection.cacheRoot, targetName);
    const backupDir = `${targetDir}.backup-${safeName(jobId, 'job', 32)}`;
    ensureDir(path.dirname(targetDir));
    try {
      const videoFile = path.join(targetDir, 'merged.mp4');
      const coverFile = fs.existsSync(path.join(workDir, 'cover.jpg')) ? path.join(targetDir, 'cover.jpg') : '';
      const info = {
        schemaVersion: 1,
        sourceType: 'local-video',
        sourceMediaKind: file.kind,
        localImported: true,
        localVideoId: localId,
        bvid,
        title: file.title,
        owner: { name: file.kind === 'audio' ? '本地音频' : '本地视频', mid: '' },
        duration: file.duration,
        mediaKind: file.kind,
        hasVideo: Boolean(file.hasVideo),
        hasAudio: Boolean(file.hasAudio),
        dimension: { width: file.width, height: file.height, rotate: 0 },
        pubdate: Math.floor(new Date(importedAt).getTime() / 1000),
        ctime: Math.floor(new Date(importedAt).getTime() / 1000),
        importedAt,
        favoriteAddedAt: importedAt,
        originalFileName: file.name,
        originalExtension: file.extension,
        sourceFingerprint: sourceFingerprint(file),
        tags: ['本地导入', file.kind === 'audio' ? '音频' : '视频'],
        pages: [{ page: 1, part: file.title, duration: file.duration }],
        coverFile: coverFile ? path.basename(coverFile) : '',
        url: ''
      };
      const metadataFile = path.join(targetDir, 'info.json');
      const record = {
        ...(existing || {}),
        id: cacheId,
        collectionId: collection.id,
        taskId,
        bvid,
        url: '',
        title: file.title,
        owner: file.kind === 'audio' ? '本地音频' : '本地视频',
        duration: file.duration,
        mediaKind: file.kind,
        hasVideo: Boolean(file.hasVideo),
        hasAudio: Boolean(file.hasAudio),
        tags: ['本地导入', file.kind === 'audio' ? '音频' : '视频'],
        cover: '',
        coverFile,
        width: file.width,
        height: file.height,
        orientation: file.orientation,
        publishedAt: importedAt,
        downloadedAt: importedAt,
        artifactDir: targetDir,
        videoFile,
        metadataFile,
        allowedRoot: collection.cacheRoot,
        status: 'ready',
        sourceType: 'local-video',
        sourceMediaKind: file.kind,
        localImported: true,
        localVideoId: localId,
        originalFileName: file.name,
        sourceFingerprint: sourceFingerprint(file),
        createdAt: existing?.createdAt || importedAt,
        updatedAt: importedAt
      };
      fs.writeFileSync(path.join(workDir, 'info.json'), `${JSON.stringify(info, null, 2)}\n`, 'utf8');
      fs.writeFileSync(path.join(workDir, 'cache-record.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
      if (fs.existsSync(targetDir)) fs.renameSync(targetDir, backupDir);
      fs.renameSync(workDir, targetDir);
      fs.writeFileSync(path.join(targetDir, IMPORT_MANIFEST_NAME), `${JSON.stringify({ kind: 'video-cache', jobId, targetDir, backupDir }, null, 2)}\n`, 'utf8');
      const task = {
        ...currentTask,
        id: taskId,
        collectionId: collection.id,
        bvid,
        sourceTitle: file.title,
        title: file.title,
        owner: file.kind === 'audio' ? '本地音频' : '本地视频',
        duration: file.duration,
        mediaKind: file.kind,
        hasVideo: Boolean(file.hasVideo),
        hasAudio: Boolean(file.hasAudio),
        tags: ['本地导入', file.kind === 'audio' ? '音频' : '视频'],
        url: '',
        favoriteAddedAt: currentTask.favoriteAddedAt || importedAt,
        publishedAt: importedAt,
        status: currentTask.status === 'done' ? 'done' : 'pending',
        enabled: currentTask.enabled !== false,
        claimedBy: '',
        workId: '',
        workspaceId: collection.workspaceId,
        workspaceRoot: collection.workspaceRoot,
        allowedRoot: collection.cacheRoot,
        artifactDir: targetDir,
        metadataFile,
        coverFile,
        cachedVideoId: cacheId,
        cachedVideoFile: videoFile,
        reuseCachedMedia: true,
        localImported: true,
        sourceType: 'local-video',
        sourceMediaKind: file.kind,
        localVideoId: localId,
        originalFileName: file.name,
        internal: true,
        createdAt: currentTask.createdAt || importedAt,
        updatedAt: importedAt
      };
      this.assertNotCancelled(jobId);
      this.store.transaction(() => {
        this.store.set('videoCaches', record.id, record);
        this.store.set('tasks', task.id, task);
        this.store.set('collections', collection.id, { ...collection, videoCount: this.store.listVideoCaches({ collectionId: collection.id }).filter((item) => item.id !== record.id).length + 1, updatedAt: importedAt });
      });
      fs.rmSync(path.join(targetDir, IMPORT_MANIFEST_NAME), { force: true });
      if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
      return record;
    } catch (error) {
      if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
      if (fs.existsSync(backupDir)) fs.renameSync(backupDir, targetDir);
      throw error;
    }
  }

  commitDocumentImport({ jobId, file, workDir, result, collection, existing, importedAt }) {
    this.assertNotCancelled(jobId);
    const latestExisting = findDocumentCollision(this.store.listTasks({ collectionId: collection.id }), file);
    if (!existing && latestExisting) throw new Error('同名同格式文档在等待期间已被其它导入任务写入，请重新选择“覆盖”或“跳过”。');
    if (existing && !latestExisting) throw new Error('准备覆盖的文档记录已经变化，请重新选择文件后再试。');
    existing = latestExisting || existing;
    const stableId = existing?.id || `local-document:${collection.id}:${stableDocumentId(`${file.name.toLowerCase()}|${file.extension}`)}`;
    const targetName = existing?.artifactDir
      ? path.basename(existing.artifactDir)
      : fitArtifactName(collection.collectionRoot, `文档-${safeName(file.title, 'document', 72)}-${stableId.slice(-8)}`);
    const targetDir = existing?.artifactDir || path.join(collection.collectionRoot, targetName);
    const backupDir = `${targetDir}.backup-${safeName(jobId, 'job', 32)}`;
    try {
      if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
      if (fs.existsSync(targetDir)) fs.renameSync(targetDir, backupDir);
      fs.renameSync(workDir, targetDir);
      fs.writeFileSync(path.join(targetDir, IMPORT_MANIFEST_NAME), `${JSON.stringify({ kind: 'multimodal-document', jobId, targetDir, backupDir }, null, 2)}\n`, 'utf8');
      const task = {
        ...(existing || {}),
        id: stableId,
        collectionId: collection.id,
        bvid: '',
        title: file.title,
        sourceTitle: file.title,
        owner: '本地文档',
        duration: 0,
        tags: ['本地文档', file.extension.slice(1).toUpperCase()],
        status: 'done',
        enabled: false,
        knowledgeActive: true,
        outputMarkdown: path.join(targetDir, path.basename(result.markdownFile)),
        metadataFile: path.join(targetDir, path.basename(result.metadataFile)),
        artifactDir: targetDir,
        allowedRoot: collection.collectionRoot,
        workspaceId: collection.workspaceId,
        workspaceRoot: collection.workspaceRoot,
        sourceType: 'local-document',
        documentKind: file.kind,
        originalFileName: file.name,
        originalExtension: file.extension,
        importedAt,
        publishedAt: importedAt,
        favoriteAddedAt: importedAt,
        completedAt: importedAt,
        internal: true,
        createdAt: existing?.createdAt || importedAt,
        updatedAt: importedAt
      };
      this.assertNotCancelled(jobId);
      this.store.transaction(() => {
        this.store.set('tasks', task.id, task);
        const count = this.store.listTasks({ collectionId: collection.id }).filter((item) => item.id !== task.id && item.sourceType === 'local-document').length + 1;
        this.store.set('collections', collection.id, { ...collection, documentCount: count, videoCount: count, updatedAt: importedAt });
      });
      fs.rmSync(path.join(targetDir, IMPORT_MANIFEST_NAME), { force: true });
      if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
      return task;
    } catch (error) {
      if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
      if (fs.existsSync(backupDir)) fs.renameSync(backupDir, targetDir);
      throw error;
    }
  }

  async runScheduledMedia(jobId, itemId, signal, execute) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const handle = this.toolRunner.scheduleUtilityStage({
      id: `local-toolbox:${jobId}:${itemId}:media`,
      pool: 'media',
      workerId: `local-toolbox:${jobId}`,
      execute: () => execute(controller.signal),
      cancel: () => controller.abort(),
      onQueued: (queue) => this.updateItem(jobId, String(itemId).split(':')[0], { phase: `等待媒体资源（队列 ${queue.position}）` }, false)
    });
    this.setActiveHandle(jobId, handle);
    try { return await handle.promise; }
    finally { signal.removeEventListener('abort', abort); this.setActiveHandle(jobId, null); }
  }

  runBackground(jobId, operation) {
    const controller = new AbortController();
    this.running.set(jobId, { controller, handle: null });
    Promise.resolve().then(() => operation(controller.signal)).catch((error) => {
      const latest = this.store.get('localToolJobs', jobId);
      if (!latest) return;
      const cancelled = this.cancelRequested.has(jobId) || controller.signal.aborted || error.code === 'LOCAL_TOOL_CANCELLED' || error.code === 'LOCAL_DOCUMENT_CANCELLED' || error.code === 'SCHEDULER_CANCELLED';
      this.updateJob(latest, {
        status: cancelled ? (latest.status === 'interrupted' ? 'interrupted' : 'cancelled') : 'failed',
        phase: cancelled ? '任务已停止，当前未完成条目已清理' : '任务失败',
        error: cancelled ? '' : (error.message || String(error)),
        ...(cancelled ? { items: interruptedItems(latest.items, '任务停止，未完成条目已回退', 'cancelled') } : {}),
        finishedAt: new Date().toISOString()
      });
    }).finally(() => {
      this.cleanupJobWorkspace(this.store.get('localToolJobs', jobId));
      this.running.delete(jobId);
      this.cancelRequested.delete(jobId);
      this.emitState('local-toolbox-queue-updated', { jobId });
    });
  }

  createJob(type, selection, extra = {}) {
    const now = new Date().toISOString();
    const id = `local-tool-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const workspace = extra.workspaceRoot
      ? { id: extra.workspaceId || '', root: path.resolve(extra.workspaceRoot) }
      : this.requireWorkspace();
    const job = {
      id,
      type,
      title: extra.title || type,
      status: 'queued',
      phase: '等待开始',
      progress: 0,
      error: '',
      collectionId: extra.collectionId || '',
      collectionName: extra.collectionName || '',
      workspaceId: extra.workspaceId || workspace.id,
      workspaceRoot: workspace.root,
      formats: extra.formats || [],
      choices: extra.choices || {},
      outputDirectories: extra.outputDirectories || [],
      items: selection.files.map((file) => ({ id: file.id, name: file.name, path: file.path, duration: file.duration || 0, size: file.size || 0, status: 'queued', phase: '等待处理', progress: 0, error: '' })),
      rejected: selection.rejected || [],
      createdAt: now,
      updatedAt: now,
      finishedAt: ''
    };
    this.store.set('localToolJobs', id, job);
    this.store.commit();
    this.emitState('local-toolbox-job-created', { jobId: id });
    return job;
  }

  updateJob(job, patch, shouldEmit = true) {
    if (!job) return null;
    const next = { ...job, ...patch, updatedAt: new Date().toISOString() };
    this.store.set('localToolJobs', next.id, next);
    this.store.commit();
    if (shouldEmit) this.emitState('local-toolbox-job-updated', { jobId: next.id });
    return next;
  }

  updateItem(jobId, itemId, patch, shouldEmit = true) {
    const job = this.store.get('localToolJobs', jobId);
    if (!job) return null;
    const items = job.items.map((item) => item.id === itemId ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item);
    const next = { ...job, status: ACTIVE_JOB_STATUSES.has(job.status) ? 'running' : job.status, items, updatedAt: new Date().toISOString() };
    this.store.set('localToolJobs', jobId, next);
    this.store.commit();
    if (shouldEmit) this.emitState('local-toolbox-job-updated', { jobId, itemId });
    return next;
  }

  updateItemProgress(jobId, itemId, phase, progress) {
    const active = this.running.get(jobId);
    const now = Date.now();
    if (active && now - Number(active.lastProgressAt || 0) < 700 && Number(progress || 0) < 1) return;
    if (active) active.lastProgressAt = now;
    const job = this.updateItem(jobId, itemId, { phase, progress: Math.max(0, Math.min(1, Number(progress || 0))) }, false);
    if (job) {
      const itemProgress = job.items.reduce((sum, item) => sum + Number(item.progress || 0), 0) / Math.max(1, job.items.length);
      this.updateJob(job, { progress: itemProgress, phase }, true);
    }
  }

  updateBatchProgress(jobId, handled, total, phase) {
    const job = this.store.get('localToolJobs', jobId);
    if (job) this.updateJob(job, { progress: Math.min(0.99, handled / Math.max(1, total)), phase });
  }

  jobItem(jobId, itemId) {
    return this.store.get('localToolJobs', jobId)?.items?.find((item) => item.id === itemId) || null;
  }

  setActiveHandle(jobId, handle) {
    const active = this.running.get(jobId);
    if (active) active.handle = handle;
  }

  isCancellationRequested(jobId, signal) {
    return this.cancelRequested.has(String(jobId || '')) || Boolean(signal?.aborted) || this.stopped;
  }

  assertNotCancelled(jobId, signal) {
    if (this.isCancellationRequested(jobId, signal)) throw cancelledError();
  }

  rememberSelection(selection) {
    const id = `selection-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const value = {
      ...selection,
      id,
      files: selection.files.map((file) => ({ ...file, id: sourceId(file.path) })),
      createdAt: new Date().toISOString()
    };
    this.selections.set(id, value);
    while (this.selections.size > MAX_SELECTIONS) this.selections.delete(this.selections.keys().next().value);
    return publicSelection(value);
  }

  requireSelection(id, type) {
    const selection = this.selections.get(String(id || ''));
    if (!selection || selection.type !== type) throw new Error('文件选择已经失效，请重新选择。');
    return selection;
  }

  resolveCollection(kind, input = {}) {
    if (input.collectionId) {
      const collection = this.store.getCollectionById(String(input.collectionId));
      if (!collection || collection.collectionKind !== kind) throw new Error('所选收藏夹类型不匹配。');
      return collection;
    }
    const name = normalizeCollectionName(input.collectionName || '');
    if (!name) return null;
    return this.store.listCollections().find((item) => item.userId === CACHE_USER_ID && sameName(item.name, name) && item.collectionKind === kind) || null;
  }

  requireOrCreateCollection(kind, collectionId, name) {
    const existing = this.resolveCollection(kind, { collectionId, collectionName: name });
    if (existing) return existing;
    const collectionName = normalizeCollectionName(name);
    if (!collectionName) throw new Error('请输入或选择内置收藏夹名称。');
    const collision = this.store.listCollections().find((item) => item.userId === CACHE_USER_ID && sameName(item.name, collectionName));
    if (collision) throw new Error(`“${collectionName}”已经被其它类型的内置收藏夹使用，请换一个名称。`);
    if (kind === 'video-cache') return this.videoCacheManager.createCollection(collectionName);
    return this.createDocumentCollection(collectionName);
  }

  createDocumentCollection(name) {
    const workspace = this.store.getDefaultWorkspace();
    if (!workspace) throw new Error('请先在设置中指定默认 Workspace。');
    const dirs = collectionDirs(workspace.root, CACHE_USER_NAME, name);
    const now = new Date().toISOString();
    this.store.upsertUser({ id: CACHE_USER_ID, mid: CACHE_USER_ID, name: CACHE_USER_NAME, internal: true });
    return this.store.upsertCollection({
      id: `builtin-document:${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      userId: CACHE_USER_ID,
      userName: CACHE_USER_NAME,
      name,
      label: 'multimodal-document',
      internal: true,
      collectionKind: MULTIMODAL_COLLECTION_KIND,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      collectionRoot: dirs.root,
      documentRoot: dirs.root,
      exportDir: dirs.exports,
      videoCount: 0,
      documentCount: 0,
      createdAt: now,
      updatedAt: now
    });
  }

  assertVideoConflictsIdle(files, records, choices) {
    for (const file of files) {
      const record = findVideoCollision(records, file);
      if (!record || choices[file.id] !== 'overwrite') continue;
      const task = record?.taskId ? this.store.getTask(record.taskId) : null;
      if (task && ['claimed', 'rejected'].includes(task.status) && (task.workId || task.claimedBy)) throw new Error(`“${file.name}”正在被 Agent 处理，请停止对应工作流后再覆盖导入。`);
    }
  }

  refreshCollectionCount(collectionId) {
    const collection = this.store.getCollectionById(collectionId);
    if (!collection) return;
    const count = collection.collectionKind === 'video-cache'
      ? this.store.listVideoCaches({ collectionId }).length
      : this.store.listTasks({ collectionId }).filter((item) => item.sourceType === 'local-document').length;
    this.store.upsertCollection({ ...collection, videoCount: count, documentCount: collection.collectionKind === MULTIMODAL_COLLECTION_KIND ? count : collection.documentCount, updatedAt: new Date().toISOString() });
  }

  requireWorkspace() {
    const workspace = this.store.getDefaultWorkspace();
    if (!workspace) throw new Error('默认 Workspace 不存在。');
    return workspace;
  }

  jobWorkspace(jobId) {
    const job = this.store.get('localToolJobs', String(jobId || ''));
    const workspaceRoot = job?.workspaceRoot || this.requireWorkspace().root;
    return ensureDir(path.join(path.resolve(workspaceRoot), '.star-note', 'local-tools', safeName(jobId, 'local-tool', 80)));
  }

  cleanupJobWorkspace(job) {
    if (!job?.id) return;
    try {
      const workspaceRoot = job.workspaceRoot || this.store.getDefaultWorkspace()?.root;
      if (!workspaceRoot) return;
      const parent = path.join(path.resolve(workspaceRoot), '.star-note', 'local-tools');
      const target = assertInside(parent, path.join(parent, safeName(job.id, 'local-tool', 80)));
      if (target !== path.resolve(parent) && fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    } catch {}
  }

  recoverImportTransactions() {
    for (const collection of this.store.listCollections()) {
      const roots = [...new Set([collection.cacheRoot, collection.collectionRoot]
        .filter(Boolean)
        .map((value) => path.resolve(value)))];
      for (const root of roots) {
        if (!fs.existsSync(root)) continue;
        let entries;
        try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          const targetDir = path.join(root, entry.name);
          const manifestPath = path.join(targetDir, IMPORT_MANIFEST_NAME);
          if (!fs.existsSync(manifestPath)) continue;
          try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const target = assertInside(root, path.resolve(manifest.targetDir || targetDir));
            if (target !== path.resolve(targetDir)) continue;
            const backup = manifest.backupDir ? assertInside(root, path.resolve(manifest.backupDir)) : '';
            const committed = collection.collectionKind === 'video-cache'
              ? this.store.listVideoCaches({ collectionId: collection.id }).some((record) => samePath(record.artifactDir, target))
              : this.store.listTasks({ collectionId: collection.id }).some((task) => samePath(task.artifactDir, target));
            if (committed) {
              fs.rmSync(manifestPath, { force: true });
              if (backup && fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
            } else {
              fs.rmSync(target, { recursive: true, force: true });
              if (backup && fs.existsSync(backup)) fs.renameSync(backup, target);
            }
          } catch {
            // Leave an unreadable marker for manual recovery rather than deleting unknown data.
          }
        }
      }
    }
  }

  emitState(type, detail = {}) {
    this.emit({ type, ...detail, localToolbox: this.state() });
  }
}

async function inspectFiles(files, inspect) {
  const accepted = [];
  const rejected = [];
  for (const file of files) {
    try { accepted.push(await inspect(file)); }
    catch (error) { rejected.push({ path: file, name: path.basename(file), error: error.message || String(error) }); }
  }
  return { accepted, rejected };
}

function walkSelectedFiles(paths, predicate) {
  const files = [];
  const seen = new Set();
  const visit = (target, depth = 0) => {
    if (files.length >= MAX_SELECTED_FILES || depth > 8) return;
    const resolved = path.resolve(target);
    let stat;
    try { stat = fs.lstatSync(resolved); } catch { return; }
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      if (!seen.has(key) && predicate(resolved)) { seen.add(key); files.push(resolved); }
      return;
    }
    if (!stat.isDirectory()) return;
    for (const item of fs.readdirSync(resolved, { withFileTypes: true })) {
      if (item.isSymbolicLink()) continue;
      visit(path.join(resolved, item.name), depth + 1);
      if (files.length >= MAX_SELECTED_FILES) break;
    }
  };
  for (const value of paths) visit(value);
  return files;
}

function normalizePaths(values) {
  return [...new Set((values || []).map((item) => path.resolve(String(item || ''))).filter(Boolean))];
}

function samePath(left, right) {
  if (!left || !right) return false;
  const a = path.resolve(String(left));
  const b = path.resolve(String(right));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function defaultSelectionName(roots, files) {
  const first = roots[0] || files[0]?.path || '本地导入';
  try {
    const stat = fs.statSync(first);
    return normalizeCollectionName(stat.isDirectory() ? path.basename(first) : path.basename(path.dirname(first)));
  } catch { return '本地导入'; }
}

function normalizeCollectionName(value) {
  return safeName(String(value || '').trim(), '', 80);
}

function sameName(left, right) {
  return String(left || '').localeCompare(String(right || ''), undefined, { sensitivity: 'accent' }) === 0;
}

function sourceId(file) {
  return crypto.createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 16);
}

function sourceFingerprint(file) {
  return crypto.createHash('sha256').update(`${path.resolve(file.path)}|${file.size}|${file.modifiedAt}`).digest('hex');
}

function localVideoId(collectionId, name) {
  return `local-${crypto.createHash('sha256').update(`${collectionId}|${String(name).toLowerCase()}`).digest('hex').slice(0, 20)}`;
}

function syntheticLocalBvid(collectionId, name) {
  return `BVLI${crypto.createHash('sha256').update(`${collectionId}|${String(name).toLowerCase()}`).digest('hex').slice(0, 8).toUpperCase()}`;
}

function findVideoCollision(records, file) {
  const wanted = String(file.name || '').toLocaleLowerCase();
  return records.find((item) => String(item.originalFileName || '').toLocaleLowerCase() === wanted) || null;
}

function findDocumentCollision(tasks, file) {
  const name = String(file.name || '').toLocaleLowerCase();
  const extension = String(file.extension || '').toLocaleLowerCase();
  return tasks.find((item) => String(item.originalFileName || '').toLocaleLowerCase() === name && String(item.originalExtension || '').toLocaleLowerCase() === extension) || null;
}

function normalizeChoices(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(source).map(([key, action]) => [String(key), action === 'overwrite' ? 'overwrite' : 'skip']));
}

function publicSelection(selection) {
  return {
    id: selection.id,
    type: selection.type,
    roots: selection.roots,
    outputDirectory: selection.outputDirectory || '',
    defaultCollectionName: selection.defaultCollectionName || '',
    files: selection.files.map(publicFile),
    rejected: selection.rejected || [],
    createdAt: selection.createdAt
  };
}

function publicFile(file) {
  return { id: file.id, path: file.path, name: file.name, title: file.title, extension: file.extension, kind: file.kind, size: file.size, duration: file.duration || 0, width: file.width || 0, height: file.height || 0, orientation: file.orientation || '' };
}

function publicCollection(collection) {
  const { cookieFile, ...safe } = collection || {};
  return safe;
}

function publicJob(job) {
  const itemCounts = (job.items || []).reduce((counts, item) => {
    const status = String(item.status || 'queued');
    counts[status] = Number(counts[status] || 0) + 1;
    return counts;
  }, {});
  return {
    ...job,
    totalItems: (job.items || []).length,
    itemCounts,
    items: (job.items || []).map(publicJobItem)
  };
}

function publicJobItem(item = {}) {
  return {
    id: item.id || '',
    name: item.name || '',
    status: item.status || 'queued',
    phase: item.phase || '',
    progress: Math.max(0, Math.min(1, Number(item.progress || 0))),
    error: item.error || '',
    duration: Number(item.duration || 0),
    size: Number(item.size || 0),
    completedAt: item.completedAt || '',
    output: item.output || '',
    cacheId: item.cacheId || ''
  };
}

function publicVideoCollision(record) {
  return { id: record.id, title: record.title, originalFileName: record.originalFileName || '', updatedAt: record.updatedAt || '', fileExists: Boolean(record.videoFile && fs.existsSync(record.videoFile)) };
}

function publicDocumentCollision(task) {
  return { id: task.id, title: task.title, originalFileName: task.originalFileName || '', originalExtension: task.originalExtension || '', updatedAt: task.updatedAt || '', fileExists: Boolean(task.outputMarkdown && fs.existsSync(task.outputMarkdown)) };
}

function cancelledError() {
  const error = new Error('本地工具任务已取消。');
  error.code = 'LOCAL_TOOL_CANCELLED';
  return error;
}

function interruptedItems(items, phase, status = 'interrupted') {
  const updatedAt = new Date().toISOString();
  return (items || []).map((item) => ['completed', 'failed', 'skipped'].includes(item.status)
    ? item
    : { ...item, status, phase, error: '', updatedAt });
}

module.exports = { LocalToolboxManager, MULTIMODAL_COLLECTION_KIND, walkSelectedFiles };
