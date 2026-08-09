const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { collectionDirs, ensureDir, safeName, assertInside, removePathInsideAsync } = require('./workspace');
const { unsupportedBilibiliUrlReason } = require('./video-support');

const MULTIPART_KIND = 'bilibili-multipart';
const MULTIPART_USER_ID = 'builtin-agent-user';
const MULTIPART_USER_NAME = '内置用户';
const ACTIVE_SESSION_STATUSES = new Set(['running', 'draining', 'stopping']);
const MAX_INDEX_PART_SUMMARY_CHARACTERS = 8000;
const VIDEO_INFO_CACHE_TTL_MS = 30 * 1000;
const VIDEO_INFO_CACHE_LIMIT = 8;
const BILIBILI_RISK_CONTROL_RETRIES = 3;
const MULTIPART_PROGRESS_EMIT_INTERVAL_MS = 800;
const MULTIPART_MUTATION_YIELD_INTERVAL = 24;

class MultiPartManager {
  constructor({ store, bili, internalAgentManager, ragAssistant, getCurrentUser, emit }) {
    this.store = store;
    this.bili = bili;
    this.internalAgentManager = internalAgentManager;
    this.ragAssistant = ragAssistant;
    this.getCurrentUser = getCurrentUser || (() => null);
    this.emit = emit || (() => {});
    this.indexRefreshFailures = [];
    this.stateEmitTimers = new Map();
    this.partTaskCache = new Map();
    this.partArtifactCache = new Map();
    this.partSummaryCache = new Map();
    this.partTaskCacheTtlMs = 250;
    this.videoInfoCache = new Map();
    this.videoInfoRequests = new Map();
    this.refreshStoredIndexes();
  }

  state({ reconcile = true } = {}) {
    const storedParents = this.store.list('multiPartParents');
    let partsByParent = this.partTasksByParent(storedParents.map((parent) => parent.id));
    let sessionsByParent = this.activeSessionsByParent(storedParents.map((parent) => parent.id));
    if (reconcile) {
      for (const parent of storedParents) {
        // Explicit state reads remain the repair boundary for legacy or missing
        // artifacts. Live progress events use the lightweight path below.
        this.reconcileParentArtifacts(parent, {
          parts: partsByParent.get(parent.id) || [],
          active: sessionsByParent.get(parent.id) || []
        });
      }
    }
    const currentParents = storedParents.map((parent) => this.store.get('multiPartParents', parent.id) || parent);
    if (reconcile) {
      partsByParent = new Map(currentParents.map((parent) => [parent.id, this.partTasks(parent.id)]));
      sessionsByParent = new Map(currentParents.map((parent) => [parent.id, sessionsByParent.get(parent.id) || []]));
    }
    const parents = currentParents.map((parent) => this.publicParent(parent, {
      reconcile: false,
      verifyArtifacts: false,
      parts: partsByParent.get(parent.id) || [],
      active: sessionsByParent.get(parent.id) || []
    }));
    return {
      collections: this.collections().map(publicCollection),
      parents: parents.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    };
  }

  parentState(parentId) {
    const parent = this.store.get('multiPartParents', String(parentId || ''));
    if (!parent) return null;
    return this.publicParent(parent, {
      reconcile: false,
      verifyArtifacts: false,
      parts: this.partTasks(parent.id),
      active: this.activeSessions(parent.id)
    });
  }

  collections() {
    return this.store.listCollections().filter((item) => item.collectionKind === MULTIPART_KIND);
  }

