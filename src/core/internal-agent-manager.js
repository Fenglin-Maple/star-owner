const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { applySubmissionFinalization, stageSubmissionFinalization } = require('./submission-artifacts');
const { collectionBlockReason, collectionStorageName } = require('./collection-state');
const { promoteMindMap } = require('./markdown');
const { isLoginRequiredMessage, isVideoUnavailableMessage, loginRequiredError } = require('./media-errors');
const { abortTaskAttempt, createWorkId } = require('./task-attempt');
const { removeUnavailableTask } = require('./unavailable-task');
const { resolveBvid } = require('./video-cache-manager');
const { validateSubmission } = require('./validation');
const {
  collectionDirs,
  ensureDir,
  normalizeTags,
  assertInside,
  videoArtifactDir
} = require('./workspace');

const INTERNAL_USER_ID = 'builtin-agent-user';
const INTERNAL_USER_NAME = '内置用户';
const LEASE_MS = 15 * 60 * 1000;
const TEMPLATE_FILE = path.join(__dirname, '..', '..', 'templates', 'video-summary-template.md');
const TERMINAL_RUNS = new Set(['succeeded', 'failed', 'cancelled', 'timeout', 'skipped']);
const DEFAULT_AGENT_CONTEXT_WINDOW = 1_000_000;
const DEFAULT_AGENT_OUTPUT_TOKENS = 128_000;
const CONTEXT_COMPACTION_TRIGGER = 0.82;
const GENERATION_SYSTEM_PROMPT = '你是星藏家的内置视频知识整理 Agent。必须依据提供的真实素材生成完整、严谨、带时间轴和关键帧的中文 Markdown，不得编造未出现的信息。只返回 Markdown 正文。';
const COMPACTOR_SYSTEM_PROMPT = '你是星藏家的上下文整理 Agent。你的任务不是写最终视频总结，而是把超长原始素材整理为无重复、可继续推理的结构化证据。必须保留时间轴、事实、步骤、参数、代码、限制、例外、字幕冲突、评论立场和不确定性；不得补充素材外事实，不得用“其余略”省略未处理内容。';

class InternalAgentManager {
  constructor({ store, toolRunner, ragAssistant, bili, getCurrentUser, emit }) {
    this.store = store;
    this.toolRunner = toolRunner;
    this.ragAssistant = ragAssistant;
    this.bili = bili;
    this.getCurrentUser = getCurrentUser || (() => null);
    this.emitEvent = emit || (() => {});
    this.controllers = new Map();
    this.running = new Map();
    this.startLocks = new Map();
    this.forcedStops = new Map();
    this.ensureInternalUser();
    this.recoverInterruptedSessions();
    this.purgeKnownUnavailableTasks();
  }

  state() {
    return {
      providers: this.ragAssistant.listProviders(),
      sessions: this.listSessions().map((session) => this.publicSession(session)),
      collections: this.store.listCollections().map((collection) => {
        const unavailableReason = agentCollectionBlockReason(collection);
        return {
          id: collection.id,
          name: collection.name,
          userName: collection.userName,
          internal: collection.userId === INTERNAL_USER_ID || collection.internal === true,
          collectionAvailable: !unavailableReason,
          collectionUnavailableReason: unavailableReason,
          ...this.collectionProgress(collection.id)
        };
      }),
      internalCollections: this.listInternalCollections()
    };
  }

  emit(event) {
    this.emitEvent(event);
  }

  listSessions() {
    return this.store.list('internalAgentSessions').sort((a, b) => {
      const created = String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
      return created || String(b.id || '').localeCompare(String(a.id || ''));
    });
  }

  listInternalCollections() {
    return this.store.listCollections().filter((collection) => (collection.userId === INTERNAL_USER_ID || collection.internal === true)
      && !['video-cache', 'document-archive'].includes(collection.collectionKind));
  }

