const fs = require('fs');
const path = require('path');
const { execFile, spawn, spawnSync } = require('child_process');
const { promisify } = require('util');
const { AsrService } = require('./asr-service');
const { detectAsrHardware } = require('./hardware-capabilities');
const { isVideoUnavailableMessage, videoUnavailableError } = require('./media-errors');
const { ResourceScheduler } = require('./resource-scheduler');
const { abortTaskAttempt, recoverPendingAttemptCleanups } = require('./task-attempt');
const { removeUnavailableTask } = require('./unavailable-task');
const { PROJECT_ROOT, assertInside, ensureDir, safeName } = require('./workspace');

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const ACTIVE_STATUSES = new Set(['queued', 'running']);
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'timeout', 'skipped']);
const DEFAULT_CONFIG = Object.freeze({
  cpuAsrEnabled: false,
  asrModel: 'medium',
  apiConcurrency: 2,
  apiStartIntervalMs: 850,
  mediaConcurrency: 3,
  diskConcurrency: 2,
  gpuReserveMiB: 1024,
  gpuStartupReserveMiB: 3072
});

class ToolRunner {
  constructor({ store, onEvent, onState }) {
    this.store = store;
    this.onEvent = onEvent || (() => {});
    this.onState = onState || (() => {});
    this.scheduler = new ResourceScheduler({ onState: () => this.notifyState() });
    this.activeRuns = new Map();
    this.processes = new Map();
    this.config = { ...DEFAULT_CONFIG };
    this.gpu = emptyGpuState();
    this.hardware = emptyHardwareState();
    this.initialized = false;
    this.shuttingDown = false;
    this.stateTimer = null;
    this.gpuTimer = null;
    this.leaseTimer = null;
    this.cpuStopTimer = null;
    this.cleanupRecoveryTimer = null;
    this.maintenance = null;
    this.gpuAsr = new AsrService({
      id: 'asr-gpu',
      device: 'cuda',
      computeType: 'float16',
      onEvent: (event) => this.publish(event),
      onLog: (id, message) => this.onEvent({ type: 'asr-service-log', serviceId: id, message: String(message).trim().slice(0, 500) })
    });
    this.cpuAsr = new AsrService({
      id: 'asr-cpu',
      device: 'cpu',
      computeType: 'int8',
      onEvent: (event) => this.publish(event),
      onLog: (id, message) => this.onEvent({ type: 'asr-service-log', serviceId: id, message: String(message).trim().slice(0, 500) })
    });
  }

  async initialize({ startGpuService = true } = {}) {
    if (this.initialized) return this.getState();
    this.shuttingDown = false;
    this.loadConfig();
    this.gpuAsr.model = this.config.asrModel;
    this.cpuAsr.model = this.config.asrModel;
    this.registerPools();
    const cleanupRecovery = recoverPendingAttemptCleanups(this.store);
    await this.refreshGpuState();
    this.hardware = await detectAsrHardware({ gpu: this.gpu, model: this.config.asrModel });
    this.scheduler.setLaneEnabled('asr', 'gpu', this.hardware.nvidia.supported);
    if (this.config.cpuAsrEnabled && !this.hardware.cpu.supported) {
      this.config.cpuAsrEnabled = false;
      this.scheduler.setLaneEnabled('asr', 'cpu', false);
      this.persistConfig();
    }
    if (startGpuService && this.hardware.nvidia.supported && this.gpu.freeMiB >= this.config.gpuStartupReserveMiB) {
      try {
        await this.gpuAsr.start();
        await this.refreshGpuState();
      } catch (error) {
        this.gpuAsr.lastError = error.message;
        this.publish({ type: 'asr-gpu-start-failed', error: error.message });
      }
    } else if (startGpuService) {
      this.gpuAsr.lastError = this.hardware.nvidia.supported
        ? `GPU free memory ${this.gpu.freeMiB} MiB is below startup reserve ${this.config.gpuStartupReserveMiB} MiB.`
        : (this.hardware.issues.join(' ') || this.gpu.error || 'NVIDIA CUDA ASR is unavailable.');
    }
    if (this.config.cpuAsrEnabled) {
      try {
        await this.cpuAsr.start();
      } catch (error) {
        this.config.cpuAsrEnabled = false;
        this.scheduler.setLaneEnabled('asr', 'cpu', false);
        this.persistConfig();
        this.publish({ type: 'asr-cpu-start-failed', error: error.message });
      }
    }
    this.initialized = true;
    this.gpuTimer = setInterval(async () => {
      try {
        await this.refreshGpuState();
      } catch (error) {
        try { this.onEvent({ type: 'gpu-state-refresh-failed', error: error.message || String(error) }); }
        catch { console.error(`[gpu-state-refresh] ${error.message || String(error)}`); }
      } finally {
        this.scheduler.dispatch('asr');
      }
    }, 3000);
    this.gpuTimer.unref?.();
    this.leaseTimer = setInterval(() => {
      try {
        this.protectActiveTaskLeases();
      } catch (error) {
        try { this.onEvent({ type: 'task-lease-refresh-failed', error: error.message || String(error) }); }
        catch { console.error(`[task-lease-refresh] ${error.message || String(error)}`); }
      }
    }, 60 * 1000);
    this.leaseTimer.unref?.();
    const recovery = this.restoreInterruptedRuns();
    this.protectActiveTaskLeases();
    this.publish({ type: 'resource-scheduler-ready', restoredRuns: recovery.restoredRuns, rolledBackTasks: recovery.rolledBackTasks, recoveredCleanups: cleanupRecovery.filter((item) => item.ok).length, cpuAsrEnabled: this.config.cpuAsrEnabled });
    this.notifyState(true);
    return this.getState();
  }

  async ensureGpuAsr() {
    if (!this.initialized) return this.initialize();
    if (this.gpuAsr.ready && this.gpuAsr.child) return this.getState();
    this.gpuAsr.model = this.config.asrModel;
    await this.refreshGpuState();
    this.hardware = await detectAsrHardware({ gpu: this.gpu, model: this.config.asrModel });
    this.scheduler.setLaneEnabled('asr', 'gpu', this.hardware.nvidia.supported);
    if (!this.hardware.nvidia.supported) throw new Error(this.hardware.issues.join(' ') || this.gpu.error || 'NVIDIA CUDA ASR is unavailable.');
    if (this.gpu.freeMiB < this.config.gpuStartupReserveMiB) throw new Error(`GPU free memory ${this.gpu.freeMiB} MiB is below startup reserve ${this.config.gpuStartupReserveMiB} MiB.`);
    await this.gpuAsr.start();
    await this.refreshGpuState();
    this.notifyState(true);
    return this.getState();
  }

  loadConfig() {
    const saved = this.store.get('settings', 'toolScheduler') || {};
    let migrated = Number(saved.resourcePolicyVersion || 0) >= 2
      ? saved
      : { ...saved, mediaConcurrency: Math.max(3, Number(saved.mediaConcurrency || 0)), resourcePolicyVersion: 2 };
    if (Number(migrated.asrModelPolicyVersion || 0) < 1) {
      migrated = { ...migrated, asrModel: 'medium', asrModelPolicyVersion: 1 };
    }
    this.config = normalizeConfig({ ...DEFAULT_CONFIG, ...migrated });
    this.store.set('settings', 'toolScheduler', { id: 'toolScheduler', ...this.config, updatedAt: new Date().toISOString() });
    this.store.commit();
  }

  registerPools() {
    this.scheduler.registerPool('api', {
      minStartIntervalMs: this.config.apiStartIntervalMs,
      lanes: createLanes('api', this.config.apiConcurrency, 'Bilibili API')
    });
    this.scheduler.registerPool('media', {
      lanes: createLanes('media', this.config.mediaConcurrency, 'Download / FFmpeg')
    });
    this.scheduler.registerPool('disk', {
      lanes: createLanes('disk', this.config.diskConcurrency, 'Disk cleanup')
    });
    this.scheduler.registerPool('asr', {
      lanes: [
        { id: 'gpu', label: 'CUDA faster-whisper', type: 'gpu', gate: () => this.gpuGate() },
        { id: 'cpu', label: 'CPU faster-whisper', type: 'cpu', enabled: this.config.cpuAsrEnabled, gate: () => this.cpuGate() }
      ]
    });
  }