  async inspect(input = {}) {
    const bvid = extractBvid(input.bvid || input.url);
    if (!bvid) throw new Error('请输入有效的多P BV号或视频链接。');
    const info = await this.readVideoInfo(bvid);
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
    const info = await this.readVideoInfo(bvid);
    assertMultipartVideoSupported(input, info);
    if (info.pages.length < 2) throw new Error('该视频只有一个P，不需要使用多P视频总结工具。');
    const collection = this.requireOrCreateCollection(input.collectionId, input.collectionName || `${info.title || bvid} 多P`);
    const parentId = parentIdFor(bvid, collection.id);
    const existing = this.store.get('multiPartParents', parentId);
    if (existing) {
      await this.mergePages(existing, info.pages, info);
      const refreshed = this.store.get('multiPartParents', parentId);
      const publicValue = this.parentState(refreshed.id);
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
      sourceInfo: sourceInfoSnapshot(info),
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
    const partSeeds = info.pages.map((page) => ({
      page,
      task: this.ensurePartTask(parent, page, selected.includes(String(page.cid)), now)
    }));
    this.ensureParentIndexTask(parent, now);
    for (let index = 0; index < partSeeds.length; index += 1) {
      const seed = partSeeds[index];
      this.seedPartInfo(parent, seed.task, seed.page);
      if ((index + 1) % MULTIPART_MUTATION_YIELD_INTERVAL === 0) await yieldToEventLoop();
    }
    this.store.commit();
    this.writeIndex(parent);
    this.emitState('multipart-parent-created', parentId);
    return this.parentState(parentId);
  }

  async refresh(parentId) {
    const parent = this.requireParent(parentId);
    const info = await this.readVideoInfo(parent.bvid, { force: true });
    assertMultipartVideoSupported({ bvid: parent.bvid }, info);
    if (info.pages.length < 2) throw new Error('B站返回的页面数已少于 2，无法继续作为多P任务处理。');
    await this.mergePages(parent, info.pages, info);
    const refreshed = this.store.get('multiPartParents', parent.id);
    this.writeIndex(refreshed);
    this.emitState('multipart-parent-refreshed', parent.id);
    return this.parentState(refreshed.id);
  }

  async start(input = {}) {
    const parent = this.requireParent(input.parentId);
    const active = this.activeMultipartSessions();
    if (active.length) throw new Error('当前多P父任务已有总结工作进行中，请等待完成或先停止。');
    const selected = normalizeSelectedPages(input.selectedPages, parent.pages);
    const tasks = this.partTasks(parent.id).filter((task) => selected.includes(String(task.cid)) && task.status !== 'done' && task.pageState !== 'removed');
    if (!tasks.length) throw new Error('当前选择范围内没有待总结的 P。');
    await this.prepareCollectionAuthentication(parent);
    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[index];
      const page = (parent.pages || []).find((item) => String(item.cid) === String(task.cid));
      if (page) this.seedPartInfo(parent, task, page);
      if ((index + 1) % MULTIPART_MUTATION_YIELD_INTERVAL === 0) await yieldToEventLoop();
    }
    const settings = { ...parent.settings, ...normalizeSettings(input, parent.settings) };
    const selectedSet = new Set(selected);
    const sessions = [];
    const createdSessions = [];
    const startPromises = [];
    const concurrency = Math.max(1, Math.min(4, Number(settings.concurrency) || 2));
    try {
      this.store.batchSave(() => {
        for (const part of this.partTasks(parent.id)) {
          if (part.status === 'done' || part.pageState === 'removed') continue;
          part.enabled = selectedSet.has(String(part.cid));
          if (part.enabled) {
            part.multiPartStopped = false;
            part.multiPartStopReason = '';
            part.multiPartStoppedAt = '';
            part.multiPartFailed = false;
            part.multiPartFailureReason = '';
            part.multiPartFailedAt = '';
          }
          part.updatedAt = new Date().toISOString();
          this.store.upsertTask(part);
        }
        parent.settings = settings;
        parent.selectedCids = selected;
        parent.status = 'running';
        parent.updatedAt = new Date().toISOString();
        this.store.set('multiPartParents', parent.id, parent);
        for (let index = 0; index < Math.min(concurrency, tasks.length); index += 1) {
          const session = this.createMultipartSession(parent, tasks, index + 1);
          createdSessions.push(session);
          startPromises.push(this.internalAgentManager.start(session.id));
        }
        this.store.commit();
      });
      const startResults = await Promise.allSettled(startPromises);
      const failedStart = startResults.find((result) => result.status === 'rejected');
      sessions.push(...startResults.filter((result) => result.status === 'fulfilled').map((result) => result.value));
      if (failedStart) throw failedStart.reason;
    } catch (error) {
      if (startPromises.length) await Promise.allSettled(startPromises);
      this.store.batchSave(() => {
        for (const session of createdSessions) {
          try { this.internalAgentManager.stop(session.id); } catch {}
        }
      });
      const waits = createdSessions.map((session) => this.internalAgentManager.running?.get(session.id)).filter(Boolean);
      if (waits.length) await Promise.allSettled(waits);
      for (const session of createdSessions) {
        try { this.internalAgentManager.deleteSession(session.id, { persist: false }); } catch {}
      }
      parent.status = 'stopped';
      parent.updatedAt = new Date().toISOString();
      this.store.set('multiPartParents', parent.id, parent);
      this.store.commit();
      throw error;
    }
    this.emitState('multipart-parent-started', parent.id);
    return { parent: this.parentState(parent.id), sessions };
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
    task.multiPartFailed = false;
    task.multiPartFailureReason = '';
    task.multiPartFailedAt = '';
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
      refreshed.multiPartFailed = false;
      refreshed.multiPartFailureReason = '';
      refreshed.multiPartFailedAt = '';
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
      parent: this.parentState(current.id),
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
    return this.parentState(parent.id);
  }

  async delete(parentId) {
    const parent = this.requireParent(parentId);
    if (this.activeSessions(parent.id).length) throw new Error('请先停止正在运行的多P父任务。');
    const collection = this.store.getCollectionById(parent.collectionId);
    if (!collection?.collectionRoot) throw new Error('多P父任务所属收藏夹不存在，无法安全删除产物。');
    for (const session of this.internalAgentManager.listSessions().filter((item) => item.multiPartParentId === parent.id)) {
      try { this.internalAgentManager.deleteSession(session.id, { persist: false }); } catch {}
    }
    const taskIds = [parent.id, ...this.partTasks(parent.id).map((task) => task.id)];
    for (const taskId of taskIds) {
      const task = this.store.getTask(taskId);
      if (task?.artifactDir && fs.existsSync(task.artifactDir)) await removePathInsideAsync(task.allowedRoot || parent.parentRoot, task.artifactDir);
      this.store.delete('tasks', taskId);
      this.store.delete('videos', taskId);
      this.partArtifactCache.delete(taskId);
      this.partSummaryCache.delete(taskId);
    }
    if (fs.existsSync(parent.parentRoot)) await removePathInsideAsync(collection.collectionRoot, parent.parentRoot);
    this.store.delete('multiPartParents', parent.id);
    if (collection) this.store.set('collections', collection.id, { ...collection, videoCount: this.store.listTasks({ collectionId: collection.id }).length, updatedAt: new Date().toISOString() });
    this.store.save();
    this.emitState('multipart-parent-deleted', parent.id);
    return { deleted: true, parentId: parent.id };
  }

