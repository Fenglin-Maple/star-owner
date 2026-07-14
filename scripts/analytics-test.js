const assert = require('assert');
const { buildAnalytics } = require('../src/core/analytics');

const tasks = [{ id: 'collection:video', collectionId: 'collection', bvid: 'BVTEST000001', title: 'Fixture', duration: 120, status: 'pending' }];
const events = [
  { id: '1', type: 'claimed', taskId: tasks[0].id, collectionId: 'collection', workerId: 'worker' },
  { id: '2', type: 'attempt-aborted', source: 'internal-agent-stop', taskId: tasks[0].id, collectionId: 'collection', workerId: 'worker' },
  { id: '3', type: 'claimed', taskId: tasks[0].id, collectionId: 'collection', workerId: 'worker' },
  { id: '4', type: 'attempt-aborted', source: 'infrastructure-failure', taskId: tasks[0].id, collectionId: 'collection', workerId: 'worker' },
  { id: '5', type: 'claimed', taskId: tasks[0].id, collectionId: 'collection', workerId: 'worker' },
  { id: '6', type: 'attempt-aborted', source: 'internal-agent-error', taskId: tasks[0].id, collectionId: 'collection', workerId: 'worker' },
  { id: '7', type: 'claimed', taskId: tasks[0].id, collectionId: 'collection', workerId: 'worker' },
  { id: '8', type: 'completed', taskId: tasks[0].id, collectionId: 'collection', workerId: 'worker', processingSeconds: 60, videoDuration: 120 }
];
const scopes = {
  collections: [{ id: 'collection', name: 'Fixture collection' }],
  taskEvents: events,
  workers: [{ id: 'worker', tool: 'codex', model: 'fixture', status: 'active' }],
  tools: []
};
const store = {
  listTasks: () => tasks,
  listToolRuns: () => [],
  listWorkers: () => scopes.workers,
  listCollections: () => scopes.collections,
  listTools: () => scopes.tools,
  list: (scope) => scopes[scope] || []
};

const analytics = buildAnalytics(store);
const worker = analytics.workers.find((item) => item.workerId === 'worker');
const collectionWorker = analytics.collections.collection.agents.find((item) => item.workerId === 'worker');
assert.strictEqual(worker.claimed, 4, 'claim attempts were not counted independently');
assert.strictEqual(worker.failures, 1, 'user stops or infrastructure rollback were incorrectly charged as Agent failures');
assert.strictEqual(worker.successes, 1);
assert.strictEqual(worker.successRate, 0.5);
assert.strictEqual(worker.weightedTimeRatio, 0.5);
assert.strictEqual(collectionWorker.failures, 1, 'collection analytics diverged from per-worker failure accounting');
console.log('analytics failure accounting test passed');
