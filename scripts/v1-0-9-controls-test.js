const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Store } = require('../src/core/store');
const { ToolRunner } = require('../src/core/tool-runner');
const { calculateFrameBudget } = require('../src/core/internal-agent-manager');
const { checkDiskSpace, assertDiskSpace } = require('../src/core/disk-space');
const { compareVersions, parseChecksumText, validateArchiveEntries } = require('../src/core/update-manager');

(async () => {
  assert.strictEqual(calculateFrameBudget(0), 12);
  assert.strictEqual(calculateFrameBudget(25), 12);
  assert.strictEqual(calculateFrameBudget(26), 12);
  assert.strictEqual(calculateFrameBudget(300), 12);
  assert.strictEqual(calculateFrameBudget(301), 13);
  assert.strictEqual(calculateFrameBudget(26, { minimumFrames: 16, frameIntervalSeconds: 10 }), 16);
  assert.strictEqual(calculateFrameBudget(161, { minimumFrames: 12, frameIntervalSeconds: 10 }), 17);

  const safe = checkDiskSpace('C:\\does-not-exist', {
    statfs: () => ({ bsize: 1024, bavail: 5 * 1024 * 1024, blocks: 100 * 1024 * 1024 })
  });
  assert(safe.safe && safe.minimumBytes === 2 * 1024 ** 3, 'disk safety threshold should preserve the absolute minimum');
  const low = checkDiskSpace('.', { statfs: () => ({ bsize: 1024, bavail: 1024 * 1024, blocks: 100 * 1024 * 1024 }) });
  assert(!low.safe && low.freeBytes < low.minimumBytes, 'low disk space was not detected');
  assert.throws(() => assertDiskSpace('.', { statfs: () => { throw new Error('statfs unavailable'); } }), (error) => error.code === 'DISK_SPACE_LOW');

  assert.strictEqual(compareVersions('1.0.10', '1.0.9'), 1);
  assert.strictEqual(compareVersions('1.0.9', '1.0.9'), 0);
  assert.strictEqual(parseChecksumText('SHA256  ' + 'a'.repeat(64) + '  core.zip'), 'a'.repeat(64));
  assert.strictEqual(parseChecksumText('not a checksum'), '');
  assert.deepStrictEqual(validateArchiveEntries(['Star-Owner/package.json', 'Star-Owner/src/main.js']).prefix, 'Star-Owner');
  assert.throws(() => validateArchiveEntries(['Star-Owner/package.json', 'Star-Owner/../outside.txt']), /不安全|unsafe|路径/);

  for (const mode of ['cuda', 'cpu']) {
    const runner = new ToolRunner({ store: { listTasks: () => [] } });
    runner.config = { ...runner.config, asrExecutionMode: mode, cpuAsrEnabled: mode === 'cpu' };
    runner.registerPools();
    const lanes = runner.scheduler.snapshot().pools.asr.lanes;
    assert.strictEqual(lanes.find((lane) => lane.id === 'gpu').enabled, mode === 'cuda');
    assert.strictEqual(lanes.find((lane) => lane.id === 'cpu').enabled, mode === 'cpu');
    runner.shutdown();
  }

  const dbFile = path.join(__dirname, '..', 'workspace', 'v1-0-9-controls.sqlite');
  fs.rmSync(dbFile, { force: true });
  try {
    const store = await Store.open(dbFile);
    store.upsertCollection({ id: 'filter-c1', name: 'Filter test', userId: 'filter-u', userName: 'Filter user' });
    store.upsertTask({ id: 'filter-c1:a', collectionId: 'filter-c1', bvid: 'BV1TESTA', status: 'pending', enabled: true });
    store.upsertTask({ id: 'filter-c1:b', collectionId: 'filter-c1', bvid: 'BV1TESTB', status: 'pending', enabled: true });
    store.commit();
    const result = store.replaceCollectionEnabledTasks('filter-c1', ['filter-c1:a']);
    assert.strictEqual(result.enabled, 1);
    assert.strictEqual(store.getTask('filter-c1:a').enabled, true);
    assert.strictEqual(store.getTask('filter-c1:b').enabled, false);
    assert.throws(() => store.replaceCollectionEnabledTasks('filter-c1', ['foreign-task']));
    store.upsertCollection({ id: 'shared-c1', name: 'Shared knowledge', userId: 'shared-user', userName: '共享', collectionKind: 'shared', internal: true });
    store.upsertTask({ id: 'shared-c1:doc', collectionId: 'shared-c1', sourceType: 'shared-bilibili', status: 'done', enabled: false });
    store.commit();
    assert.throws(() => store.updateTasksEnabled(['shared-c1:doc'], true), /共享收藏夹.*不能启用/);
    assert.throws(() => store.replaceCollectionEnabledTasks('shared-c1', ['shared-c1:doc']), /共享收藏夹.*不能启用/);
    assert.strictEqual(store.getTask('shared-c1:doc').enabled, false, '共享知识文档被任务开关错误启用');
    store.db.close();
  } finally {
    fs.rmSync(dbFile, { force: true });
    fs.rmSync(`${dbFile}.bak`, { force: true });
    fs.rmSync(`${dbFile}.tmp`, { force: true });
  }
  console.log('1.0.9 controls test passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
