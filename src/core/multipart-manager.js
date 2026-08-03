const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { collectionDirs, ensureDir, safeName, assertInside, removePathInside } = require('./workspace');
const { unsupportedBilibiliUrlReason } = require('./video-support');

const MULTIPART_KIND = 'bilibili-multipart';
const MULTIPART_USER_ID = 'builtin-agent-user';
const MULTIPART_USER_NAME = '内置用户';
const ACTIVE_SESSION_STATUSES = new Set(['running', 'draining', 'stopping']);
const MAX_INDEX_PART_SUMMARY_CHARACTERS = 8000;

class MultiPartManager {
  constructor({ store, bili, internalAgentManager, ragAssistant, emit }) {
    this.store = store;
    this.bili = bili;
    this.internalAgentManager = internalAgentManager;
    this.ragAssistant = ragAssistant;
    this.emit = emit || (() => {});
    this.indexRefreshFailures = [];
    this.stateEmitTimers = new Map();
    this.refreshStoredIndexes();
  }

  state() {
    return {
      collections: this.collections().map(publicCollection),
      parents: this.store.list('multiPartParents').map((parent) => this.publicParent(parent))
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    };
  }

  collections() {
    return this.store.listCollections().filter((item) => item.collectionKind === MULTIPART_KIND);
  }

  async inspect(input = {}) {
    const bvid = extractBvid(input.bvid || input.url);
    if (!bvid) throw new Error('请输入有效的多P BV号或视频链接。');
    const info = await this.bili.getVideoInfo(bvid);
    assertMultipartVideoSupported(input, info);
    if (info.pages.length < 2) throw new Error('该视频只有一个P，不需要使用多P视频总结工具。');
    return {
      bvid,
      title: info.title,
      owner: info.owner?.name || '',
      pages: info.pages.map(publicPage),
      duration: Number(info.duration || 0),
      cover: info.pic || '',
      parentDocumentId: parentIdFor(bvid, input.collectionId || input.collectionName || '')
    };
  }

  async create(input = {}) {
    const provider = this.ragAssistant.rawProvider(input.providerId);
    const modelId = String(input.modelId || '');
    if (!(provider.enabledModels || []).some((model) => model.id === modelId)) throw new Error('请选择已启用的模型。');
    const bvid = extractBvid(input.bvid || input.url);
    if (!bvid) throw new Error('请输入有效的多P BV号或视频链接。');
    const info = await this.bili.getVideoInfo(bvid);
    assertMultipartVideoSupported(input, info);
    if (info.pages.length < 2) throw new Error('该视频只有一个P，不需要使用多P视频总结工具。');
    const collection = this.requireOrCreateCollection(input.collectionId, input.collectionName || `${info.title || bvid} 多P`);
    const parentId = parentIdFor(bvid, collection.id);
    const existing = this.store.get('multiPartParents', parentId);
    if (existing) {
      await this.mergePages(existing, info.pages, info);
      const refreshed = this.store.get('multiPartParents', parentId);
      const publicValue = this.publicParent(refreshed);
      return {
        ...publicValue,
        existing: true,
        existingCompletedCids: publicValue.parts.filter((part) => part.status === 'done').map((part) => String(part.cid)),
        existingPendingCids: publicValue.parts.filter((part) => part.status !== 'done' && part.pageState !== 'removed').map((part) => String(part.cid))
      };
    }
    const now = new Date().toISOString();
    const parentRoot = this.parentRoot(collection, bvid);
    ensureDir(parentRoot);
    const selected = normalizeSelectedPages(input.selectedPages, info.pages);
    const settings = normalizeSettings(input);
    const parent = {
      id: parentId,
      parentDocumentId: parentId,
      bvid,
      title: info.title || bvid,
      owner: info.owner?.name || '',
      aid: info.aid || '',
      cover: info.pic || '',
      collectionId: collection.id,
      collectionName: collection.name,
      collectionKind: MULTIPART_KIND,
      parentRoot,
      pages: info.pages.map(publicPage),
      selectedCids: selected,
      settings,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      lastRefreshedAt: now,
      completedAt: ''
    };
    this.store.set('multiPartParents', parentId, parent);
    this.store.upsertCollection({ ...collection, updatedAt: now });
    for (const page of info.pages) this.ensurePartTask(parent, page, selected.includes(String(page.cid)), now);
    this.ensureParentIndexTask(parent, now);
    this.store.commit();
    this.writeIndex(parent);
    this.emitState('multipart-parent-created', parentId);
    return this.publicParent(this.store.get('multiPartParents', parentId));
  }

