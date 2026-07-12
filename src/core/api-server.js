const http = require('http');
const fs = require('fs');
const path = require('path');
const { validateSubmission } = require('./validation');
const { buildAnalytics } = require('./analytics');
const { isAllowedApiOrigin } = require('./network-policy');
const { finalizeSubmissionArtifacts, relocateCachedVideo } = require('./submission-artifacts');
const { abortTaskAttempt, createWorkId } = require('./task-attempt');
const { PROJECT_ROOT, collectionDirs, ensureDir, normalizeTags, videoArtifactDir } = require('./workspace');

const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const PAUSED_MESSAGE = '来自用户的信息，你需要暂停工作';
const TEMPLATE_FILE = path.join(PROJECT_ROOT, 'templates', 'video-summary-template.md');

class ApiServer {
  constructor({ store, toolRunner, getToolHealth, onEvent }) {
    this.store = store;
    this.toolRunner = toolRunner;
    this.getToolHealth = getToolHealth || (() => []);
    this.onEvent = onEvent || (() => {});
    this.server = null;
    this.port = 0;
  }

  async start(preferredPort = 17391) {
    this.server = http.createServer((req, res) => {
      Promise.resolve(this.route(req, res)).catch((error) => this.handleRouteError(res, error));
    });
    this.server.requestTimeout = 30000;
    this.server.headersTimeout = 15000;
    this.server.keepAliveTimeout = 5000;
    this.server.maxHeadersCount = 100;
    await new Promise((resolve, reject) => {
      const listenRandom = () => {
        this.server.removeAllListeners('error');
        this.server.listen(0, '127.0.0.1', () => resolve());
        this.server.once('error', reject);
      };
      this.server.once('error', listenRandom);
      this.server.listen(preferredPort, '127.0.0.1', () => {
        this.server.removeListener('error', listenRandom);
        resolve();
      });
    });
    this.port = this.server.address().port;
    return this.url();
  }

  stop() {
    if (this.server) this.server.close();
  }

  url() {
    return `http://127.0.0.1:${this.port}`;
  }

  handleRouteError(res, error) {
    if (res.headersSent || res.destroyed) {
      if (!res.destroyed) res.destroy();
      return;
    }
    this.json(res, apiErrorPayload(error), Number(error.statusCode || 500));
  }

