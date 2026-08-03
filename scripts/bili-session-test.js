const assert = require('assert');
const { LEGACY_BILI_SESSION, migrateLegacyBiliPartition, projectBiliPartition } = require('../src/core/bili-session');

function createCookieSession(partitions, name) {
  if (!partitions.has(name)) partitions.set(name, []);
  const cookies = {
    get: async () => partitions.get(name).map((cookie) => ({ ...cookie })),
    set: async (cookie) => {
      const current = partitions.get(name);
      const index = current.findIndex((item) => item.name === cookie.name && item.domain === cookie.domain && item.path === cookie.path);
      if (index >= 0) current[index] = { ...current[index], ...cookie };
      else current.push({ ...cookie });
    }
  };
  return { cookies };
}

function createFailOnceCookieSession(partitions, name, failedCookieName) {
  const session = createCookieSession(partitions, name);
  const originalSet = session.cookies.set;
  let failed = false;
  session.cookies.set = async (cookie) => {
    if (!failed && cookie.name === failedCookieName) {
      failed = true;
      throw new Error('simulated cookie write failure');
    }
    return originalSet(cookie);
  };
  return session;
}

(async () => {
  assert.notStrictEqual(projectBiliPartition('C:\\Star Owner A'), projectBiliPartition('C:\\Star Owner B'), 'different project roots shared a Bilibili partition');
  assert.strictEqual(projectBiliPartition('C:\\Star Owner A'), projectBiliPartition('c:\\star owner a'), 'partition identity was not stable across Windows path casing');

  const partitions = new Map();
  const sessionModule = { fromPartition: (name) => createCookieSession(partitions, name) };
  partitions.set(LEGACY_BILI_SESSION, [
    { domain: '.bilibili.com', path: '/', name: 'SESSDATA', value: 'legacy-session', secure: true, httpOnly: true },
    { domain: 'passport.bilibili.com', path: '/', name: 'bili_jct', value: 'legacy-jct', secure: true, httpOnly: false },
    { domain: '.example.com', path: '/', name: 'unrelated', value: 'must-not-copy' }
  ]);
  const settings = new Map();
  const store = {
    list: (scope) => scope === 'users' ? [{ mid: '100', name: '测试用户' }] : [],
    get: (scope, id) => scope === 'settings' ? settings.get(id) || null : null,
    set: (scope, id, value) => { if (scope === 'settings') settings.set(id, value); },
    commit: () => {}
  };
  const target = projectBiliPartition('C:\\Star Owner A');
  const migrated = await migrateLegacyBiliPartition({ sessionModule, targetPartition: target, store });
  assert.strictEqual(migrated.copied, 2, 'legacy Bilibili cookies were not migrated for an existing project');
  assert.strictEqual(partitions.get(target).length, 2, 'non-Bilibili cookies were copied into the project partition');
  const repeated = await migrateLegacyBiliPartition({ sessionModule, targetPartition: target, store });
  assert.strictEqual(repeated.skipped, 'already-migrated', 'legacy partition migration did not become idempotent');

  const retryPartitions = new Map(partitions);
  const retryTarget = projectBiliPartition('C:\\Star Owner Retry');
  retryPartitions.set(retryTarget, [{ domain: '.bilibili.com', path: '/', name: 'existing', value: 'keep-me', secure: true }]);
  let targetSession = createFailOnceCookieSession(retryPartitions, retryTarget, 'bili_jct');
  const retrySessionModule = {
    fromPartition: (name) => name === retryTarget ? targetSession : createCookieSession(retryPartitions, name)
  };
  const retrySettings = new Map();
  const retryStore = {
    list: (scope) => scope === 'users' ? [{ mid: '200', name: '重试用户' }] : [],
    get: (scope, id) => scope === 'settings' ? retrySettings.get(id) || null : null,
    set: (scope, id, value) => { if (scope === 'settings') retrySettings.set(id, value); },
    commit: () => {}
  };
  const firstRetry = await migrateLegacyBiliPartition({ sessionModule: retrySessionModule, targetPartition: retryTarget, store: retryStore });
  assert.strictEqual(firstRetry.copied, 1, 'partial migration did not retain successful cookie writes');
  assert.strictEqual(firstRetry.errors, 1, 'partial migration did not report the failed cookie write');
  assert.strictEqual(retrySettings.get('biliPartitionMigration').status, 'retry-needed', 'partial migration was incorrectly marked complete');
  assert.strictEqual(retryPartitions.get(retryTarget).find((cookie) => cookie.name === 'existing').value, 'keep-me', 'migration overwrote an existing target cookie');
  targetSession = createCookieSession(retryPartitions, retryTarget);
  const secondRetry = await migrateLegacyBiliPartition({ sessionModule: retrySessionModule, targetPartition: retryTarget, store: retryStore });
  assert.strictEqual(secondRetry.copied, 1, 'migration retry did not copy only the missing cookie');
  assert.strictEqual(secondRetry.status, 'completed', 'successful migration retry was not marked complete');
  assert.strictEqual(retryPartitions.get(retryTarget).length, 3, 'migration retry duplicated an existing cookie');
  const thirdRetry = await migrateLegacyBiliPartition({ sessionModule: retrySessionModule, targetPartition: retryTarget, store: retryStore });
  assert.strictEqual(thirdRetry.skipped, 'already-migrated', 'completed migration retry was not idempotent');

  retrySettings.set('biliPartitionMigration', { targetPartition: retryTarget, copied: 1, errors: 1 });
  retryPartitions.get(retryTarget).splice(retryPartitions.get(retryTarget).findIndex((cookie) => cookie.name === 'bili_jct'), 1);
  const legacyMarkerRetry = await migrateLegacyBiliPartition({ sessionModule: retrySessionModule, targetPartition: retryTarget, store: retryStore });
  assert.strictEqual(legacyMarkerRetry.copied, 1, 'legacy partial-failure marker did not trigger a retry');

  const blankSettings = new Map();
  const blankStore = {
    list: () => [],
    get: (_scope, id) => blankSettings.get(id) || null,
    set: (_scope, id, value) => blankSettings.set(id, value),
    commit: () => {}
  };
  const blankTarget = projectBiliPartition('C:\\Blank Star Owner');
  const blank = await migrateLegacyBiliPartition({ sessionModule, targetPartition: blankTarget, store: blankStore });
  assert.strictEqual(blank.copied, 0, 'a blank project copied the legacy shared login state');
  assert.strictEqual(partitions.get(blankTarget).length, 0, 'a blank project received legacy Bilibili cookies');
  console.log('Bilibili project partition test passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