  async refresh(parentId) {
    const parent = this.requireParent(parentId);
    const info = await this.bili.getVideoInfo(parent.bvid);
    assertMultipartVideoSupported({ bvid: parent.bvid }, info);
    if (info.pages.length < 2) throw new Error('B站返回的页面数已少于 2，无法继续作为多P任务处理。');
    await this.mergePages(parent, info.pages, info);
    const refreshed = this.store.get('multiPartParents', parent.id);
    this.writeIndex(refreshed);
    this.emitState('multipart-parent-refreshed', parent.id);
    return this.publicParent(refreshed);
  }

  async start(input = {}) {
    const parent = this.requireParent(input.parentId);
    const active = this.activeMultipartSessions();
    if (active.length) throw new Error('当前多P父任务已有总结工作进行中，请等待完成或先停止。');
    const selected = normalizeSelectedPages(input.selectedPages, parent.pages);
    const tasks = this.partTasks(parent.id).filter((task) => selected.includes(String(task.cid)) && task.status !== 'done' && task.pageState !== 'removed');
    if (!tasks.length) throw new Error('当前选择范围内没有待总结的 P。');
    const settings = { ...parent.settings, ...normalizeSettings(input, parent.settings) };
    const selectedSet = new Set(selected);
    for (const part of this.partTasks(parent.id)) {
      if (part.status === 'done' || part.pageState === 'removed') continue;
      part.enabled = selectedSet.has(String(part.cid));
      if (part.enabled) {
        part.multiPartStopped = false;
        part.multiPartStopReason = '';
        part.multiPartStoppedAt = '';
      }
      part.updatedAt = new Date().toISOString();
      this.store.upsertTask(part);
    }
    parent.settings = settings;
    parent.selectedCids = selected;
    parent.status = 'running';
    parent.updatedAt = new Date().toISOString();
    this.store.set('multiPartParents', parent.id, parent);
    this.store.commit();
    const sessions = [];
    const concurrency = Math.max(1, Math.min(4, Number(settings.concurrency) || 2));
    try {
      for (let index = 0; index < Math.min(concurrency, tasks.length); index += 1) {
        const session = this.createMultipartSession(parent, tasks, index + 1);
        sessions.push(await this.internalAgentManager.start(session.id));
      }
    } catch (error) {
      for (const session of sessions) {
        try { this.internalAgentManager.stop(session.id); } catch {}
      }
      const waits = sessions.map((session) => this.internalAgentManager.running?.get(session.id)).filter(Boolean);
      if (waits.length) await Promise.allSettled(waits);
      parent.status = 'stopped';
      parent.updatedAt = new Date().toISOString();
      this.store.set('multiPartParents', parent.id, parent);
      this.store.commit();
      throw error;
    }
    this.emitState('multipart-parent-started', parent.id);
    return { parent: this.publicParent(this.store.get('multiPartParents', parent.id)), sessions };
  }

