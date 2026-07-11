const fs = require('fs');
const path = require('path');
const { CollectionSyncService } = require('../src/core/collection-sync-service');
const { Store } = require('../src/core/store');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const root = path.join(__dirname, '..', '.cache', 'collection-sync-test');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const store = await Store.open(path.join(root, 'test.sqlite'));
  const workspace = store.addWorkspace({ name: 'Sync test', root: path.join(root, 'workspace') });
  store.setDefaultWorkspace(workspace.id);
  const events = [];
  const bili = {
    listFolders: async () => [{ id: '7', name: 'AIcode', mediaCount: 2, updatedAt: '2026-07-01T00:00:00.000Z' }],
    exportCookies: async () => path.join(root, 'cookies.txt'),
    listVideos: async (_id, onProgress) => {
      onProgress({ page: 1, loaded: 2, total: 2, done: true });
      return [
        { bvid: 'BV1234567890', title: 'Video A', owner: 'UP A', duration: 60, favoriteAddedAt: '2026-07-02T00:00:00.000Z', publishedAt: '2026-06-01T00:00:00.000Z', url: 'https://www.bilibili.com/video/BV1234567890' },
        { bvid: 'BV0987654321', title: 'Video B', owner: 'UP B', duration: 120, favoriteAddedAt: '2026-07-03T00:00:00.000Z', publishedAt: '2026-06-02T00:00:00.000Z', url: 'https://www.bilibili.com/video/BV0987654321' }
      ];
    }
  };
  const service = new CollectionSyncService({ store, bili, getCurrentUser: () => ({ isLogin: true, mid: '100', name: '测试用户' }), onEvent: (event) => events.push(event) });
  const result = await service.sync({ collectionName: 'AIcode' });
  assert(result.count === 2 && result.collection.id === '100:7', 'collection sync result is incorrect');
  assert(store.listTasks({ collectionId: '100:7' }).length === 2, 'collection tasks were not persisted');
  assert(events.some((event) => event.type === 'collection-sync-progress' && event.stage === 'done'), 'completion progress event was not emitted');
  assert(fs.readdirSync(result.collection.exportDir).some((name) => /^sync-.*\.json$/.test(name)), 'collection export index was not written');
  store.db.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log('collection sync service integration test passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
