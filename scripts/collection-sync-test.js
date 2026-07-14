const fs = require('fs');
const path = require('path');
const { CollectionSyncService } = require('../src/core/collection-sync-service');
const { Store } = require('../src/core/store');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function video(bvid, title, favoriteAddedAt) {
  return { bvid, title, owner: `UP ${title}`, duration: 60, favoriteAddedAt, publishedAt: '2026-06-01T00:00:00.000Z', url: `https://www.bilibili.com/video/${bvid}` };
}

(async () => {
  const root = path.join(__dirname, '..', '.cache', 'collection-sync-test');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const store = await Store.open(path.join(root, 'test.sqlite'));
  const workspace = store.addWorkspace({ name: 'Sync test', root: path.join(root, 'workspace') });
  store.setDefaultWorkspace(workspace.id);
  const events = [];
  const stopped = [];
  const unavailableSessions = [];
  let folders = [{ id: '7', name: 'AIcode', mediaCount: 2, updatedAt: '2026-07-01T00:00:00.000Z' }];
  let videos = [
    video('BV1234567890', 'Video A', '2026-07-02T00:00:00.000Z'),
    video('BV0987654321', 'Video B', '2026-07-03T00:00:00.000Z')
  ];
  let videoError = null;
  const bili = {
    listFolders: async () => folders,
    exportCookies: async () => path.join(root, 'cookies.txt'),
    listVideos: async (_id, onProgress) => {
      if (videoError) throw videoError;
      onProgress({ page: 1, loaded: videos.length, total: videos.length, done: true });
      return videos;
    }
  };
  const internalAgentManager = {
    stopCollectionForSync: async (collectionId, reason, source) => { stopped.push({ collectionId, reason, source }); return ['agent-test']; },
    markCollectionUnavailable: (collectionId, reason) => unavailableSessions.push({ collectionId, reason })
  };
  const service = new CollectionSyncService({
    store,
    bili,
    internalAgentManager,
    getCurrentUser: () => ({ isLogin: true, mid: '100', name: '测试用户' }),
    onEvent: (event) => events.push(event)
  });

  const first = await service.sync({ collectionName: '7' });
  assert(first.count === 2 && first.collection.id === '100:7', 'initial collection sync result is incorrect');
  assert(first.collection.syncReady === true && first.collection.syncState === 'ready', 'successful sync did not leave an internally dispatchable inventory');
  assert(first.collection.storageName === 'AIcode', 'initial immutable collection storage name is incorrect');
  assert(store.listTasks({ collectionId: '100:7' }).length === 2, 'initial collection tasks were not persisted');
  assert(events.some((event) => event.type === 'collection-sync-progress' && event.stage === 'done'), 'completion progress event was not emitted');
  assert(fs.readdirSync(first.collection.exportDir).some((name) => /^sync-.*\.json$/.test(name)), 'collection export index was not written');

  videos = [...videos, video('BVDEAD123456', '已失效视频', '2026-07-03T12:00:00.000Z')];
  folders = [{ ...folders[0], mediaCount: 3 }];
  await service.sync({ collectionName: '7' });
  assert(!store.getTask('100:7:BVDEAD123456') && store.get('unavailableTasks', '100:7:BVDEAD123456')?.source === 'collection-sync', 'unavailable title from collection sync did not create a permanent tombstone');
  videos = videos.filter((item) => item.bvid !== 'BVDEAD123456');
  folders = [{ ...folders[0], mediaCount: 2 }];

  const unavailableTaskId = '100:7:BV0987654321';
  store.set('unavailableTasks', unavailableTaskId, { id: unavailableTaskId, taskId: unavailableTaskId, bvid: 'BV0987654321', removedAt: new Date().toISOString() });
  store.delete('tasks', unavailableTaskId);
  store.delete('videos', unavailableTaskId);
  store.commit();
  await service.sync({ collectionName: '7' });
  assert(!store.getTask(unavailableTaskId), 'unavailable task tombstone was recreated during collection sync');

  const completedTaskId = '100:7:BV1234567890';
  const markdown = path.join(root, 'video-a.md');
  fs.writeFileSync(markdown, '# Video A\n', 'utf8');
  store.upsertTask({ ...store.getTask(completedTaskId), status: 'done', outputMarkdown: markdown, completedAt: new Date().toISOString() });
  store.commit();
  videos = [video('BVNEW1234567', 'Video C', '2026-07-04T00:00:00.000Z')];
  folders = [{ ...folders[0], mediaCount: 1 }];
  const changed = await service.sync({ collectionName: '7' });
  const archived = store.getTask(completedTaskId);
  assert(changed.summary.added === 1 && changed.summary.archived === 1, 'added/removed favorite reconciliation counts are incorrect');
  assert(archived?.status === 'done' && archived.removedFromFavorites === true && archived.title.endsWith('（已移出收藏夹）') && archived.outputMarkdown === markdown, 'completed Markdown artifact was not preserved and marked after favorite removal');
  assert(store.getTask('100:7:BVNEW1234567')?.status === 'pending', 'new favorite did not become a pending task');

  folders = [{ id: '7', name: 'AIcode Renamed Direct', mediaCount: 1, updatedAt: '2026-07-05T00:00:00.000Z' }];
  const directRename = await service.sync({ collectionName: 'AIcode' });
  assert(directRename.collection.name === 'AIcode Renamed Direct' && directRename.collection.storageName === 'AIcode', 'syncing by a stale pre-rename display name treated the stable mediaId as a deleted folder');

  folders = [{ id: '7', name: 'AIcode Renamed', mediaCount: 1, updatedAt: '2026-07-05T01:00:00.000Z' }];
  const folderDiff = await service.reconcileFolders(folders, { mid: '100', name: '测试用户' });
  const renamedNeedsSync = store.getCollectionById('100:7');
  assert(folderDiff.renamed === 1 && renamedNeedsSync.name === 'AIcode Renamed' && renamedNeedsSync.syncReady === false, 'folder rename was not detected as requiring a full sync');
  assert(renamedNeedsSync.storageName === 'AIcode', 'folder rename changed the immutable disk storage name');
  const renamed = await service.sync({ collectionName: '7' });
  assert(renamed.collection.id === '100:7' && renamed.collection.name === 'AIcode Renamed' && renamed.collection.storageName === 'AIcode' && renamed.collection.collectionRoot === first.collection.collectionRoot, 'renamed folder created a duplicate or moved its storage identity');

  const beforeFailure = store.getCollectionById('100:7');
  videoError = new Error('simulated interrupted page fetch');
  let failed = false;
  try { await service.sync({ collectionName: '7' }); } catch { failed = true; }
  videoError = null;
  const afterFailure = store.getCollectionById('100:7');
  assert(failed && afterFailure.syncState === beforeFailure.syncState && afterFailure.lastSyncedAt === beforeFailure.lastSyncedAt && afterFailure.name === beforeFailure.name, 'failed sync did not roll back the previous collection state');
  assert(events.some((event) => event.type === 'collection-sync-rolled-back'), 'sync rollback was not written to the event log');

  videos = [
    video('BV1234567890', 'Video A', '2026-07-06T00:00:00.000Z'),
    video('BVNEW1234567', 'Video C', '2026-07-04T00:00:00.000Z')
  ];
  folders = [{ ...folders[0], mediaCount: 2 }];
  await service.sync({ collectionName: '7' });
  const restored = store.getTask(completedTaskId);
  assert(restored.status === 'done' && restored.removedFromFavorites === false && restored.title === 'Video A' && restored.enabled === true, 're-added completed video did not restore active favorite metadata and enable state');

  folders = [];
  const deletedDiff = await service.reconcileFolders(folders, { mid: '100', name: '测试用户' });
  const deletedCollection = store.getCollectionById('100:7');
  const remaining = store.listTasks({ collectionId: '100:7' });
  assert(deletedDiff.deleted === 1 && deletedCollection.biliDeleted === true && deletedCollection.name.endsWith('（已在B站删除的收藏夹）'), 'deleted Bilibili folder was not archived locally');
  assert(remaining.length === 1 && remaining[0].id === completedTaskId && remaining[0].status === 'done' && fs.existsSync(remaining[0].outputMarkdown), 'deleted folder did not retain only completed artifacts');
  assert(!store.getTask('100:7:BVNEW1234567') && store.get('removedFavoriteTasks', '100:7:BVNEW1234567'), 'unfinished task from a deleted folder remained dispatchable');
  assert(unavailableSessions.some((item) => item.collectionId === '100:7'), 'Agent workflows were not marked unavailable after folder deletion');
  assert(stopped.length >= 5, 'collection changes did not stop related Agent workflows');

  folders = [{ id: '8', name: 'AIcode Renamed', mediaCount: 1, updatedAt: '2026-07-07T00:00:00.000Z' }];
  videos = [video('BVREPLACED01', 'Replacement folder video', '2026-07-07T01:00:00.000Z')];
  const replacement = await service.sync({ collectionName: 'AIcode Renamed' });
  assert(replacement.collection.id === '100:8' && replacement.collection.syncState === 'ready', 'same-name replacement folder was not synchronized as a new stable collection id');
  assert(store.getCollectionById('100:7').biliDeleted === true && store.getCollectionById('100:7').syncState === 'deleted', 'same-name replacement left the old deleted collection stuck in syncing state');
  assert(store.getTask('100:8:BVREPLACED01')?.status === 'pending', 'replacement collection did not receive its new task inventory');

  const interruptedId = 'collection-sync:100:7';
  store.set('collectionSyncTransactions', interruptedId, { id: interruptedId, collectionId: '100:7', collectionBefore: deletedCollection, startedAt: new Date().toISOString() });
  store.set('collections', '100:7', { ...deletedCollection, name: 'BROKEN PARTIAL STATE', syncState: 'syncing' });
  const orphanDir = path.join(workspace.root, '测试用户', 'AIcode', 'orphan-attempt');
  fs.mkdirSync(orphanDir, { recursive: true });
  fs.writeFileSync(path.join(orphanDir, 'partial.cache'), 'partial');
  store.set('removedFavoriteTasks', '100:7:BVORPHAN', {
    id: '100:7:BVORPHAN', taskId: '100:7:BVORPHAN', collectionId: '100:7', bvid: 'BVORPHAN', cleanupPending: true,
    cleanupTask: { id: '100:7:BVORPHAN', collectionId: '100:7', bvid: 'BVORPHAN', artifactDir: orphanDir, allowedRoot: path.join(workspace.root, '测试用户', 'AIcode') }
  });
  store.commit();
  const recoveryEvents = [];
  new CollectionSyncService({ store, bili, getCurrentUser: () => null, onEvent: (event) => recoveryEvents.push(event) });
  assert(store.getCollectionById('100:7').name === deletedCollection.name && !store.get('collectionSyncTransactions', interruptedId), 'startup recovery did not restore an interrupted sync snapshot');
  assert(recoveryEvents.some((event) => event.type === 'collection-sync-rolled-back'), 'startup rollback was not logged');
  assert(!fs.existsSync(orphanDir) && store.get('removedFavoriteTasks', '100:7:BVORPHAN')?.cleanupPending === false, 'startup recovery did not finish persisted removed-task cache cleanup');

  store.db.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log('collection sync service integration test passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