  handleAgentEvent(event = {}) {
    const eventType = String(event.type || '');
    if (['stream', 'log', 'session-updated', 'multipart-progress'].includes(eventType)) {
      // Stream deltas can arrive once per token. They only need to wake the
      // throttled viewer; full task/session scans belong to terminal events.
      const lightweightParentId = event.parentId || event.session?.multiPartParentId || '';
      if (lightweightParentId) {
        this.invalidatePartTaskCache(lightweightParentId);
        this.scheduleStateEmit(lightweightParentId);
      }
      return;
    }
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
    if (event.type === 'session-finished' && event.status === 'stopped') {
      // Preserve an explicit user stop while the terminal Agent event is being
      // reconciled. Other terminal failures are allowed to become retryable.
      parent.status = 'stopped';
      parent.updatedAt = new Date().toISOString();
      this.store.set('multiPartParents', parent.id, parent);
    }
    const reconciliation = this.reconcileParentArtifacts(parent, {
      writeIndex: false,
      taskIds: task?.id ? [task.id] : []
    });
    const parts = reconciliation.parts || this.partTasks(parent.id);
    const done = parts.filter((item) => item.status === 'done' && multipartArtifactReady(item)).length;
    const pending = parts.filter((item) => item.status !== 'done' && item.pageState !== 'removed').length;
    const sessionStopped = event.type === 'session-finished' && ['stopped', 'collection-unavailable', 'model-unavailable'].includes(String(event.status || ''));
    const activeSessions = (reconciliation.active || this.activeSessions(parent.id)).filter((session) => event.type !== 'session-finished' || session.id !== event.sessionId);
    parent.status = activeSessions.length
      ? 'running'
      : sessionStopped && event.status === 'stopped'
        ? 'stopped'
        : (pending ? (done ? 'partial' : 'pending') : 'completed');
    parent.completedAt = parent.status === 'completed' ? (parent.completedAt || new Date().toISOString()) : '';
    parent.updatedAt = new Date().toISOString();
    this.store.set('multiPartParents', parent.id, parent);
    this.store.commit();
    this.writeIndex(parent);
    this.emitState('multipart-parent-updated', parent.id);
  }

  requireParent(id) {
    const parent = this.store.get('multiPartParents', String(id || ''));
    if (!parent) throw new Error('多P父任务不存在。');
    return parent;
  }

  partTasks(parentId) {
    const key = String(parentId || '');
    const cached = this.partTaskCache.get(key);
    if (cached && Date.now() - cached.createdAt < this.partTaskCacheTtlMs) return cached.tasks;
    const tasks = this.store.listTasks().filter((task) => task.multiPartParentId === key && task.multiPartRole === 'part');
    this.partTaskCache.set(key, { createdAt: Date.now(), tasks });
    return tasks;
  }

  partTasksByParent(parentIds = []) {
    const wanted = new Set(parentIds.map(String));
    const grouped = new Map([...wanted].map((id) => [id, []]));
    for (const task of this.store.listTasks()) {
      const parentId = String(task.multiPartParentId || '');
      if (task.multiPartRole === 'part' && wanted.has(parentId)) grouped.get(parentId).push(task);
    }
    const createdAt = Date.now();
    for (const [parentId, tasks] of grouped) this.partTaskCache.set(parentId, { createdAt, tasks });
    return grouped;
  }

  activeSessionsByParent(parentIds = []) {
    const wanted = new Set(parentIds.map(String));
    const grouped = new Map([...wanted].map((id) => [id, []]));
    for (const session of this.internalAgentManager.listSessions()) {
      const parentId = String(session.multiPartParentId || '');
      if (!wanted.has(parentId)) continue;
      if (!ACTIVE_SESSION_STATUSES.has(session.status) && !this.internalAgentManager.running?.has(session.id)) continue;
      grouped.get(parentId).push(session);
    }
    return grouped;
  }