  async stopPart(input = {}) {
    const parent = this.requireParent(input.parentId);
    const cid = String(input.cid || input.partId || '').trim();
    if (!cid) throw new Error('请选择要停止的 P。');
    const task = this.partTasks(parent.id).find((item) => String(item.cid) === cid || String(item.id) === cid);
    if (!task) throw new Error('指定的子 P 不存在。');
    if (task.status === 'done') throw new Error('已完成的 P 不能停止。');

    const now = new Date().toISOString();
    const activeSessions = this.internalAgentManager.listSessions().filter((session) => session.multiPartParentId === parent.id
      && (session.currentTaskId === task.id || (task.claimedBy && session.workerId === task.claimedBy))
      && ['running', 'draining', 'stopping'].includes(session.status));
    const hadActiveSession = activeSessions.length > 0;
    const stopReason = '用户单独停止了这个 P，已回退到待继续状态。';

    task.enabled = false;
    task.multiPartStopped = true;
    task.multiPartStopReason = stopReason;
    task.multiPartStoppedAt = now;
    task.multiPartProgress = 0;
    task.multiPartPhase = '已单独停止，等待继续';
    task.updatedAt = now;
    this.store.upsertTask(task);
    parent.selectedCids = (parent.selectedCids || []).map(String).filter((value) => value !== cid);
    parent.updatedAt = now;
    this.store.set('multiPartParents', parent.id, parent);
    this.store.commit();

    const waits = [];
    for (const session of activeSessions) {
      try {
        this.internalAgentManager.stop(session.id);
      } catch (error) {
        throw new Error(`停止 P${task.page || ''} 失败：${error.message || String(error)}`);
      }
      const running = this.internalAgentManager.running?.get(session.id);
      if (running) waits.push(running);
    }
    if (!activeSessions.length && task.status !== 'pending' && task.status !== 'failed') {
      try {
        this.internalAgentManager.abortAttempt(task.id, task.claimedBy, stopReason, 'multipart-part-stop');
      } catch (error) {
        throw new Error(`回退 P${task.page || ''} 失败：${error.message || String(error)}`);
      }
    }
    if (waits.length) await Promise.allSettled(waits);

    const refreshed = this.store.getTask(task.id);
    if (refreshed) {
      refreshed.enabled = false;
      refreshed.multiPartStopped = true;
      refreshed.multiPartStopReason = stopReason;
      refreshed.multiPartStoppedAt = now;
      refreshed.multiPartProgress = 0;
      refreshed.multiPartPhase = '已单独停止，等待继续';
      refreshed.updatedAt = new Date().toISOString();
      this.store.upsertTask(refreshed);
    }
    this.store.commit();

    let replacementSessions = [];
    let replacementWarning = '';
    if (hadActiveSession) {
      try {
        replacementSessions = await this.ensureReplacementSessions(parent.id);
      } catch (error) {
        replacementWarning = `当前 P 已停止，但补位工作流未能启动：${error.message || String(error)}。其它已运行的 P 不受影响，剩余 P 可稍后点击“继续”处理。`;
      }
    }
    const current = this.store.get('multiPartParents', parent.id);
    this.emitState('multipart-part-stopped', parent.id);
    return {
      parent: this.publicParent(current),
      stoppedPart: publicPart(this.store.getTask(task.id)),
      replacementSessions,
      replacementWarning
    };
  }

  async stop(parentId) {
    const parent = this.requireParent(parentId);
    const sessions = this.activeSessions(parent.id);
    for (const session of sessions) this.internalAgentManager.stop(session.id);
    const waits = sessions.map((session) => this.internalAgentManager.running?.get(session.id)).filter(Boolean);
    if (waits.length) await Promise.allSettled(waits);
    parent.status = 'stopped';
    parent.updatedAt = new Date().toISOString();
    this.store.set('multiPartParents', parent.id, parent);
    this.store.commit();
    this.emitState('multipart-parent-stopped', parent.id);
    return this.publicParent(parent);
  }

  async delete(parentId) {
    const parent = this.requireParent(parentId);
    if (this.activeSessions(parent.id).length) throw new Error('请先停止正在运行的多P父任务。');
    const collection = this.store.getCollectionById(parent.collectionId);
    if (!collection?.collectionRoot) throw new Error('多P父任务所属收藏夹不存在，无法安全删除产物。');
    for (const session of this.internalAgentManager.listSessions().filter((item) => item.multiPartParentId === parent.id)) {
      try { this.internalAgentManager.deleteSession(session.id); } catch {}
    }
    const taskIds = [parent.id, ...this.partTasks(parent.id).map((task) => task.id)];
    for (const taskId of taskIds) {
      const task = this.store.getTask(taskId);
      if (task?.artifactDir && fs.existsSync(task.artifactDir)) removePathInside(task.allowedRoot || parent.parentRoot, task.artifactDir);
      this.store.delete('tasks', taskId);
      this.store.delete('videos', taskId);
    }
    if (fs.existsSync(parent.parentRoot)) removePathInside(collection.collectionRoot, parent.parentRoot);
    this.store.delete('multiPartParents', parent.id);
    if (collection) this.store.set('collections', collection.id, { ...collection, videoCount: this.store.listTasks({ collectionId: collection.id }).length, updatedAt: new Date().toISOString() });
    this.store.save();
    this.emitState('multipart-parent-deleted', parent.id);
    return { deleted: true, parentId: parent.id };
  }

