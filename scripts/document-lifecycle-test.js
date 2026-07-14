const fs = require('fs');
const path = require('path');
const { deleteCompletedDocument } = require('../src/core/document-lifecycle');
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

  const internalCollection = collection('builtin:versions', '内置版本测试', path.join(root, 'builtin'), { internal: true, userId: 'builtin-agent-user', userName: '内置用户' });
  store.upsertCollection(internalCollection);
  const first = completedTask(internalCollection, 'single-v1', 'BVVERSION001', { singleTask: true, revision: 1, knowledgeActive: false, completedAt: '2026-01-01T00:00:00.000Z' });
  const second = completedTask(internalCollection, 'single-v2', 'BVVERSION001', { singleTask: true, revision: 2, knowledgeActive: true, completedAt: '2026-01-02T00:00:00.000Z' });
  writeArtifact(first);
  writeArtifact(second);
  store.upsertTask(first);
  store.upsertTask(second);
  store.upsertTask(completedTask(internalCollection, 'ordinary-same-bv', 'BVVERSION001', { singleTask: false, knowledgeActive: true }));
  store.commit();
  const versionResult = deleteCompletedDocument({ store, taskId: second.id });
  assert(versionResult.restored && store.getTask(second.id).status === 'pending', 'latest internal version was not returned to pending');
  assert(store.getTask(first.id).knowledgeActive === true, 'previous completed version was not restored as the RAG-active version');
  assert(store.getTask('ordinary-same-bv').knowledgeActive === true, 'single-video version selection changed an unrelated ordinary task');

  fs.rmSync(first.outputMarkdown, { force: true });
  store.upsertTask({ ...second, status: 'done', outputMarkdown: second.outputMarkdown, knowledgeActive: true });
  writeArtifact(second);
  store.commit();
  deleteCompletedDocument({ store, taskId: second.id });
  assert(store.getTask(first.id).knowledgeActive !== true, 'a missing historical Markdown was reactivated for RAG');

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