  async probeTools(tools = this.store.listTools(), onResult = () => {}) {
    const results = await Promise.all(tools.map(async (tool) => {
      const result = await probeTool(tool);
      onResult(result);
      return result;
    }));
    return results.sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  }

  start({ task, tool, collection, workerId, agentName, options = {} }) {
    if (!this.initialized) throw new Error('Resource scheduler is still starting.');
    if (this.maintenance) {
      const error = new Error(`Application tools are temporarily paused for ${this.maintenance.reason}. Wait for dependency installation to finish and retry.`);
      error.code = 'TOOL_MAINTENANCE_ACTIVE';
      error.failureKind = 'infrastructure';
      throw error;
    }
    if (!task) throw new Error('Task does not exist.');
    if (!tool) throw new Error('Tool does not exist.');
    if (!tool.enabled) throw new Error(`Tool is disabled: ${tool.id}`);
    if (!task.artifactDir) throw new Error('Task has no artifactDir. Claim the task before running tools.');

    const artifactDir = assertInside(task.allowedRoot, task.artifactDir);
    ensureDir(artifactDir);
    const runId = `${Date.now()}-${safeName(tool.id)}-${Math.random().toString(16).slice(2, 8)}`;
    const runDir = ensureDir(path.join(artifactDir, 'tool-runs'));
    const logFile = path.join(runDir, `${runId}.log`);
    const timeoutMs = clampNumber(options.timeoutMs, 60 * 1000, 12 * 60 * 60 * 1000, DEFAULT_TIMEOUT_MS);
    const now = new Date().toISOString();
    const callerId = workerId || agentName || task.claimedBy || 'unknown-worker';
    const pool = initialPoolForAction(tool.action);
    const runRecord = {
      id: runId,
      taskId: task.id,
      workId: task.workId || '',
      collectionId: collection?.id || task.collectionId || '',
      toolId: tool.id,
      toolName: tool.name,
      action: tool.action,
      workerId: callerId,
      agentName: callerId,
      status: 'queued',
      stage: initialStageForAction(tool.action),
      command: `app://tools/${tool.id}`,
      actualCommand: '',
      cwd: PROJECT_ROOT,
      artifactDir,
      logFile,
      options: sanitizeOptions(options),
      resourcePool: pool,
      resourceLane: '',
      queuePosition: 1,
      queueLength: 1,
      queueReason: 'RESOURCE_BUSY',
      estimatedWaitMs: null,
      exitCode: null,
      signal: '',
      timeoutMs,
      createdAt: now,
      queuedAt: now,
      startedAt: '',
      updatedAt: now,
      finishedAt: ''
    };
    fs.appendFileSync(logFile, `[${now}] queued ${tool.id} for ${task.id}\n`, 'utf8');
    const run = this.store.createToolRun(runRecord);
    this.enqueuePersistedRun(run);
    this.protectActiveTaskLeases();
    this.publish({ type: 'tool-run-queued', runId, toolId: tool.id, taskId: task.id, resourcePool: pool });
    return this.store.getToolRun(runId);
  }

  enqueuePersistedRun(run) {
    if (this.activeRuns.has(run.id)) return;
    const state = {
      runId: run.id,
      workerId: run.workerId || run.agentName || 'unknown-worker',
      cancelled: false,
      finalized: false,
      schedulerJobId: '',
      stageCounter: 0,
      child: null,
      asrService: null,
      warnings: []
    };
    this.activeRuns.set(run.id, state);
    this.executeRun(state)
      .catch((error) => this.handleUnexpectedRunFailure(state, error))
      .finally(() => {
        this.activeRuns.delete(run.id);
        this.processes.delete(run.id);
        this.stopCpuWhenIdle();
        this.notifyState(true);
      });
  }

  async executeRun(state) {
    const run = this.store.getToolRun(state.runId);
    const task = run ? this.store.getTask(run.taskId) : null;
    const tool = run ? this.store.get('tools', run.toolId) : null;
    const collection = task ? this.store.getCollectionById(run.collectionId || task.collectionId) : null;
    if (!run || !task || !tool) {
      return this.finishRun(state, 'failed', { error: 'Persisted tool run is missing its task or tool definition.' });
    }
    try {
      if (tool.action === 'bundle') await this.executeBundle(state, run, task, tool, collection);
      else if (tool.action === 'asr') await this.executeAsr(state, run, task, tool, collection);
      else {
        const pool = initialPoolForAction(tool.action);
        await this.runCommandStage(state, pool, tool.action, this.buildArgs({ task, action: tool.action, collection, artifactDir: run.artifactDir, options: run.options || {} }));
      }
      if (state.cancelled) throw cancelledError(run.id);
      return this.finishRun(state, 'succeeded', { exitCode: 0, stage: 'complete' });
    } catch (error) {
      if (this.shuttingDown) {
        const current = this.store.getToolRun(run.id);
        if (state.cancelled || current?.status === 'cancelled') return current;
        return this.updateRun(run.id, {
          status: 'queued',
          stage: 'recovery',
          resourceLane: '',
          queueReason: 'APP_RESTART_RECOVERY',
          queuePosition: null,
          queueLength: null,
          estimatedWaitMs: null,
          signal: 'APP_SHUTDOWN',
          error: ''
        });
      }
      if (state.cancelled || error.code === 'RUN_CANCELLED' || error.code === 'SCHEDULER_CANCELLED') {
        return this.finishRun(state, 'cancelled', { signal: 'CANCELLED', error: 'Cancelled by caller.' });
      }
      if (error.code === 'BILIBILI_VIDEO_UNAVAILABLE' || isVideoUnavailableMessage(error.message)) {
        const terminalError = error.code === 'BILIBILI_VIDEO_UNAVAILABLE' ? error : videoUnavailableError(error.message);
        const removal = removeUnavailableTask({
          store: this.store,
          toolRunner: this,
          taskId: task.id,
          reason: terminalError.message,
          source: 'tool-runner',
          excludeRunId: run.id
        });
        this.publish({ type: 'video-unavailable', taskId: task.id, collectionId: task.collectionId, bvid: task.bvid, reason: terminalError.message, removed: removal.removed });
        error = terminalError;
      }
      const status = error.code === 'BILIBILI_VIDEO_UNAVAILABLE' ? 'skipped' : (error.code === 'TOOL_TIMEOUT' ? 'timeout' : 'failed');
      const finished = this.finishRun(state, status, {
        signal: status === 'timeout' ? 'TIMEOUT' : '',
        error: error.message || String(error),
        errorCode: error.code || '',
        failureKind: error.failureKind || '',
        possibleCauses: Array.isArray(error.possibleCauses) ? error.possibleCauses : [],
        stage: 'error'
      });
      if (error.code === 'ASR_INFRASTRUCTURE_FAILURE') this.stopWorkerForInfrastructure(run, task, error);
      return finished;
    }
  }

  handleUnexpectedRunFailure(state, error) {
    const current = this.store.getToolRun(state.runId);
    if (!current || TERMINAL_STATUSES.has(current.status)) return current;
    const message = `Unexpected tool-runner failure: ${error?.message || String(error)}`;
    try { this.appendLog(state.runId, `\n[${new Date().toISOString()}] ${message}\n`); } catch {}
    try {
      return this.finishRun(state, 'failed', {
        error: message,
        errorCode: error?.code || 'TOOL_RUNNER_FAILURE',
        failureKind: error?.failureKind || 'infrastructure',
        possibleCauses: Array.isArray(error?.possibleCauses) ? error.possibleCauses : [],
        stage: 'error'
      });
    } catch {
      try {
        return this.store.updateToolRun(state.runId, {
          status: 'failed',
          stage: 'error',
          error: message,
          errorCode: error?.code || 'TOOL_RUNNER_FAILURE',
          failureKind: 'infrastructure',
          finishedAt: new Date().toISOString()
        });
      } catch { return null; }
    }
  }

