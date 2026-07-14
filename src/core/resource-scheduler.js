class ResourceScheduler {
  constructor({ onState } = {}) {
    this.pools = new Map();
    this.jobs = new Map();
    this.onState = onState || (() => {});
  }

  registerPool(name, options = {}) {
    const lanes = (options.lanes || []).map((lane) => ({ ...lane, enabled: lane.enabled !== false, busy: false, checking: false, currentJobId: '' }));
    this.pools.set(name, {
      name,
      lanes,
      queue: [],
      minStartIntervalMs: Number(options.minStartIntervalMs || 0),
      lastStartedAt: 0,
      lastWorkerId: '',
      retryTimer: null,
      dispatching: false,
      waitReason: '',
      durations: []
    });
  }

  enqueue(poolName, job) {
    const pool = this.requirePool(poolName);
    if (this.jobs.has(job.id)) throw new Error(`Scheduler job already exists: ${job.id}`);
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
    const entry = {
      ...job,
      poolName,
      queuedAt: new Date().toISOString(),
      state: 'queued',
      waitReason: 'RESOURCE_BUSY',
      resolve: resolvePromise,
      reject: rejectPromise,
      promise
    };
    this.jobs.set(entry.id, entry);
    pool.queue.push(entry);
    this.refreshQueue(pool);
    this.dispatch(poolName);
    return { id: entry.id, promise, cancel: () => this.cancel(entry.id) };
  }

  cancel(jobId) {
    const entry = this.jobs.get(String(jobId));
    if (!entry) return false;
    const pool = this.requirePool(entry.poolName);
    if (entry.state === 'queued') {
      pool.queue = pool.queue.filter((item) => item.id !== entry.id);
      entry.state = 'cancelled';
      this.jobs.delete(entry.id);
      entry.reject(cancelledError(entry.id));
      this.refreshQueue(pool);
      this.dispatch(pool.name);
      return true;
    }
    if (entry.state === 'running') {
      entry.cancel?.();
      return true;
    }
    return false;
  }

  getJob(jobId) {
    const entry = this.jobs.get(String(jobId));
    if (!entry) return null;
    return {
      id: entry.id,
      pool: entry.poolName,
      lane: entry.laneId || '',
      workerId: entry.workerId || '',
      state: entry.state,
      queuedAt: entry.queuedAt,
      waitReason: entry.waitReason || ''
    };
  }

  setLaneEnabled(poolName, laneId, enabled) {
    const pool = this.requirePool(poolName);
    const lane = pool.lanes.find((item) => item.id === laneId);
    if (!lane) throw new Error(`Scheduler lane not found: ${poolName}/${laneId}`);
    lane.enabled = Boolean(enabled);
    this.refreshQueue(pool);
    this.dispatch(poolName);
  }

  async dispatch(poolName) {
    const pool = this.requirePool(poolName);
    if (pool.dispatching) return;
    pool.dispatching = true;
    const fatalGates = [];
    try {
      for (const lane of pool.lanes) {
        if (!pool.queue.length) break;
        if (!lane.enabled || lane.busy || lane.checking) continue;
        const elapsed = Date.now() - pool.lastStartedAt;
        if (elapsed < pool.minStartIntervalMs) {
          this.scheduleRetry(pool, pool.minStartIntervalMs - elapsed);
          continue;
        }
        lane.checking = true;
        let gate = { ready: true };
        try { gate = lane.gate ? await lane.gate() : gate; } catch (error) { gate = { ready: false, reason: 'RESOURCE_CHECK_FAILED', message: error.message }; }
        lane.checking = false;
        lane.lastGate = { ...gate, checkedAt: new Date().toISOString() };
        if (!lane.enabled) {
          this.scheduleRetry(pool, 200);
          continue;
        }
        if (!gate.ready) {
          pool.waitReason = gate.reason || 'RESOURCE_WAIT';
          for (const item of pool.queue) item.waitReason = pool.waitReason;
          if (gate.fatal) {
            fatalGates.push(gate);
            continue;
          }
          this.scheduleRetry(pool, Number(gate.retryAfterMs || 2000));
          continue;
        }
        const entry = this.takeFair(pool);
        if (!entry) break;
        pool.waitReason = '';
        this.startEntry(pool, lane, entry);
      }
      if (pool.queue.length && fatalGates.length) {
        const enabledLanes = pool.lanes.filter((lane) => lane.enabled);
        const allEnabledLanesFatal = enabledLanes.length > 0
          && enabledLanes.every((lane) => !lane.busy && !lane.checking && lane.lastGate?.fatal);
        if (allEnabledLanesFatal) this.rejectQueued(pool, fatalGates[0]);
        else this.scheduleRetry(pool, 500);
      }
    } finally {
      pool.dispatching = false;
      this.refreshQueue(pool);
    }
  }

  takeFair(pool) {
    let index = pool.queue.findIndex((item) => item.workerId && item.workerId !== pool.lastWorkerId);
    if (index < 0) index = 0;
    const [entry] = pool.queue.splice(index, 1);
    return entry;
  }

  startEntry(pool, lane, entry) {
    lane.busy = true;
    lane.currentJobId = entry.id;
    entry.state = 'running';
    entry.laneId = lane.id;
    entry.waitReason = '';
    entry.startedMs = Date.now();
    pool.lastStartedAt = Date.now();
    pool.lastWorkerId = entry.workerId || '';
    try {
      entry.onStart?.({ pool: pool.name, lane: lane.id });
      this.onState(this.snapshot());
    } catch (error) {
      lane.busy = false;
      lane.currentJobId = '';
      entry.state = 'failed';
      this.jobs.delete(entry.id);
      entry.reject(error);
      this.refreshQueue(pool);
      this.scheduleRetry(pool, 200);
      return;
    }
    Promise.resolve()
      .then(() => entry.execute(lane))
      .then((result) => entry.resolve(result), (error) => entry.reject(error))
      .finally(() => {
        const duration = Date.now() - entry.startedMs;
        pool.durations.push(duration);
        if (pool.durations.length > 20) pool.durations.shift();
        lane.busy = false;
        lane.currentJobId = '';
        this.jobs.delete(entry.id);
        this.refreshQueue(pool);
        this.dispatch(pool.name);
      });
  }

  refreshQueue(pool) {
    const activeLanes = pool.lanes.filter((lane) => lane.enabled);
    const allBusy = !activeLanes.length || activeLanes.every((lane) => lane.busy || lane.checking);
    const enabledLanes = Math.max(1, activeLanes.length);
    const averageMs = pool.durations.length ? pool.durations.reduce((sum, value) => sum + value, 0) / pool.durations.length : 0;
    pool.queue.forEach((entry, index) => {
      if (!activeLanes.length) entry.waitReason = 'RESOURCE_DISABLED';
      else if (allBusy && (!entry.waitReason || entry.waitReason === 'RESOURCE_DISABLED')) entry.waitReason = 'RESOURCE_BUSY';
      try {
        entry.onQueued?.({
          pool: pool.name,
          position: index + 1,
          queued: pool.queue.length,
          reason: entry.waitReason || pool.waitReason || 'RESOURCE_BUSY',
          estimatedWaitMs: averageMs ? Math.ceil((index + 1) / enabledLanes) * averageMs : null
        });
      } catch {
        // Queue observability must not stop resource dispatch.
      }
    });
    try { this.onState(this.snapshot()); } catch { /* state observers are non-critical */ }
  }

  scheduleRetry(pool, delayMs) {
    if (pool.retryTimer) return;
    pool.retryTimer = setTimeout(() => {
      pool.retryTimer = null;
      this.dispatch(pool.name);
    }, Math.max(200, delayMs));
  }

  rejectQueued(pool, gate) {
    const queued = pool.queue.splice(0);
    for (const entry of queued) {
      entry.state = 'failed';
      this.jobs.delete(entry.id);
      entry.reject(resourceFailureError(gate));
    }
    this.refreshQueue(pool);
  }

  snapshot() {
    const pools = {};
    for (const [name, pool] of this.pools.entries()) {
      pools[name] = {
        queued: pool.queue.length,
        waitReason: pool.waitReason,
        averageDurationMs: pool.durations.length ? pool.durations.reduce((sum, value) => sum + value, 0) / pool.durations.length : 0,
        lanes: pool.lanes.map((lane) => ({
          id: lane.id,
          label: lane.label || lane.id,
          type: lane.type || '',
          enabled: lane.enabled,
          busy: lane.busy,
          checking: lane.checking,
          currentJobId: lane.currentJobId,
          lastGate: lane.lastGate || null
        })),
        queuedJobs: pool.queue.map((entry, index) => ({
          id: entry.id,
          workerId: entry.workerId || '',
          position: index + 1,
          reason: entry.waitReason || pool.waitReason || 'RESOURCE_BUSY'
        }))
      };
    }
    return { pools, updatedAt: new Date().toISOString() };
  }

  requirePool(name) {
    const pool = this.pools.get(name);
    if (!pool) throw new Error(`Scheduler pool not found: ${name}`);
    return pool;
  }

  shutdown() {
    for (const pool of this.pools.values()) {
      if (pool.retryTimer) clearTimeout(pool.retryTimer);
      pool.retryTimer = null;
    }
    for (const jobId of [...this.jobs.keys()]) this.cancel(jobId);
  }
}

function cancelledError(jobId) {
  const error = new Error(`Scheduler job cancelled: ${jobId}`);
  error.code = 'SCHEDULER_CANCELLED';
  return error;
}

function resourceFailureError(gate = {}) {
  const error = new Error(gate.message || 'A required application resource is unavailable.');
  error.code = gate.code || 'RESOURCE_FATAL';
  error.failureKind = gate.failureKind || 'infrastructure';
  error.possibleCauses = Array.isArray(gate.possibleCauses) ? gate.possibleCauses : [];
  error.resourceReason = gate.reason || 'RESOURCE_FATAL';
  return error;
}

module.exports = { ResourceScheduler };
