const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { finalizeSubmissionArtifacts, relocateCachedVideo } = require('./submission-artifacts');
const { promoteMindMap } = require('./markdown');
const { isLoginRequiredMessage, isVideoUnavailableMessage, loginRequiredError } = require('./media-errors');
const { abortTaskAttempt, createWorkId } = require('./task-attempt');
const { removeUnavailableTask } = require('./unavailable-task');
const { validateSubmission } = require('./validation');
const {
  WORKSPACE_ROOT,
  collectionDirs,
  ensureDir,
  normalizeTags,
  safeName,
  videoArtifactDir
} = require('./workspace');

const INTERNAL_USER_ID = 'builtin-agent-user';
const INTERNAL_USER_NAME = '内置用户';
const LEASE_MS = 15 * 60 * 1000;
const TEMPLATE_FILE = path.join(__dirname, '..', '..', 'templates', 'video-summary-template.md');
const TERMINAL_RUNS = new Set(['succeeded', 'failed', 'cancelled', 'timeout', 'skipped']);

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
    this.ensureInternalUser();
    this.recoverInterruptedSessions();
    this.purgeKnownUnavailableTasks();
  }

  state() {
    return {
      providers: this.ragAssistant.listProviders(),
      sessions: this.listSessions().map((session) => this.publicSession(session)),
      collections: this.store.listCollections().map((collection) => ({
        id: collection.id,
        name: collection.name,
        userName: collection.userName,
        internal: collection.userId === INTERNAL_USER_ID || collection.internal === true,
        tasks: this.store.listTasks({ collectionId: collection.id }).length,
        pending: this.store.listTasks({ collectionId: collection.id }).filter((task) => task.enabled !== false && ['pending', 'failed', 'rejected'].includes(task.status)).length
      })),
      internalCollections: this.listInternalCollections()
    };
  }

  emit(event) {
    this.emitEvent(event);
  }

  listSessions() {
    return this.store.list('internalAgentSessions').sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  listInternalCollections() {
    return this.store.listCollections().filter((collection) => (collection.userId === INTERNAL_USER_ID || collection.internal === true) && collection.collectionKind !== 'video-cache');
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
      singleOutputDir: String(input.singleOutputDir || ''),
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
      createdAt: now,
      updatedAt: now
    };
    this.saveSession(session);
    this.log(session, '会话已创建，等待启动。');
    return this.publicSession(session);
  }

  async createSingleTask(input = {}) {
    const bvid = extractBvid(input.video);
    if (!bvid) throw new Error('请输入有效的 BV 号或 Bilibili 视频链接。');
    const outputDir = path.resolve(String(input.outputDir || ''));
    if (!String(input.outputDir || '').trim()) throw new Error('单任务模式必须指定输出目录。');
    ensureDir(outputDir);
    const collection = this.store.getCollectionById(String(input.collectionId || ''));
    if (!collection || !(collection.userId === INTERNAL_USER_ID || collection.internal === true)) throw new Error('请选择内置用户下的内置收藏夹。');
    const workspace = this.requireWorkspace();
    const dirs = collectionDirs(workspace.root, INTERNAL_USER_NAME, collection.name);
    const now = new Date().toISOString();
    const taskId = `${collection.id}:${bvid}:single-${Date.now()}`;
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
    return this.createSession({ ...input, mode: 'single', singleTaskId: taskId, singleOutputDir: outputDir, collectionId: collection.id, acceptNewTasks: false });
  }

  async start(sessionId) {
    const session = this.requireSession(sessionId);
    if (this.running.has(session.id)) return this.publicSession(session);
    if (session.status === 'waiting-login') {
      const user = this.getCurrentUser();
      if (!user?.isLogin) {
        this.emit({ type: 'login-required', sessionId: session.id, bvid: this.store.getTask(session.singleTaskId)?.bvid || '', reason: '请先前往 B站登录。登录完成后回到视频总结页面，点击“开始/继续”。' });
        throw new Error('这个视频需要 Bilibili 登录后才能继续，请先完成登录。');
      }
      const task = this.store.getTask(session.singleTaskId);
      if (!task) throw new Error('等待登录的单视频任务已不存在。');
      task.cookieFile = await this.bili.exportCookies(user.name || String(user.mid));
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
    const promise = this.runLoop(session.id, controller.signal).finally(() => {
      this.controllers.delete(session.id);
      this.running.delete(session.id);
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

  deleteSession(sessionId) {
    const session = this.requireSession(sessionId);
    if (this.running.has(session.id)) throw new Error('请先停止正在工作的 Agent 会话。');
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
          this.abortAttempt(task.id, latest.workerId, '用户或应用停止了 Agent 工作。', 'internal-agent-stop');
          this.finishSession(latest, 'stopped', '已停止，任务缓存已清理');
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
          this.emit({ type: 'login-required', sessionId: latest.id, bvid: task.bvid, title: task.title, reason: '已先尝试公开获取，但该视频要求登录。登录完成后回到“视频总结（单个）”，点击“开始/继续”重试。' });
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
    this.reclaimExpired(collection.id);
    const task = this.store.listTasks({ collectionId: collection.id }).find((item) => {
      if (excluded.has(item.id) || item.enabled === false) return false;
      if (session.mode === 'single' && item.id !== session.singleTaskId) return false;
      return item.status === 'pending' || item.status === 'failed' || (item.status === 'rejected' && !item.workId && !item.claimedBy);
    });
    if (!task) return null;
    const workspace = this.requireWorkspace();
    const dirs = collectionDirs(workspace.root, collection.userName, collection.name);
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
    this.saveSession(session);
    this.log(session, `领取任务 ${task.bvid} · ${task.title || task.bvid}`);
    return task;
  }

  async processTask(session, task, signal) {
    const collection = this.store.getCollectionById(task.collectionId) || {};
    const toolCollection = task.singleTask ? { ...collection, cookieFile: task.publicAttempt ? '' : (task.cookieFile || '') } : collection;
    this.setProgress(session, '准备视频素材', 0.09);
    const bundle = this.startTool(session, task, toolCollection, 'material-bundle', { frames: session.taskOptions?.frames || 12, commentLimit: session.taskOptions?.commentLimit ?? 3, timeoutMs: 7_200_000 });
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
    let externalOutput = '';
    if (session.mode === 'single') {
      externalOutput = copyArtifact(finalized.artifactDir, session.singleOutputDir);
      this.log(session, `单任务产物已复制到：${externalOutput}`);
    }
    const latest = this.requireSession(session.id);
    latest.completed = Number(latest.completed || 0) + 1;
    latest.currentTaskId = '';
    latest.currentRunId = '';
    latest.progress = 1;
    latest.phase = '任务完成';
    latest.lastOutput = finalized.artifactDir;
    latest.externalOutput = externalOutput;
    latest.updatedAt = new Date().toISOString();
    this.saveSession(latest);
    this.log(latest, `完成 ${task.bvid}，产物已通过应用校验。`);
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
      task.leaseExpiresAt = new Date(Date.now() + LEASE_MS).toISOString();
      task.updatedAt = new Date().toISOString();
      this.store.upsertTask(task);
      this.store.commit();
      await delay(650, signal);
    }
  }

  async generateMarkdown(session, task, collection, signal) {
    const provider = this.ragAssistant.rawProvider(session.providerId);
    const model = this.ragAssistant.sessionModel(session);
    const materials = collectMaterials(task.artifactDir);
    const template = fs.readFileSync(TEMPLATE_FILE, 'utf8');
    const basePrompt = buildGenerationPrompt({ session, task, collection, materials, template });
    let previous = '';
    let errors = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prompt = attempt === 0 ? basePrompt : `${basePrompt}\n\n上一稿未通过校验。请只返回修正后的完整 Markdown。\n校验错误：\n- ${errors.join('\n- ')}\n\n上一稿：\n${previous.slice(0, 120000)}`;
      const userContent = model.supportsVision && materials.frames.length
        ? [{ type: 'text', text: prompt }, ...materials.frames.slice(0, 4).map((file) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(path.join(task.artifactDir, file)).toString('base64')}` } }))]
        : prompt;
      session.reasoning = '';
      session.content = '';
      this.saveSession(session);
      const result = await this.ragAssistant.streamCompletion(provider, {
        model: session.modelId,
        messages: [
          { role: 'system', content: '你是星藏家的内置视频知识整理 Agent。必须依据提供的真实素材生成完整、严谨、带时间轴和关键帧的中文 Markdown，不得编造未出现的信息。只返回 Markdown 正文。' },
          { role: 'user', content: userContent }
        ],
        temperature: provider.temperature,
        max_tokens: this.ragAssistant.outputTokenLimit?.(provider, model) || model.maxOutputTokens || provider.maxOutputTokens || 128000
      }, signal, (delta) => this.streamDelta(session.id, delta));
      this.addUsage(session, result.usage || {});
      previous = normalizeGeneratedMarkdown(injectFrameGallery(stripMarkdownFence(result.content || ''), materials.frames), task, materials);
      const draft = path.join(task.artifactDir, `agent-draft-${attempt + 1}.md`);
      fs.writeFileSync(draft, `${previous.trim()}\n`, 'utf8');
      const validation = validateSubmission(task, { artifactDir: task.artifactDir, markdownFile: draft, metadataFile: path.join(task.artifactDir, 'info.json') });
      if (validation.ok) return previous;
      errors = validation.errors;
      this.log(session, `第 ${attempt + 1} 稿未通过校验：${errors.join('；')}`);
    }
    throw new Error(`模型生成的 Markdown 未通过校验：${errors.join('；')}`);
  }

  refreshTaskMetadata(task) {
    const info = readJson(path.join(task.artifactDir, 'info.json'));
    task.title = String(info.title || task.title || task.bvid);
    task.owner = String(info.owner?.name || info.uploader || info.owner || task.owner || '');
    task.duration = Number(info.duration || task.duration || 0);
    task.publishedAt = info.timestamp ? new Date(Number(info.timestamp) * 1000).toISOString() : (info.upload_date || task.publishedAt || '');
    task.cover = info.pic || info.thumbnail || task.cover || '';
    const localCover = info.coverFile ? path.resolve(task.artifactDir, info.coverFile) : '';
    task.coverFile = localCover && fs.existsSync(localCover) ? localCover : (task.coverFile || '');
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
    const finalized = finalizeSubmissionArtifacts({ task, collection, validation, filenameMetadata: this.store.getFilenameMetadata() });
    const completedWorkId = task.workId;
    Object.assign(task, { status: 'done', workId: '', completedAt: now, outputMarkdown: finalized.markdownFile, artifactDir: finalized.artifactDir, metadataFile: finalized.metadataFile, validatorErrors: [], updatedAt: now });
    relocateCachedVideo(this.store, task, finalized);
    this.store.upsertTask(task);
    this.store.commit();
    this.store.recordTaskEvent(task.id, 'completed', { collectionId: task.collectionId, workerId: session.workerId, agentName: session.workerId, workId: completedWorkId, processingSeconds: secondsBetween(task.claimedAt, now), videoDuration: Number(task.duration || 0), internalAgent: true });
    this.emitEvent({ type: 'task-completed', taskId: task.id, collectionId: task.collectionId, workerId: session.workerId, agentName: session.workerId, internalAgent: true });
    return finalized;
  }

  abortAttempt(taskId, workerId, reason, source) {
    const result = abortTaskAttempt({ store: this.store, toolRunner: this.toolRunner, taskId, workerId, reason, source });
    if (!result.alreadyAborted) this.emitEvent({ type: 'task-attempt-aborted', taskId, workerId, reason, source, cleanup: result.cleanup });
    return result;
  }

  reclaimExpired(collectionId) {
    const active = new Set(this.store.listToolRuns().filter((run) => ['queued', 'running'].includes(run.status)).map((run) => run.taskId));
    for (const task of this.store.listTasks({ collectionId })) {
      if (!['claimed', 'rejected'].includes(task.status) || !task.leaseExpiresAt || Date.parse(task.leaseExpiresAt) > Date.now() || active.has(task.id)) continue;
      this.abortAttempt(task.id, task.claimedBy, '任务租约已超时，内置 Agent 未完成或未正常中止本次工作。', 'lease-expired');
    }
  }

  streamDelta(sessionId, delta) {
    const session = this.requireSession(sessionId);
    if (delta.content) session.content = `${session.content || ''}${delta.content}`;
    if (delta.reasoning) session.reasoning = `${session.reasoning || ''}${delta.reasoning}`;
    session.phase = delta.reasoning && !session.content ? '模型正在思考' : '模型正在撰写';
    session.progress = Math.min(0.86, 0.58 + Math.log10(1 + String(session.content || '').length) * 0.055);
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
    return { ...session, currentTask: task ? { id: task.id, bvid: task.bvid, title: task.title, duration: task.duration, artifactDir: task.artifactDir } : null };
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
  const asr = readText(path.join(artifactDir, 'asr', 'asr-transcript.txt'), 70000);
  const stationFile = listFiles(path.join(artifactDir, 'subtitles'), '.txt')[0];
  return {
    info: readJson(path.join(artifactDir, 'info.json')),
    manifest: readJson(path.join(artifactDir, 'manifest.json')),
    comments: readJson(path.join(artifactDir, 'comments', 'comments.json')),
    asr,
    station: stationFile ? readText(stationFile, 70000) : '',
    frames
  };
}

function buildGenerationPrompt({ session, task, collection, materials, template }) {
  return `请基于以下真实素材生成一份完整的视频知识 Markdown。\n\n强制要求：\n1. 开头章节严格为“小结 -> 思维导图 -> 目录”，思维导图使用有效 Mermaid mindmap。\n2. 正文完整覆盖视频的新闻、技术、经验、步骤、参数、限制和时效性，不能只做简短摘要。\n3. 章节标题加入 Bilibili 时间轴链接：https://www.bilibili.com/video/${task.bvid}?t=<秒数>。\n4. 必须比较站内字幕与本次 ASR；无论有无站内字幕，本次 ASR 都已经执行。\n5. 从给出的关键帧中选择适合正文的图片，使用相对路径 frames/xxx.jpg，并解释图片价值。\n6. 评论分析只处理可获取的热评前三条。\n7. 处理记录写明 Worker ID、模型、工具、字幕选择、关键帧依据和缓存清理。\n8. 不要输出 Markdown 外层代码围栏。\n\n用户附加要求：\n${session.taskRequirements || '无额外要求'}\n\n任务：\n${JSON.stringify({ bvid: task.bvid, title: task.title, owner: task.owner, duration: task.duration, collection: collection.name, workerId: session.workerId, model: session.modelId }, null, 2)}\n\n元数据：\n${JSON.stringify(materials.info, null, 2).slice(0, 30000)}\n\n素材清单：\n${JSON.stringify(materials.manifest, null, 2).slice(0, 16000)}\n\n关键帧路径：\n${materials.frames.join('\n') || '无'}\n\n站内字幕：\n${materials.station || '未提供可用站内字幕'}\n\nASR 字幕：\n${materials.asr || 'ASR 输出为空，请在文档中如实说明'}\n\n热评：\n${JSON.stringify(materials.comments, null, 2).slice(0, 18000)}\n\n参考模板（按真实内容改写，不保留占位符）：\n${template}`;
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
  const list = Array.isArray(value) ? value : (value?.comments || value?.replies || value?.data?.replies || []);
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

function copyArtifact(source, outputRoot) {
  const root = ensureDir(path.resolve(outputRoot));
  let target = path.join(root, path.basename(source));
  for (let index = 2; fs.existsSync(target); index += 1) target = path.join(root, safeName(`${path.basename(source)} (${index})`, 'video-summary', 180));
  fs.cpSync(source, target, { recursive: true, errorOnExist: true });
  return target;
}

function listFiles(directory, extension) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).map((name) => path.join(directory, name)).filter((file) => fs.statSync(file).isFile() && (!extension || path.extname(file).toLowerCase() === extension)).sort();
}

function readText(file, max) {
  try { return fs.readFileSync(file, 'utf8').slice(0, max); } catch { return ''; }
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
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()); }, { once: true });
  });
}

function abortError() {
  const error = new Error('Agent 工作已停止。');
  error.name = 'AbortError';
  return error;
}

module.exports = { InternalAgentManager, INTERNAL_USER_ID, INTERNAL_USER_NAME, extractBvid, normalizeGeneratedMarkdown };