  async executeBundle(state, run, task, tool, collection) {
    await this.runScheduledStage(state, 'api', 'metadata-comments', async () => {
      const options = run.options || {};
      if (!options.skipInfo) {
        await this.runChild(state, this.buildArgs({ task, action: 'info', collection, artifactDir: run.artifactDir, options }), run.timeoutMs);
      }
      if (!fs.existsSync(path.join(run.artifactDir, 'info.json'))) {
        throw new Error('Required video metadata is missing after the material bundle metadata stage.');
      }
      const optionalCalls = [];
      if (!options.skipSubtitles) optionalCalls.push(['subtitles', this.buildArgs({ task, action: 'subtitles', collection, artifactDir: run.artifactDir, options })]);
      if (!options.skipComments && options.comments !== false && Number(options.commentLimit ?? 3) > 0) {
        optionalCalls.push(['comments', this.buildArgs({ task, action: 'comments', collection, artifactDir: run.artifactDir, options: { ...options, commentLimit: clampNumber(options.commentLimit, 1, 3, 3) } })]);
      }
      for (const [label, args] of optionalCalls) {
        try {
          await this.runChild(state, args, run.timeoutMs);
        } catch (error) {
          if (state.cancelled || error.code === 'TOOL_TIMEOUT') throw error;
          if (error.code === 'BILIBILI_VIDEO_UNAVAILABLE' || isVideoUnavailableMessage(error.message)) throw videoUnavailableError(error.message);
          state.warnings.push(`${label}: ${error.message}`);
          this.appendLog(run.id, `[warning] ${label} failed: ${error.message}\n`);
        }
      }
    });

    await this.runCommandStage(state, 'media', 'media-preparation', this.buildArgs({
      task,
      action: 'bundle',
      collection,
      artifactDir: run.artifactDir,
      options: { ...(run.options || {}), asr: false, comments: false, skipInfo: true, skipSubtitles: true, skipComments: true, audio: true }
    }));
    await this.runAsrStage(state, run);
    this.finalizeBundleManifest(run, state.warnings);
  }

  async executeAsr(state, run, task, tool, collection) {
    await this.runCommandStage(state, 'media', 'audio-preparation', this.buildArgs({
      task,
      action: 'audio',
      collection,
      artifactDir: run.artifactDir,
      options: run.options || {}
    }));
    await this.runAsrStage(state, run);
  }