  reconcileParentArtifacts(parentInput, { writeIndex = true, parts: providedParts = null, active: providedActive = null, taskIds = null } = {}) {
    const parent = this.store.get('multiPartParents', String(parentInput?.id || '')) || parentInput;
    if (!parent?.id) return { changed: false, parent };
    const parts = Array.isArray(providedParts) ? providedParts : (() => {
      this.invalidatePartTaskCache(parent.id);
      return this.partTasks(parent.id);
    })();
    const wantedTaskIds = taskIds === null ? null : new Set((taskIds || []).map(String));
    let changed = false;
    let artifactChanged = false;
    let missingArtifactDetected = false;
    const now = new Date().toISOString();
    for (const task of parts) {
      if (wantedTaskIds && !wantedTaskIds.has(String(task.id))) continue;
      if (task.status !== 'done') continue;
      const artifact = resolveMultipartArtifact(task);
      if (artifact.ready) {
        if (artifact.markdownFile && task.outputMarkdown !== artifact.markdownFile) {
          task.outputMarkdown = artifact.markdownFile;
          task.updatedAt = now;
          this.store.upsertTask(task);
          changed = true;
          artifactChanged = true;
        }
        continue;
      }
      const reason = `P${task.page || ''} 已完成状态对应的总结产物缺失或为空，请重试该 P。`;
      Object.assign(task, {
        status: 'pending',
        enabled: false,
        workId: '',
        claimedBy: '',
        claimedAt: '',
        leaseExpiresAt: '',
        completedAt: '',
        outputMarkdown: '',
        validatorErrors: [reason],
        failureReason: reason,
        multiPartFailed: true,
        multiPartFailureReason: reason,
        multiPartFailedAt: now,
        multiPartStopped: false,
        multiPartStopReason: '',
        multiPartStoppedAt: '',
        multiPartProgress: 0,
        multiPartPhase: '完成状态与产物不一致，可重试',
        updatedAt: now
      });
      this.store.upsertTask(task);
      changed = true;
      artifactChanged = true;
      missingArtifactDetected = true;
    }
    let refreshedParts = parts;
    if (!Array.isArray(providedParts)) {
      this.invalidatePartTaskCache(parent.id);
      refreshedParts = this.partTasks(parent.id);
    } else {
      this.partTaskCache.set(parent.id, { createdAt: Date.now(), tasks: refreshedParts });
    }
    const active = Array.isArray(providedActive) ? providedActive : this.activeSessions(parent.id);
    const nextStatus = deriveMultipartParentStatus(parent, refreshedParts, active, { missingArtifactDetected, verifyArtifacts: false });
    const statusChanged = parent.status !== nextStatus;
    if (statusChanged) {
      parent.status = nextStatus;
      changed = true;
    }
    const nextCompletedAt = nextStatus === 'completed' ? (parent.completedAt || now) : '';
    const completedAtChanged = parent.completedAt !== nextCompletedAt;
    if (completedAtChanged) {
      parent.completedAt = nextCompletedAt;
      changed = true;
    }
    const parentTask = this.store.getTask(parent.id) || {
      multiPartRole: 'parent',
      artifactDir: parent.parentRoot,
      outputMarkdown: path.join(parent.parentRoot || '', 'index.md')
    };
    const indexReady = multipartArtifactReady(parentTask);
    const indexNeedsRepair = Boolean(writeIndex && parent.parentRoot && fs.existsSync(parent.parentRoot) && !indexReady);
    if (!changed && !indexNeedsRepair) return { changed: false, parent, parts: refreshedParts, active };
    parent.updatedAt = now;
    this.store.set('multiPartParents', parent.id, parent);
    this.store.commit();
    if (writeIndex && parent.parentRoot && fs.existsSync(parent.parentRoot) && (indexNeedsRepair || artifactChanged || statusChanged)) {
      try {
        this.writeIndex(parent);
        this.store.commit();
      } catch {}
    }
    return { changed: true, parent, parts: refreshedParts, active };
  }

  invalidatePartTaskCache(parentId = '') {
    const key = String(parentId || '');
    if (key) this.partTaskCache.delete(key);
    else this.partTaskCache.clear();
  }

  activeSessions(parentId) {
    return this.internalAgentManager.listSessions().filter((session) => session.multiPartParentId === parentId && (ACTIVE_SESSION_STATUSES.has(session.status) || this.internalAgentManager.running?.has(session.id)));
  }

  activeMultipartSessions() {
    return this.internalAgentManager.listSessions().filter((session) => session.mode === 'multipart' && (ACTIVE_SESSION_STATUSES.has(session.status) || this.internalAgentManager.running?.has(session.id)));
  }

  async readVideoInfo(bvid, { force = false } = {}) {
    const key = String(bvid || '').trim();
    const cached = this.videoInfoCache.get(key);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.info;
    if (this.videoInfoRequests.has(key)) return this.videoInfoRequests.get(key);

    const request = this.fetchVideoInfoWithRetry(key).then((info) => {
      this.videoInfoCache.delete(key);
      this.videoInfoCache.set(key, { info, expiresAt: Date.now() + VIDEO_INFO_CACHE_TTL_MS });
      while (this.videoInfoCache.size > VIDEO_INFO_CACHE_LIMIT) this.videoInfoCache.delete(this.videoInfoCache.keys().next().value);
      return info;
    }).finally(() => {
      if (this.videoInfoRequests.get(key) === request) this.videoInfoRequests.delete(key);
    });
    this.videoInfoRequests.set(key, request);
    return request;
  }

  async fetchVideoInfoWithRetry(bvid) {
    for (let attempt = 0; attempt <= BILIBILI_RISK_CONTROL_RETRIES; attempt += 1) {
      try {
        return await this.bili.getVideoInfo(bvid);
      } catch (error) {
        if (!isBilibiliRiskControlError(error)) throw error;
        if (attempt >= BILIBILI_RISK_CONTROL_RETRIES) throw multipartRiskControlError(error);
        await delay(bilibiliRiskControlDelay(attempt));
      }
    }
    throw multipartRiskControlError();
  }