  handleAgentEvent(event = {}) {
    const session = event.session || (event.sessionId
      ? this.internalAgentManager.listSessions().find((item) => item.id === event.sessionId)
      : null);
    const task = event.taskId
      ? this.store.getTask(event.taskId)
      : session?.currentTaskId ? this.store.getTask(session.currentTaskId) : null;
    const parentId = event.parentId || session?.multiPartParentId || task?.multiPartParentId;
    if (!parentId) return;
    const parent = this.store.get('multiPartParents', parentId);
    if (!parent) return;
    const parts = this.partTasks(parent.id);
    const done = parts.filter((item) => item.status === 'done').length;
    const pending = parts.filter((item) => item.status !== 'done' && item.pageState !== 'removed').length;
    const sessionStopped = event.type === 'session-finished' && ['stopped', 'collection-unavailable', 'model-unavailable'].includes(String(event.status || ''));
    const activeSessions = this.activeSessions(parent.id).filter((session) => event.type !== 'session-finished' || session.id !== event.sessionId);
    parent.status = activeSessions.length
      ? 'running'
      : sessionStopped && event.status === 'stopped'
        ? 'stopped'
        : (pending ? (done ? 'partial' : 'pending') : 'completed');
    parent.completedAt = parent.status === 'completed' ? (parent.completedAt || new Date().toISOString()) : '';
    parent.updatedAt = new Date().toISOString();
    const lightweight = ['stream', 'log', 'session-updated'].includes(String(event.type || ''));
    if (!lightweight) {
      this.store.set('multiPartParents', parent.id, parent);
      this.store.commit();
      this.writeIndex(parent);
      this.emitState('multipart-parent-updated', parent.id);
    } else {
      this.scheduleStateEmit(parent.id);
    }
  }

  requireParent(id) {
    const parent = this.store.get('multiPartParents', String(id || ''));
    if (!parent) throw new Error('多P父任务不存在。');
    return parent;
  }

  partTasks(parentId) {
    return this.store.listTasks().filter((task) => task.multiPartParentId === String(parentId || '') && task.multiPartRole === 'part');
  }

  activeSessions(parentId) {
    return this.internalAgentManager.listSessions().filter((session) => session.multiPartParentId === parentId && (ACTIVE_SESSION_STATUSES.has(session.status) || this.internalAgentManager.running?.has(session.id)));
  }

  activeMultipartSessions() {
    return this.internalAgentManager.listSessions().filter((session) => session.mode === 'multipart' && (ACTIVE_SESSION_STATUSES.has(session.status) || this.internalAgentManager.running?.has(session.id)));
  }

  refreshStoredIndexes() {
    this.indexRefreshFailures = [];
    let refreshed = 0;
    for (const parent of this.store.list('multiPartParents')) {
      if (!parent?.parentRoot || !fs.existsSync(parent.parentRoot)) continue;
      try {
        this.writeIndex(parent);
        refreshed += 1;
      } catch (error) {
        this.indexRefreshFailures.push({ parentId: parent.id, error: error.message });
      }
    }
    return { refreshed, failures: [...this.indexRefreshFailures] };
  }

  requireOrCreateCollection(collectionId, name) {
    if (collectionId) {
      const existing = this.store.getCollectionById(String(collectionId));
      if (!existing || existing.collectionKind !== MULTIPART_KIND) throw new Error('请选择 B站多P类型收藏夹。');
      return existing;
    }
    const normalized = String(name || '').trim();
    if (!normalized) throw new Error('B站多P类型收藏夹名称不能为空。');
    const existing = this.collections().find((item) => item.name === normalized);
    if (existing) return existing;
    const workspace = this.store.getDefaultWorkspace();
    const dirs = collectionDirs(workspace.root, MULTIPART_USER_NAME, normalized);
    const now = new Date().toISOString();
    return this.store.upsertCollection({
      id: `builtin-multipart:${crypto.randomUUID()}`,
      userId: MULTIPART_USER_ID,
      userName: MULTIPART_USER_NAME,
      name: normalized,
      storageName: normalized,
      label: 'bilibili-multipart',
      internal: true,
      collectionKind: MULTIPART_KIND,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      collectionRoot: dirs.root,
      videosDir: dirs.root,
      exportDir: dirs.exports,
      videoCount: 0,
      createdAt: now,
      updatedAt: now
    });
  }

  parentRoot(collection, bvid) {
    const root = path.resolve(collection.collectionRoot);
    const name = `parent-${safeName(bvid, 'video', 24)}`;
    return assertInside(root, path.join(root, name));
  }