  async runAsrStage(state, run) {
    const audioFile = path.join(run.artifactDir, 'audio', 'audio.wav');
    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync(path.join(run.artifactDir, 'manifest.json'), 'utf8')); } catch {}
    let audioStatus = manifest.audio || {};
    try {
      if (!audioStatus.reason) audioStatus = JSON.parse(fs.readFileSync(path.join(run.artifactDir, 'audio', 'status.json'), 'utf8'));
    } catch {}
    if (!fs.existsSync(audioFile)) {
      if (audioStatus.available === false && audioStatus.reason === 'NO_AUDIO_STREAM') {
        const result = writeNoAudioAsrArtifacts(run.artifactDir, {
          model: this.config.asrModel,
          duration: this.store.getTask(run.taskId)?.duration,
          message: audioStatus.message
        });
        this.updateRun(run.id, { asrResult: result, actualCommand: 'ASR skipped: source video has no audio stream' });
        this.appendLog(run.id, `[${new Date().toISOString()}] ASR skipped: source video has no audio stream; empty diagnostic artifacts created.\n`);
        this.recordAsrManifest(run);
        return result;
      }
      const context = [...(state.warnings || []), ...(manifest.warnings || [])].join('\n');
      if (isVideoUnavailableMessage(context)) throw videoUnavailableError(context);
      throw new Error(`ASR audio is missing: ${audioFile}${context ? `\nEarlier tool errors:\n${context.slice(-2400)}` : ''}`);
    }
    const outputDir = ensureDir(path.join(run.artifactDir, 'asr'));
    await this.runScheduledStage(state, 'asr', 'transcription', async (lane) => {
      const service = lane.id === 'cpu' ? this.cpuAsr : this.gpuAsr;
      state.asrService = service;
      this.appendLog(run.id, `[${new Date().toISOString()}] transcribe on ${service.id}, pid=${service.child?.pid || '-'}\n`);
      try {
        let lastProgressWrite = 0;
        const request = {
          id: run.id,
          action: 'transcribe',
          audio: audioFile,
          outputDir,
          language: run.options?.language || 'auto',
          beamSize: clampNumber(run.options?.beamSize, 1, 10, 5),
          conditionOnPreviousText: run.options?.conditionOnPreviousText !== false
        };
        const maxNewTokens = optionalAsrMaxNewTokens(run.options?.maxNewTokens);
        if (maxNewTokens !== undefined) request.maxNewTokens = maxNewTokens;
        const result = await withTimeout(service.request(request, {
          onProgress: (progress) => {
            if (Date.now() - lastProgressWrite < 800 && Number(progress.progress || 0) < 1) return;
            lastProgressWrite = Date.now();
            this.updateRun(run.id, { asrProgress: progress });
            this.appendLog(run.id, `[${new Date().toISOString()}] ASR ${Math.round(Number(progress.progress || 0) * 100)}% (${Number(progress.audioSeconds || 0).toFixed(1)}s / ${Number(progress.totalSeconds || 0).toFixed(1)}s)\n`);
          }
        }), Number(run.timeoutMs || DEFAULT_TIMEOUT_MS), () => service.cancel(run.id));
        this.updateRun(run.id, { asrResult: result, actualCommand: `${service.id} transcribe ${audioFile}` });
        this.appendLog(run.id, `[${new Date().toISOString()}] ASR completed: ${JSON.stringify(result)}\n`);
        this.recordAsrManifest(run);
        return result;
      } catch (error) {
        if (state.cancelled || ['RUN_CANCELLED', 'SCHEDULER_CANCELLED', 'TOOL_TIMEOUT'].includes(error.code)) throw error;
        if (!isAsrInfrastructureFailure(error, service)) {
          error.code ||= 'ASR_TRANSCRIPTION_FAILED';
          error.failureKind ||= 'task';
          throw error;
        }
        service.lastError = error.message || String(error);
        throw asrInfrastructureError(error, service);
      } finally {
        state.asrService = null;
      }
    });
  }

  runCommandStage(state, pool, stage, args) {
    return this.runScheduledStage(state, pool, stage, () => this.runChild(state, args, this.store.getToolRun(state.runId)?.timeoutMs));
  }

  async runScheduledStage(state, pool, stage, execute) {
    if (state.cancelled) throw cancelledError(state.runId);
    const schedulerJobId = `${state.runId}:${++state.stageCounter}:${stage}`;
    state.schedulerJobId = schedulerJobId;
    const queuedAt = new Date().toISOString();
    this.updateRun(state.runId, {
      status: 'queued',
      stage,
      resourcePool: pool,
      resourceLane: '',
      queuedAt,
      queueReason: 'RESOURCE_BUSY'
    });
    const handle = this.scheduler.enqueue(pool, {
      id: schedulerJobId,
      workerId: state.workerId,
      execute,
      cancel: () => this.cancelCurrentWork(state),
      onQueued: (queue) => {
        if (state.cancelled || this.shuttingDown) return;
        this.updateRun(state.runId, {
          status: 'queued',
          stage,
          resourcePool: queue.pool,
          resourceLane: '',
          queuePosition: queue.position,
          queueLength: queue.queued,
          queueReason: queue.reason,
          estimatedWaitMs: queue.estimatedWaitMs
        });
      },
      onStart: ({ pool: startedPool, lane }) => {
        const latest = this.store.getToolRun(state.runId);
        this.updateRun(state.runId, {
          status: 'running',
          stage,
          resourcePool: startedPool,
          resourceLane: lane,
          queuePosition: 0,
          queueLength: 0,
          queueReason: '',
          estimatedWaitMs: 0,
          startedAt: latest?.startedAt || new Date().toISOString()
        });
        this.publish({ type: 'tool-run-stage-started', runId: state.runId, stage, resourcePool: startedPool, resourceLane: lane });
      }
    });
    try {
      return await handle.promise;
    } finally {
      if (state.schedulerJobId === schedulerJobId) state.schedulerJobId = '';
    }
  }

  runChild(state, args, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (state.cancelled) return Promise.reject(cancelledError(state.runId));
    const command = displayCommand(args);
    this.updateRun(state.runId, { actualCommand: command });
    this.appendLog(state.runId, `\n[${new Date().toISOString()}] start ${command}\n`);
    return new Promise((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let outputTail = '';
      const rememberOutput = (chunk) => {
        outputTail = `${outputTail}${String(chunk)}`.slice(-8000);
      };
      const child = spawn('node', args, {
        cwd: PROJECT_ROOT,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      state.child = child;
      this.processes.set(state.runId, child);
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, clampNumber(timeoutMs, 60 * 1000, 12 * 60 * 60 * 1000, DEFAULT_TIMEOUT_MS));
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (state.child === child) state.child = null;
        if (this.processes.get(state.runId) === child) this.processes.delete(state.runId);
        error ? reject(error) : resolve(result);
      };
      child.stdout.on('data', (chunk) => {
        const text = String(chunk);
        rememberOutput(text);
        this.appendLog(state.runId, text);
        const progress = parseDownloadProgress(text);
        if (progress) this.updateRun(state.runId, { downloadProgress: progress });
      });
      child.stderr.on('data', (chunk) => {
        rememberOutput(chunk);
        this.appendLog(state.runId, String(chunk));
      });
      child.on('error', (error) => finish(error));
      child.on('close', (code, signal) => {
        this.appendLog(state.runId, `[${new Date().toISOString()}] exit code=${code} signal=${signal || ''}\n`);
        if (state.cancelled || this.shuttingDown) return finish(cancelledError(state.runId));
        if (timedOut) {
          const error = new Error(`Tool stage timed out after ${timeoutMs} ms.`);
          error.code = 'TOOL_TIMEOUT';
          return finish(error);
        }
        if (code !== 0) {
          const detail = outputTail.trim();
          const error = new Error(`Tool process exited with code ${code}${signal ? ` (${signal})` : ''}.${detail ? `\n${detail}` : ''}`);
          if (isVideoUnavailableMessage(detail)) {
            const unavailable = videoUnavailableError(detail);
            unavailable.exitCode = code;
            return finish(unavailable);
          }
          return finish(error);
        }
        finish(null, { exitCode: code, signal: signal || '' });
      });
    });
  }

  cancel(runId) {
    const run = this.store.getToolRun(runId);
    if (!run) throw new Error(`Tool run not found: ${runId}`);
    if (TERMINAL_STATUSES.has(run.status)) return run;
    const state = this.activeRuns.get(runId);
    if (state) {
      state.cancelled = true;
      state.finalized = true;
      if (state.schedulerJobId) this.scheduler.cancel(state.schedulerJobId);
      this.cancelCurrentWork(state);
    }
    const next = this.updateRun(runId, {
      status: 'cancelled',
      stage: 'cancelled',
      queuePosition: null,
      queueLength: null,
      queueReason: '',
      estimatedWaitMs: null,
      signal: 'CANCELLED',
      finishedAt: new Date().toISOString()
    });
    this.publish({ type: 'tool-run-cancelled', runId, toolId: run.toolId, taskId: run.taskId });
    return next;
  }

  cancelCurrentWork(state) {
    if (state.child) killProcessTree(state.child);
    if (state.asrService) state.asrService.cancel(state.runId);
  }

  scheduleCleanupRecovery(delayMs = 1800) {
    if (this.cleanupRecoveryTimer || this.shuttingDown) return;
    this.cleanupRecoveryTimer = setTimeout(() => {
      this.cleanupRecoveryTimer = null;
      const results = recoverPendingAttemptCleanups(this.store);
      for (const result of results) {
        this.publish({
          type: result.ok ? 'task-attempt-cleanup-recovered' : 'task-attempt-cleanup-still-pending',
          taskId: result.id,
          cleanup: result.cleanup || null,
          error: result.error || ''
        });
      }
      const retryable = this.store.list('attemptCleanupQueue').some((item) => Number(item.attempts || 0) < 5);
      if (retryable) this.scheduleCleanupRecovery(Math.min(5 * 60 * 1000, Math.max(15000, Number(delayMs || 1800) * 3)));
    }, Math.max(500, Number(delayMs) || 1800));
    this.cleanupRecoveryTimer.unref?.();
  }

  finishRun(state, status, patch = {}) {
    if (state.finalized && !this.shuttingDown) return this.store.getToolRun(state.runId);
    state.finalized = true;
    const current = this.store.getToolRun(state.runId);
    if (!current) return null;
    if (current.status === 'cancelled' && status !== 'cancelled') return current;
    const next = this.updateRun(state.runId, {
      status,
      resourceLane: current.resourceLane || '',
      queuePosition: null,
      queueLength: null,
      queueReason: '',
      estimatedWaitMs: null,
      finishedAt: new Date().toISOString(),
      ...patch
    });
    this.publish({
      type: `tool-run-${status}`,
      runId: state.runId,
      toolId: current.toolId,
      taskId: current.taskId,
      error: patch.error || ''
    });
    return next;
  }

  finalizeBundleManifest(run, warnings = []) {
    const file = path.join(run.artifactDir, 'manifest.json');
    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    const outputs = { ...(manifest.outputs || {}) };
    if (fs.existsSync(path.join(run.artifactDir, 'info.json'))) outputs.info = 'info.json';
    if (fs.existsSync(path.join(run.artifactDir, 'comments', 'comments.json'))) outputs.comments = 'comments/comments.json';
    if (fs.existsSync(path.join(run.artifactDir, 'subtitles', 'index.json'))) outputs.subtitles = 'subtitles/';
    if (fs.existsSync(path.join(run.artifactDir, 'audio', 'audio.wav'))) outputs.audio = 'audio/audio.wav';
    addAsrManifestOutputs(outputs, run.artifactDir);
    manifest = {
      ...manifest,
      videoUrl: manifest.videoUrl || this.store.getTask(run.taskId)?.url || '',
      createdAt: manifest.createdAt || run.createdAt,
      completedAt: new Date().toISOString(),
      outputs,
      warnings: [...new Set([...(manifest.warnings || []), ...warnings])]
    };
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  recordAsrManifest(run) {
    const file = path.join(run.artifactDir, 'manifest.json');
    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    const outputs = { ...(manifest.outputs || {}) };
    addAsrManifestOutputs(outputs, run.artifactDir);
    fs.writeFileSync(file, `${JSON.stringify({
      ...manifest,
      videoUrl: manifest.videoUrl || this.store.getTask(run.taskId)?.url || '',
      createdAt: manifest.createdAt || run.createdAt,
      outputs
    }, null, 2)}\n`, 'utf8');
  }

  restoreInterruptedRuns() {
    const rolledBackTaskIds = new Set();
    for (const task of this.store.listTasks().filter((item) => ['claimed', 'rejected'].includes(item.status))) {
      try {
        abortTaskAttempt({
          store: this.store,
          toolRunner: this,
          taskId: task.id,
          workerId: task.claimedBy,
          reason: '应用在本次视频总结任务完成前退出，启动时已执行完整回滚。',
          source: 'app-restart-recovery'
        });
        rolledBackTaskIds.add(task.id);
      } catch (error) {
        rolledBackTaskIds.add(task.id);
        this.publish({ type: 'task-attempt-cleanup-failed', taskId: task.id, workerId: task.claimedBy, error: error.message || String(error), source: 'app-restart-recovery' });
      }
    }

    let restoredRuns = 0;
    for (const run of this.store.listToolRuns()) {
      if (!ACTIVE_STATUSES.has(run.status)) continue;
      if (rolledBackTaskIds.has(run.taskId)) {
        this.store.updateToolRun(run.id, { status: 'cancelled', stage: 'cancelled', signal: 'ATTEMPT_ROLLED_BACK', finishedAt: new Date().toISOString() });
        continue;
      }
      if (run.workerId === 'video-cache-manager' || run.agentName === 'video-cache-manager') {
        this.store.updateToolRun(run.id, {
          status: 'cancelled',
          stage: 'cancelled',
          signal: 'VIDEO_CACHE_JOB_RECOVERY',
          error: '',
          finishedAt: new Date().toISOString()
        });
        continue;
      }
      const task = this.store.getTask(run.taskId);
      const tool = this.store.get('tools', run.toolId);
      if (!task || !tool) {
        this.store.updateToolRun(run.id, { status: 'failed', error: 'Could not restore run because task or tool is missing.', finishedAt: new Date().toISOString() });
        continue;
      }
      const recovered = this.store.updateToolRun(run.id, {
        status: 'queued',
        stage: 'recovery',
        collectionId: run.collectionId || task.collectionId || '',
        options: run.options || {},
        resourcePool: initialPoolForAction(tool.action),
        resourceLane: '',
        queuePosition: null,
        queueLength: null,
        queueReason: 'APP_RESTART_RECOVERY',
        estimatedWaitMs: null,
        recoveredAt: new Date().toISOString(),
        finishedAt: '',
        signal: ''
      });
      this.enqueuePersistedRun(recovered);
      restoredRuns += 1;
    }
    return { restoredRuns, rolledBackTasks: rolledBackTaskIds.size };
  }

  protectActiveTaskLeases() {
    if (!this.activeRuns.size) return;
    const now = new Date();
    let changed = false;
    for (const state of this.activeRuns.values()) {
      const run = this.store.getToolRun(state.runId);
      if (!run || !ACTIVE_STATUSES.has(run.status)) continue;
      const task = this.store.getTask(run.taskId);
      if (!task || !['claimed', 'rejected'].includes(task.status) || task.claimedBy !== run.workerId || task.workId !== run.workId) continue;
      task.leaseExpiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
      task.updatedAt = now.toISOString();
      this.store.upsertTask(task);
      changed = true;
    }
    if (changed) this.store.commit();
  }

  async gpuGate() {
    await this.refreshGpuState();
    this.syncHardwareGpuState();
    if (!this.hardware.nvidia.supported) {
      if (this.config.cpuAsrEnabled) return { ready: false, reason: 'GPU_UNAVAILABLE', message: this.gpu.error, retryAfterMs: 5000 };
      return {
        ready: false,
        fatal: true,
        reason: 'ASR_INFRASTRUCTURE_FAILURE',
        code: 'ASR_INFRASTRUCTURE_FAILURE',
        failureKind: 'infrastructure',
        message: `GPU ASR 不可用且 CPU ASR 已关闭：${this.hardware.issues.join(' ') || this.gpu.error || '未检测到兼容的 NVIDIA/CUDA 环境。'}`,
        possibleCauses: ['当前设备没有兼容的 NVIDIA GPU', 'NVIDIA 驱动、CUDA 运行库或 CTranslate2 设备检测失败', this.hardware.cpu.supported ? '可在设置中手动启用 CPU ASR' : '当前 CPU/内存环境也不满足本地 ASR 条件']
      };
    }
    if (!this.gpuAsr.ready) {
      if (this.gpu.freeMiB < this.config.gpuStartupReserveMiB) {
        return {
          ready: false,
          reason: 'GPU_CAPACITY_WAIT',
          message: `Need ${this.config.gpuStartupReserveMiB} MiB free to load the model; ${this.gpu.freeMiB} MiB is free.`,
          retryAfterMs: 3000,
          freeMiB: this.gpu.freeMiB
        };
      }
      try {
        await this.gpuAsr.start();
        await this.refreshGpuState();
      } catch (error) {
        const failure = this.asrInfrastructureGate(this.gpuAsr, 'GPU');
        return failure || { ready: false, reason: 'GPU_SERVICE_UNAVAILABLE', message: error.message, retryAfterMs: Number(error.retryAfterMs || 5000) };
      }
    }
    if (this.gpu.freeMiB < this.config.gpuReserveMiB) {
      return {
        ready: false,
        reason: 'GPU_CAPACITY_WAIT',
        message: `GPU free memory ${this.gpu.freeMiB} MiB is below reserve ${this.config.gpuReserveMiB} MiB.`,
        retryAfterMs: 2500,
        freeMiB: this.gpu.freeMiB
      };
    }
    return { ready: true, freeMiB: this.gpu.freeMiB, reserveMiB: this.config.gpuReserveMiB };
  }

  async cpuGate() {
    if (!this.config.cpuAsrEnabled) return { ready: false, reason: 'CPU_ASR_DISABLED', retryAfterMs: 5000 };
    if (!this.hardware.cpu.supported) {
      return { ready: false, fatal: true, reason: 'ASR_HARDWARE_UNSUPPORTED', code: 'ASR_HARDWARE_UNSUPPORTED', failureKind: 'infrastructure', message: this.hardware.recommendation, possibleCauses: this.hardware.issues };
    }
    try {
      await this.cpuAsr.start();
      return { ready: true };
    } catch (error) {
      if (Number(this.cpuAsr.consecutiveFailures || 0) >= 3) {
        this.config.cpuAsrEnabled = false;
        this.scheduler.setLaneEnabled('asr', 'cpu', false);
        this.persistConfig();
        this.publish({ type: 'asr-cpu-disabled-after-failures', error: error.message || String(error) });
        return { ready: false, reason: 'CPU_SERVICE_UNAVAILABLE', message: error.message, retryAfterMs: 500 };
      }
      const failure = this.asrInfrastructureGate(this.cpuAsr, 'CPU');
      return failure || { ready: false, reason: 'CPU_SERVICE_UNAVAILABLE', message: error.message, retryAfterMs: Number(error.retryAfterMs || 5000) };
    }
  }

  asrInfrastructureGate(service, label) {
    if (Number(service.consecutiveFailures || 0) < 3) return null;
    if (label === 'GPU' && this.config.cpuAsrEnabled) return null;
    if (label === 'CPU') return null;
    const possibleCauses = diagnoseAsrFailure(service, label);
    const exit = service.lastExitCode === null || service.lastExitCode === undefined ? '' : `，退出码 ${service.lastExitCode}`;
    return {
      ready: false,
      fatal: true,
      reason: 'ASR_INFRASTRUCTURE_FAILURE',
      code: 'ASR_INFRASTRUCTURE_FAILURE',
      failureKind: 'infrastructure',
      message: `${label} ASR 常驻服务连续 ${service.consecutiveFailures} 次启动失败${exit}，应用已停止相关 Agent，避免继续领取视频。`,
      possibleCauses
    };
  }

  stopWorkerForInfrastructure(run, task, error) {
    const possibleCauses = Array.isArray(error.possibleCauses) ? error.possibleCauses : [];
    const reason = [error.message || String(error), possibleCauses.length ? `可能原因：${possibleCauses.join('；')}` : ''].filter(Boolean).join('\n');
    const worker = this.store.getWorker(run.workerId);
    if (worker) this.store.updateWorker(worker.id, { status: 'paused', pauseReason: reason, pausedAt: new Date().toISOString() });
    let cleanup = null;
    try {
      cleanup = abortTaskAttempt({ store: this.store, toolRunner: this, taskId: task?.id || run.taskId, workerId: run.workerId, reason, source: 'infrastructure-failure' }).cleanup;
    } catch (cleanupError) {
      this.store.commit();
      this.publish({ type: 'task-attempt-cleanup-failed', workerId: run.workerId, taskId: task?.id || run.taskId, error: cleanupError.message || String(cleanupError) });
    }
    this.publish({ type: 'agent-infrastructure-stopped', workerId: run.workerId, taskId: task?.id || run.taskId, error: error.message || String(error), possibleCauses, cleanup });
  }

  async refreshGpuState() {
    try {
      const { stdout } = await execFileAsync('nvidia-smi', [
        '--query-gpu=index,name,memory.total,memory.used,memory.free',
        '--format=csv,noheader,nounits'
      ], { windowsHide: true, timeout: 5000 });
      const line = String(stdout || '').trim().split(/\r?\n/).find(Boolean);
      if (!line) throw new Error('nvidia-smi returned no GPU rows.');
      const [index, name, total, used, free] = line.split(',').map((value) => value.trim());
      this.gpu = {
        available: true,
        index: Number(index || 0),
        name,
        totalMiB: Number(total || 0),
        usedMiB: Number(used || 0),
        freeMiB: Number(free || 0),
        error: '',
        checkedAt: new Date().toISOString()
      };
    } catch (error) {
      this.gpu = { ...emptyGpuState(), error: error.message || String(error), checkedAt: new Date().toISOString() };
    }
    if (this.hardware?.checkedAt) this.syncHardwareGpuState();
    this.notifyState();
    return this.gpu;
  }

  async updateConfig(patch = {}) {
    const next = normalizeConfig({ ...this.config, ...patch });
    const modelChanged = next.asrModel !== this.config.asrModel;
    const enablingCpu = !this.config.cpuAsrEnabled && next.cpuAsrEnabled;
    let cpuStartError = null;

    if (enablingCpu && !this.hardware.cpu.supported) {
      throw new Error(`当前硬件环境不支持所选模型的 CPU ASR：${this.hardware.issues.join(' ') || this.hardware.recommendation}`);
    }

    if (modelChanged) {
      const asrPool = this.scheduler.snapshot().pools?.asr;
      const busy = Number(asrPool?.queued || 0) > 0 || (asrPool?.lanes || []).some((lane) => lane.busy || lane.checking);
      if (busy || this.gpuAsr.currentRequestId || this.cpuAsr.currentRequestId) {
        throw new Error('ASR 正在转写或已有任务排队，请等待队列空闲后再切换模型。');
      }
      const modelRoot = path.join(PROJECT_ROOT, 'runtime', 'models', next.asrModel);
      if (!fs.existsSync(path.join(modelRoot, 'model.bin')) || !fs.existsSync(path.join(modelRoot, 'config.json'))) {
        throw new Error(`${next.asrModel} 模型尚未安装，请先在“项目依赖包”中下载。`);
      }
      this.scheduler.setLaneEnabled('asr', 'gpu', false);
      this.scheduler.setLaneEnabled('asr', 'cpu', false);
      this.gpuAsr.stop();
      this.cpuAsr.stop();
      try {
        await waitForServicesStopped([this.gpuAsr, this.cpuAsr]);
      } catch (error) {
        this.scheduler.setLaneEnabled('asr', 'gpu', this.hardware.nvidia.supported);
        this.scheduler.setLaneEnabled('asr', 'cpu', this.config.cpuAsrEnabled);
        this.notifyState(true);
        throw error;
      }
    }

    this.config = next;
    this.gpuAsr.model = next.asrModel;
    this.cpuAsr.model = next.asrModel;
    if (modelChanged) {
      await this.refreshGpuState();
      this.hardware = await detectAsrHardware({ gpu: this.gpu, model: next.asrModel });
      if (next.cpuAsrEnabled && !this.hardware.cpu.supported) {
        this.config.cpuAsrEnabled = false;
        cpuStartError = new Error(`所选模型不满足 CPU ASR 条件：${this.hardware.issues.join(' ') || this.hardware.recommendation}`);
      }
      if (this.hardware.nvidia.supported && this.gpu.freeMiB >= this.config.gpuStartupReserveMiB) {
        try { await this.gpuAsr.start(); }
        catch (error) {
          this.gpuAsr.lastError = error.message;
          this.publish({ type: 'asr-gpu-start-failed', error: error.message, model: next.asrModel });
        }
      }
    }
    if (this.config.cpuAsrEnabled && (enablingCpu || modelChanged)) {
      try {
        await this.cpuAsr.start();
      } catch (error) {
        this.config.cpuAsrEnabled = false;
        cpuStartError = error;
      }
    }
    this.scheduler.setLaneEnabled('asr', 'gpu', this.hardware.nvidia.supported);
    this.scheduler.setLaneEnabled('asr', 'cpu', this.config.cpuAsrEnabled);
    this.persistConfig();
    if (!this.config.cpuAsrEnabled) this.stopCpuWhenIdle();
    this.publish({ type: 'scheduler-config-updated', cpuAsrEnabled: this.config.cpuAsrEnabled, asrModel: this.config.asrModel, gpuReserveMiB: this.config.gpuReserveMiB });
    this.notifyState(true);
    if (cpuStartError) throw cpuStartError;
    return this.getState();
  }

  persistConfig() {
    this.store.set('settings', 'toolScheduler', { id: 'toolScheduler', ...this.config, updatedAt: new Date().toISOString() });
    this.store.commit();
  }

  stopCpuWhenIdle() {
    if (this.config.cpuAsrEnabled || this.cpuAsr.currentRequestId || !this.cpuAsr.child) return;
    if (this.cpuStopTimer) clearTimeout(this.cpuStopTimer);
    this.cpuStopTimer = setTimeout(() => {
      this.cpuStopTimer = null;
      if (!this.config.cpuAsrEnabled && !this.cpuAsr.currentRequestId) this.cpuAsr.stop();
    }, 100);
  }

  getConfig() {
    return { ...this.config };
  }

  getState() {
    const scheduler = this.scheduler.snapshot();
    const pools = scheduler.pools || {};
    return {
      ready: this.initialized && !this.shuttingDown,
      config: this.getConfig(),
      gpu: { ...this.gpu },
      hardware: JSON.parse(JSON.stringify(this.hardware)),
      services: { gpu: this.gpuAsr.status(), cpu: this.cpuAsr.status() },
      maintenance: this.maintenance ? { ...this.maintenance } : null,
      pools,
      totals: {
        queued: Object.values(pools).reduce((sum, pool) => sum + Number(pool.queued || 0), 0),
        running: Object.values(pools).reduce((sum, pool) => sum + pool.lanes.filter((lane) => lane.busy).length, 0)
      },
      updatedAt: scheduler.updatedAt
    };
  }

  notifyState(immediate = false) {
    if (immediate) {
      if (this.stateTimer) clearTimeout(this.stateTimer);
      this.stateTimer = null;
      this.onState(this.getState());
      return;
    }
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.onState(this.getState());
    }, 100);
  }

  syncHardwareGpuState() {
    if (!this.hardware?.nvidia) return;
    const minimum = this.config.asrModel === 'small' ? 2048 : 4096;
    this.hardware.nvidia.detected = Boolean(this.gpu.available);
    this.hardware.nvidia.name = String(this.gpu.name || '');
    this.hardware.nvidia.totalMiB = Number(this.gpu.totalMiB || 0);
    this.hardware.nvidia.supported = Boolean(this.hardware.runtime?.ready && this.gpu.available && Number(this.hardware.nvidia.cudaDeviceCount || 0) > 0 && Number(this.gpu.totalMiB || 0) >= minimum);
    this.hardware.localAsrSupported = Boolean(this.hardware.nvidia.supported || this.hardware.cpu?.supported);
    this.hardware.preferredMode = this.hardware.nvidia.supported ? 'cuda' : this.hardware.cpu?.supported ? 'cpu' : 'unavailable';
    if (this.scheduler.pools?.has?.('asr')) this.scheduler.setLaneEnabled('asr', 'gpu', this.hardware.nvidia.supported);
  }

  shutdown() {
    if (this.shuttingDown) return;
    for (const task of this.store.listTasks().filter((item) => ['claimed', 'rejected'].includes(item.status))) {
      try {
        abortTaskAttempt({
          store: this.store,
          toolRunner: this,
          taskId: task.id,
          workerId: task.claimedBy,
          reason: '应用关闭，中止并回滚当前视频总结任务。',
          source: 'app-shutdown'
        });
      } catch (error) {
        this.publish({ type: 'task-attempt-cleanup-failed', taskId: task.id, workerId: task.claimedBy, error: error.message || String(error), source: 'app-shutdown' });
      }
    }
    this.shuttingDown = true;
    if (this.gpuTimer) clearInterval(this.gpuTimer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    if (this.stateTimer) clearTimeout(this.stateTimer);
    if (this.cpuStopTimer) clearTimeout(this.cpuStopTimer);
    for (const state of this.activeRuns.values()) {
      const run = this.store.getToolRun(state.runId);
      if (run && ACTIVE_STATUSES.has(run.status)) {
        this.updateRun(run.id, {
          status: 'queued',
          stage: 'recovery',
          queueReason: 'APP_RESTART_RECOVERY',
          queuePosition: null,
          queueLength: null,
          resourceLane: '',
          signal: 'APP_SHUTDOWN'
        });
      }
      this.cancelCurrentWork(state);
    }
    this.scheduler.shutdown();
    this.gpuAsr.stop();
    this.cpuAsr.stop();
    this.maintenance = null;
    this.initialized = false;
  }

  async acquireMaintenance(reason = 'dependency installation', onWait = () => {}) {
    while (!this.shuttingDown) {
      const state = this.getState();
      const busy = this.maintenance || this.activeRuns.size > 0 || state.totals.queued > 0 || state.totals.running > 0
        || Boolean(this.gpuAsr.currentRequestId || this.cpuAsr.currentRequestId);
      if (!busy) {
        const id = `maintenance-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        this.maintenance = { id, reason: String(reason || 'dependency installation'), startedAt: new Date().toISOString() };
        this.notifyState(true);
        this.gpuAsr.stop();
        this.cpuAsr.stop();
        try {
          await waitForServicesStopped([this.gpuAsr, this.cpuAsr], 15000);
        } catch (error) {
          this.maintenance = null;
          this.notifyState(true);
          throw error;
        }
        let released = false;
        return async () => {
          if (released || this.maintenance?.id !== id) return;
          released = true;
          this.maintenance = null;
          this.notifyState(true);
        };
      }
      onWait(state);
      await delay(750);
    }
    throw new Error('Application is shutting down; dependency installation was cancelled.');
  }

  updateRun(id, patch) {
    return this.store.updateToolRun(id, patch);
  }

  appendLog(runId, text) {
    const run = this.store.getToolRun(runId);
    if (!run?.logFile) return;
    try { fs.appendFileSync(run.logFile, String(text), 'utf8'); } catch {}
  }

  publish(event) {
    this.onEvent(event);
    this.notifyState();
  }

  buildArgs({ task, action, collection, artifactDir, options }) {
    const script = path.join(PROJECT_ROOT, 'tools', 'video-tool.js');
    const target = task.bvid || task.url;
    const args = [script, action];
    if (action !== 'clean-cache') args.push(target);
    else args.push(artifactDir);

    if (action !== 'clean-cache') {
      args.push('--out', artifactDir);
      if (collection?.cookieFile && fs.existsSync(collection.cookieFile)) args.push('--cookies', collection.cookieFile);
    } else if (options.preserveVideo || task.keepVideoCache || task.cachedVideoId) {
      args.push('--preserve-video');
    }
    if (action === 'bundle') {
      args.push('--frames', String(clampNumber(options.frames, 1, 60, 12)));
      if (options.audio) args.push('--audio');
      if (options.asr) args.push('--asr');
      if (options.comments !== false) args.push('--comments');
      if (options.skipInfo) args.push('--skip-info');
      if (options.skipSubtitles) args.push('--skip-subtitles');
      if (options.skipComments) args.push('--skip-comments');
      args.push('--comment-limit', String(clampNumber(options.commentLimit, 1, 3, 3)));
    }
    if (action === 'merged' || action === 'audio') args.push('--height', String(clampNumber(options.height, 360, 2160, 720)));
    if (action === 'comments') args.push('--comment-limit', String(clampNumber(options.commentLimit, 1, 3, 3)));
    return args;
  }
}

function probeTool(tool) {
  const script = path.join(PROJECT_ROOT, 'tools', 'video-tool.js');
  const startedAt = Date.now();
  const base = {
    toolId: tool.id,
    toolName: tool.name,
    action: tool.action,
    order: tool.order,
    enabled: tool.enabled !== false,
    apiUsage: tool.apiUsage,
    checkedAt: new Date().toISOString()
  };
  if (!fs.existsSync(script)) return Promise.resolve({ ...base, status: 'offline', responded: false, durationMs: 0, message: 'tools/video-tool.js 不存在', dependencies: [] });
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ ...base, durationMs: Date.now() - startedAt, ...result });
    };
    const child = spawn('node', [script, 'health', tool.action], { cwd: PROJECT_ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish({ status: 'offline', responded: false, message: '健康检查 15 秒内未响应', dependencies: [] });
    }, 15000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ status: 'offline', responded: false, message: error.message, dependencies: [] });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      try {
        const payload = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || '{}');
        const missing = Array.isArray(payload.missing) ? payload.missing : [];
        finish({
          status: payload.response === 'pong' ? (payload.ok ? 'online' : 'degraded') : 'offline',
          responded: payload.response === 'pong',
          message: payload.ok ? '接口响应正常' : missing.length ? `缺少依赖：${missing.join(', ')}` : (stderr.trim() || `退出码 ${code}`),
          dependencies: payload.dependencies || [],
          node: payload.node || ''
        });
      } catch (error) {
        finish({ status: 'offline', responded: false, message: stderr.trim() || error.message, dependencies: [] });
      }
    });
  });
}

function createLanes(prefix, count, label) {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index + 1}`, label: `${label} ${index + 1}`, type: prefix }));
}

