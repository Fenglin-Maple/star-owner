const http = require('http');
const fs = require('fs');
const path = require('path');
const { validateSubmission } = require('./validation');
const { buildAnalytics } = require('./analytics');
const { PROJECT_ROOT, collectionDirs, ensureDir, normalizeTags, videoArtifactDir, videoArtifactName, timestampForFile } = require('./workspace');

const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const PAUSED_MESSAGE = '来自用户的信息，你需要暂停工作';
const TEMPLATE_FILE = path.join(PROJECT_ROOT, 'templates', 'video-summary-template.md');

class ApiServer {
  constructor({ store, bili, toolRunner, getCurrentUser, getToolHealth, onEvent }) {
    this.store = store;
    this.bili = bili;
    this.toolRunner = toolRunner;
    this.getCurrentUser = getCurrentUser;
    this.getToolHealth = getToolHealth || (() => []);
    this.onEvent = onEvent || (() => {});
    this.server = null;
    this.port = 0;
  }

  async start(preferredPort = 17391) {
    this.server = http.createServer((req, res) => this.route(req, res));
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

  async route(req, res) {
    try {
      const url = new URL(req.url, this.url());
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
      if (req.method === 'GET' && url.pathname === '/api/tasks') {
        return this.json(res, { tasks: this.store.listTasks({ collectionId: url.searchParams.get('collectionId') || '' }) });
      }
      if (req.method === 'GET' && url.pathname === '/api/tool-runs') return this.listToolRuns(res, url);
      if (req.method === 'POST' && url.pathname === '/api/collections/sync') return this.syncCollection(req, res);
      if (req.method === 'POST' && url.pathname === '/api/tasks/claim') return this.claimTask(req, res);
      if (req.method === 'POST' && url.pathname === '/api/tasks/batch') return this.updateTasks(req, res);

      const workerMatch = url.pathname.match(/^\/api\/workers\/([^/]+)$/);
      if (workerMatch) {
        const workerId = decodeURIComponent(workerMatch[1]);
        if (req.method === 'GET') return this.getWorker(res, workerId);
      }

      const toolMatch = url.pathname.match(/^\/api\/tools\/([^/]+)$/);
      if (toolMatch && (req.method === 'PATCH' || req.method === 'POST')) {
        return this.updateTool(req, res, decodeURIComponent(toolMatch[1]));
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
          if (!task) return this.json(res, { task: null }, 404);
          const collection = this.store.getCollectionById(task.collectionId);
          return this.json(res, { task: collection ? this.taskContext(task, collection) : task });
        }
        if (req.method === 'POST' && action === 'heartbeat') return this.heartbeatTask(req, res, taskId);
        if (req.method === 'POST' && action === 'submit') return this.submitTask(req, res, taskId);
        if (req.method === 'POST' && action === 'fail') return this.failTask(req, res, taskId);
      }

      this.json(res, { error: 'Not found' }, 404);
    } catch (error) {
      this.json(res, { error: error.message || String(error) }, 500);
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

  apiManifest(res, url) {
    const workerId = url.searchParams.get('workerId') || '';
    const worker = workerId ? this.store.getWorker(workerId) : null;
    this.json(res, this.buildApiManifest(worker));
  }

  buildApiManifest(worker = null) {
    const base = this.url();
    return {
      product: '星藏家',
      protocolVersion: '2.1',
      baseUrl: base,
      worker: worker ? this.publicWorker(worker) : null,
      activeCollection: this.store.getActiveCollection(),
      requiredFlow: [
        'A new agent session registers once and receives an app-generated workerId.',
        'Every state-changing agent request includes workerId.',
        'Read the desktop-selected active collection, then claim one task.',
        'Use app-managed tool endpoints. Tool calls return HTTP 202 and may remain queued; poll the run until it reaches a terminal status.',
        'The app protects the task lease while one of its tool runs is queued or running. Clean cache and submit final artifacts after tools finish.'
      ],
      endpoints: [
        { method: 'GET', path: '/api/manifest?workerId=<workerId>', purpose: 'Return this complete interface manifest and current context.', params: { workerId: 'Optional after registration.' } },
        { method: 'POST', path: '/api/workers/register', purpose: 'Create a new caller identity for this fresh agent session.', body: { tool: 'Required caller application, e.g. codex or claude-code.', model: 'Required model name.', sessionLabel: 'Optional human-readable session note.' } },
        { method: 'GET', path: '/api/tool-health', purpose: 'Return startup probe results for every app-managed tool interface.' },
        { method: 'GET', path: '/api/scheduler', purpose: 'Return resource pools, queue depth, GPU memory, ASR service state, and CPU ASR policy.' },
        { method: 'GET', path: '/api/active-collection', purpose: 'Read the collection activated by the desktop user.' },
        { method: 'POST', path: '/api/tasks/claim', purpose: 'Claim one enabled task from the active collection.', body: { workerId: 'Required app-generated worker id.' } },
        { method: 'GET', path: '/api/tasks/<taskId>', purpose: 'Read task context and enabled tools.' },
        { method: 'POST', path: '/api/tasks/<taskId>/heartbeat', purpose: 'Extend the 15-minute lease.', body: { workerId: 'Required.' } },
        { method: 'POST', path: '/api/tasks/<taskId>/tools/<toolId>/run', purpose: 'Queue a tool run. Returns HTTP 202 with queue position, reason, pool, and stage.', body: { workerId: 'Required.', options: 'Tool-specific options object.' } },
        { method: 'GET', path: '/api/tool-runs/<runId>?log=1', purpose: 'Poll queued/running/terminal status, stage, queue metadata, and optional log tail.' },
        { method: 'POST', path: '/api/tool-runs/<runId>/cancel', purpose: 'Cancel a tool run owned by this worker.', body: { workerId: 'Required.' } },
        { method: 'GET', path: '/api/templates/video-summary', purpose: 'Return the reference Markdown template.' },
        { method: 'POST', path: '/api/tasks/<taskId>/submit', purpose: 'Validate and submit final artifacts.', body: { workerId: 'Required.', artifactDir: 'Assigned artifact directory.', markdownFile: 'Final Markdown path.', metadataFile: 'info.json path.' } },
        { method: 'POST', path: '/api/tasks/<taskId>/fail', purpose: 'Report an actionable terminal failure.', body: { workerId: 'Required.', reason: 'Required failure explanation.' } }
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
      message: 'Store this workerId for the lifetime of this agent session and include it in every state-changing request.',
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
    this.json(res, { runs: this.store.listToolRuns({ taskId: url.searchParams.get('taskId') || '' }) });
  }

  getToolRun(res, runId, url) {
    const run = this.store.getToolRun(runId);
    if (!run) return this.json(res, { run: null }, 404);
    const withLog = url.searchParams.get('log') === '1' || url.searchParams.get('log') === 'true';
    this.json(res, { run: withLog ? { ...run, logTail: readTail(run.logFile) } : run });
  }

  async cancelToolRun(req, res, runId) {
    const body = await readBody(req);
    const worker = this.requireWorker(body);
    const existing = this.store.getToolRun(runId);
    if (!existing) throw new Error(`Tool run not found: ${runId}`);
    if ((existing.workerId || existing.agentName) !== worker.id) throw new Error('This worker does not own the tool run.');
    const run = this.toolRunner.cancel(runId);
    this.json(res, { run });
  }

  async syncCollection(req, res) {
    const body = await readBody(req);
    const currentUser = this.getCurrentUser();
    if (!currentUser?.isLogin) throw new Error('Not logged in to Bilibili in the desktop app.');
    const folders = await this.bili.listFolders(currentUser.mid);
    const wanted = folders.find((folder) => folder.name === body.collectionName || folder.id === String(body.collectionName));
    if (!wanted) throw new Error(`Collection not found: ${body.collectionName}`);
    const label = body.label || 'bili';
    const workspace = this.store.getDefaultWorkspace();
    if (!workspace) throw new Error('No default workspace is configured.');
    const dirs = collectionDirs(workspace.root, currentUser.name, wanted.name);
    const cookieFile = await this.bili.exportCookies(currentUser.name);
    const syncId = `sync-${currentUser.mid}-${wanted.id}-${Date.now()}`;
    const expectedTotal = Number(wanted.mediaCount || 0);
    this.onEvent({ type: 'collection-sync-progress', syncId, collectionName: wanted.name, stage: 'fetching', loaded: 0, total: expectedTotal, progress: 0 });
    const videos = await this.bili.listVideos(wanted.id, (progress) => {
      const total = progress.total || expectedTotal || null;
      this.onEvent({
        type: 'collection-sync-progress',
        syncId,
        collectionName: wanted.name,
        stage: progress.done ? 'indexing' : 'fetching',
        loaded: progress.loaded,
        total,
        page: progress.page,
        progress: total ? Math.min(0.92, progress.loaded / total * 0.92) : Math.min(0.9, progress.page / Math.max(progress.page + 1, 2))
      });
    });
    const now = new Date().toISOString();
    const latestFavoriteAt = videos.reduce((latest, video) => {
      const candidate = String(video.favoriteAddedAt || '');
      return candidate > latest ? candidate : latest;
    }, String(wanted.updatedAt || ''));
    const collectionId = `${currentUser.mid}:${wanted.id}`;
    const collection = this.store.upsertCollection({
      id: collectionId,
      mediaId: wanted.id,
      userId: String(currentUser.mid),
      userName: currentUser.name,
      name: wanted.name,
      label,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      collectionRoot: dirs.root,
      videosDir: dirs.videos,
      exportDir: dirs.exports,
      cookieFile,
      lastSyncedAt: now,
      videoCount: videos.length,
      latestFavoriteAt
    });

    for (const video of videos) {
      const key = `${collectionId}:${video.bvid}`;
      this.store.upsertVideo({ key, collectionId, ...video, syncedAt: now });
      const existing = this.store.getTask(key);
      this.store.upsertTask({
        id: key,
        collectionId,
        bvid: video.bvid,
        title: video.title,
        owner: video.owner,
        duration: video.duration,
        cover: video.cover,
        url: video.url,
        favoriteAddedAt: video.favoriteAddedAt,
        publishedAt: video.publishedAt,
        enabled: existing?.enabled !== false,
        status: existing?.status || 'pending',
        claimedBy: existing?.claimedBy || '',
        claimedAt: existing?.claimedAt || '',
        leaseExpiresAt: existing?.leaseExpiresAt || '',
        attempts: existing?.attempts || 0,
        allowedRoot: dirs.videos,
        artifactDir: existing?.artifactDir || '',
        outputMarkdown: existing?.outputMarkdown || '',
        validatorErrors: existing?.validatorErrors || [],
        createdAt: existing?.createdAt || now,
        updatedAt: now
      });
    }
    this.store.commit();
    this.writeCollectionExport(collection, videos);
    this.onEvent({ type: 'collection-sync-progress', syncId, collectionName: wanted.name, stage: 'done', loaded: videos.length, total: videos.length, progress: 1 });
    this.onEvent({ type: 'collection-synced', collection, count: videos.length });
    this.json(res, { collection, count: videos.length });
  }

  async claimTask(req, res) {
    const body = await readBody(req);
    const worker = this.requireWorker(body);
    if (worker.status === 'paused') {
      return this.json(res, {
        task: null,
        message: 'WORKER_PAUSED',
        userMessage: PAUSED_MESSAGE,
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
    reclaimExpired(this.store, collection.id);
    const task = this.store.listTasks({ collectionId: collection.id })
      .find((item) => item.enabled !== false && (item.status === 'pending' || item.status === 'rejected' || item.status === 'failed'));
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
      claimedBy: worker.id,
      claimedAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + DEFAULT_LEASE_MS).toISOString(),
      attempts: Number(task.attempts || 0) + 1,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      allowedRoot: task.cachedVideoId ? task.allowedRoot : dirs.root,
      artifactDir,
      validatorErrors: [],
      updatedAt: now.toISOString()
    });
    this.store.upsertTask(task);
    this.store.commit();
    this.store.recordTaskEvent(task.id, 'claimed', {
      collectionId: collection.id,
      workerId: worker.id,
      agentName: worker.id,
      attempt: task.attempts,
      workspaceId: workspace.id
    });
    this.onEvent({ type: 'task-claimed', taskId: task.id, collectionId: collection.id, workerId: worker.id, agentName: worker.id });
    this.json(res, { worker: this.publicWorker(worker), task: this.taskContext(task, collection, worker) });
  }

  async updateTasks(req, res) {
    const body = await readBody(req);
    if (!Array.isArray(body.taskIds) || !body.taskIds.length) throw new Error('taskIds must be a non-empty array.');
    if (!Object.prototype.hasOwnProperty.call(body, 'enabled')) throw new Error('enabled is required.');
    const tasks = this.store.updateTasksEnabled(body.taskIds, Boolean(body.enabled));
    this.onEvent({ type: 'tasks-enabled-changed', taskIds: tasks.map((task) => task.id), enabled: Boolean(body.enabled) });
    this.json(res, { updated: tasks.length, enabled: Boolean(body.enabled), tasks });
  }

  async runTaskTool(req, res, taskId, toolId) {
    const body = await readBody(req);
    const worker = this.requireWorker(body);
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    this.assertTaskWorker(task, worker);
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
    if (!task) throw new Error(`Task not found: ${taskId}`);
    this.assertTaskWorker(task, worker);
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
    if (!task) throw new Error(`Task not found: ${taskId}`);
    this.assertTaskWorker(task, worker);
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
    Object.assign(task, {
      status: 'done',
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
      processingSeconds: secondsBetween(task.claimedAt, now),
      videoDuration: Number(task.duration || 0)
    });
    this.onEvent({ type: 'task-completed', taskId: task.id, collectionId: task.collectionId, workerId: worker.id, agentName: worker.id });
    this.json(res, { accepted: true, task });
  }

  async failTask(req, res, taskId) {
    const body = await readBody(req);
    const worker = this.requireWorker(body);
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    this.assertTaskWorker(task, worker);
    Object.assign(task, {
      status: 'failed',
      failureReason: body.reason || 'unknown',
      updatedAt: new Date().toISOString()
    });
    this.store.upsertTask(task);
    this.store.commit();
    this.store.recordTaskEvent(task.id, 'failed', {
      collectionId: task.collectionId,
      workerId: worker.id,
      agentName: worker.id,
      reason: task.failureReason
    });
    this.onEvent({ type: 'task-failed', taskId: task.id, collectionId: task.collectionId, workerId: worker.id, agentName: worker.id });
    this.json(res, { task });
  }

  async updateTool(req, res, toolId) {
    const body = await readBody(req);
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(body, 'enabled')) patch.enabled = Boolean(body.enabled);
    const tool = this.store.updateTool(toolId, patch);
    this.onEvent({ type: 'tool-updated', tool });
    this.json(res, { tool: this.publicTool(tool) });
  }

  requireWorker(body = {}) {
    const workerId = String(body.workerId || '').trim();
    if (!workerId) throw new Error('workerId is required. Register this fresh agent session with POST /api/workers/register.');
    return this.store.touchWorker(workerId);
  }

  assertTaskWorker(task, worker) {
    if (!task.claimedBy) throw new Error('Task has not been claimed.');
    if (task.claimedBy !== worker.id) throw new Error(`Task is owned by another worker: ${task.claimedBy}`);
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
          : '最终产物保存后，通过 clean-cache 工具运行 API 删除临时视频和音频缓存。'
      },
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
      resourcePolicy: resourcePolicyForAction(tool.action)
    };
  }

  writeCollectionExport(collection, videos) {
    const exportDir = ensureDir(collection.exportDir || path.join(collection.workspaceRoot, '.star-note', 'exports'));
    const file = path.join(exportDir, `sync-${timestampForFile()}.json`);
    fs.writeFileSync(file, `${JSON.stringify({ collection, videos, exportedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  }

  json(res, data, status = 200) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
      'access-control-allow-headers': 'content-type'
    });
    res.end(JSON.stringify(data, null, 2));
  }
}

function reclaimExpired(store, collectionId) {
  const now = new Date();
  const protectedTaskIds = new Set(
    store.listToolRuns().filter((run) => ['queued', 'running'].includes(run.status)).map((run) => run.taskId)
  );
  for (const task of store.listTasks({ collectionId })) {
    if (task.status === 'claimed' && task.leaseExpiresAt && new Date(task.leaseExpiresAt) <= now) {
      if (protectedTaskIds.has(task.id)) continue;
      task.status = 'pending';
      task.claimedBy = '';
      task.claimedAt = '';
      task.leaseExpiresAt = '';
      task.updatedAt = now.toISOString();
      store.upsertTask(task);
    }
  }
  store.commit();
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

function finalizeSubmissionArtifacts({ task, collection, validation, filenameMetadata }) {
  const currentDir = path.resolve(validation.artifactDir);
  const root = path.resolve(task.allowedRoot || path.dirname(currentDir));
  const baseName = videoArtifactName(task, collection, filenameMetadata);
  let finalDir = path.join(root, baseName);
  if (!samePath(currentDir, finalDir) && fs.existsSync(finalDir)) {
    finalDir = videoArtifactDir(root, task, collection, filenameMetadata);
  }

  const markdownRelative = path.relative(currentDir, validation.markdownFile);
  const metadataRelative = path.relative(currentDir, validation.metadataFile);
  if (!samePath(currentDir, finalDir)) fs.renameSync(currentDir, finalDir);

  const sourceMarkdown = path.join(finalDir, markdownRelative);
  const finalMarkdown = path.join(finalDir, `${path.basename(finalDir)}.md`);
  if (!samePath(sourceMarkdown, finalMarkdown)) {
    if (fs.existsSync(finalMarkdown)) fs.rmSync(finalMarkdown, { force: true });
    fs.renameSync(sourceMarkdown, finalMarkdown);
  }
  return {
    artifactDir: finalDir,
    markdownFile: finalMarkdown,
    metadataFile: path.join(finalDir, metadataRelative)
  };
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function relocateCachedVideo(store, task, finalized) {
  if (!task.cachedVideoId) return;
  const record = store.getVideoCache(task.cachedVideoId);
  if (!record) return;
  const videoName = record.videoFile ? path.basename(record.videoFile) : 'merged.mp4';
  const videoFile = path.join(finalized.artifactDir, videoName);
  task.cachedVideoFile = videoFile;
  store.upsertVideoCache({
    ...record,
    artifactDir: finalized.artifactDir,
    videoFile,
    metadataFile: finalized.metadataFile,
    updatedAt: new Date().toISOString()
  });
  try {
    fs.writeFileSync(path.join(finalized.artifactDir, 'cache-record.json'), `${JSON.stringify(store.getVideoCache(task.cachedVideoId), null, 2)}\n`, 'utf8');
  } catch {}
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk.toString(); });
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

module.exports = { ApiServer, finalizeSubmissionArtifacts };