  ensurePartTask(parent, page, enabled, now = new Date().toISOString()) {
    const cid = String(page.cid || '');
    if (!cid) return null;
    const id = `${parent.id}:part:${cid}`;
    const current = this.store.getTask(id);
    const partRoot = assertInside(parent.parentRoot, path.join(parent.parentRoot, 'parts', `cid-${safeName(cid, 'part', 40)}`));
    const task = {
      ...(current || {}),
      id,
      collectionId: parent.collectionId,
      bvid: parent.bvid,
      cid,
      page: Number(page.page || 1),
      part: String(page.part || `P${page.page || 1}`),
      title: `${parent.title} · P${page.page || 1} ${page.part || ''}`.trim(),
      sourceTitle: parent.title,
      owner: parent.owner,
      duration: Number(page.duration || 0),
      url: `https://www.bilibili.com/video/${parent.bvid}?p=${Number(page.page || 1)}`,
      publishedAt: current?.publishedAt || '',
      favoriteAddedAt: current?.favoriteAddedAt || now,
      enabled: current?.status === 'done' ? false : Boolean(enabled),
      status: current?.status || 'pending',
      multiPartProgress: Number.isFinite(Number(current?.multiPartProgress)) ? Number(current.multiPartProgress) : 0,
      multiPartPhase: String(current?.multiPartPhase || '待处理'),
      multiPartStopped: Boolean(current?.multiPartStopped),
      multiPartStopReason: String(current?.multiPartStopReason || ''),
      multiPartStoppedAt: String(current?.multiPartStoppedAt || ''),
      multiPartParentId: parent.id,
      parentDocumentId: parent.parentDocumentId,
      multiPartId: cid,
      multiPartRole: 'part',
      artifactLayout: 'multipart-part',
      preallocatedArtifactDir: partRoot,
      allowedRoot: parent.parentRoot,
      workspaceId: this.store.getCollectionById(parent.collectionId)?.workspaceId || '',
      workspaceRoot: this.store.getCollectionById(parent.collectionId)?.workspaceRoot || '',
      knowledgeActive: true,
      internal: true,
      pageState: 'active',
      createdAt: current?.createdAt || now,
      updatedAt: now
    };
    this.store.upsertTask(task);
    return task;
  }

  ensureParentIndexTask(parent, now = new Date().toISOString()) {
    const task = this.store.getTask(parent.id) || {};
    const collection = this.store.getCollectionById(parent.collectionId);
    return this.store.upsertTask({
      ...task,
      id: parent.id,
      collectionId: parent.collectionId,
      bvid: parent.bvid,
      title: `${parent.title} · 多P目录`,
      sourceTitle: parent.title,
      owner: parent.owner,
      duration: 0,
      url: `https://www.bilibili.com/video/${parent.bvid}`,
      status: 'done',
      enabled: false,
      multiPartParentId: parent.id,
      parentDocumentId: parent.parentDocumentId,
      multiPartRole: 'parent',
      artifactLayout: 'multipart-parent',
      artifactDir: parent.parentRoot,
      allowedRoot: collection?.collectionRoot || parent.parentRoot,
      workspaceId: collection?.workspaceId || '',
      workspaceRoot: collection?.workspaceRoot || '',
      knowledgeActive: true,
      internal: true,
      outputMarkdown: path.join(parent.parentRoot, 'index.md'),
      metadataFile: path.join(parent.parentRoot, 'metadata.json'),
      createdAt: task.createdAt || now,
      completedAt: task.completedAt || now,
      updatedAt: now
    });
  }

  async mergePages(parent, pages, info) {
    const now = new Date().toISOString();
    const previousCids = new Set((parent.pages || []).map((page) => String(page.cid || '')));
    const remoteCids = new Set(pages.map((page) => String(page.cid || '')));
    const selected = new Set(parent.selectedCids || []);
    for (const page of pages) {
      const cid = String(page.cid || '');
      if (cid && !previousCids.has(cid)) selected.add(cid);
    }
    parent.pages = pages.map(publicPage);
    parent.title = info.title || parent.title;
    parent.owner = info.owner?.name || parent.owner;
    parent.cover = info.pic || parent.cover;
    parent.lastRefreshedAt = now;
    for (const page of pages) this.ensurePartTask(parent, page, selected.has(String(page.cid)), now);
    parent.selectedCids = pages.map((page) => String(page.cid || '')).filter((cid) => selected.has(cid));
    for (const task of this.partTasks(parent.id)) {
      if (!remoteCids.has(String(task.cid)) && task.pageState !== 'removed') {
        task.pageState = 'removed';
        task.enabled = false;
        task.updatedAt = now;
        this.store.upsertTask(task);
      }
    }
    parent.updatedAt = now;
    this.store.set('multiPartParents', parent.id, parent);
    this.ensureParentIndexTask(parent, now);
    this.store.commit();
  }