function parseDownloadProgress(value) {
  const matches = [...String(value || '').matchAll(/download:\s*([0-9.]+)%\|([^|\r\n]*)\|([^|\r\n]*)\|([^|\r\n]*)\|([^|\r\n]*)/g)];
  if (!matches.length) return null;
  const match = matches.at(-1);
  const percent = Math.max(0, Math.min(100, Number(match[1]) || 0));
  return {
    progress: percent / 100,
    percent,
    downloadedBytes: Number(match[2]) || 0,
    totalBytes: Number(match[3]) || 0,
    speed: String(match[4] || '').trim(),
    eta: String(match[5] || '').trim(),
    updatedAt: new Date().toISOString()
  };
}

function initialPoolForAction(action) {
  if (['info', 'subtitles', 'comments'].includes(action)) return 'api';
  if (action === 'clean-cache') return 'disk';
  return 'media';
}

function initialStageForAction(action) {
  if (action === 'bundle') return 'metadata-comments';
  if (action === 'asr') return 'audio-preparation';
  return action;
}

function normalizeConfig(value) {
  return {
    resourcePolicyVersion: 2,
    asrModelPolicyVersion: 1,
    cpuAsrEnabled: Boolean(value.cpuAsrEnabled),
    asrModel: ['small', 'medium'].includes(String(value.asrModel)) ? String(value.asrModel) : DEFAULT_CONFIG.asrModel,
    apiConcurrency: clampNumber(value.apiConcurrency, 1, 4, DEFAULT_CONFIG.apiConcurrency),
    apiStartIntervalMs: clampNumber(value.apiStartIntervalMs, 250, 5000, DEFAULT_CONFIG.apiStartIntervalMs),
    mediaConcurrency: clampNumber(value.mediaConcurrency, 1, 4, DEFAULT_CONFIG.mediaConcurrency),
    diskConcurrency: clampNumber(value.diskConcurrency, 1, 4, DEFAULT_CONFIG.diskConcurrency),
    gpuReserveMiB: clampNumber(value.gpuReserveMiB, 256, 4096, DEFAULT_CONFIG.gpuReserveMiB),
    gpuStartupReserveMiB: clampNumber(value.gpuStartupReserveMiB, 1536, 6144, DEFAULT_CONFIG.gpuStartupReserveMiB)
  };
}

