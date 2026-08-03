const fs = require('fs');
const path = require('path');
const { deleteCompletedDocument, recoverPendingDocumentDeletions } = require('../src/core/document-lifecycle');
const { recoverPendingUnavailableRemovals, removeUnavailableTask } = require('../src/core/unavailable-task');
const { Store } = require('../src/core/store');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const root = path.join(__dirname, '..', '.cache', 'document-lifecycle-test');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const store = await Store.open(path.join(root, 'test.sqlite'));

  const activeCollection = collection('user:7', '已经改名的收藏夹', path.join(root, 'renamed-storage'), { mediaId: '7', storageName: '改名前目录' });
  store.upsertCollection(activeCollection);
  const active = completedTask(activeCollection, 'active-task', 'BVACTIVE0001');
  writeArtifact(active);
  store.upsertTask(active);
  store.commit();
  const activeResult = deleteCompletedDocument({ store, taskId: active.id });
  const restored = store.getTask(active.id);
  assert(activeResult.restored && restored.status === 'pending' && restored.collectionId === activeCollection.id, 'active favorite document was not restored to pending by stable collection id');
  assert(store.getCollectionById(activeCollection.id).name === '已经改名的收藏夹', 'document deletion reverted the renamed collection display name');
  assert(!restored.outputMarkdown && !restored.artifactDir && !fs.existsSync(active.artifactDir), 'active document artifacts or output references survived deletion');

  const removed = completedTask(activeCollection, 'removed-task', 'BVREMOVED001', { favoriteState: 'removed', removedFromFavorites: true });
  writeArtifact(removed);
  store.upsertTask(removed);
  store.commit();
  const removedResult = deleteCompletedDocument({ store, taskId: removed.id });
  assert(removedResult.removed && !store.getTask(removed.id) && store.get('removedFavoriteTasks', removed.id), 'removed favorite document was incorrectly restored');
  assert(!fs.existsSync(removed.artifactDir), 'removed favorite artifacts survived document deletion');

  const deletedCollection = collection('user:9', '历史收藏夹（已在B站删除的收藏夹）', path.join(root, 'deleted-collection'), { mediaId: '9', biliDeleted: true, syncReady: false });
  store.upsertCollection(deletedCollection);
  const deleted = completedTask(deletedCollection, 'deleted-collection-task', 'BVDELETED001', { favoriteState: 'collection-deleted', removedFromFavorites: true });
  writeArtifact(deleted);
  store.upsertTask(deleted);
  store.commit();
  const deletedResult = deleteCompletedDocument({ store, taskId: deleted.id });
  assert(deletedResult.removed && !store.getTask(deleted.id), 'deleted Bilibili collection document was incorrectly restored');

  const internalCollection = collection('builtin:single', '内置单视频测试', path.join(root, 'builtin'), { internal: true, userId: 'builtin-agent-user', userName: '内置用户' });
  store.upsertCollection(internalCollection);
  const single = completedTask(internalCollection, 'single-only', 'BVSINGLE0001', { singleTask: true });
  writeArtifact(single);
  store.upsertTask(single);
  store.commit();
  const singleResult = deleteCompletedDocument({ store, taskId: single.id });
  assert(singleResult.removed && singleResult.reason === 'single-task-deleted' && !store.getTask(single.id), 'single-video output deletion restored a task instead of deleting it permanently');
  assert(!fs.existsSync(single.artifactDir), 'single-video generated artifacts survived deletion');

  const local = completedTask(internalCollection, 'local-summary', 'BVLOCAL00001');
  writeArtifact(local);
  store.upsertTask(local);
  store.commit();
  const localResult = deleteCompletedDocument({ store, taskId: local.id });
  assert(localResult.removed && localResult.reason === 'local-task-deleted' && !store.getTask(local.id), 'ordinary local document was incorrectly restored to pending');

  const interrupted = completedTask(activeCollection, 'interrupted-delete', 'BVINTERRUPT1');
  writeArtifact(interrupted);
  store.upsertTask(interrupted);
  store.commit();
  const transaction = store.transaction.bind(store);
  store.transaction = () => { throw new Error('simulated database commit interruption'); };
  let documentInterrupted = false;
  try { deleteCompletedDocument({ store, taskId: interrupted.id }); } catch (error) { documentInterrupted = /simulated database/.test(error.message || String(error)); }
  assert(documentInterrupted, 'document deletion did not expose the simulated database interruption');
  store.transaction = transaction;
  assert(!fs.existsSync(interrupted.artifactDir) && store.getTask(interrupted.id)?.status === 'done' && store.list('destructiveOperations').some((item) => item.type === 'document-delete'), 'document crash fixture did not retain a recoverable operation');
  const recoveredDeletes = recoverPendingDocumentDeletions(store);
  assert(recoveredDeletes.some((item) => item.ok && item.taskId === interrupted.id) && store.getTask(interrupted.id)?.status === 'pending', 'startup recovery did not finish the interrupted document deletion');

  const unavailableArtifact = path.join(activeCollection.collectionRoot, 'unavailable-interrupted');
  fs.mkdirSync(unavailableArtifact, { recursive: true });
  fs.writeFileSync(path.join(unavailableArtifact, 'partial.txt'), 'partial');
  const unavailable = { id: 'unavailable-interrupted', collectionId: activeCollection.id, bvid: 'BVUNAVAILABLE', title: 'Unavailable', status: 'claimed', artifactDir: unavailableArtifact, allowedRoot: activeCollection.collectionRoot, createdAt: new Date().toISOString() };
  store.upsertTask(unavailable);
  store.commit();
  store.transaction = () => { throw new Error('simulated unavailable database interruption'); };
  let unavailableInterrupted = false;
  try { removeUnavailableTask({ store, taskId: unavailable.id, reason: 'video unavailable', source: 'test' }); } catch (error) { unavailableInterrupted = /simulated unavailable/.test(error.message || String(error)); }
  assert(unavailableInterrupted, 'unavailable-task removal did not expose the simulated database interruption');
  store.transaction = transaction;
  assert(!fs.existsSync(unavailableArtifact) && store.getTask(unavailable.id) && store.list('destructiveOperations').some((item) => item.type === 'unavailable-remove'), 'unavailable-task crash fixture did not retain a recoverable operation');
  const recoveredUnavailable = recoverPendingUnavailableRemovals({ store });
  assert(recoveredUnavailable.some((item) => item.ok && item.tombstone.taskId === unavailable.id) && !store.getTask(unavailable.id) && store.get('unavailableTasks', unavailable.id), 'startup recovery did not finish the interrupted unavailable-task removal');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('document lifecycle test passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

function collection(id, name, collectionRoot, patch = {}) {
  fs.mkdirSync(collectionRoot, { recursive: true });
  return { id, name, sourceName: name, collectionRoot, videosDir: collectionRoot, userId: 'user', userName: '测试用户', videoCount: 1, syncReady: true, ...patch };
}

function completedTask(collectionValue, id, bvid, patch = {}) {
  const artifactDir = path.join(collectionValue.collectionRoot, id);
  return {
    id,
    collectionId: collectionValue.id,
    bvid,
    title: `${bvid} 测试文档`,
    status: 'done',
    enabled: true,
    allowedRoot: collectionValue.collectionRoot,
    workspaceRoot: collectionValue.collectionRoot,
    artifactDir,
    outputMarkdown: path.join(artifactDir, `${id}.md`),
    metadataFile: path.join(artifactDir, 'info.json'),
    completedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...patch
  };
}

function writeArtifact(task) {
  fs.mkdirSync(task.artifactDir, { recursive: true });
  fs.writeFileSync(task.outputMarkdown, '# completed\n', 'utf8');
  fs.writeFileSync(task.metadataFile, '{}\n', 'utf8');
}
