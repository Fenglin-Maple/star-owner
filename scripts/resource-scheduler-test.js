const assert = require('assert');
const { ResourceScheduler } = require('../src/core/resource-scheduler');
const { ToolRunner, asrInfrastructureError } = require('../src/core/tool-runner');

(async () => {
  await testConcurrencyAndFairness();
  await testDisabledLaneAndCapacityWait();
  await testLaneDisabledDuringGateCheck();
  await testQueuedCancellation();
  await testFatalGateRejectsQueue();
  await testBusyHealthyLanePreventsFatalQueueRejection();
  await testToolMaintenanceWindow();
  await testCleanupRecoveryTimerSurvivesCpuIdleStop();
  testAsrRequestFailureClassification();
  console.log('resource scheduler ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function testConcurrencyAndFairness() {
  const scheduler = new ResourceScheduler();
  scheduler.registerPool('media', { lanes: [{ id: 'media-1' }, { id: 'media-2' }] });
  let active = 0;
  let peak = 0;
  const handles = [];
  for (let index = 0; index < 6; index += 1) {
    handles.push(scheduler.enqueue('media', {
      id: `media-${index}`,
      workerId: index % 2 ? 'worker-b' : 'worker-a',
      execute: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await delay(35);
        active -= 1;
      }
    }));
  }
  await Promise.all(handles.map((handle) => handle.promise));
  assert(peak <= 2, `media pool exceeded concurrency: ${peak}`);

  const fair = new ResourceScheduler();
  fair.registerPool('api', { lanes: [{ id: 'api-1' }] });
  const order = [];
  const jobs = [
    ['a1', 'worker-a'],
    ['a2', 'worker-a'],
    ['b1', 'worker-b']
  ].map(([id, workerId]) => fair.enqueue('api', {
    id,
    workerId,
    execute: async () => { order.push(id); await delay(15); }
  }));
  await Promise.all(jobs.map((job) => job.promise));
  assert.deepStrictEqual(order, ['a1', 'b1', 'a2'], `worker fairness failed: ${order.join(',')}`);
}

async function testLaneDisabledDuringGateCheck() {
  const scheduler = new ResourceScheduler();
  let releaseGate;
  let firstGate = true;
  let ran = false;
  scheduler.registerPool('asr', {
    lanes: [{ id: 'gpu', gate: () => firstGate ? new Promise((resolve) => { releaseGate = (value) => { firstGate = false; resolve(value); }; }) : Promise.resolve({ ready: true }) }]
  });
  const handle = scheduler.enqueue('asr', { id: 'disable-during-gate', workerId: 'worker-a', execute: async () => { ran = true; } });
  while (!releaseGate) await delay(1);
  scheduler.setLaneEnabled('asr', 'gpu', false);
  releaseGate({ ready: true });
  await delay(30);
  assert.strictEqual(ran, false, 'a lane disabled during its asynchronous gate check still started work');
  assert.strictEqual(scheduler.getJob(handle.id)?.state, 'queued');
  assert.strictEqual(scheduler.snapshot().pools.asr.queuedJobs[0]?.reason, 'RESOURCE_DISABLED');
  scheduler.setLaneEnabled('asr', 'gpu', true);
  await handle.promise;
  assert.strictEqual(ran, true);
}

async function testDisabledLaneAndCapacityWait() {
  const scheduler = new ResourceScheduler();
  let gpuReady = false;
  let ranOn = '';
  let latestQueue = null;
  scheduler.registerPool('asr', {
    lanes: [
      { id: 'gpu', gate: async () => gpuReady ? { ready: true } : { ready: false, reason: 'GPU_CAPACITY_WAIT', retryAfterMs: 30 } },
      { id: 'cpu', enabled: false }
    ]
  });
  const handle = scheduler.enqueue('asr', {
    id: 'asr-1',
    workerId: 'worker-a',
    onQueued: (queue) => { latestQueue = queue; },
    execute: async (lane) => { ranOn = lane.id; }
  });
  await delay(60);
  assert.strictEqual(ranOn, '', 'ASR should remain queued while GPU is capacity-gated and CPU is disabled');
  assert.strictEqual(latestQueue?.reason, 'GPU_CAPACITY_WAIT');
  scheduler.setLaneEnabled('asr', 'cpu', true);
  await handle.promise;
  assert.strictEqual(ranOn, 'cpu');
}

async function testQueuedCancellation() {
  const scheduler = new ResourceScheduler();
  scheduler.registerPool('disk', { lanes: [{ id: 'disk-1' }] });
  const blocker = scheduler.enqueue('disk', { id: 'blocker', workerId: 'a', execute: () => delay(80) });
  const queued = scheduler.enqueue('disk', { id: 'cancel-me', workerId: 'b', execute: () => delay(1) });
  await delay(10);
  assert.strictEqual(scheduler.cancel('cancel-me'), true);
  await assert.rejects(queued.promise, (error) => error.code === 'SCHEDULER_CANCELLED');
  await blocker.promise;
}

async function testFatalGateRejectsQueue() {
  const scheduler = new ResourceScheduler();
  scheduler.registerPool('asr', { lanes: [{ id: 'gpu', gate: async () => ({ ready: false, fatal: true, reason: 'ASR_INFRASTRUCTURE_FAILURE', code: 'ASR_INFRASTRUCTURE_FAILURE', message: 'ASR native runtime crashed.', possibleCauses: ['broken runtime'] }) }] });
  const first = scheduler.enqueue('asr', { id: 'fatal-1', workerId: 'worker-a', execute: async () => {} });
  const second = scheduler.enqueue('asr', { id: 'fatal-2', workerId: 'worker-b', execute: async () => {} });
  await assert.rejects(first.promise, (error) => error.code === 'ASR_INFRASTRUCTURE_FAILURE' && error.possibleCauses.includes('broken runtime'));
  await assert.rejects(second.promise, (error) => error.code === 'ASR_INFRASTRUCTURE_FAILURE');
  assert.strictEqual(scheduler.snapshot().pools.asr.queued, 0, 'fatal resource failure left queued jobs behind');
}

async function testBusyHealthyLanePreventsFatalQueueRejection() {
  const scheduler = new ResourceScheduler();
  let releaseGpu;
  let secondRan = false;
  scheduler.registerPool('asr', {
    lanes: [
      { id: 'gpu', gate: async () => ({ ready: true }) },
      { id: 'cpu', gate: async () => ({ ready: false, fatal: true, reason: 'CPU_SERVICE_UNAVAILABLE', message: 'CPU runtime is broken.' }) }
    ]
  });
  const first = scheduler.enqueue('asr', {
    id: 'gpu-busy',
    workerId: 'worker-a',
    execute: () => new Promise((resolve) => { releaseGpu = resolve; })
  });
  while (!releaseGpu) await delay(1);
  const second = scheduler.enqueue('asr', {
    id: 'wait-for-gpu',
    workerId: 'worker-b',
    execute: async (lane) => { secondRan = lane.id === 'gpu'; }
  });
  await delay(30);
  assert.strictEqual(scheduler.getJob(second.id)?.state, 'queued', 'a fatal idle lane rejected work even though another enabled lane was only busy');
  releaseGpu();
  await Promise.all([first.promise, second.promise]);
  assert.strictEqual(secondRan, true, 'queued work did not continue on the healthy lane after it became idle');
}

async function testToolMaintenanceWindow() {
  const runner = Object.create(ToolRunner.prototype);
  runner.shuttingDown = false;
  runner.maintenance = null;
  runner.activeRuns = new Map([['busy-run', {}]]);
  runner.gpuAsr = fakeService();
  runner.cpuAsr = fakeService();
  runner.getState = () => ({ totals: { queued: 0, running: 0 } });
  runner.notifyState = () => {};
  let waited = 0;
  setTimeout(() => runner.activeRuns.clear(), 30);
  const release = await runner.acquireMaintenance('test install', () => { waited += 1; });
  assert(waited > 0, 'dependency maintenance did not wait for active tools');
  assert.strictEqual(runner.maintenance?.reason, 'test install');
  await release();
  assert.strictEqual(runner.maintenance, null, 'dependency maintenance lock was not released');
}

async function testCleanupRecoveryTimerSurvivesCpuIdleStop() {
  const runner = Object.create(ToolRunner.prototype);
  runner.config = { cpuAsrEnabled: false };
  runner.cpuAsr = fakeService({ child: {} });
  runner.cpuStopTimer = null;
  runner.cleanupRecoveryTimer = setTimeout(() => {}, 5000);
  const cleanupTimer = runner.cleanupRecoveryTimer;
  runner.stopCpuWhenIdle();
  assert.strictEqual(runner.cleanupRecoveryTimer, cleanupTimer, 'CPU idle cleanup cancelled deferred task-cache recovery');
  clearTimeout(runner.cpuStopTimer);
  clearTimeout(runner.cleanupRecoveryTimer);
}

function testAsrRequestFailureClassification() {
  const failure = asrInfrastructureError(new Error('native worker exited'), {
    device: 'cuda',
    lastError: 'CUDA out of memory',
    lastExitCode: 1
  });
  assert.strictEqual(failure.code, 'ASR_INFRASTRUCTURE_FAILURE');
  assert.strictEqual(failure.failureKind, 'infrastructure');
  assert(failure.possibleCauses.some((item) => /GPU|CUDA/.test(item)), 'ASR infrastructure failure omitted actionable GPU causes');
}

function fakeService(overrides = {}) {
  return {
    child: null,
    currentRequestId: '',
    stop() { this.child = null; },
    ...overrides
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