  writeIndex(parentInput) {
    const parent = this.store.get('multiPartParents', parentInput.id) || parentInput;
    ensureDir(parent.parentRoot);
    const parts = this.partTasks(parent.id).sort((a, b) => Number(a.page || 0) - Number(b.page || 0));
    const partSummaries = parts.flatMap((task) => partSummaryLines(parent, task));
    const lines = [
      `# ${parent.title} · 多P视频目录`, '',
      '## 小结', '',
      `该父任务包含 ${parent.pages.length} 个 P，当前已完成 ${parts.filter((task) => task.status === 'done').length} 个。每个 P 的详细总结单独存放，并保留稳定 CID 标识。`, '',
      '## 思维导图', '', '```mermaid', 'flowchart TD', '  A[多P视频] --> B[逐P总结]', ...parts.map((task) => `  B --> P${task.page}[P${task.page} ${escapeMermaid(task.part)}]`), '```', '',
      '## 目录', '',
      ...parts.map((task) => `- [P${task.page} ${task.part}](parts/cid-${safeName(task.cid, 'part', 40)}/summary.md) · ${task.status === 'done' ? '已完成' : task.pageState === 'removed' ? '远程已移除' : '待处理'}`), '',
      '## 每 P 小结', '',
      ...partSummaries,
      '## 字幕', '', '每个 P 的 ASR 时间戳和站内字幕位于对应 P 的产物目录。', '',
      '## 处理记录', '', `- BV：${parent.bvid}`, `- 最后刷新：${parent.lastRefreshedAt || parent.updatedAt}`, `- 产物身份：${parent.parentDocumentId}`
    ];
    writeTextIfChanged(path.join(parent.parentRoot, 'index.md'), `${lines.join('\n')}\n`);
    writeTextIfChanged(path.join(parent.parentRoot, 'metadata.json'), `${JSON.stringify({ ...parent, parts: parts.map(publicPartMetadata) }, null, 2)}\n`);
  }

  publicParent(parent) {
    const parts = this.partTasks(parent.id).sort((a, b) => Number(a.page || 0) - Number(b.page || 0));
    const active = this.activeSessions(parent.id);
    const sessionsByTask = new Map(active
      .filter((session) => session.currentTaskId)
      .map((session) => [String(session.currentTaskId), session]));
    const publicParts = parts.map((task) => publicPart(task, sessionsByTask.get(String(task.id))));
    const completed = parts.filter((task) => task.status === 'done').length;
    const running = parts.filter((task) => sessionsByTask.has(String(task.id))).length;
    const stopped = parts.filter((task) => task.multiPartStopped === true).length;
    const failed = parts.filter((task) => task.status === 'failed').length;
    const progress = publicParts.length
      ? publicParts.reduce((total, task) => total + clampProgress(task.progress), 0) / publicParts.length
      : 0;
    return {
      ...parent,
      parentRoot: undefined,
      pages: (parent.pages || []).map((page) => {
        const task = parts.find((item) => String(item.cid) === String(page.cid));
        return { ...page, task: publicPart(task, sessionsByTask.get(String(task?.id || ''))) };
      }),
      parts: publicParts,
      completed,
      total: parts.length,
      progress,
      running,
      stopped,
      failed,
      activeSessions: active.map((session) => ({ id: session.id, status: session.status, title: session.title, currentTaskId: session.currentTaskId || '' }))
    };
  }