  createInternalCollection(name) {
    const collectionName = String(name || '').trim();
    if (!collectionName) throw new Error('内置收藏夹名称不能为空。');
    const duplicate = this.listInternalCollections().find((item) => item.name === collectionName);
    if (duplicate) return duplicate;
    const workspace = this.requireWorkspace();
    const dirs = collectionDirs(workspace.root, INTERNAL_USER_NAME, collectionName);
    const now = new Date().toISOString();
    return this.store.upsertCollection({
      id: `builtin:${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      userId: INTERNAL_USER_ID,
      userName: INTERNAL_USER_NAME,
      name: collectionName,
      storageName: collectionName,
      label: 'builtin',
      internal: true,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      collectionRoot: dirs.root,
      videosDir: dirs.videos,
      exportDir: dirs.exports,
      videoCount: 0,
      createdAt: now,
      updatedAt: now
    });
  }

  createSession(input = {}) {
    const provider = this.ragAssistant.rawProvider(input.providerId);
    const modelId = String(input.modelId || '');
    if (!(provider.enabledModels || []).some((model) => model.id === modelId)) throw new Error('请选择已启用的模型。');
    const collection = this.store.getCollectionById(String(input.collectionId || ''));
    if (!collection) throw new Error('请选择工作收藏夹。');
    const collectionReason = agentCollectionBlockReason(collection);
    if (collectionReason) throw new Error(collectionReason);
    const worker = this.store.registerWorker({
      tool: 'star-owner-internal',
      model: modelId,
      sessionLabel: String(input.title || `内置 Agent · ${collection.name}`),
      metadata: { providerId: provider.id, internalAgent: true }
    });
    const now = new Date().toISOString();
    const session = {
      id: `agent-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      mode: input.mode === 'single' ? 'single' : 'queue',
      title: String(input.title || `Agent · ${collection.name}`).trim(),
      providerId: provider.id,
      modelId,
      collectionId: collection.id,
      workerId: worker.id,
      status: 'idle',
      acceptNewTasks: input.acceptNewTasks !== false,
      taskRequirements: String(input.taskRequirements || '').trim(),
      taskOptions: {
        frames: clamp(input.taskOptions?.frames, 4, 30, 12),
        commentLimit: clamp(input.taskOptions?.commentLimit, 0, 3, 3)
      },
      singleTaskId: String(input.singleTaskId || ''),
      currentTaskId: '',
      currentRunId: '',
      phase: '等待启动',
      progress: 0,
      reasoning: '',
      content: '',
      logs: [],
      completed: 0,
      failed: 0,
      skipped: 0,
      tokenUsage: { input: 0, output: 0, total: 0 },
      contextCycle: 0,
      contextPercent: 0,
      contextInputTokens: 0,
      contextOutputLimit: 0,
      contextCompactions: 0,
      createdAt: now,
      updatedAt: now
    };
    this.saveSession(session);
    this.log(session, '会话已创建，等待启动。');
    return this.publicSession(session);
  }

  async createSingleTask(input = {}) {
    const provider = this.ragAssistant.rawProvider(input.providerId);
    const modelId = String(input.modelId || '');
    if (!(provider.enabledModels || []).some((model) => model.id === modelId)) throw new Error('Select an enabled model before creating a single-video task.');
    const bvid = extractBvid(input.video) || await resolveBvid(input.video);
    if (!bvid) throw new Error('请输入有效的 BV 号或 Bilibili 视频链接。');
    const collection = this.store.getCollectionById(String(input.collectionId || ''));
    if (!collection || !(collection.userId === INTERNAL_USER_ID || collection.internal === true)) throw new Error('请选择内置用户下的内置收藏夹。');
    if (['video-cache', 'document-archive'].includes(collection.collectionKind)) throw new Error('请选择普通内置收藏夹，不能把单视频任务写入缓存库或文档归档库。');
    const workspace = this.requireWorkspace();
    const dirs = collectionDirs(workspace.root, INTERNAL_USER_NAME, collectionStorageName(collection));
    const now = new Date().toISOString();
    const taskId = `${collection.id}:${bvid}:single-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    this.store.upsertTask({
      id: taskId,
      collectionId: collection.id,
      bvid,
      title: bvid,
      owner: '',
      duration: 0,
      url: `https://www.bilibili.com/video/${bvid}`,
      favoriteAddedAt: now,
      publishedAt: '',
      enabled: true,
      status: 'pending',
      claimedBy: '',
      attempts: 0,
      allowedRoot: dirs.root,
      artifactDir: '',
      outputMarkdown: '',
      validatorErrors: [],
      internal: true,
      singleTask: true,
      publicAttempt: true,
      cookieFile: '',
      keepVideoCache: Boolean(input.keepVideoCache),
      createdAt: now,
      updatedAt: now
    });
    collection.videoCount = this.store.listTasks({ collectionId: collection.id }).length;
    collection.updatedAt = now;
    this.store.upsertCollection(collection);
    this.store.commit();
    return this.createSession({ ...input, mode: 'single', singleTaskId: taskId, collectionId: collection.id, acceptNewTasks: false });
  }

  collectionOutputDirectory(collectionId) {
    const collection = this.store.getCollectionById(String(collectionId || ''));
    if (!collection || !(collection.userId === INTERNAL_USER_ID || collection.internal === true) || collection.collectionKind === 'video-cache') {
      throw new Error('请选择内置用户下的内置收藏夹。');
    }
    const workspace = this.requireWorkspace();
    return collectionDirs(workspace.root, INTERNAL_USER_NAME, collectionStorageName(collection)).root;
  }

  sessionOutputDirectory(sessionId) {
    const session = this.requireSession(sessionId);
    const collectionRoot = this.collectionOutputDirectory(session.collectionId);
    const output = path.resolve(String(session.lastOutput || collectionRoot));
    if (!isInside(collectionRoot, output)) throw new Error('会话产物目录不在所选内置收藏夹中。');
    return fs.existsSync(output) ? output : collectionRoot;
  }

  async start(sessionId) {
    const id = String(sessionId || '');
    if (this.startLocks.has(id)) return this.startLocks.get(id);
    const operation = this.startUnlocked(id).finally(() => this.startLocks.delete(id));
    this.startLocks.set(id, operation);
    return operation;
  }

  async startUnlocked(sessionId) {
    let session = this.requireSession(sessionId);
    this.forcedStops.delete(session.id);
    if (this.running.has(session.id)) {
      const controller = this.controllers.get(session.id);
      if (!controller?.signal.aborted) return this.publicSession(session);
      await this.running.get(session.id);
      session = this.requireSession(sessionId);
    }
    const collectionAvailability = this.collectionAvailability(session);
    if (!collectionAvailability.available) throw new Error(collectionAvailability.reason);
    const modelAvailability = this.modelAvailability(session);
    if (!modelAvailability.available) throw new Error(modelAvailability.reason);
    if (session.status === 'waiting-login') {
      const user = this.getCurrentUser();
      if (!user?.isLogin) {
        this.emit({ type: 'login-required', sessionId: session.id, bvid: this.store.getTask(session.singleTaskId)?.bvid || '', reason: '请先前往 B站登录。登录完成后回到视频总结页面，点击“登录后重试”。' });
        throw new Error('这个视频需要 Bilibili 登录后才能继续，请先完成登录。');
      }
      const task = this.store.getTask(session.singleTaskId);
      if (!task) throw new Error('等待登录的单视频任务已不存在。');
      const startupController = new AbortController();
      this.controllers.set(session.id, startupController);
      try {
        task.cookieFile = await this.bili.exportCookies(user.name || String(user.mid));
      } catch (error) {
        if (this.controllers.get(session.id) === startupController) this.controllers.delete(session.id);
        throw error;
      }
      if (startupController.signal.aborted) {
        if (this.controllers.get(session.id) === startupController) this.controllers.delete(session.id);
        return this.publicSession(this.requireSession(session.id));
      }
      if (this.controllers.get(session.id) === startupController) this.controllers.delete(session.id);
      task.publicAttempt = false;
      task.updatedAt = new Date().toISOString();
      this.store.upsertTask(task);
      this.store.commit();
      this.log(session, `已同步 ${user.name || user.mid} 的登录状态，准备重试。`);
    }
    const worker = this.store.getWorker(session.workerId);
    if (worker?.status === 'paused') this.store.updateWorker(worker.id, { status: 'active' });
    session.acceptNewTasks = session.mode === 'single' ? false : true;
    session.status = 'running';
    session.phase = '准备领取任务';
    session.progress = 0.02;
    session.updatedAt = new Date().toISOString();
    this.saveSession(session);
    const controller = new AbortController();
    this.controllers.set(session.id, controller);
    const promise = this.runLoop(session.id, controller.signal)
      .catch((error) => this.handleLoopFailure(session.id, error))
      .finally(() => {
        this.controllers.delete(session.id);
        this.running.delete(session.id);
        this.forcedStops.delete(session.id);
      });
    this.running.set(session.id, promise);
    return this.publicSession(session);
  }

  pause(sessionId) {
    const session = this.requireSession(sessionId);
    session.acceptNewTasks = false;
    session.status = session.currentTaskId ? 'draining' : 'paused';
    session.phase = session.currentTaskId ? '完成当前任务后暂停' : '已暂停';
    session.updatedAt = new Date().toISOString();
    this.store.updateWorker(session.workerId, { status: 'paused', pauseReason: '用户暂停了应用内 Agent 的后续任务分配。' });
    this.saveSession(session);
    return this.publicSession(session);
  }

  stop(sessionId) {
    const session = this.requireSession(sessionId);
    session.acceptNewTasks = false;
    this.controllers.get(session.id)?.abort();
    let cleanupMessage = '没有正在处理的任务';
    if (session.currentTaskId) {
      try {
        const result = this.abortAttempt(session.currentTaskId, session.workerId, '用户立即停止了 Agent 工作。', 'internal-agent-stop');
        cleanupMessage = result.alreadyAborted ? '任务已回滚' : '任务缓存已清理并回滚';
      } catch (error) {
        cleanupMessage = `停止完成，但任务清理需要启动恢复复查：${error.message || String(error)}`;
        session.lastError = cleanupMessage;
      }
    }
    try { this.store.updateWorker(session.workerId, { status: 'paused', pauseReason: '用户立即停止了应用内 Agent。' }); } catch {}
    session.status = 'stopped';
    session.phase = `已停止，${cleanupMessage}`;
    session.currentTaskId = '';
    session.currentRunId = '';
    this.saveSession(session);
    return this.publicSession(session);
  }

  async stopCollectionForSync(collectionId, reason, source = 'collection-sync') {
    const affected = [];
    const running = [];
    for (const session of this.listSessions().filter((item) => item.collectionId === String(collectionId || '') && item.mode !== 'single')) {
      const message = String(reason || '收藏夹同步已中止该 Agent 工作流。');
      if (this.running.has(session.id)) {
        this.forcedStops.set(session.id, {
          reason: message,
          source,
          status: 'stopped',
          phase: '收藏夹同步已停止工作流，请手动重新开始'
        });
        running.push(this.running.get(session.id));
      }
      session.acceptNewTasks = false;
      this.controllers.get(session.id)?.abort();
      if (session.currentTaskId) {
        try { this.abortAttempt(session.currentTaskId, session.workerId, message, source); }
        catch (error) { session.lastError = `同步前任务清理失败：${error.message || String(error)}`; }
      }
      try { this.store.updateWorker(session.workerId, { status: 'paused', pauseReason: message, pausedAt: new Date().toISOString() }); } catch {}
      session.status = 'stopped';
      session.phase = '收藏夹同步已停止工作流，请手动重新开始';
      session.currentTaskId = '';
      session.currentRunId = '';
      this.saveSession(session);
      this.log(session, `${message} 同步完成后需要用户手动重新开始工作流。`);
      affected.push(session.id);
    }
    if (running.length) await Promise.allSettled(running);
    return affected;
  }

  markCollectionUnavailable(collectionId, reason) {
    const affected = [];
    for (const session of this.listSessions().filter((item) => item.collectionId === String(collectionId || '') && item.mode !== 'single')) {
      session.acceptNewTasks = false;
      session.status = 'collection-unavailable';
      session.phase = String(reason || 'B站收藏夹已删除，任务不可用。');
      session.currentTaskId = '';
      session.currentRunId = '';
      try { this.store.updateWorker(session.workerId, { status: 'paused', pauseReason: session.phase, pausedAt: new Date().toISOString() }); } catch {}
      this.saveSession(session);
      this.log(session, session.phase);
      affected.push(session.id);
    }
    return affected;
  }

  deleteSession(sessionId) {
    const session = this.requireSession(sessionId);
    if (this.running.has(session.id)) throw new Error('请先停止正在工作的 Agent 会话。');
    if (session.mode === 'single' && session.singleTaskId) {
      const task = this.store.getTask(session.singleTaskId);
      if (task && task.status !== 'done') {
        if (['claimed', 'rejected'].includes(task.status) && (task.workId || task.claimedBy)) {
          this.abortAttempt(task.id, session.workerId, '用户删除了未完成的单视频工作流。', 'single-session-delete');
        }
        this.store.delete('tasks', task.id);
        this.store.delete('videos', task.id);
        const collection = this.store.getCollectionById(task.collectionId);
        if (collection) this.store.set('collections', collection.id, { ...collection, videoCount: this.store.listTasks({ collectionId: collection.id }).length, updatedAt: new Date().toISOString() });
      }
    }
    try { this.store.updateWorker(session.workerId, { status: 'paused', pauseReason: '对应的应用内 Agent 工作流已被用户删除。' }); } catch {}
    this.store.delete('internalAgentSessions', session.id);
    this.store.save();
    return { deleted: true, id: session.id };
  }

  shutdown() {
    for (const controller of this.controllers.values()) controller.abort();
    for (const session of this.listSessions()) {
      if (!['running', 'draining', 'stopping'].includes(session.status)) continue;
      if (session.currentRunId) {
        try { this.toolRunner.cancel(session.currentRunId); } catch {}
      }
      if (session.currentTaskId) {
        try { this.abortAttempt(session.currentTaskId, session.workerId, '应用关闭，中止当前任务。', 'app-shutdown'); }
        catch (error) { session.lastError = `关闭时清理失败，将在下次启动重试：${error.message || String(error)}`; }
      }
      session.status = 'stopped';
      session.phase = '应用关闭，任务已回滚';
      session.acceptNewTasks = false;
      session.currentTaskId = '';
      session.currentRunId = '';
      session.updatedAt = new Date().toISOString();
      this.store.set('internalAgentSessions', session.id, session);
    }
    this.store.save();
  }

  reconcileModelAvailability(providerId = '') {
    const affected = [];
    for (const session of this.listSessions()) {
      if (providerId && session.providerId !== providerId) continue;
      const availability = this.modelAvailability(session);
      if (availability.available) {
        if (session.status === 'model-unavailable') {
          session.status = 'stopped';
          session.phase = 'AI 模型配置已恢复，可重新开始';
          session.lastError = '';
          this.saveSession(session);
        }
        continue;
      }
      session.acceptNewTasks = false;
      session.lastError = availability.reason;
      try { this.store.updateWorker(session.workerId, { status: 'paused', pauseReason: availability.reason, pausedAt: new Date().toISOString() }); } catch {}
      if (this.running.has(session.id) && session.currentTaskId) {
        this.forcedStops.set(session.id, {
          status: 'model-unavailable',
          phase: 'AI 模型配置不可用，当前任务已回退',
          reason: availability.reason,
          source: 'model-configuration-unavailable'
        });
        session.status = 'stopping';
        session.phase = 'AI 模型配置不可用，正在清理当前任务';
        this.saveSession(session);
        this.controllers.get(session.id)?.abort();
      } else if (!['completed', 'unavailable'].includes(session.status)) {
        this.controllers.get(session.id)?.abort();
        session.status = 'model-unavailable';
        session.phase = 'AI 模型配置不可用';
        session.currentTaskId = '';
        session.currentRunId = '';
        this.saveSession(session);
        this.log(session, availability.reason);
      } else {
        this.saveSession(session);
      }
      affected.push(session.id);
    }
    return { affected };
  }

  async runLoop(sessionId, signal) {
    const excluded = new Set();
    while (!signal.aborted) {
      const session = this.requireSession(sessionId);
      const worker = this.store.getWorker(session.workerId);
      if (!worker || worker.status === 'paused') {
        this.finishSession(session, 'paused', '已暂停');
        return;
      }
      const task = this.claimNextTask(session, excluded);
      if (!task) {
        this.finishSession(session, session.mode === 'single' ? 'completed' : 'idle', session.mode === 'single' ? '单任务已结束' : '当前没有可领取任务');
        return;
      }
      try {
        await this.processTask(session, task, signal);
      } catch (error) {
        const latest = this.requireSession(session.id);
        if (signal.aborted) {
          const forced = this.forcedStops.get(session.id);
          this.forcedStops.delete(session.id);
          const reason = forced?.reason || '用户或应用停止了 Agent 工作。';
          try {
            this.abortAttempt(task.id, latest.workerId, reason, forced?.source || 'internal-agent-stop');
          } catch (cleanupError) {
            latest.lastError = `任务已停止，但缓存清理将在启动恢复时重试：${cleanupError.message || String(cleanupError)}`;
          }
          latest.acceptNewTasks = false;
          latest.lastError = forced?.reason || latest.lastError;
          latest.currentTaskId = '';
          latest.currentRunId = '';
          this.finishSession(latest, forced?.status || 'stopped', forced?.phase || '已停止，任务缓存已清理');
          if (forced) this.log(latest, `${forced.reason} 当前视频缓存已清理，任务已退回待领取。`);
          return;
        }
        if (error.code === 'BILIBILI_VIDEO_UNAVAILABLE' || isVideoUnavailableMessage(error.message)) {
          const removal = removeUnavailableTask({ store: this.store, toolRunner: this.toolRunner, taskId: task.id, reason: error.message, source: 'internal-agent' });
          latest.skipped = Number(latest.skipped || 0) + 1;
          latest.currentTaskId = '';
          latest.currentRunId = '';
          latest.lastError = error.message || String(error);
          latest.phase = '视频不可用，已从库存移除';
          this.saveSession(latest);
          this.log(latest, `跳过并移除 ${task.bvid}：视频已删除、下架或不可用。`);
          this.emit({ type: 'video-unavailable', sessionId: latest.id, taskId: task.id, bvid: task.bvid, reason: latest.lastError, removed: removal.removed });
          if (latest.mode === 'single') {
            latest.content = `## 视频不可用\n\n${task.bvid} 已被删除、下架或无法访问，任务已从库存移除，不会再次派发。\n\n详细原因：${latest.lastError}`;
            this.finishSession(latest, 'unavailable', '视频不可用，任务已移除');
            return;
          }
          if (!latest.acceptNewTasks) {
            this.finishSession(latest, 'paused', '已暂停');
            return;
          }
          latest.status = 'running';
          this.saveSession(latest);
          continue;
        }
        if (error.code === 'ASR_INFRASTRUCTURE_FAILURE' || error.failureKind === 'infrastructure') {
          const possibleCauses = Array.isArray(error.possibleCauses) ? error.possibleCauses : [];
          const report = [
            '## Agent 因基础设施故障停止',
            '',
            `**中断步骤**：${latest.phase || '准备视频素材'}`,
            '',
            `**遇到的问题**：${error.message || String(error)}`,
            '',
            '**可能原因**：',
            ...(possibleCauses.length ? possibleCauses.map((item) => `- ${item}`) : ['- 应用工具、模型或本地运行时当前不可用']),
            '',
            '**处理建议**：检查“Agent 工具状态”和设置中的依赖状态，修复或重新下载对应依赖后，再手动恢复此 Agent。当前视频任务已退回待领取，不会继续领取其它视频。'
          ].join('\n');
          latest.acceptNewTasks = false;
          latest.status = 'blocked';
          latest.phase = '基础设施故障，工作已停止';
          latest.lastError = error.message || String(error);
          latest.reasoning = '';
          latest.content = report;
          latest.currentTaskId = '';
          latest.currentRunId = '';
          this.abortAttempt(task.id, latest.workerId, latest.lastError, 'infrastructure-failure');
          this.store.updateWorker(latest.workerId, { status: 'paused', pauseReason: report, pausedAt: new Date().toISOString() });
          this.saveSession(latest);
          this.log(latest, `基础设施故障，Agent 已停止：${latest.lastError}`);
          this.emit({ type: 'infrastructure-stopped', sessionId: latest.id, taskId: task.id, report, possibleCauses });
          return;
        }
        if (latest.mode === 'single' && error.code === 'BILIBILI_LOGIN_REQUIRED') {
          this.abortAttempt(task.id, latest.workerId, error.message || String(error), 'login-required');
          latest.status = 'waiting-login';
          latest.phase = '需要登录后继续';
          latest.lastError = error.message || String(error);
          latest.currentTaskId = '';
          latest.currentRunId = '';
          latest.progress = Math.max(0.08, Number(latest.progress || 0));
          this.saveSession(latest);
          this.log(latest, `公开获取受限：${latest.lastError}`);
          this.emit({ type: 'login-required', sessionId: latest.id, bvid: task.bvid, title: task.title, reason: '已先尝试公开获取，但该视频要求登录。登录完成后回到“视频总结（单个）”，点击“登录后重试”并从头处理。' });
          return;
        }
        excluded.add(task.id);
        latest.failed = Number(latest.failed || 0) + 1;
        latest.status = 'error';
        latest.phase = '任务失败';
        latest.lastError = error.message || String(error);
        latest.currentTaskId = '';
        latest.currentRunId = '';
        this.abortAttempt(task.id, latest.workerId, latest.lastError, 'internal-agent-error');
        this.saveSession(latest);
        this.log(latest, `任务失败：${latest.lastError}`);
        if (latest.mode === 'single' || !latest.acceptNewTasks) return;
        latest.status = 'running';
        this.saveSession(latest);
        continue;
      }
      const latest = this.requireSession(session.id);
      if (latest.mode === 'single' || !latest.acceptNewTasks) {
        this.finishSession(latest, latest.mode === 'single' ? 'completed' : 'paused', latest.mode === 'single' ? '单任务已完成' : '已暂停');
        return;
      }
    }
  }

  claimNextTask(session, excluded) {
    const collection = this.store.getCollectionById(session.collectionId);
    if (!collection) throw new Error('工作收藏夹已不存在。');
    const collectionReason = agentCollectionBlockReason(collection);
    if (collectionReason) throw new Error(collectionReason);
    this.reclaimExpired(collection.id);
    const task = this.store.listTasks({ collectionId: collection.id }).find((item) => {
      if (excluded.has(item.id) || item.enabled === false) return false;
      if (session.mode === 'single' && item.id !== session.singleTaskId) return false;
      return item.status === 'pending' || item.status === 'failed' || (item.status === 'rejected' && !item.workId && !item.claimedBy);
    });
    if (!task) return null;
    const workspace = this.requireWorkspace();
    const dirs = collectionDirs(workspace.root, collection.userName, collectionStorageName(collection));
    const canReuse = task.artifactDir && (task.cachedVideoId ? fs.existsSync(task.artifactDir) : task.workspaceId === workspace.id);
    const artifactDir = canReuse ? task.artifactDir : videoArtifactDir(dirs.videos, task, collection, this.store.getFilenameMetadata());
    ensureDir(artifactDir);
    const now = new Date();
    Object.assign(task, {
      status: 'claimed',
      workId: createWorkId(),
      claimedBy: session.workerId,
      claimedAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS).toISOString(),
      attempts: Number(task.attempts || 0) + 1,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      allowedRoot: task.cachedVideoId ? task.allowedRoot : dirs.root,
      artifactDir,
      validatorErrors: [],
      failureReason: '',
      infrastructureError: '',
      abortReason: '',
      abortSource: '',
      abortedAt: '',
      updatedAt: now.toISOString()
    });
    this.store.upsertTask(task);
    this.store.commit();
    this.store.recordTaskEvent(task.id, 'claimed', { collectionId: collection.id, workerId: session.workerId, agentName: session.workerId, attempt: task.attempts, workId: task.workId, workspaceId: workspace.id, internalAgent: true });
    session.currentTaskId = task.id;
    session.status = 'running';
    session.phase = '已领取任务';
    session.progress = 0.05;
    session.reasoning = '';
    session.content = '';
    session.lastError = '';
    session.contextCycle = Number(session.contextCycle || 0) + 1;
    session.contextPercent = 0;
    session.contextInputTokens = 0;
    session.contextOutputLimit = 0;
    this.saveSession(session);
    this.log(session, `领取任务 ${task.bvid} · ${task.title || task.bvid}`);
    this.log(session, `已创建第 ${session.contextCycle} 个独立任务上下文；Worker ID ${session.workerId} 保持不变。`);
    return task;
  }

  async processTask(session, task, signal) {
    const stopLeaseHeartbeat = this.startTaskLeaseHeartbeat(task);
    try {
    const collection = this.store.getCollectionById(task.collectionId) || {};
    const toolCollection = task.singleTask ? { ...collection, cookieFile: task.publicAttempt ? '' : (task.cookieFile || '') } : collection;
    this.setProgress(session, '准备视频素材', 0.09);
    const commentLimit = Number(session.taskOptions?.commentLimit ?? 3);
    const bundle = this.startTool(session, task, toolCollection, 'material-bundle', {
      frames: session.taskOptions?.frames || 12,
      comments: commentLimit > 0,
      skipComments: commentLimit <= 0,
      commentLimit: Math.max(0, commentLimit),
      timeoutMs: 7_200_000
    });
    await this.waitForRun(session, task, bundle.id, signal, 0.1, 0.52);
    this.refreshTaskMetadata(task);
    this.setProgress(session, '模型正在整理完整 Markdown', 0.56);
    const generated = await this.generateMarkdown(session, task, collection, signal);
    const markdownFile = path.join(task.artifactDir, 'summary-draft.md');
    fs.writeFileSync(markdownFile, `${generated.trim()}\n`, 'utf8');
    this.setProgress(session, task.keepVideoCache || task.cachedVideoId ? '清理过渡缓存并保留视频' : '清理临时音视频缓存', 0.88);
    const cleanup = this.startTool(session, task, toolCollection, 'clean-cache', { timeoutMs: 30 * 60 * 1000, preserveVideo: Boolean(task.keepVideoCache || task.cachedVideoId) });
    await this.waitForRun(session, task, cleanup.id, signal, 0.89, 0.94);
    this.setProgress(session, '校验并归档产物', 0.95);
    const finalized = this.submitTask(session, task, markdownFile);
    const latest = this.requireSession(session.id);
    latest.completed = Number(latest.completed || 0) + 1;
    latest.currentTaskId = '';
    latest.currentRunId = '';
    latest.progress = 1;
    latest.phase = '任务完成';
    latest.lastOutput = finalized.artifactDir;
    latest.updatedAt = new Date().toISOString();
    this.saveSession(latest);
    this.log(latest, `完成 ${task.bvid}，产物已通过应用校验。`);
    } finally {
      stopLeaseHeartbeat();
    }
  }

  startTool(session, task, collection, toolId, options) {
    const tool = this.store.get('tools', toolId);
    const run = this.toolRunner.start({ task, tool, collection, workerId: session.workerId, options });
    const latest = this.requireSession(session.id);
    latest.currentRunId = run.id;
    this.saveSession(latest);
    Object.assign(session, latest);
    return run;
  }

  async waitForRun(session, task, runId, signal, progressStart, progressEnd) {
    while (true) {
      if (signal.aborted) throw abortError();
      const run = this.store.getToolRun(runId);
      if (!run) throw new Error(`工具运行记录不存在：${runId}`);
      const fraction = run.asrProgress ? Number(run.asrProgress.progress || 0) : (run.status === 'running' ? 0.45 : 0.12);
      const progress = progressStart + (progressEnd - progressStart) * Math.max(0, Math.min(1, fraction));
      const detail = run.status === 'queued' ? `排队 ${run.queuePosition || '-'} · ${run.stage || run.toolName}` : `${run.toolName} · ${run.stage || run.status}`;
      this.setProgress(session, detail, progress, false);
      if (TERMINAL_RUNS.has(run.status)) {
        if (run.status !== 'succeeded') {
          const message = `${run.toolName || run.toolId} ${run.status}：${run.error || '请查看运行日志'}`;
          if (session.mode === 'single' && task.publicAttempt && isLoginRequiredMessage(message)) throw loginRequiredError(message);
          const error = new Error(message);
          error.code = run.errorCode || '';
          error.failureKind = run.failureKind || '';
          error.possibleCauses = Array.isArray(run.possibleCauses) ? run.possibleCauses : [];
          throw error;
        }
        return run;
      }
      await delay(650, signal);
    }
  }

  startTaskLeaseHeartbeat(task) {
    const workId = String(task.workId || '');
    const workerId = String(task.claimedBy || '');
    const refresh = () => {
      try {
        const latest = this.store.getTask(task.id);
        if (!latest || latest.workId !== workId || latest.claimedBy !== workerId || !['claimed', 'rejected'].includes(latest.status)) return;
        const now = new Date();
        latest.leaseExpiresAt = new Date(now.getTime() + LEASE_MS).toISOString();
        latest.updatedAt = now.toISOString();
        this.store.upsertTask(latest);
        this.store.commit();
      } catch (error) {
        console.error(`[internal-agent-lease] ${task.id}: ${error.message || String(error)}`);
      }
    };
    const timer = setInterval(refresh, 60 * 1000);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  handleLoopFailure(sessionId, error) {
    let session;
    try { session = this.requireSession(sessionId); }
    catch { return; }
    const forced = this.forcedStops.get(sessionId);
    const reason = forced?.reason || error?.message || String(error);
    if (session.currentTaskId) {
      try {
        this.abortAttempt(session.currentTaskId, session.workerId, reason, forced?.source || 'internal-agent-loop-failure');
      } catch (cleanupError) {
        session.lastError = `${reason}\n任务缓存清理将在启动恢复时重试：${cleanupError.message || String(cleanupError)}`;
      }
    }
    try {
      this.store.updateWorker(session.workerId, {
        status: 'paused',
        pauseReason: reason,
        pausedAt: new Date().toISOString()
      });
    } catch {}
    session.acceptNewTasks = false;
    session.status = forced?.status || (this.collectionAvailability(session).available ? 'error' : 'collection-unavailable');
    session.phase = forced?.phase || 'Agent 工作循环异常停止，当前任务已回滚';
    session.lastError = session.lastError || reason;
    session.currentTaskId = '';
    session.currentRunId = '';
    try { this.saveSession(session); } catch {}
    try { this.log(session, `Agent 工作循环已安全停止：${reason}`); } catch {}
  }

  async generateMarkdown(session, task, collection, signal) {
    const provider = this.ragAssistant.rawProvider(session.providerId);
    const model = this.ragAssistant.sessionModel(session);
    const originalMaterials = collectMaterials(task.artifactDir);
    let generationMaterials = originalMaterials;
    const template = fs.readFileSync(TEMPLATE_FILE, 'utf8');
    let previous = '';
    let errors = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let result;
      let repairContext = previous;
      for (let contextAttempt = 0; contextAttempt < 3; contextAttempt += 1) {
        const plan = planGenerationRequest({
          session,
          task,
          collection,
          materials: generationMaterials,
          template,
          model,
          provider,
          configuredOutput: this.ragAssistant.outputTokenLimit?.(provider, model),
          previous: repairContext,
          errors,
          repair: attempt > 0
        });
        if (plan.requiresSemanticCompaction) {
          if (!generationMaterials.evidencePack) {
            generationMaterials = await this.compactTaskMaterials(session, task, collection, originalMaterials, provider, model, signal);
            continue;
          }
          if (attempt > 0 && repairContext && !repairContext.startsWith('[语义整理后的修订稿]')) {
            repairContext = `[语义整理后的修订稿]\n${await this.compactRepairDraft(session, task, repairContext, errors, provider, model, signal)}`;
            continue;
          }
          throw new Error(`语义整理后的当前视频证据仍无法装入模型上下文（预计 ${plan.contextPercent}%）。请检查模型配置的上下文窗口是否与供应商实际限制一致。`);
        }
        const frames = model.supportsVision ? generationMaterials.frames.slice(0, plan.frameLimit) : [];
        const userContent = frames.length
          ? [{ type: 'text', text: plan.prompt }, ...frames.map((file) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(path.join(task.artifactDir, file)).toString('base64')}` } }))]
          : plan.prompt;
        const latest = this.requireSession(session.id);
        latest.reasoning = '';
        latest.content = '';
        latest.contextPercent = plan.contextPercent;
        latest.contextInputTokens = plan.inputTokens;
        latest.contextOutputLimit = plan.maxTokens;
        this.saveSession(latest);
        Object.assign(session, latest);
        try {
          result = await this.ragAssistant.streamCompletion(provider, {
            model: session.modelId,
            messages: [
              { role: 'system', content: GENERATION_SYSTEM_PROMPT },
              { role: 'user', content: userContent }
            ],
            temperature: provider.temperature,
            max_tokens: plan.maxTokens
          }, signal, (delta) => this.streamDelta(session.id, delta));
          break;
        } catch (error) {
          if (!isContextLimitError(error.message)) throw error;
          if (!generationMaterials.evidencePack) {
            this.log(session, '供应商报告当前视频上下文超限，正在保留 Worker ID 与 workId，并启动同模型的上下文整理 Agent。');
            generationMaterials = await this.compactTaskMaterials(session, task, collection, originalMaterials, provider, model, signal);
            continue;
          }
          if (attempt > 0 && repairContext && !repairContext.startsWith('[语义整理后的修订稿]')) {
            repairContext = `[语义整理后的修订稿]\n${await this.compactRepairDraft(session, task, repairContext, errors, provider, model, signal)}`;
            continue;
          }
          throw new Error(`相同模型完成上下文语义整理后，供应商仍报告上下文超限：${error.message || String(error)}`);
        }
      }
      if (!result) throw new Error('模型上下文重试未返回结果。');
      this.addUsage(session, result.usage || {});
      previous = normalizeGeneratedMarkdown(injectFrameGallery(stripMarkdownFence(result.content || ''), originalMaterials.frames), task, originalMaterials);
      const draft = path.join(task.artifactDir, `agent-draft-${attempt + 1}.md`);
      fs.writeFileSync(draft, `${previous.trim()}\n`, 'utf8');
      const validation = validateSubmission(task, { artifactDir: task.artifactDir, markdownFile: draft, metadataFile: path.join(task.artifactDir, 'info.json') }, { requireMediaCleanup: false });
      if (validation.ok) return previous;
      errors = validation.errors;
      this.log(session, `第 ${attempt + 1} 稿未通过校验：${errors.join('；')}`);
    }
    throw new Error(`模型生成的 Markdown 未通过校验：${errors.join('；')}`);
  }

  async compactTaskMaterials(session, task, collection, materials, provider, model, signal) {
    const sources = [
      { label: '任务与收藏夹', text: JSON.stringify({ bvid: task.bvid, title: task.title, owner: task.owner, duration: task.duration, collection: collection.name }, null, 2) },
      { label: '视频元数据', text: JSON.stringify(materials.info, null, 2) },
      { label: '素材清单', text: JSON.stringify(materials.manifest, null, 2) },
      { label: '站内字幕', text: materials.station || '未提供可用站内字幕' },
      { label: '本次 ASR 字幕', text: materials.asr || 'ASR 输出为空' },
      { label: '热评', text: JSON.stringify(materials.comments, null, 2) }
    ];
    this.setProgress(session, '极端长视频：上下文整理 Agent 正在分块读取素材', 0.57);
    this.log(session, '当前单视频素材预计接近模型上下文上限，已启动相同供应商/模型的独立上下文整理 Agent；原始素材不会裁剪或删除。');
    const evidencePack = await this.semanticCompactSources(session, provider, model, sources, signal, {
      purpose: '当前视频完整证据包',
      targetRatio: 0.38,
      progressStart: 0.57,
      progressEnd: 0.69
    });
    const latest = this.requireSession(session.id);
    latest.contextCompactions = Number(latest.contextCompactions || 0) + 1;
    this.saveSession(latest);
    Object.assign(session, latest);
    this.log(session, `上下文整理 Agent 已生成证据包（约 ${estimateAgentTokens(evidencePack)} tokens），继续由原 Agent 完成本视频。`);
    return { ...materials, station: '', asr: '', evidencePack };
  }

  async compactRepairDraft(session, task, draft, errors, provider, model, signal) {
    this.setProgress(session, '极端长修订稿：上下文整理 Agent 正在整理校验依据', 0.6);
    const result = await this.semanticCompactSources(session, provider, model, [
      { label: '当前视频校验错误', text: errors.join('\n') || '结构校验失败' },
      { label: '当前视频上一版完整草稿', text: draft }
    ], signal, {
      purpose: `${task.bvid} 修订证据`,
      targetRatio: 0.2,
      progressStart: 0.6,
      progressEnd: 0.68
    });
    const latest = this.requireSession(session.id);
    latest.contextCompactions = Number(latest.contextCompactions || 0) + 1;
    this.saveSession(latest);
    Object.assign(session, latest);
    this.log(session, '上下文整理 Agent 已整理当前视频的超长修订稿，原 Agent 将依据校验错误继续修订。');
    return result;
  }

  async semanticCompactSources(session, provider, model, sources, signal, options = {}) {
    const contextWindow = positiveInteger(model.contextWindow, DEFAULT_AGENT_CONTEXT_WINDOW);
    const configuredOutput = positiveInteger(this.ragAssistant.outputTokenLimit?.(provider, model) || model.maxOutputTokens || provider.maxOutputTokens, DEFAULT_AGENT_OUTPUT_TOKENS);
    const outputTokens = Math.min(configuredOutput, 12000, Math.max(2048, Math.floor(contextWindow * 0.08)));
    const targetTokens = Math.max(4000, Math.floor(contextWindow * Number(options.targetRatio || 0.38)));
    const scales = [0.52, 0.3, 0.16];
    let lastContextError = null;
    for (const scale of scales) {
      const chunkBudget = Math.max(2000, Math.floor(contextWindow * scale));
      try {
        return await this.semanticMapReduce(session, provider, model, sources, signal, {
          ...options,
          outputTokens,
          targetTokens,
          chunkBudget
        });
      } catch (error) {
        if (!isContextLimitError(error.message)) throw error;
        lastContextError = error;
        this.log(session, `上下文整理分块仍超过供应商实际限制，自动把分块预算降至 ${chunkBudget} tokens 后重试。`);
      }
    }
    throw new Error(`上下文整理 Agent 无法适配供应商实际窗口：${lastContextError?.message || '持续报告上下文超限'}`);
  }

  async semanticMapReduce(session, provider, model, sources, signal, options) {
    const chunks = [];
    for (const source of sources) {
      const parts = splitTextByTokenBudget(String(source.text || ''), options.chunkBudget);
      parts.forEach((text, index) => chunks.push({ label: source.label, index: index + 1, total: parts.length, text }));
    }
    const summaries = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const fraction = chunks.length ? index / chunks.length : 0;
      this.setProgress(session, `上下文整理 Agent：读取 ${index + 1}/${chunks.length} · ${chunk.label}`, Number(options.progressStart || 0.57) + (Number(options.progressEnd || 0.69) - Number(options.progressStart || 0.57)) * fraction, false);
      const content = await this.runContextCompactor(session, provider, model, [
        `整理目标：${options.purpose || '视频证据包'}`,
        `素材来源：${chunk.label}（分块 ${chunk.index}/${chunk.total}）`,
        '按时间或原文顺序提取本块全部有效信息。输出结构化 Markdown，至少覆盖：时间范围、事实与论据、步骤与参数、术语/代码、限制与例外、与其它字幕可能冲突之处、不确定内容。不要写最终总结，不要省略本块后半段。',
        '\n--- 原始素材分块开始 ---\n',
        chunk.text,
        '\n--- 原始素材分块结束 ---'
      ].join('\n'), signal, options.outputTokens);
      summaries.push(`## ${chunk.label} · 分块 ${chunk.index}/${chunk.total}\n\n${content}`);
    }
    let evidence = summaries.join('\n\n---\n\n');
    for (let round = 1; estimateAgentTokens(evidence) > options.targetTokens && round <= 4; round += 1) {
      const groups = splitTextByTokenBudget(evidence, options.chunkBudget);
      const merged = [];
      for (let index = 0; index < groups.length; index += 1) {
        const content = await this.runContextCompactor(session, provider, model, [
          `整理目标：${options.purpose || '视频证据包'}，分层合并第 ${round} 轮（${index + 1}/${groups.length}）`,
          `请去除重复表述并合并同一时间点的信息，但必须保留来源标签、时间轴、事实、步骤、参数、代码、限制、例外、字幕冲突和不确定性。目标长度不超过 ${Math.max(2000, Math.floor(options.targetTokens / Math.max(1, groups.length)))} tokens。`,
          '\n--- 待合并证据开始 ---\n',
          groups[index],
          '\n--- 待合并证据结束 ---'
        ].join('\n'), signal, Math.min(options.outputTokens, Math.max(2000, Math.floor(options.targetTokens / Math.max(1, groups.length)))));
        merged.push(content);
      }
      evidence = merged.join('\n\n---\n\n');
    }
    if (!evidence.trim()) throw new Error('上下文整理 Agent 返回了空证据包。');
    if (estimateAgentTokens(evidence) > options.targetTokens) throw new Error('上下文整理 Agent 的分层证据包仍超过目标预算。');
    return evidence;
  }

  async runContextCompactor(session, provider, model, prompt, signal, maxTokens) {
    const body = {
      model: session.modelId,
      messages: [
        { role: 'system', content: COMPACTOR_SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      temperature: 0,
      max_tokens: maxTokens
    };
    const result = this.ragAssistant.complete
      ? await this.ragAssistant.complete(provider, body, signal)
      : await this.ragAssistant.streamCompletion(provider, body, signal, () => {});
    this.addUsage(session, result.usage || {});
    const content = String(result.content || '').trim();
    if (!content) throw new Error('上下文整理 Agent 未返回可用内容。');
    return content;
  }

  refreshTaskMetadata(task) {
    const info = readJson(path.join(task.artifactDir, 'info.json'));
    task.title = String(info.title || task.title || task.bvid);
    task.owner = String(info.owner?.name || info.uploader || info.owner || task.owner || '');
    task.duration = Number(info.duration || task.duration || 0);
    const published = Number(info.pubdate || info.timestamp || info.ctime || 0);
    task.publishedAt = published ? new Date(published * 1000).toISOString() : (info.upload_date || task.publishedAt || '');
    task.cover = info.pic || info.thumbnail || task.cover || '';
    let localCover = '';
    try {
      const candidate = info.coverFile ? assertInside(task.artifactDir, path.resolve(task.artifactDir, info.coverFile)) : '';
      const stat = candidate ? fs.lstatSync(candidate) : null;
      if (stat?.isFile() && !stat.isSymbolicLink()) localCover = candidate;
    } catch {
      localCover = '';
    }
    task.coverFile = localCover || task.coverFile || '';
    task.tags = normalizeTags(info.tags || task.tags);
    task.updatedAt = new Date().toISOString();
    this.store.upsertTask(task);
    this.store.commit();
  }

  submitTask(session, task, markdownFile) {
    const metadataFile = path.join(task.artifactDir, 'info.json');
    const validation = validateSubmission(task, { artifactDir: task.artifactDir, markdownFile, metadataFile });
    const now = new Date().toISOString();
    this.store.recordSubmission(task.id, { createdAt: now, workerId: session.workerId, agentName: session.workerId, request: { artifactDir: task.artifactDir, markdownFile, metadataFile }, accepted: validation.ok, errors: validation.errors, internalAgent: true });
    if (!validation.ok) throw new Error(`提交校验失败：${validation.errors.join('；')}`);
    const collection = this.store.getCollectionById(task.collectionId) || {};
    const metadata = readJson(metadataFile);
    task.tags = normalizeTags(metadata.tags || task.tags);
    const completedWorkId = task.workId;
    const completedTask = { ...task, status: 'done', workId: '', completedAt: now, validatorErrors: [], updatedAt: now };
    const event = { id: `submission-completed:${completedWorkId || task.id}`, taskId: task.id, type: 'completed', createdAt: now, collectionId: task.collectionId, workerId: session.workerId, agentName: session.workerId, workId: completedWorkId, processingSeconds: secondsBetween(task.claimedAt, now), videoDuration: Number(task.duration || 0), internalAgent: true };
    const staged = stageSubmissionFinalization({ store: this.store, task, collection, validation, filenameMetadata: this.store.getFilenameMetadata(), completedTask, event });
    const { finalized } = applySubmissionFinalization(this.store, staged);
    this.emitEvent({ type: 'task-completed', taskId: task.id, collectionId: task.collectionId, workerId: session.workerId, agentName: session.workerId, internalAgent: true });
    return finalized;
  }

  abortAttempt(taskId, workerId, reason, source) {
    const result = abortTaskAttempt({ store: this.store, toolRunner: this.toolRunner, taskId, workerId, reason, source });
    if (!result.alreadyAborted) this.emitEvent({ type: 'task-attempt-aborted', taskId, workerId, reason, source, cleanup: result.cleanup });
    return result;
  }

  reclaimExpired(collectionId) {
    const active = new Set(this.store.listToolRuns().filter((run) => ['queued', 'running'].includes(run.status) && run.workId).map((run) => `${run.taskId}:${run.workId}`));
    for (const task of this.store.listTasks({ collectionId })) {
      if (!['claimed', 'rejected'].includes(task.status) || !task.leaseExpiresAt || Date.parse(task.leaseExpiresAt) > Date.now() || active.has(`${task.id}:${task.workId}`)) continue;
      this.abortAttempt(task.id, task.claimedBy, '任务租约已超时，内置 Agent 未完成或未正常中止本次工作。', 'lease-expired');
    }
  }

  streamDelta(sessionId, delta) {
    const session = this.requireSession(sessionId);
    if (delta.content) session.content = `${session.content || ''}${delta.content}`;
    if (delta.reasoning) session.reasoning = `${session.reasoning || ''}${delta.reasoning}`;
    session.phase = delta.reasoning && !session.content ? '模型正在思考' : '模型正在撰写';
    const baseProgress = Number(session.contextCompactions || 0) > 0 ? 0.7 : 0.58;
    session.progress = Math.min(0.86, baseProgress + Math.log10(1 + String(session.content || '').length) * 0.045);
    session.updatedAt = new Date().toISOString();
    this.store.set('internalAgentSessions', session.id, session);
    this.emit({ type: 'stream', sessionId, delta, phase: session.phase, progress: session.progress });
  }

  addUsage(session, usage) {
    const latest = this.requireSession(session.id);
    latest.tokenUsage = addUsage(latest.tokenUsage, usage);
    this.ragAssistant.recordModelUsage(latest.providerId, latest.modelId, usage);
    this.saveSession(latest);
  }

  setProgress(session, phase, progress, persist = true) {
    const latest = this.requireSession(session.id);
    latest.phase = phase;
    latest.progress = Math.max(0, Math.min(1, Number(progress || 0)));
    latest.updatedAt = new Date().toISOString();
    if (persist) this.saveSession(latest);
    else {
      this.store.set('internalAgentSessions', latest.id, latest);
      this.emit({ type: 'session-updated', session: this.publicSession(latest) });
    }
  }

  log(session, message) {
    const latest = this.store.get('internalAgentSessions', session.id) || session;
    latest.logs = [...(latest.logs || []), { at: new Date().toISOString(), message: String(message) }].slice(-200);
    latest.updatedAt = new Date().toISOString();
    Object.assign(session, latest);
    this.store.set('internalAgentSessions', latest.id, latest);
    this.store.save();
    this.emit({ type: 'log', sessionId: latest.id, entry: latest.logs.at(-1) });
  }

  finishSession(session, status, phase) {
    session.status = status;
    session.phase = phase;
    session.currentTaskId = '';
    session.currentRunId = '';
    if (status === 'completed') session.progress = 1;
    session.updatedAt = new Date().toISOString();
    this.saveSession(session);
  }

  saveSession(session) {
    session.updatedAt = new Date().toISOString();
    this.store.set('internalAgentSessions', session.id, session);
    this.store.save();
    this.emit({ type: 'session-updated', session: this.publicSession(session) });
    return session;
  }

  publicSession(session) {
    const task = session.currentTaskId ? this.store.getTask(session.currentTaskId) : null;
    const modelAvailability = this.modelAvailability(session);
    const collectionAvailability = this.collectionAvailability(session);
    return {
      ...session,
      modelAvailable: modelAvailability.available,
      modelUnavailableReason: modelAvailability.reason,
      collectionAvailable: collectionAvailability.available,
      collectionUnavailableReason: collectionAvailability.reason,
      collectionProgress: this.collectionProgress(session.collectionId),
      currentTask: task ? { id: task.id, bvid: task.bvid, title: task.title, duration: task.duration, artifactDir: task.artifactDir } : null
    };
  }

  modelAvailability(session) {
    const provider = this.store.get('ragProviders', String(session.providerId || ''));
    if (!provider) return { available: false, reason: 'AI 模型配置不可用：供应商已被删除。请在“AI 模型配置”中重新配置后再启动。' };
    const enabled = (provider.enabledModels || []).some((model) => model.id === session.modelId);
    if (!enabled) return { available: false, reason: `AI 模型配置不可用：${provider.name || session.providerId} 中的模型 ${session.modelId} 已被删除或停用。` };
    return { available: true, reason: '' };
  }

  collectionAvailability(session) {
    const collection = this.store.getCollectionById(String(session.collectionId || ''));
    if (!collection) return { available: false, reason: '工作收藏夹已不存在。' };
    const reason = agentCollectionBlockReason(collection);
    return { available: !reason, reason };
  }

  collectionProgress(collectionId) {
    const tasks = this.store.listTasks({ collectionId: String(collectionId || '') });
    const enabledTasks = tasks.filter((task) => task.enabled !== false);
    const done = enabledTasks.filter((task) => task.status === 'done').length;
    const claimed = enabledTasks.filter((task) => task.status === 'claimed' || (task.status === 'rejected' && task.workId && task.claimedBy)).length;
    const failed = enabledTasks.filter((task) => task.status === 'failed' || (task.status === 'rejected' && (!task.workId || !task.claimedBy))).length;
    const pending = enabledTasks.filter((task) => task.status === 'pending').length;
    return {
      tasks: tasks.length,
      enabled: enabledTasks.length,
      done,
      claimed,
      failed,
      pending,
      remaining: Math.max(0, enabledTasks.length - done - claimed),
      disabled: tasks.length - enabledTasks.length,
      progress: enabledTasks.length ? done / enabledTasks.length : 0
    };
  }

  requireSession(id) {
    const session = this.store.get('internalAgentSessions', String(id || ''));
    if (!session) throw new Error('应用内 Agent 会话不存在。');
    return session;
  }

  requireWorkspace() {
    const workspace = this.store.getDefaultWorkspace();
    if (!workspace) throw new Error('请先在设置中指定默认 Workspace。');
    return workspace;
  }

  ensureInternalUser() {
    this.store.upsertUser({ id: INTERNAL_USER_ID, mid: INTERNAL_USER_ID, name: INTERNAL_USER_NAME, internal: true });
    if (!this.listInternalCollections().length) this.createInternalCollection('单例产物');
  }

  recoverInterruptedSessions() {
    for (const session of this.listSessions()) {
      if (!['running', 'draining', 'stopping'].includes(session.status)) continue;
      if (session.currentTaskId) {
        try { this.abortAttempt(session.currentTaskId, session.workerId, '应用在上次任务执行期间退出。', 'app-restart-recovery'); }
        catch (error) { session.lastError = `中断任务清理失败：${error.message || String(error)}`; }
      }
      session.status = 'stopped';
      session.phase = '上次中断任务已回滚，请重新开始';
      session.acceptNewTasks = false;
      session.currentTaskId = '';
      session.currentRunId = '';
      session.updatedAt = new Date().toISOString();
      this.store.set('internalAgentSessions', session.id, session);
    }
    this.store.save();
  }

  purgeKnownUnavailableTasks() {
    for (const task of this.store.listTasks()) {
      if (task.status === 'done' || !isVideoUnavailableMessage(task.title || '')) continue;
      this.reclassifyUnavailableHistory(task);
      removeUnavailableTask({ store: this.store, toolRunner: this.toolRunner, taskId: task.id, reason: `同步条目已标记为“${task.title}”。`, source: 'startup-migration' });
    }
  }

  reclassifyUnavailableHistory(task) {
    const failures = this.store.list('taskEvents').filter((event) => event.taskId === task.id && event.type === 'attempt-aborted' && event.source === 'internal-agent-error');
    const byWorker = new Map();
    for (const event of failures) byWorker.set(event.workerId, Number(byWorker.get(event.workerId) || 0) + 1);
    for (const session of this.listSessions()) {
      const count = byWorker.get(session.workerId) || 0;
      if (!count) continue;
      session.failed = Math.max(0, Number(session.failed || 0) - count);
      session.skipped = Number(session.skipped || 0) + count;
      this.store.set('internalAgentSessions', session.id, session);
    }
    for (const run of this.store.listToolRuns({ taskId: task.id })) {
      if (!['failed', 'timeout'].includes(run.status)) continue;
      this.store.set('toolRuns', run.id, { ...run, status: 'skipped', errorCode: 'BILIBILI_VIDEO_UNAVAILABLE', failureKind: 'terminal-video' });
    }
    this.store.save();
  }
}

function collectMaterials(artifactDir) {
  const frames = listFiles(path.join(artifactDir, 'frames'), '.jpg').map((file) => `frames/${path.basename(file)}`);
  const asr = readTimedAsr(path.join(artifactDir, 'asr'));
  const station = readTimedStationSubtitles(path.join(artifactDir, 'subtitles'));
  return {
    info: readJson(path.join(artifactDir, 'info.json')),
    manifest: readJson(path.join(artifactDir, 'manifest.json')),
    comments: readJson(path.join(artifactDir, 'comments', 'comments.json')),
    asr,
    station,
    frames
  };
}

function agentCollectionBlockReason(collection) {
  if (collection?.collectionKind === 'document-archive') return '该收藏夹仅保留已完成文档，不能继续派发视频总结任务。';
  return collectionBlockReason(collection);
}

function readTimedAsr(directory) {
  const srt = readText(path.join(directory, 'transcript.srt'));
  if (srt.trim()) return `ASR 时间轴字幕（SRT）：\n${srt}`;
  const result = readJson(path.join(directory, 'asr-result.json'));
  if (Array.isArray(result.segments) && result.segments.length) {
    return `ASR 时间轴字幕（分段 JSON 回退）：\n${formatTimedSegments(result.segments)}`;
  }
  const text = readText(path.join(directory, 'asr-transcript.txt'));
  return text.trim() ? `ASR 时间轴字幕（文本格式回退）：\n${text}` : '';
}

function readTimedStationSubtitles(directory) {
  const srtFiles = listFiles(directory, '.srt');
  if (srtFiles.length) {
    return srtFiles.map((file) => `站内时间轴字幕 ${path.basename(file)}：\n${readText(file)}`).join('\n\n');
  }
  return listFiles(directory, '.txt').map((file) => `站内字幕 ${path.basename(file)}：\n${readText(file)}`).join('\n\n');
}

function formatTimedSegments(segments) {
  return segments.map((segment) => {
    const start = subtitleTime(segment.start);
    const end = subtitleTime(segment.end);
    return `[${start} --> ${end}] ${String(segment.text || '').trim()}`;
  }).filter((line) => !line.endsWith('] ')).join('\n');
}

function subtitleTime(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const milliseconds = totalMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

function buildGenerationPrompt({ session, task, collection, materials, template }) {
  const transcriptContext = materials.evidencePack
    ? `极端长视频语义证据包（由相同供应商/模型的独立上下文整理 Agent 分块读取全部原始素材后生成）：\n${materials.evidencePack}\n\n注意：证据包用于替代本次请求中的超长原始字幕，但原始文件仍保存在任务目录。必须覆盖证据包中的全部时间段、事实、步骤、参数、限制、冲突和不确定性。`
    : `站内字幕：\n${materials.station || '未提供可用站内字幕'}\n\nASR 字幕：\n${materials.asr || 'ASR 输出为空，请在文档中如实说明'}`;
  return `请基于以下真实素材生成一份完整的视频知识 Markdown。

强制要求：
1. 开头章节严格为“小结 -> 思维导图 -> 目录”，思维导图使用有效 Mermaid mindmap。
2. 正文完整覆盖视频的新闻、技术、经验、步骤、参数、限制和时效性，不能只做简短摘要。
3. 章节标题加入 Bilibili 时间轴链接：https://www.bilibili.com/video/${task.bvid}?t=<秒数>。优先依据 ASR/站内 SRT 的起止时间换算秒数，不得根据文字顺序猜测时间位置。
4. 必须比较站内字幕与本次 ASR；无论有无站内字幕，本次 ASR 都已经执行。时间轴字幕中的“HH:MM:SS,mmm --> HH:MM:SS,mmm”是可直接使用的真实分段时间。
5. 从给出的关键帧中选择适合正文的图片，使用相对路径 frames/xxx.jpg，并解释图片价值。
6. 评论分析只处理可获取的热评前三条。
7. 处理记录写明 Worker ID、模型、工具、字幕选择、关键帧依据和缓存清理。
8. 不要输出 Markdown 外层代码围栏。

用户附加要求：
${session.taskRequirements || '无额外要求'}

任务：
${JSON.stringify({ bvid: task.bvid, title: task.title, owner: task.owner, duration: task.duration, collection: collection.name, workerId: session.workerId, model: session.modelId }, null, 2)}

元数据：
${JSON.stringify(materials.info, null, 2)}

素材清单：
${JSON.stringify(materials.manifest, null, 2)}

关键帧路径：
${materials.frames.join('\n') || '无'}

${transcriptContext}

热评：
${JSON.stringify(materials.comments, null, 2)}

参考模板（按真实内容改写，不保留占位符）：
${template}`;
}

function planGenerationRequest({ session, task, collection, materials, template, model = {}, provider = {}, configuredOutput, previous = '', errors = [], repair = false }) {
  const contextWindow = positiveInteger(model.contextWindow, DEFAULT_AGENT_CONTEXT_WINDOW);
  const wantedOutput = positiveInteger(configuredOutput || model.maxOutputTokens || provider.maxOutputTokens, DEFAULT_AGENT_OUTPUT_TOKENS);
  const protocolReserve = Math.min(16000, Math.max(1024, Math.floor(contextWindow * 0.05)));
  const frameLimit = model.supportsVision && materials.frames.length ? 4 : 0;
  const imageReserve = frameLimit * 2600;
  const targetOutput = Math.min(wantedOutput, Math.max(2048, Math.floor(contextWindow * 0.3)));
  let prompt = buildGenerationPrompt({ session, task, collection, materials, template });
  if (repair) {
    const correction = `\n\n上一稿未通过校验。请只返回修正后的完整 Markdown。\n校验错误：\n- ${errors.join('\n- ') || '文档结构或引用不合规'}\n\n上一稿：\n`;
    prompt = `${prompt}${correction}${previous}`;
  }
  const inputTokens = estimateAgentTokens(GENERATION_SYSTEM_PROMPT) + estimateAgentTokens(prompt) + 16;
  const availableOutput = contextWindow - inputTokens - protocolReserve - imageReserve;
  const plannedTokens = inputTokens + imageReserve + protocolReserve + targetOutput;
  const contextPercent = Math.round((plannedTokens / contextWindow) * 1000) / 10;
  const requiresSemanticCompaction = plannedTokens > contextWindow * CONTEXT_COMPACTION_TRIGGER || availableOutput < 2048;
  const maxTokens = Math.max(1024, Math.min(wantedOutput, targetOutput, Math.max(1024, availableOutput)));
  return { prompt, maxTokens, frameLimit, inputTokens, contextWindow, contextPercent, requiresSemanticCompaction };
}

function splitTextByTokenBudget(value, budgetTokens) {
  const text = String(value || '');
  if (!text) return [''];
  if (estimateAgentTokens(text) <= budgetTokens) return [text];
  const chunks = [];
  let current = '';
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || [text]) {
    if (estimateAgentTokens(line) > budgetTokens) {
      if (current) { chunks.push(current); current = ''; }
      let remaining = line;
      while (remaining) {
        const size = prefixLengthForTokenBudget(remaining, budgetTokens);
        chunks.push(remaining.slice(0, size));
        remaining = remaining.slice(size);
      }
      continue;
    }
    if (current && estimateAgentTokens(current + line) > budgetTokens) {
      chunks.push(current);
      current = line;
    } else {
      current += line;
    }
  }
  if (current) chunks.push(current);
  return chunks.filter(Boolean);
}

function prefixLengthForTokenBudget(text, budgetTokens) {
  let low = 1;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateAgentTokens(text.slice(0, middle)) <= budgetTokens) low = middle;
    else high = middle - 1;
  }
  return Math.max(1, low);
}

function estimateAgentTokens(value) {
  const text = String(value || '');
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  return Math.max(1, Math.ceil(cjk + (text.length - cjk) / 4));
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isContextLimitError(value) {
  return /context(?:[_ -]?(?:length|window))?|maximum context|too many tokens|token limit|上下文.{0,8}(?:超|长|限)|请求.{0,8}过长/i.test(String(value || ''));
}

function injectFrameGallery(markdown, frames) {
  if (!frames.length || /!\[[^\]]*]\(frames\//.test(markdown)) return markdown;
  const gallery = `\n\n## 精选关键帧\n\n${frames.slice(0, 3).map((file, index) => `![关键帧 ${index + 1}](${file})\n\n> 图：来自视频的代表性画面，用于辅助核对正文与字幕语义。`).join('\n\n')}\n`;
  const marker = markdown.search(/^##\s+字幕比对\s*$/m);
  return marker >= 0 ? `${markdown.slice(0, marker)}${gallery}\n${markdown.slice(marker)}` : `${markdown}${gallery}`;
}

function normalizeGeneratedMarkdown(markdown, task, materials) {
  let result = String(markdown || '').trim();
  const mapBlock = `## 思维导图\n\n\`\`\`mermaid\nmindmap\n  root((${mermaidLabel(task.title || task.bvid || '视频知识')}))\n    核心内容\n    字幕核对\n    关键帧\n    评论反馈\n\`\`\``;
  const mapMatch = result.match(/^##\s+思维导图\s*$[\s\S]*?(?=^##\s+|$)/m);
  if (!mapMatch) {
    const contentsIndex = result.search(/^##\s+目录\s*$/m);
    result = contentsIndex >= 0
      ? `${result.slice(0, contentsIndex).trimEnd()}\n\n${mapBlock}\n\n${result.slice(contentsIndex)}`
      : `${result}\n\n${mapBlock}`;
  } else if (!/```mermaid\s+[\s\S]*?```/i.test(mapMatch[0])) {
    result = `${result.slice(0, mapMatch.index)}${mapBlock}\n\n${result.slice(mapMatch.index + mapMatch[0].length).trimStart()}`;
  }
  result = promoteMindMap(result).trim();
  if (!/^##\s+评论分析\s*$/m.test(result)) {
    const comments = normalizeCommentItems(materials.comments).slice(0, 3);
    const body = comments.length
      ? `${comments.map((item, index) => `- 热评 ${index + 1}：${item}`).join('\n')}\n\n以上内容是观众反馈摘录，只用于补充理解视频反响，不作为正文事实依据。`
      : '本次流程未获取到可用热评，因此不推断观众态度或额外结论。';
    const section = `## 评论分析\n\n${body}`;
    const recordIndex = result.search(/^##\s+处理记录\s*$/m);
    result = recordIndex >= 0
      ? `${result.slice(0, recordIndex).trimEnd()}\n\n${section}\n\n${result.slice(recordIndex)}`
      : `${result}\n\n${section}`;
  }
  return result;
}

function normalizeCommentItems(value) {
  const list = Array.isArray(value) ? value : (value?.items || value?.comments || value?.replies || value?.data?.replies || []);
  return list.map((item) => String(item?.message || item?.content?.message || item?.text || item || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function mermaidLabel(value) {
  return String(value || '视频知识').replace(/[()\[\]{}"'\n\r:;]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 42) || '视频知识';
}

function stripMarkdownFence(value) {
  const text = String(value || '').trim();
  const match = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return match ? match[1].trim() : text;
}

function listFiles(directory, extension) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).map((name) => path.join(directory, name)).filter((file) => fs.statSync(file).isFile() && (!extension || path.extname(file).toLowerCase() === extension)).sort();
}

function readText(file, max) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return Number.isFinite(Number(max)) ? text.slice(0, Number(max)) : text;
  } catch { return ''; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function extractBvid(value) {
  return String(value || '').match(/BV[0-9A-Za-z]{10}/i)?.[0] || '';
}

function addUsage(current = {}, next = {}) {
  const input = Number(next.input ?? next.prompt_tokens ?? 0);
  const output = Number(next.output ?? next.completion_tokens ?? 0);
  const total = Number(next.total ?? next.total_tokens ?? (input + output));
  return { input: Number(current.input || 0) + input, output: Number(current.output || 0) + output, total: Number(current.total || 0) + total };
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
}

function secondsBetween(start, end) {
  const startMs = Date.parse(start || '');
  const endMs = Date.parse(end || '');
  return startMs && endMs >= startMs ? (endMs - startMs) / 1000 : 0;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError() {
  const error = new Error('Agent 工作已停止。');
  error.name = 'AbortError';
  return error;
}

module.exports = { InternalAgentManager, INTERNAL_USER_ID, INTERNAL_USER_NAME, extractBvid, normalizeGeneratedMarkdown, planGenerationRequest, splitTextByTokenBudget };