  async route(req, res) {
    try {
      const url = new URL(req.url, this.url());
      if (!isAllowedApiOrigin(req.headers.origin, this.url())) {
        return this.json(res, { error: 'Browser cross-origin access to the local Agent API is forbidden.' }, 403);
      }
      if (req.method === 'OPTIONS') return this.json(res, { ok: true });
      if (req.method === 'GET' && (url.pathname === '/api' || url.pathname === '/api/manifest')) return this.apiManifest(res, url);
      if (req.method === 'GET' && url.pathname === '/api/health') return this.json(res, { ok: true, url: this.url() });
      if (req.method === 'GET' && url.pathname === '/api/tool-health') return this.json(res, { tools: this.getToolHealth(), checkedAt: new Date().toISOString() });
      if (req.method === 'GET' && url.pathname === '/api/scheduler') return this.json(res, { scheduler: this.toolRunner.getState() });
      if (req.method === 'POST' && url.pathname === '/api/workers/register') return this.registerWorker(req, res);
      if (req.method === 'GET' && url.pathname === '/api/workers') return this.json(res, { workers: buildAnalytics(this.store).workers });
      if (req.method === 'GET' && url.pathname === '/api/templates/video-summary') return this.videoSummaryTemplate(res);
      if (req.method === 'GET' && url.pathname === '/api/collections') return this.json(res, { collections: this.store.listCollections() });
      if (req.method === 'GET' && url.pathname === '/api/active-collection') return this.getActiveCollection(res);
      if (req.method === 'GET' && url.pathname === '/api/stats') return this.listStats(res, url);
      if (req.method === 'GET' && url.pathname === '/api/workspaces') return this.json(res, { workspaces: this.store.listWorkspaces() });
      if (req.method === 'GET' && url.pathname === '/api/tools') return this.listTools(res, url);
      if (req.method === 'GET' && url.pathname === '/api/tasks') return this.listTasks(res, url);
      if (req.method === 'GET' && url.pathname === '/api/tool-runs') return this.listToolRuns(res, url);
      if (req.method === 'POST' && url.pathname === '/api/tasks/claim') return this.claimTask(req, res);

      const workerMatch = url.pathname.match(/^\/api\/workers\/([^/]+)$/);
      if (workerMatch) {
        const workerId = decodeURIComponent(workerMatch[1]);
        if (req.method === 'GET') return this.getWorker(res, workerId);
      }

      const taskToolMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/tools\/([^/]+)\/run$/);
      if (taskToolMatch && req.method === 'POST') {
        return this.runTaskTool(req, res, decodeURIComponent(taskToolMatch[1]), decodeURIComponent(taskToolMatch[2]));
      }

      const runMatch = url.pathname.match(/^\/api\/tool-runs\/([^/]+)(?:\/([^/]+))?$/);
      if (runMatch) {
        const runId = decodeURIComponent(runMatch[1]);
        const action = runMatch[2] || '';
        if (req.method === 'GET' && !action) return this.getToolRun(res, runId, url);
        if (req.method === 'POST' && action === 'cancel') return this.cancelToolRun(req, res, runId);
      }

      const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/([^/]+))?$/);
      if (taskMatch) {
        const taskId = decodeURIComponent(taskMatch[1]);
        const action = taskMatch[2] || '';
        if (req.method === 'GET' && !action) {
          const task = this.store.getTask(taskId);
          if (!task) {
            const unavailable = this.store.get('unavailableTasks', taskId);
            return this.json(res, unavailable
              ? { task: null, code: 'BILIBILI_VIDEO_UNAVAILABLE', unavailable, directive: { action: 'stop', message: 'This video was removed from inventory and will not be reassigned.' } }
              : { task: null }, unavailable ? 410 : 404);
          }
          const collection = this.store.getCollectionById(task.collectionId);
          return this.json(res, { task: collection ? this.taskContext(task, collection) : task });
        }
        if (req.method === 'POST' && action === 'heartbeat') return this.heartbeatTask(req, res, taskId);
        if (req.method === 'POST' && action === 'submit') return this.submitTask(req, res, taskId);
        if (req.method === 'POST' && action === 'abort') return this.abortTask(req, res, taskId);
        if (req.method === 'POST' && action === 'fail') return this.failTask(req, res, taskId);
      }

      this.json(res, { error: 'Not found' }, 404);
    } catch (error) {
      this.json(res, apiErrorPayload(error), Number(error.statusCode || 500));
    }
  }

  listTools(res, url) {
    const enabled = url.searchParams.get('enabled');
    const filter = enabled === null ? {} : { enabled: enabled === 'true' || enabled === '1' };
    this.json(res, { tools: this.store.listTools(filter).map((tool) => this.publicTool(tool)) });
  }

  listStats(res, url) {
    const analytics = buildAnalytics(this.store);
    const collectionId = url.searchParams.get('collectionId');
    if (!collectionId) return this.json(res, { analytics });
    this.json(res, { collectionId, stats: analytics.collections[collectionId] || null });
  }

  listTasks(res, url) {
    const collectionId = url.searchParams.get('collectionId') || '';
    const all = this.store.listTasks({ collectionId });
    const limit = boundedLimit(url.searchParams.get('limit'));
    this.json(res, { tasks: all.slice(0, limit), total: all.length, limit });
  }

  apiManifest(res, url) {
    const workerId = url.searchParams.get('workerId') || '';
    const worker = workerId ? this.store.getWorker(workerId) : null;
    this.json(res, this.buildApiManifest(worker));
  }

  buildApiManifest(worker = null) {
    const base = this.url();
    return {
      product: '星藏家',
      protocolVersion: '2.4',
      baseUrl: base,
      worker: worker ? this.publicWorker(worker) : null,
      activeCollection: this.store.getActiveCollection(),
      requiredFlow: [
        'A new agent session registers once and receives an app-generated workerId.',
        'A long-running agent keeps one workerId, while every successful claim returns a brand-new one-time workId.',
        'Every state-changing task request includes workerId and the workId returned by that specific claim.',
        'Read the desktop-selected active collection, then claim one task.',
        'Use app-managed tool endpoints. Tool calls return HTTP 202 and may remain queued; poll the run until it reaches a terminal status.',
        'The app protects the task lease while one of its tool runs is queued or running. Clean cache and submit final artifacts after tools finish.',
        'If the attempt cannot continue, call the task abort endpoint with workerId, workId, and a concrete reason. The app removes the attempt and the next claim starts from scratch.'
      ],
      endpoints: [
        { method: 'GET', path: '/api/manifest?workerId=<workerId>', purpose: 'Return this complete interface manifest and current context.', params: { workerId: 'Optional after registration.' } },
        { method: 'POST', path: '/api/workers/register', purpose: 'Create a new caller identity for this fresh agent session.', body: { tool: 'Required caller application, e.g. codex or claude-code.', model: 'Required model name.', sessionLabel: 'Optional human-readable session note.' } },
        { method: 'GET', path: '/api/tool-health', purpose: 'Return startup probe results for every app-managed tool interface.' },
        { method: 'GET', path: '/api/scheduler', purpose: 'Return resource pools, queue depth, GPU memory, ASR service state, and CPU ASR policy.' },
        { method: 'GET', path: '/api/active-collection', purpose: 'Read the collection activated by the desktop user.' },
        { method: 'POST', path: '/api/tasks/claim', purpose: 'Claim one enabled task and create a unique workId for this attempt.', body: { workerId: 'Required app-generated Worker identity.' } },
        { method: 'GET', path: '/api/tasks/<taskId>', purpose: 'Read task context and enabled tools.' },
        { method: 'POST', path: '/api/tasks/<taskId>/heartbeat', purpose: 'Extend the 15-minute lease.', body: { workerId: 'Required.', workId: 'Required one-time claim id.' } },
        { method: 'POST', path: '/api/tasks/<taskId>/tools/<toolId>/run', purpose: 'Queue a tool run. Returns HTTP 202 with queue position, reason, pool, and stage.', body: { workerId: 'Required.', workId: 'Required one-time claim id.', options: 'Tool-specific options object.' } },
        { method: 'GET', path: '/api/tool-runs/<runId>?log=1', purpose: 'Poll queued/running/terminal status, stage, queue metadata, and optional log tail.' },
        { method: 'POST', path: '/api/tool-runs/<runId>/cancel', purpose: 'Cancel a tool run owned by the current work attempt.', body: { workerId: 'Required.', workId: 'Required one-time claim id.' } },
        { method: 'GET', path: '/api/templates/video-summary', purpose: 'Return the reference Markdown template.' },
        { method: 'POST', path: '/api/tasks/<taskId>/submit', purpose: 'Validate and submit final artifacts.', body: { workerId: 'Required.', workId: 'Required one-time claim id.', artifactDir: 'Assigned artifact directory.', markdownFile: 'Final Markdown path.', metadataFile: 'info.json path.' } },
        { method: 'POST', path: '/api/tasks/<taskId>/abort', purpose: 'Stop the current attempt, cancel app-managed tools, delete attempt files, invalidate workId, and return the task to pending.', body: { workerId: 'Required.', workId: 'Required one-time claim id.', reason: 'Required explanation of why work cannot continue.' } },
        { method: 'POST', path: '/api/tasks/<taskId>/fail', purpose: 'Compatibility alias for abort. Failed attempts are cleaned and returned to pending.', body: { workerId: 'Required.', workId: 'Required one-time claim id.', reason: 'Required failure explanation.' } }
      ],
      tools: this.store.listTools({ enabled: true }).map((tool) => this.publicTool(tool)),
      markdownTemplateUrl: `${base}/api/templates/video-summary`,
      pauseMessage: PAUSED_MESSAGE
    };
  }

  async registerWorker(req, res) {
    const body = await readBody(req);
    const worker = this.store.registerWorker(body);
    this.onEvent({ type: 'worker-registered', workerId: worker.id, tool: worker.tool, model: worker.model });
    this.json(res, {
      workerId: worker.id,
      worker: this.publicWorker(worker),
      message: 'Store this workerId for the lifetime of this agent session. Each claim also returns a one-time workId required by every state-changing request for that task.',
      manifest: this.buildApiManifest(worker)
    }, 201);
  }

  getWorker(res, workerId) {
    const worker = this.store.getWorker(workerId);
    if (!worker) return this.json(res, { worker: null }, 404);
    const stats = buildAnalytics(this.store).workers.find((item) => item.workerId === workerId) || null;
    this.json(res, { worker: this.publicWorker(worker), stats });
  }

  videoSummaryTemplate(res) {
    if (!fs.existsSync(TEMPLATE_FILE)) throw new Error('Video summary template is missing.');
    this.json(res, { name: 'video-summary-template.md', template: fs.readFileSync(TEMPLATE_FILE, 'utf8') });
  }

  getActiveCollection(res) {
    const collection = this.store.getActiveCollection();
    if (!collection) return this.json(res, { collection: null, message: 'NO_ACTIVE_COLLECTION' });
    const stats = buildAnalytics(this.store).collections[collection.id] || null;
    this.json(res, { collection, stats });
  }

  listToolRuns(res, url) {
    const all = this.store.listToolRuns({ taskId: url.searchParams.get('taskId') || '' });
    const limit = boundedLimit(url.searchParams.get('limit'));
    this.json(res, { runs: all.slice(0, limit), total: all.length, limit });
  }

  getToolRun(res, runId, url) {
    const run = this.store.getToolRun(runId);
    if (!run) return this.json(res, { run: null }, 404);
    const withLog = url.searchParams.get('log') === '1' || url.searchParams.get('log') === 'true';
    const task = run.workId ? this.store.getTask(run.taskId) : null;
    const active = Boolean(run.workId && task?.workId === run.workId && ['claimed', 'rejected'].includes(task.status));
    this.json(res, {
      run: withLog ? { ...run, logTail: readTail(run.logFile) } : run,
      ...(run.workId ? {
        workAttempt: active
          ? { active: true, workId: run.workId }
          : { active: false, code: 'WORK_ATTEMPT_ENDED', workId: run.workId, directive: claimNewTaskDirective() }
      } : {})
    });
  }

  async cancelToolRun(req, res, runId) {
    const body = await readBody(req);
    const worker = this.requireWorker(body);
    const existing = this.store.getToolRun(runId);
    if (!existing) throw new Error(`Tool run not found: ${runId}`);
    const task = this.store.getTask(existing.taskId);
    if (!task) throw missingTaskError(this.store, existing.taskId);
    this.assertTaskWorker(task, worker, body.workId);
    if (existing.workId && existing.workId !== String(body.workId || '')) throw workAttemptEndedError(task, String(body.workId || ''));
    if ((existing.workerId || existing.agentName) !== worker.id) throw new Error('This worker does not own the tool run.');
    const run = this.toolRunner.cancel(runId);
    this.json(res, { run });
  }

  async claimTask(req, res) {
    const body = await readBody(req);
    const worker = this.requireWorker(body);
    if (worker.status === 'paused') {
      return this.json(res, {
        task: null,
        message: 'WORKER_PAUSED',
        userMessage: [PAUSED_MESSAGE, worker.pauseReason ? `原因：${worker.pauseReason}` : ''].filter(Boolean).join('\n'),
        directive: worker.pauseReason ? { action: 'stop-and-report', reason: worker.pauseReason } : { action: 'pause' },
        worker: this.publicWorker(worker)
      }, 423);
    }
    const collection = this.store.getActiveCollection();
    if (!collection) throw new Error('No active collection. Select and activate one in the desktop task inventory.');
    if (body.collectionId && body.collectionId !== collection.id) {
      throw new Error('The desktop app owns task targeting. Remove collectionId or activate that collection in the task inventory.');
    }
    if (body.collectionName && body.collectionName !== collection.name) {
      throw new Error('The desktop app owns task targeting. Remove collectionName or activate that collection in the task inventory.');
    }
    reclaimExpired(this.store, collection.id, this.toolRunner);
    const task = this.store.listTasks({ collectionId: collection.id })
      .find((item) => item.enabled !== false && (item.status === 'pending' || item.status === 'failed' || (item.status === 'rejected' && !item.workId && !item.claimedBy)));
    if (!task) return this.json(res, { task: null, message: 'NO_TASK' });
    const now = new Date();
    const workspace = this.store.getDefaultWorkspace();
    if (!workspace) throw new Error('No default workspace is configured.');
    const dirs = collectionDirs(workspace.root, collection.userName, collection.name);
    const canReuseArtifact = task.artifactDir && (task.cachedVideoId ? fs.existsSync(task.artifactDir) : task.workspaceId === workspace.id);
    const artifactDir = canReuseArtifact
      ? task.artifactDir
      : videoArtifactDir(dirs.videos, task, collection, this.store.getFilenameMetadata());
    ensureDir(artifactDir);
    Object.assign(task, {
      status: 'claimed',
      workId: createWorkId(),
      claimedBy: worker.id,
      claimedAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + DEFAULT_LEASE_MS).toISOString(),
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
    this.store.recordTaskEvent(task.id, 'claimed', {
      collectionId: collection.id,
      workerId: worker.id,
      agentName: worker.id,
      attempt: task.attempts,
      workId: task.workId,
      workspaceId: workspace.id
    });
    this.onEvent({ type: 'task-claimed', taskId: task.id, collectionId: collection.id, workerId: worker.id, agentName: worker.id });
    this.json(res, { worker: this.publicWorker(worker), task: this.taskContext(task, collection, worker) });
  }

  async runTaskTool(req, res, taskId, toolId) {
    const body = await readBody(req);
    const worker = this.requireWorker(body);
    const task = this.store.getTask(taskId);
    if (!task) throw missingTaskError(this.store, taskId);
    this.assertTaskWorker(task, worker, body.workId);
    if (task.enabled === false) throw new Error('Task is disabled and cannot run tools.');
    const tool = this.store.get('tools', toolId);
    if (!tool) throw new Error(`Tool not found: ${toolId}`);
    const collection = this.store.getCollectionById(task.collectionId);
    const run = this.toolRunner.start({
      task,
      tool,
      collection,
      workerId: worker.id,
      options: body.options || {}
    });
    this.json(res, { run }, 202);
  }

  async heartbeatTask(req, res, taskId) {
    const body = await readBody(req);
    const worker = this.requireWorker(body);
    const task = this.store.getTask(taskId);
    if (!task) throw missingTaskError(this.store, taskId);
    this.assertTaskWorker(task, worker, body.workId);
    task.leaseExpiresAt = new Date(Date.now() + DEFAULT_LEASE_MS).toISOString();
    task.updatedAt = new Date().toISOString();
    this.store.upsertTask(task);
    this.store.commit();
    this.json(res, { task });
  }

  async submitTask(req, res, taskId) {
    const body = await readBody(req);
    const worker = this.requireWorker(body);
    const task = this.store.getTask(taskId);
    if (!task) throw missingTaskError(this.store, taskId);
    this.assertTaskWorker(task, worker, body.workId);
    const validation = validateSubmission(task, body);
    const now = new Date().toISOString();
    this.store.recordSubmission(taskId, {
      createdAt: now,
      workerId: worker.id,
      agentName: worker.id,
      request: body,
      accepted: validation.ok,
      errors: validation.errors
    });
    if (!validation.ok) {
      Object.assign(task, {
        status: 'rejected',
        validatorErrors: validation.errors,
        updatedAt: now
      });
      this.store.upsertTask(task);
      this.store.commit();
      this.store.recordTaskEvent(task.id, 'rejected', {
        collectionId: task.collectionId,
        workerId: worker.id,
        agentName: worker.id,
        errors: validation.errors
      });
      this.onEvent({ type: 'task-rejected', taskId: task.id, collectionId: task.collectionId, workerId: worker.id, agentName: worker.id });
      return this.json(res, { accepted: false, errors: validation.errors }, 422);
    }
    const collection = this.store.getCollectionById(task.collectionId) || {};
    const metadata = readMetadataFile(validation.metadataFile);
    task.tags = normalizeTags(metadata.tags || task.tags);
    const finalized = finalizeSubmissionArtifacts({
      task,
      collection,
      validation,
      filenameMetadata: this.store.getFilenameMetadata()
    });
    const completedWorkId = task.workId;
    Object.assign(task, {
      status: 'done',
      workId: '',
      completedAt: now,
      outputMarkdown: finalized.markdownFile,
      artifactDir: finalized.artifactDir,
      metadataFile: finalized.metadataFile,
      validatorErrors: [],
      updatedAt: now
    });
    relocateCachedVideo(this.store, task, finalized);
    this.store.upsertTask(task);
    this.store.commit();
    this.store.recordTaskEvent(task.id, 'completed', {
      collectionId: task.collectionId,
      workerId: worker.id,
      agentName: worker.id,
      workId: completedWorkId,
      processingSeconds: secondsBetween(task.claimedAt, now),
      videoDuration: Number(task.duration || 0)
    });
    this.onEvent({ type: 'task-completed', taskId: task.id, collectionId: task.collectionId, workerId: worker.id, agentName: worker.id });
    this.json(res, { accepted: true, completedWorkId, task });
  }

  async failTask(req, res, taskId) {
    return this.abortTask(req, res, taskId, 'agent-fail');
  }

  async abortTask(req, res, taskId, source = 'agent-abort') {
    const body = await readBody(req);
    const worker = this.requireWorker(body);
    const task = this.store.getTask(taskId);
    if (!task) throw missingTaskError(this.store, taskId);
    this.assertTaskWorker(task, worker, body.workId);
    const reason = String(body.reason || '').trim();
    if (!reason) throw new Error('reason is required so the application can record why this attempt stopped.');
    const result = abortTaskAttempt({ store: this.store, toolRunner: this.toolRunner, taskId, workerId: worker.id, reason, source });
    this.onEvent({ type: 'task-attempt-aborted', taskId: task.id, collectionId: task.collectionId, workerId: worker.id, agentName: worker.id, reason, source, cleanup: result.cleanup });
    this.json(res, { aborted: true, endedWorkId: result.endedWorkId, task: result.task, cancelledRuns: result.cancelledRuns, cleanup: result.cleanup });
  }

  requireWorker(body = {}) {
    const workerId = String(body.workerId || '').trim();
    if (!workerId) throw new Error('workerId is required. Register this fresh agent session with POST /api/workers/register.');
    return this.store.touchWorker(workerId);
  }

  assertTaskWorker(task, worker, workId) {
    const suppliedWorkId = String(workId || '').trim();
    if (!suppliedWorkId) throw workIdRequiredError(task);
    if (!task.workId || task.workId !== suppliedWorkId || !['claimed', 'rejected'].includes(task.status)) {
      throw workAttemptEndedError(task, suppliedWorkId);
    }
    if (!task.claimedBy || task.claimedBy !== worker.id) throw httpError(409, 'This work attempt is owned by another worker.', {
      code: 'WORK_ATTEMPT_OWNED_BY_ANOTHER',
      taskId: task.id,
      workId: suppliedWorkId,
      directive: { action: 'stop', message: 'Do not continue or modify this task.' }
    });
  }

  publicWorker(worker) {
    return {
      id: worker.id,
      workerId: worker.id,
      tool: worker.tool,
      model: worker.model,
      sessionLabel: worker.sessionLabel || '',
      status: worker.status,
      createdAt: worker.createdAt,
      lastSeenAt: worker.lastSeenAt,
      pausedAt: worker.pausedAt || '',
      pauseReason: worker.pauseReason || ''
    };
  }

  taskContext(task, collection, worker = null) {
    return {
      id: task.id,
      status: task.status,
      workId: task.workId || '',
      bvid: task.bvid,
      title: task.title,
      owner: task.owner,
      duration: task.duration,
      userName: collection.userName,
      collectionName: collection.name,
      collectionId: collection.id,
      workspaceId: task.workspaceId,
      workspaceRoot: task.workspaceRoot,
      videoUrl: canonicalVideoUrl(task),
      artifactDir: task.artifactDir,
      allowedRoot: task.allowedRoot,
      cookieFile: collection.cookieFile,
      leaseExpiresAt: task.leaseExpiresAt,
      outputMarkdown: task.outputMarkdown || '',
      completedAt: task.completedAt || '',
      validatorErrors: task.validatorErrors || [],
      cachedVideoId: task.cachedVideoId || '',
      cachedVideoFile: task.cachedVideoFile || '',
      reuseCachedMedia: Boolean(task.cachedVideoId || task.reuseCachedMedia),
      worker: worker ? this.publicWorker(worker) : null,
      apiManifestUrl: `${this.url()}/api/manifest${worker ? `?workerId=${encodeURIComponent(worker.id)}` : ''}`,
      markdownTemplateUrl: `${this.url()}/api/templates/video-summary`,
      requirements: {
        output: ['Markdown 总结', 'info.json', '精选关键帧', '字幕比对结果', '可获取时的热评前三条'],
        requiredSections: ['小结', '目录', '思维导图', '字幕比对', '评论分析', '处理记录'],
        requiredOpeningOrder: ['小结', '思维导图', '目录'],
        cleanup: task.cachedVideoId
          ? '最终产物保存后仍调用 clean-cache；应用会保留缓存库中的合轨视频，只删除音频等过渡缓存。'
          : '最终产物保存后，通过 clean-cache 工具运行 API 删除临时视频和音频缓存。',
        authorization: '本次领取的 workId 是一次性工作凭证。心跳、工具运行/取消、提交和中止都必须同时提交 workerId 与 workId。不要自行生成或复用旧 workId。',
        interruption: `如果当前任务因错误、用户要求或其它原因无法继续，必须立即 POST ${this.url()}/api/tasks/${encodeURIComponent(task.id)}/abort 并提交 workerId、workId 与 reason。应用会取消工具、删除本次产物并将任务退回 pending；旧 workId 随即失效，不要自行保留断点或直接修改文件状态。`
      },
      abortUsage: `POST ${this.url()}/api/tasks/${encodeURIComponent(task.id)}/abort`,
      toolPolicy: 'Agent 不直接运行本地工具脚本。必须通过 /api/tasks/<taskId>/tools/<toolId>/run 请求桌面应用代为执行。',
      tools: this.store.listTools({ enabled: true }).map((tool) => this.publicTool(tool, task.id))
    };
  }

  publicTool(tool, taskId = '<taskId>') {
    const taskPart = taskId === '<taskId>' ? '<taskId>' : encodeURIComponent(taskId);
    return {
      id: tool.id,
      action: tool.action,
      name: tool.name,
      category: tool.category,
      enabled: tool.enabled,
      description: tool.description,
      apiUsage: `POST ${this.url()}/api/tasks/${taskPart}/tools/${encodeURIComponent(tool.id)}/run`,
      statusUsage: `GET ${this.url()}/api/tool-runs/<runId>?log=1`,
      cancelUsage: `POST ${this.url()}/api/tool-runs/<runId>/cancel`,
      internalCommand: tool.internalCommand,
      agentPrompt: tool.agentPrompt,
      outputs: tool.outputs,
      projects: tool.projects,
      resourcePolicy: resourcePolicyForAction(tool.action),
      workIdRequired: true
    };
  }

  json(res, data, status = 200) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    });
    res.end(JSON.stringify(data, null, 2));
  }
}