async function waitForServicesStopped(services, timeoutMs = 5000) {
  const started = Date.now();
  while (services.some((service) => service.child)) {
    if (Date.now() - started > timeoutMs) throw new Error('ASR 服务切换模型时未能及时停止，请稍后重试。');
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
}

function sanitizeOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return {};
  return JSON.parse(JSON.stringify(options));
}

function displayCommand(args) {
  const safe = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index - 1] === '--cookies' ? '<cookie-file>' : String(args[index]);
    safe.push(/\s/.test(value) ? JSON.stringify(value) : value);
  }
  return ['node', ...safe].join(' ');
}

function emptyGpuState() {
  return { available: false, index: 0, name: '', totalMiB: 0, usedMiB: 0, freeMiB: 0, error: '', checkedAt: '' };
}

function emptyHardwareState() {
  return {
    checkedAt: '',
    selectedModel: 'medium',
    localAsrSupported: false,
    preferredMode: 'unavailable',
    runtime: { ready: false, pythonAvailable: false, modelReady: false, error: '' },
    system: { platform: process.platform, arch: process.arch, totalMemoryMiB: 0, cpuThreads: 0 },
    nvidia: { detected: false, name: '', totalMiB: 0, cudaDeviceCount: 0, supported: false },
    cpu: { supported: false, architectureSupported: false, minimumMemoryMiB: 0 },
    issues: ['ASR hardware detection has not completed.'],
    recommendation: 'Wait for ASR hardware detection.'
  };
}