  async prepareCollectionAuthentication(parent) {
    const collection = this.store.getCollectionById(parent.collectionId);
    const user = this.getCurrentUser?.();
    if (!collection || !user?.isLogin) return collection;

    let cookieFile = String(user.cookieFile || '').trim();
    if (!cookieFile || !fs.existsSync(cookieFile)) {
      try {
        cookieFile = await this.bili.exportCookies(user.name || String(user.mid || user.id || 'multipart'));
      } catch (error) {
        console.warn(`[multipart] unable to export Bilibili cookies: ${error.message || String(error)}`);
        return collection;
      }
    }
    if (!cookieFile || !fs.existsSync(cookieFile) || path.resolve(cookieFile) === path.resolve(String(collection.cookieFile || ''))) return collection;
    const updated = this.store.upsertCollection({
      ...collection,
      cookieFile,
      cookieExportedAt: new Date().toISOString()
    });
    return updated;
  }

  seedPartInfo(parent, task, page) {
    if (!task?.preallocatedArtifactDir || !page) return '';
    const artifactDir = assertInside(parent.parentRoot, task.preallocatedArtifactDir);
    ensureDir(artifactDir);
    const file = path.join(artifactDir, 'info.json');
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    const info = buildPartInfo(parent, page, task, existing);
    writeTextIfChanged(file, `${JSON.stringify(info, null, 2)}\n`);
    return file;
  }