  emitState(type, parentId) {
    const key = String(parentId || '');
    const timer = this.stateEmitTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.stateEmitTimers.delete(key);
    }
    this.emit({ type, parentId, multiPart: this.state() });
  }

  scheduleStateEmit(parentId) {
    const key = String(parentId || '');
    if (!key || this.stateEmitTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.stateEmitTimers.delete(key);
      this.emit({ type: 'multipart-progress', parentId: key, multiPart: this.state() });
    }, 250);
    timer.unref?.();
    this.stateEmitTimers.set(key, timer);
  }

  createMultipartSession(parent, tasks, sequence = 1) {
    const settings = parent.settings || {};
    return this.internalAgentManager.createSession({
      mode: 'multipart',
      title: `多P · ${parent.title} · 工作流 ${sequence}`,
      providerId: settings.providerId,
      modelId: settings.modelId,
      collectionId: parent.collectionId,
      multiPartParentId: parent.id,
      multiPartTaskIds: tasks.map((task) => task.id),
      taskRequirements: settings.taskRequirements,
      taskOptions: settings.taskOptions
    });
  }

  async ensureReplacementSessions(parentId) {
    const parent = this.requireParent(parentId);
    const active = this.activeSessions(parent.id);
    const eligible = this.partTasks(parent.id).filter((task) => task.enabled !== false && task.status !== 'done' && task.pageState !== 'removed');
    const configured = Math.max(1, Math.min(4, Number(parent.settings?.concurrency) || 2));
    const desired = Math.min(configured, eligible.length);
    const sessions = [];
    for (let index = active.length; index < desired; index += 1) {
      const session = this.createMultipartSession(parent, eligible, active.length + sessions.length + 1);
      try {
        sessions.push(await this.internalAgentManager.start(session.id));
      } catch (error) {
        if (!this.internalAgentManager.running?.has(session.id)) {
          try { this.internalAgentManager.deleteSession(session.id); } catch {}
        }
        throw error;
      }
    }
    if (sessions.length) {
      parent.status = 'running';
      parent.updatedAt = new Date().toISOString();
      this.store.set('multiPartParents', parent.id, parent);
      this.store.commit();
    }
    return sessions;
  }
}

function normalizeSettings(input = {}, base = {}) {
  const source = { ...base, ...input };
  return {
    providerId: String(source.providerId || ''),
    modelId: String(source.modelId || ''),
    concurrency: Math.max(1, Math.min(4, Number(source.concurrency) || 2)),
    taskRequirements: String(source.taskRequirements || '').trim(),
    taskOptions: {
      minimumFrames: Math.max(8, Math.min(300, Number(source.minimumFrames ?? source.taskOptions?.minimumFrames) || 8)),
      frameIntervalSeconds: Math.max(1, Math.min(600, Number(source.frameIntervalSeconds ?? source.taskOptions?.frameIntervalSeconds) || 25)),
      commentLimit: Math.max(0, Math.min(3, Number(source.commentLimit ?? source.taskOptions?.commentLimit) || 3)),
      retainProcessCache: Boolean(source.retainProcessCache ?? source.taskOptions?.retainProcessCache)
    }
  };
}

function normalizeSelectedPages(value, pages) {
  const all = (pages || []).map((page) => String(page.cid || '')).filter(Boolean);
  if (value === undefined || value === null) return all;
  if (!Array.isArray(value)) return all;
  const wanted = new Set(value.map((item) => String(item)));
  return all.filter((cid) => wanted.has(cid));
}

function parentIdFor(bvid, collectionId) {
  return `multipart:${String(collectionId || 'unassigned')}:${String(bvid || '').toUpperCase()}`;
}