function diagnoseAsrFailure(service, label) {
  const code = Number(service.lastExitCode);
  const message = String(service.lastError || '').toLowerCase();
  if (message.includes('whisper model') && message.includes('max_new_tokens') && message.includes('max_length')) {
    return [
      'ASR 解码 token 预算与 Whisper 总窗口冲突',
      '应用或旧版常驻服务传入了不兼容的 max_new_tokens 参数；重启应用并重试'
    ];
  }
  if ([3221225477, -1073741819].includes(code)) {
    return [
      '本地 CTranslate2、Microsoft Visual C++ 或 CUDA 原生 DLL 发生访问冲突',
      '项目运行库损坏、被安全软件拦截，或系统加载了不兼容的同名 DLL',
      '显卡驱动与当前 CUDA 运行库组合异常'
    ];
  }
  if (message.includes('out of memory') || message.includes('cuda') && message.includes('memory')) {
    return ['GPU 显存不足或被其它程序占用', 'CUDA 上下文未能为模型分配连续显存'];
  }
  if (message.includes('model') && (message.includes('missing') || message.includes('not installed') || message.includes('does not exist'))) {
    return ['所选 ASR 模型未完整安装或文件损坏', '依赖包解压未完成'];
  }
  return [`${label} ASR 运行时或模型无法加载`, '项目依赖损坏、权限拦截或原生运行库不兼容', '可在设置中重新下载 ASR 依赖后再恢复 Agent'];
}