  refreshStoredIndexes() {
    this.indexRefreshFailures = [];
    let refreshed = 0;
    const parents = this.store.list('multiPartParents');
    const partsByParent = this.partTasksByParent(parents.map((parent) => parent.id));
    const sessionsByParent = this.activeSessionsByParent(parents.map((parent) => parent.id));
    for (const parent of parents) {
      if (!parent?.parentRoot || !fs.existsSync(parent.parentRoot)) continue;
      try {
        this.reconcileParentArtifacts(parent, {
          writeIndex: false,
          parts: partsByParent.get(parent.id) || [],
          active: sessionsByParent.get(parent.id) || []
        });
        this.writeIndex(this.store.get('multiPartParents', parent.id) || parent);
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
      multiPartFailed: Boolean(current?.multiPartFailed),
      multiPartFailureReason: String(current?.multiPartFailureReason || ''),
      multiPartFailedAt: String(current?.multiPartFailedAt || ''),
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
    parent.aid = info.aid || parent.aid;
    parent.sourceInfo = sourceInfoSnapshot(info);
    parent.lastRefreshedAt = now;
    const partSeeds = [];
    for (const page of pages) {
      const task = this.ensurePartTask(parent, page, selected.has(String(page.cid)), now);
      if (task.status !== 'done') partSeeds.push({ task, page });
    }
    for (let index = 0; index < partSeeds.length; index += 1) {
      const seed = partSeeds[index];
      this.seedPartInfo(parent, seed.task, seed.page);
      if ((index + 1) % MULTIPART_MUTATION_YIELD_INTERVAL === 0) await yieldToEventLoop();
    }
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
    const artifacts = new Map(parts.map((task) => [task.id, this.cachedPartArtifact(task)]));
    const completedParts = parts.filter((task) => artifacts.get(task.id)?.ready);
    const partSummaries = parts.flatMap((task) => partSummaryLines(parent, task, artifacts.get(task.id), this.partSummaryCache));
    const coverReference = this.ensureParentCover(parent, parts);
    const lines = [
      `# ${parent.title} · 多P视频目录`, '',
      '## 小结', '',
      `该父任务包含 ${parent.pages.length} 个 P，当前已完成 ${completedParts.length} 个。每个 P 的详细总结单独存放，并保留稳定 CID 标识。`, '',
      '## 思维导图', '', '```mermaid', 'flowchart TD', '  A[多P视频] --> B[逐P总结]', ...parts.map((task) => `  B --> P${task.page}[P${task.page} ${escapeMermaid(task.part)}]`), '```', '',
      '## 目录', '',
      ...parts.map((task) => `- [P${task.page} ${task.part}](parts/cid-${safeName(task.cid, 'part', 40)}/summary.md) · ${artifacts.get(task.id)?.ready ? '已完成' : task.pageState === 'removed' ? '远程已移除' : '待处理'}`), '',
      '## 每 P 小结', '',
      ...partSummaries,
      '## 字幕', '', '每个 P 的 ASR 时间戳和站内字幕位于对应 P 的产物目录。', '',
      '## 处理记录', '', `- BV：${parent.bvid}`, `- 最后刷新：${parent.lastRefreshedAt || parent.updatedAt}`, `- 产物身份：${parent.parentDocumentId}`
    ];
    if (coverReference) lines.splice(1, 0, `![视频封面](${coverReference})`, '');
    writeTextIfChanged(path.join(parent.parentRoot, 'index.md'), `${lines.join('\n')}\n`);
    const { sourceInfo: _sourceInfo, ...parentMetadata } = parent;
    writeTextIfChanged(path.join(parent.parentRoot, 'metadata.json'), `${JSON.stringify({ ...parentMetadata, coverFile: coverReference, parts: parts.map(publicPartMetadata) }, null, 2)}\n`);
  }

  cachedPartArtifact(task) {
    if (task.status !== 'done') return { ready: false, markdownFile: '', root: '' };
    const cacheKey = [task.status, task.updatedAt, task.outputMarkdown, task.artifactDir, task.preallocatedArtifactDir].map((value) => String(value || '')).join('|');
    const cached = this.partArtifactCache.get(task.id);
    if (cached?.key === cacheKey) return cached.artifact;
    const artifact = resolveMultipartArtifact(task);
    this.partArtifactCache.set(task.id, { key: cacheKey, artifact });
    return artifact;
  }

  ensureParentCover(parent, parts) {
    if (parent.coverFile) {
      const existing = path.isAbsolute(String(parent.coverFile))
        ? String(parent.coverFile)
        : path.join(parent.parentRoot, String(parent.coverFile));
      try {
        if (fs.statSync(assertInside(parent.parentRoot, existing)).isFile()) return path.basename(existing).replace(/\\/g, '/');
      } catch {}
    }
    const ordered = parts.filter((task) => task.status === 'done').sort((left, right) => {
      const leftP1 = Number(left.page || 0) === 1 ? 0 : 1;
      const rightP1 = Number(right.page || 0) === 1 ? 0 : 1;
      return leftP1 - rightP1 || Number(left.page || 0) - Number(right.page || 0);
    });
    const candidates = [];
    for (const task of ordered) {
      const artifactDir = String(task.artifactDir || task.preallocatedArtifactDir || '');
      if (!artifactDir) continue;
      if (task.coverFile) candidates.push(path.isAbsolute(String(task.coverFile)) ? String(task.coverFile) : path.join(artifactDir, String(task.coverFile)));
      for (const name of ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp', 'thumbnail.jpg', 'thumbnail.png']) candidates.push(path.join(artifactDir, name));
      try {
        for (const name of fs.readdirSync(path.join(artifactDir, 'frames'))) {
          if (/^frame-\d+\.(?:jpe?g|png|webp)$/i.test(name)) candidates.push(path.join(artifactDir, 'frames', name));
        }
      } catch {}
    }
    const source = candidates.find((candidate) => {
      try { return fs.statSync(assertInside(parent.parentRoot, candidate)).isFile(); } catch { return false; }
    });
    if (source) {
      const extension = ['.jpg', '.jpeg', '.png', '.webp'].includes(path.extname(source).toLowerCase()) ? path.extname(source).toLowerCase() : '.jpg';
      const target = path.join(parent.parentRoot, `cover${extension === '.jpeg' ? '.jpg' : extension}`);
      try {
        if (path.resolve(source) !== path.resolve(target)) fs.copyFileSync(source, target);
        for (const staleName of ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp']) {
          const stale = path.join(parent.parentRoot, staleName);
          if (path.resolve(stale) !== path.resolve(target) && fs.existsSync(stale)) fs.rmSync(stale, { force: true });
        }
        parent.coverFile = path.basename(target);
        this.store.set('multiPartParents', parent.id, parent);
        return path.basename(target).replace(/\\/g, '/');
      } catch {}
    }
    return /^https?:\/\//i.test(String(parent.cover || '').trim()) ? String(parent.cover).trim() : '';
  }

  publicParent(parent, { reconcile = true, verifyArtifacts = true, parts = null, active = null } = {}) {
    if (reconcile) {
      this.reconcileParentArtifacts(parent);
      verifyArtifacts = false;
      parts = null;
      active = null;
    }
    parent = this.store.get('multiPartParents', parent.id) || parent;
    const resolvedParts = (parts || this.partTasks(parent.id)).sort((a, b) => Number(a.page || 0) - Number(b.page || 0));
    const resolvedActive = active || this.activeSessions(parent.id);
    const sessionsByTask = new Map(resolvedActive
      .filter((session) => session.currentTaskId)
      .map((session) => [String(session.currentTaskId), session]));
    const tasksByCid = new Map(resolvedParts.map((task) => [String(task.cid), task]));
    const publicParts = resolvedParts.map((task) => publicPart(task, sessionsByTask.get(String(task.id)), { verifyArtifacts }));
    const completed = resolvedParts.filter((task) => task.status === 'done' && (!verifyArtifacts || multipartArtifactReady(task))).length;
    const running = resolvedParts.filter((task) => sessionsByTask.has(String(task.id))).length;
    const stopped = resolvedParts.filter((task) => task.multiPartStopped === true).length;
    const failed = resolvedParts.filter((task) => isMultipartTaskFailed(task)).length;
    const progress = publicParts.length
      ? publicParts.reduce((total, task) => total + clampProgress(task.progress), 0) / publicParts.length
      : 0;
    const { parentRoot: _parentRoot, sourceInfo: _sourceInfo, ...publicParent } = parent;
    return {
      ...publicParent,
      pages: (parent.pages || []).map((page) => {
        const task = tasksByCid.get(String(page.cid));
        return { ...page, task: publicPart(task, sessionsByTask.get(String(task?.id || '')), { verifyArtifacts }) };
      }),
      parts: publicParts,
      completed,
      total: resolvedParts.length,
      progress,
      running,
      stopped,
      failed,
      activeSessions: resolvedActive.map((session) => ({ id: session.id, status: session.status, title: session.title, currentTaskId: session.currentTaskId || '' }))
    };
  }

  emitState(type, parentId) {
    const key = String(parentId || '');
    const timer = this.stateEmitTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.stateEmitTimers.delete(key);
    }
    const parent = this.parentState(key);
    this.emit({
      type,
      parentId: key,
      parent,
      removed: !parent,
      ...(['multipart-parent-created', 'multipart-parent-deleted'].includes(type)
        ? { collections: this.collections().map(publicCollection) }
        : {})
    });
  }

  scheduleStateEmit(parentId) {
    const key = String(parentId || '');
    if (!key || this.stateEmitTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.stateEmitTimers.delete(key);
      const parent = this.parentState(key);
      if (parent) this.emit({ type: 'multipart-progress', parentId: key, parent });
    }, MULTIPART_PROGRESS_EMIT_INTERVAL_MS);
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
function deriveMultipartParentStatus(parent = {}, parts = [], activeSessions = [], { missingArtifactDetected = false, verifyArtifacts = true } = {}) {
  if (activeSessions.length) return 'running';
  const available = parts.filter((task) => task.pageState !== 'removed');
  const completed = available.filter((task) => task.status === 'done' && (!verifyArtifacts || multipartArtifactReady(task))).length;
  if (available.length > 0 && completed === available.length) return 'completed';
  // A user stop is a meaningful terminal UI state. Keep it until the user
  // explicitly resumes the parent, unless reconciliation found a completed
  // task whose artifact disappeared and needs to be made retryable.
  if (parent.status === 'stopped' && !missingArtifactDetected) return 'stopped';
  return completed > 0 ? 'partial' : 'pending';
}

function resolveMultipartArtifact(task = {}) {
  const preferredName = task.multiPartRole === 'parent' ? 'index.md' : 'summary.md';
  const roots = [...new Set([task.artifactDir, task.preallocatedArtifactDir, task.parentRoot]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .map((value) => path.resolve(value)))];
  const pointer = String(task.outputMarkdown || '').trim();
  const candidates = [];
  if (pointer && path.basename(pointer).toLowerCase() === preferredName) candidates.push(path.resolve(pointer));
  for (const root of roots) candidates.push(path.join(root, preferredName));
  for (const markdownFile of [...new Set(candidates)]) {
    try {
      const containingRoot = roots.find((root) => isPathWithin(root, markdownFile));
      if (roots.length && !containingRoot) continue;
      const stat = fs.statSync(markdownFile);
      if (!stat.isFile()) continue;
      if (stat.size > 0) {
        return { ready: true, markdownFile, root: containingRoot || path.dirname(markdownFile) };
      }
    } catch {}
  }
  return { ready: false, markdownFile: '', root: roots[0] || '' };
}
function multipartArtifactReady(task = {}) { return resolveMultipartArtifact(task).ready; }
function isPathWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function assertMultipartVideoSupported(input, info) {
  const urlReason = unsupportedBilibiliUrlReason(input?.url || '');
  if (urlReason) throw new Error(urlReason);
  const rights = info?.rights || {};
  if (rights.is_stein_gate || rights.is_360) throw new Error('当前多P工具不支持互动视频或 360 视频。');
  if (rights.arc_pay || rights.is_ugc_pay) throw new Error('当前多P工具不支持付费或特殊权限视频。');
}
function publicPage(page) { return { page: Number(page.page || 1), cid: String(page.cid || ''), part: String(page.part || ''), duration: Number(page.duration || 0) }; }
function publicPart(task, session = null, { verifyArtifacts = true } = {}) {
  if (!task) return null;
  const active = Boolean(session && session.currentTaskId === task.id);
  const completed = task.status === 'done' && (!verifyArtifacts || multipartArtifactReady(task));
  const progress = completed
    ? 1
    : active
      ? clampProgress(session.progress)
      : clampProgress(task.multiPartProgress);
  const displayStatus = completed
    ? 'completed'
    : task.multiPartStopped
      ? 'stopped'
      : active
        ? 'running'
        : isMultipartTaskFailed(task) ? 'failed' : 'pending';
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
    failed: isMultipartTaskFailed(task),
    pageState: task.pageState || 'active',
    progress,
    progressPercent: Math.round(progress * 100),
    phase: active ? String(session.phase || '') : String(task.multiPartPhase || ''),
    sessionId: active ? String(session.id || '') : '',
    outputMarkdown: task.outputMarkdown || '',
    completedAt: task.completedAt || '',
    error: task.failureReason || task.infrastructureError || task.multiPartFailureReason || task.abortReason || task.multiPartStopReason || '',
    parentDocumentId: task.parentDocumentId
  };
}
function publicPartMetadata(task) { return publicPart(task); }
function isMultipartTaskFailed(task) {
  return Boolean(task && (task.multiPartFailed === true || task.status === 'failed'));
}
function publicCollection(collection) { const { cookieFile, collectionRoot, videosDir, exportDir, ...safe } = collection; return safe; }
function escapeMermaid(value) { return String(value || '').replace(/[\[\]{}()<>"']/g, '').slice(0, 80); }
function clampProgress(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function partSummaryLines(parent, task, artifact, summaryCache) {
  const cid = safeName(task.cid, 'part', 40);
  const title = `P${Number(task.page || 1)} ${String(task.part || '').replace(/[\r\n]+/g, ' ').trim()}`.trim();
  const link = `parts/cid-${cid}/summary.md`;
  const completed = task.status === 'done' && artifact?.ready;
  const status = completed
    ? (task.pageState === 'removed' ? '已完成，远程页面已移除' : '已完成')
    : task.pageState === 'removed' ? '远程已移除'
      : isMultipartTaskFailed(task) ? '处理失败，可继续重试'
        : '待处理';
  const lines = [`### ${title}`, '', `- 状态：${status}`, `- CID：${task.cid || '-'}`];
  if (completed) lines.push(`- [打开本 P 完整总结](${link})`);
  lines.push('');
  if (!completed) {
    lines.push(`> ${task.pageState === 'removed' ? '该 P 尚未完成且远程页面已移除，当前没有可展示的小结。' : '该 P 尚未完成；完成后会自动在这里写入小结。'}`, '');
    return lines;
  }
  const summary = readPartSummary(parent, task, `parts/cid-${cid}`, artifact, summaryCache);
  lines.push('#### 小结', '', summary || '> 该 P 已完成，但总结文档中没有可提取的“小结”章节；请打开完整总结查看。', '');
  return lines;
}

function readPartSummary(parent, task, relativePartDirectory, artifact, summaryCache) {
  try {
    const markdownFile = assertInside(parent.parentRoot, artifact?.markdownFile || task.outputMarkdown);
    const cacheKey = [task.updatedAt, markdownFile, relativePartDirectory].map((value) => String(value || '')).join('|');
    const cached = summaryCache?.get(task.id);
    if (cached?.key === cacheKey) return cached.summary;
    const section = extractLevelTwoSummary(fs.readFileSync(markdownFile, 'utf8'));
    if (!section) {
      summaryCache?.set(task.id, { key: cacheKey, summary: '' });
      return '';
    }
    let value = rebaseRelativeMarkdownDestinations(section, relativePartDirectory)
      .replace(/^(#{1,6})\s+(.+)$/gm, (_match, marks, heading) => `${'#'.repeat(Math.min(6, marks.length + 2))} ${heading}`)
      .trim();
    if (value.length > MAX_INDEX_PART_SUMMARY_CHARACTERS) {
      value = `${value.slice(0, MAX_INDEX_PART_SUMMARY_CHARACTERS).trimEnd()}\n\n> 本 P 小结过长，目录中已截断；请打开完整总结查看剩余内容。`;
    }
    summaryCache?.set(task.id, { key: cacheKey, summary: value });
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

function sourceInfoSnapshot(info = {}) {
  return {
    bvid: String(info.bvid || ''),
    aid: info.aid || '',
    title: String(info.title || ''),
    owner: {
      mid: info.owner?.mid || '',
      name: String(info.owner?.name || ''),
      face: String(info.owner?.face || '')
    },
    pubdate: info.pubdate || 0,
    ctime: info.ctime || 0,
    desc: String(info.desc || ''),
    pic: String(info.pic || ''),
    duration: Number(info.duration || 0),
    dimension: info.dimension || null,
    redirectUrl: String(info.redirectUrl || ''),
    rights: info.rights || {},
    stat: info.stat || {},
    fetchedAt: String(info.fetchedAt || new Date().toISOString())
  };
}

function buildPartInfo(parent, page, task, existing = {}) {
  const source = parent.sourceInfo || {};
  const owner = source.owner && typeof source.owner === 'object' ? source.owner : {};
  return {
    ...existing,
    ...source,
    bvid: String(parent.bvid || source.bvid || ''),
    aid: source.aid || parent.aid || existing.aid || '',
    title: String(parent.title || source.title || existing.title || parent.bvid || ''),
    owner: { ...owner, name: String(parent.owner || owner.name || '') },
    pic: String(parent.cover || source.pic || existing.pic || ''),
    duration: Number(source.duration || existing.duration || (parent.pages || []).reduce((total, item) => total + Number(item.duration || 0), 0)),
    dimension: source.dimension || existing.dimension || page.dimension || null,
    redirectUrl: String(source.redirectUrl || existing.redirectUrl || ''),
    rights: source.rights || existing.rights || {},
    stat: source.stat || existing.stat || {},
    tags: Array.isArray(existing.tags) ? existing.tags : [],
    pages: [publicPage(page)],
    page: Number(page.page || 1),
    cid: String(page.cid || ''),
    url: String(task.url || `https://www.bilibili.com/video/${parent.bvid}?p=${Number(page.page || 1)}`),
    fetchedAt: String(source.fetchedAt || parent.lastRefreshedAt || parent.updatedAt || new Date().toISOString())
  };
}

function isBilibiliRiskControlError(error) {
  return /(?:HTTP\s*412|Bilibili API\s*-412|Request was banned|请求被拦截|临时风控)/i.test(String(error?.message || error || ''));
}

function multipartRiskControlError(cause = null) {
  const error = new Error('B站触发临时风控（HTTP 412 / -412），多P工具已完成退避重试但接口仍未恢复。请暂停反复操作，稍后再试；使用代理时请让 B站域名直连。');
  error.code = 'BILIBILI_RISK_CONTROL';
  if (cause) error.cause = cause;
  return error;
}

function bilibiliRiskControlDelay(attempt) {
  return Math.min(12_000, 1_600 * (2 ** Math.max(0, Number(attempt) || 0))) + 250 + Math.floor(Math.random() * 650);
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function writeTextIfChanged(file, content) {
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return false;
  } catch {}
  fs.writeFileSync(file, content, 'utf8');
  return true;
}

module.exports = { MultiPartManager, MULTIPART_KIND, MULTIPART_USER_ID, MULTIPART_USER_NAME, parentIdFor, assertMultipartVideoSupported };
