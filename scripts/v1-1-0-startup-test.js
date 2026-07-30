const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { StartupFolderProbe, localReportedCount } = require('../src/core/startup-folder-probe');

(async () => {
  let currentUser = { isLogin: true, mid: '100', name: 'Startup user' };
  let folderCalls = 0;
  let videoCalls = 0;
  const collections = [
    { id: '100:7', mediaId: '7', userId: '100', name: 'Changed', remoteReportedCount: 12, videoCount: 11, lastSyncedAt: '2026-07-01T00:00:00.000Z' },
    { id: '100:8', mediaId: '8', userId: '100', name: 'Same', remoteVideoCount: 4, lastSyncedAt: '2026-07-01T00:00:00.000Z' },
    { id: '100:9', mediaId: '9', userId: '100', name: 'Legacy', videoCount: 3, lastSyncedAt: '2026-07-01T00:00:00.000Z' },
    { id: 'other:7', mediaId: '7', userId: 'other', name: 'Other user', remoteReportedCount: 99 },
    { id: 'local', userId: '100', name: 'Internal', internal: true, videoCount: 2 }
  ];
  const bili = {
    listFolders: async (mid) => {
      folderCalls += 1;
      assert(['100', '200'].includes(mid));
      return mid === '100'
        ? [
            { id: '7', name: 'Changed', mediaCount: 14 },
            { id: '8', name: 'Same', mediaCount: 4 },
            { id: '9', name: 'Legacy', mediaCount: 2 },
            { id: '10', name: 'Never synced', mediaCount: 6 }
          ]
        : [{ id: '20', name: 'Second user folder', mediaCount: 1 }];
    },
    listVideos: async () => {
      videoCalls += 1;
      throw new Error('startup probe must not request favorite videos');
    }
  };
  const probe = new StartupFolderProbe({
    store: { listCollections: () => collections },
    bili,
    getCurrentUser: () => currentUser,
    now: () => '2026-07-30T00:00:00.000Z'
  });

  const [first, repeated] = await Promise.all([probe.run(), probe.run()]);
  assert.strictEqual(folderCalls, 1, 'startup folder inventory was requested more than once for one account');
  assert.strictEqual(videoCalls, 0, 'startup folder probe requested favorite video pages');
  assert.strictEqual(first, repeated, 'same-account startup probe did not reuse the in-flight/result promise');
  assert.deepStrictEqual(first.changes.map((item) => [item.mediaId, item.previousCount, item.currentCount, item.delta]), [
    ['7', 12, 14, 2],
    ['9', 3, 2, -1]
  ]);
  assert.strictEqual(first.changes.some((item) => item.mediaId === '10'), false, 'unsynchronized remote folder generated a false count-change notice');
  assert.strictEqual(localReportedCount({ remoteReportedCount: 0, videoCount: 8 }), 0, 'zero remote count was not treated as a valid baseline');

  currentUser = { isLogin: true, mid: '200', name: 'Second user' };
  const second = await probe.run();
  assert.strictEqual(folderCalls, 2, 'a different account incorrectly reused the previous account probe');
  assert.strictEqual(second.userId, '200');
  assert.deepStrictEqual(second.changes, []);
  assert.strictEqual(videoCalls, 0);

  currentUser = { isLogin: false };
  assert.throws(() => probe.run(), /Not logged in/);

  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  assert(renderer.includes('setTimeout(() => synchronizeLogin({ startupProbe: true }), 0)'), 'initial login check does not request the startup-only folder probe');
  assert(renderer.includes('await ensureLoginPage(true);'), 'QR login button does not force a fresh login page');
  assert(renderer.includes('biliView.reloadIgnoringCache();'), 'QR login refresh does not bypass the stale WebView cache');
  assert(renderer.includes('showStartupFolderProbeNotice();'), 'collection page does not consume the startup count-change notice');
  assert(renderer.includes('duration: 12000'), 'folder count-change notice is not long-lived');

  console.log('1.1.0 startup folder probe and QR refresh test passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