function asrInfrastructureError(error, service) {
  const detail = String(error?.message || error || 'ASR request failed.');
  const wrapped = new Error(`ASR 常驻服务无法完成转写：${detail}`);
  wrapped.code = 'ASR_INFRASTRUCTURE_FAILURE';
  wrapped.failureKind = 'infrastructure';
  wrapped.possibleCauses = diagnoseAsrFailure(service, service?.device === 'cpu' ? 'CPU' : 'GPU');
  wrapped.cause = error;
  return wrapped;
}

function isAsrInfrastructureFailure(error, service) {
  if (!service?.ready || !service?.child) return true;
  const message = String(error?.message || error || '').toLowerCase();
  if (message.includes('whisper model') && message.includes('max_new_tokens') && message.includes('max_length')) return true;
  return /(?:cuda|cudnn|cublas|ctranslate2|out of memory|memory allocation|dll|winerror|access violation|driver|device unavailable|failed to load|module not found|no module named|broken pipe|epipe|service exited|native runtime|model.+(?:missing|not installed|does not exist))/.test(message);
}

function addAsrManifestOutputs(outputs, artifactDir) {
  const directory = path.join(artifactDir, 'asr');
  if (!fs.existsSync(path.join(directory, 'transcript.srt'))) return outputs;
  outputs.asr = 'asr/';
  outputs.asrSrt = 'asr/transcript.srt';
  if (fs.existsSync(path.join(directory, 'asr-transcript.txt'))) outputs.asrTimedText = 'asr/asr-transcript.txt';
  if (fs.existsSync(path.join(directory, 'asr-result.json'))) outputs.asrSegments = 'asr/asr-result.json';
  outputs.asrHasTimestamps = true;
  return outputs;
}

function writeNoAudioAsrArtifacts(artifactDir, options = {}) {
  const directory = ensureDir(path.join(artifactDir, 'asr'));
  const message = String(options.message || '源视频不包含音频流，ASR 没有可转写内容。');
  const diagnostics = {
    sentenceCount: 0,
    speechSeconds: 0,
    speechCoverage: 0,
    firstSpeechAt: null,
    lastSpeechAt: null,
    largeGapCount: 0,
    largestGaps: [],
    noAudioStream: true,
    warnings: [message]
  };
  const payload = {
    model: String(options.model || ''),
    source: '',
    language: null,
    languageProbability: 0,
    requestedLanguage: 'auto',
    duration: Math.max(0, Number(options.duration || 0)),
    device: 'not-applicable',
    computeType: 'not-applicable',
    skipped: true,
    skipReason: 'NO_AUDIO_STREAM',
    noAudioStream: true,
    segments: [],
    diagnostics
  };
  fs.writeFileSync(path.join(directory, 'transcript.srt'), '', 'utf8');
  fs.writeFileSync(path.join(directory, 'asr-transcript.txt'), `[无音轨] ${message}\n`, 'utf8');
  fs.writeFileSync(path.join(directory, 'asr-result.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { ok: true, skipped: true, reason: 'NO_AUDIO_STREAM', segments: 0, diagnostics };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function optionalAsrMaxNewTokens(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return clampNumber(value, 32, 220, 220);
}

function cancelledError(runId) {
  const error = new Error(`Tool run cancelled: ${runId}`);
  error.code = 'RUN_CANCELLED';
  return error;
}

function withTimeout(promise, timeoutMs, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout?.();
      const error = new Error(`Tool stage timed out after ${timeoutMs} ms.`);
      error.code = 'TOOL_TIMEOUT';
      reject(error);
    }, timeoutMs);
    promise.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killProcessTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    const result = spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    if (result.status === 0) return;
  }
  try { child.kill('SIGTERM'); } catch {}
}

module.exports = { DEFAULT_CONFIG, ToolRunner, asrInfrastructureError, isAsrInfrastructureFailure };