function extractBvid(value) { return String(value || '').match(/BV[0-9A-Za-z]{10}/i)?.[0] || ''; }
function assertMultipartVideoSupported(input, info) {
  const urlReason = unsupportedBilibiliUrlReason(input?.url || '');
  if (urlReason) throw new Error(urlReason);
  const rights = info?.rights || {};
  if (rights.is_stein_gate || rights.is_360) throw new Error('当前多P工具不支持互动视频或 360 视频。');
  if (rights.arc_pay || rights.is_ugc_pay) throw new Error('当前多P工具不支持付费或特殊权限视频。');
}
function publicPage(page) { return { page: Number(page.page || 1), cid: String(page.cid || ''), part: String(page.part || ''), duration: Number(page.duration || 0) }; }
function publicPart(task, session = null) {
  if (!task) return null;
  const active = Boolean(session && session.currentTaskId === task.id);
  const progress = task.status === 'done'
    ? 1
    : active
      ? clampProgress(session.progress)
      : clampProgress(task.multiPartProgress);
  const displayStatus = task.status === 'done'
    ? 'completed'
    : task.multiPartStopped
      ? 'stopped'
      : active
        ? 'running'
        : task.status === 'failed' ? 'failed' : 'pending';
  return {
    id: task.id,
    cid: task.cid,
    page: task.page,
    part: task.part,
    title: task.title,
    status: task.status,
    displayStatus,
    enabled: task.enabled !== false,
    stopped: task.multiPartStopped === true,
    pageState: task.pageState || 'active',
    progress,
    progressPercent: Math.round(progress * 100),
    phase: active ? String(session.phase || '') : String(task.multiPartPhase || ''),
    sessionId: active ? String(session.id || '') : '',
    outputMarkdown: task.outputMarkdown || '',
    completedAt: task.completedAt || '',
    error: task.failureReason || task.infrastructureError || task.abortReason || task.multiPartStopReason || '',
    parentDocumentId: task.parentDocumentId
  };
}
function publicPartMetadata(task) { return publicPart(task); }
function publicCollection(collection) { const { cookieFile, collectionRoot, videosDir, exportDir, ...safe } = collection; return safe; }
function escapeMermaid(value) { return String(value || '').replace(/[\[\]{}()<>"']/g, '').slice(0, 80); }
function clampProgress(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function partSummaryLines(parent, task) {
  const cid = safeName(task.cid, 'part', 40);
  const title = `P${Number(task.page || 1)} ${String(task.part || '').replace(/[\r\n]+/g, ' ').trim()}`.trim();
  const link = `parts/cid-${cid}/summary.md`;
  const completed = task.status === 'done';
  const status = completed
    ? (task.pageState === 'removed' ? '已完成，远程页面已移除' : '已完成')
    : task.pageState === 'removed' ? '远程已移除'
      : task.status === 'failed' ? '处理失败，可继续重试'
        : '待处理';
  const lines = [`### ${title}`, '', `- 状态：${status}`, `- CID：${task.cid || '-'}`];
  if (completed) lines.push(`- [打开本 P 完整总结](${link})`);
  lines.push('');
  if (!completed) {
    lines.push(`> ${task.pageState === 'removed' ? '该 P 尚未完成且远程页面已移除，当前没有可展示的小结。' : '该 P 尚未完成；完成后会自动在这里写入小结。'}`, '');
    return lines;
  }
  const summary = readPartSummary(parent, task, `parts/cid-${cid}`);
  lines.push('#### 小结', '', summary || '> 该 P 已完成，但总结文档中没有可提取的“小结”章节；请打开完整总结查看。', '');
  return lines;
}

function readPartSummary(parent, task, relativePartDirectory) {
  try {
    if (!task.outputMarkdown) return '';
    const markdownFile = assertInside(parent.parentRoot, task.outputMarkdown);
    if (!fs.existsSync(markdownFile) || !fs.statSync(markdownFile).isFile()) return '';
    const section = extractLevelTwoSummary(fs.readFileSync(markdownFile, 'utf8'));
    if (!section) return '';
    let value = rebaseRelativeMarkdownDestinations(section, relativePartDirectory)
      .replace(/^(#{1,6})\s+(.+)$/gm, (_match, marks, heading) => `${'#'.repeat(Math.min(6, marks.length + 2))} ${heading}`)
      .trim();
    if (value.length > MAX_INDEX_PART_SUMMARY_CHARACTERS) {
      value = `${value.slice(0, MAX_INDEX_PART_SUMMARY_CHARACTERS).trimEnd()}\n\n> 本 P 小结过长，目录中已截断；请打开完整总结查看剩余内容。`;
    }
    return value;
  } catch {
    return '';
  }
}

function extractLevelTwoSummary(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const result = [];
  let collecting = false;
  let fence = '';
  for (const line of lines) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      const token = marker[1][0];
      if (!fence) fence = token;
      else if (fence === token) fence = '';
    }
    if (!collecting) {
      if (!fence && /^##\s+小结\s*$/u.test(line.trim())) collecting = true;
      continue;
    }
    if (!fence && /^##\s+\S/u.test(line)) break;
    result.push(line);
  }
  return result.join('\n').trim();
}

function rebaseRelativeMarkdownDestinations(markdown, relativeDirectory) {
  const prefix = String(relativeDirectory || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!prefix) return markdown;
  return String(markdown || '').replace(/(!?\[[^\]\r\n]*\])\(([^)\r\n]+)\)/g, (whole, label, rawDestination) => {
    const destination = String(rawDestination || '').trim();
    const angle = destination.match(/^<([^>]+)>(.*)$/);
    const target = angle ? angle[1] : destination.match(/^(\S+)/)?.[1];
    const suffix = angle ? angle[2] : destination.slice(String(target || '').length);
    if (!target || /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) return whole;
    const rebased = `${prefix}/${target.replace(/^\.\//, '')}`;
    return `${label}(${angle ? `<${rebased}>` : rebased}${suffix})`;
  });
}

function writeTextIfChanged(file, content) {
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return false;
  } catch {}
  fs.writeFileSync(file, content, 'utf8');
  return true;
}

module.exports = { MultiPartManager, MULTIPART_KIND, MULTIPART_USER_ID, MULTIPART_USER_NAME, parentIdFor, assertMultipartVideoSupported };
