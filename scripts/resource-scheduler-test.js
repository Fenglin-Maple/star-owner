const assert = require('assert');
const { ResourceScheduler } = require('../src/core/resource-scheduler');

(async () => {
  await testConcurrencyAndFairness();
  await testDisabledLaneAndCapacityWait();
  await testQueuedCancellation();
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