function reclaimExpired(store, collectionId, toolRunner = null) {
  const now = new Date();
  const protectedTaskIds = new Set(
    store.listToolRuns().filter((run) => ['queued', 'running'].includes(run.status)).map((run) => run.taskId)
  );
  for (const task of store.listTasks({ collectionId })) {
    if (['claimed', 'rejected'].includes(task.status) && task.leaseExpiresAt && new Date(task.leaseExpiresAt) <= now) {
      if (protectedTaskIds.has(task.id)) continue;
      abortTaskAttempt({ store, toolRunner, taskId: task.id, workerId: task.claimedBy, reason: 'Task lease expired before the Agent completed or aborted the attempt.', source: 'lease-expired' });
    }
  }
}

function resourcePolicyForAction(action) {
  if (action === 'bundle') return ['api', 'media', 'asr'];
  if (action === 'asr') return ['media', 'asr'];
  if (['info', 'subtitles', 'comments'].includes(action)) return ['api'];
  if (action === 'clean-cache') return ['disk'];
  return ['media'];
}

function canonicalVideoUrl(task = {}) {
  if (task.bvid) return `https://www.bilibili.com/video/${task.bvid}`;
  return task.url || '';
}

function readMetadataFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    let bytes = 0;
    const contentLength = Number(req.headers['content-length'] || 0);
    if (contentLength > MAX_JSON_BODY_BYTES) return reject(httpError(413, 'JSON request body exceeds 1 MiB.'));
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_JSON_BODY_BYTES) {
        reject(httpError(413, 'JSON request body exceeds 1 MiB.'));
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      text += chunk.toString();
    });
    req.on('end', () => {
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function httpError(statusCode, message, details = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

function workIdRequiredError(task) {
  return httpError(400, 'workId is required. Use the one-time workId returned by the current task claim.', {
    code: 'WORK_ID_REQUIRED',
    taskId: task.id,
    directive: { action: 'use-claimed-work-id', message: 'Read workId from the task claim response. Do not invent one.' }
  });
}

function missingTaskError(store, taskId) {
  const unavailable = store.get('unavailableTasks', String(taskId || ''));
  if (unavailable) return httpError(410, 'This Bilibili video was deleted, removed, or made unavailable. The task was permanently removed from inventory.', {
    code: 'BILIBILI_VIDEO_UNAVAILABLE',
    taskId,
    directive: { action: 'stop', message: 'Do not retry this task. Request a new task with the same workerId.' }
  });
  return httpError(404, `Task not found: ${taskId}`, { code: 'TASK_NOT_FOUND', taskId });
}

function workAttemptEndedError(task, workId) {
  return httpError(409, 'This work attempt no longer exists. It was completed, interrupted, expired, or replaced by a newer claim.', {
    code: 'WORK_ATTEMPT_ENDED',
    taskId: task.id,
    workId,
    taskStatus: task.status,
    directive: claimNewTaskDirective()
  });
}

function claimNewTaskDirective() {
  return {
    action: 'claim-new-task',
    method: 'POST',
    path: '/api/tasks/claim',
    keepWorkerId: true,
    message: 'Stop using this workId and request a new task with the same workerId.'
  };
}

function apiErrorPayload(error) {
  const payload = { error: error.message || String(error) };
  for (const key of ['code', 'taskId', 'workId', 'taskStatus', 'directive']) {
    if (error[key] !== undefined) payload[key] = error[key];
  }
  return payload;
}

function boundedLimit(value, fallback = 300) {
  return Math.max(1, Math.min(1000, Math.floor(Number(value) || fallback)));
}

function secondsBetween(start, end) {
  const startMs = Date.parse(start || '');
  const endMs = Date.parse(end || '');
  return startMs && endMs >= startMs ? (endMs - startMs) / 1000 : 0;
}

function readTail(file, maxBytes = 12000) {
  if (!file || !fs.existsSync(file)) return '';
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(stat.size - start);
  fs.readSync(fd, buffer, 0, buffer.length, start);
  fs.closeSync(fd);
  return buffer.toString('utf8');
}

module.exports = { ApiServer, MAX_JSON_BODY_BYTES };
