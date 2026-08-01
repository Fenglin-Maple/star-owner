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
