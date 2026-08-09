const fs = require('fs');
const path = require('path');
const { Store } = require('../src/core/store');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const root = path.join(__dirname, '..', '.cache', 'persistence-test');
  const database = path.join(root, 'orchestrator.sqlite');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const store = await Store.open(database);
  store.set('test', 'record', { value: 42 });
  store.save();
  const originalSave = store.save.bind(store);
  let batchPhysicalSaves = 0;
  store.save = (...args) => {
    if (store.saveBatchDepth === 0) batchPhysicalSaves += 1;
    return originalSave(...args);
  };
  store.batchSave(() => {
    store.set('test', 'batch-a', { value: 'a' });
    store.save();
    store.batchSave(() => {
      store.set('test', 'batch-b', { value: 'b' });
      store.save();
    });
  });
  store.save = originalSave;
  assert(batchPhysicalSaves === 1, 'nested save batching exported the complete SQLite database more than once');
  store.db.close();
  fs.copyFileSync(database, `${database}.bak`);
  fs.writeFileSync(`${database}.tmp`, 'incomplete');
  fs.rmSync(database, { force: true });
  const recovered = await Store.open(database);
  assert(recovered.get('test', 'record')?.value === 42, 'database backup was not recovered');
  assert(recovered.get('test', 'batch-a')?.value === 'a' && recovered.get('test', 'batch-b')?.value === 'b', 'batched SQLite updates were not persisted');
  assert(!fs.existsSync(`${database}.tmp`), 'stale database temporary file was not removed');
  recovered.db.close();

  const oldProject = path.join(root, 'old-project');
  const oldWorkspace = path.join(oldProject, 'workspace');
  const portableDatabase = path.join(oldWorkspace, 'orchestrator.sqlite');
  const externalRoot = path.join(root, 'external-library');
  fs.mkdirSync(oldWorkspace, { recursive: true });
  const portable = await Store.open(portableDatabase);
  const managedArtifact = path.join(oldWorkspace, '用户', '收藏夹', 'BVTEST');
  portable.set('collections', 'portable-collection', {
    id: 'portable-collection', workspaceId: 'default', collectionRoot: path.dirname(managedArtifact), exportFile: path.join(oldWorkspace, '.star-note', 'exports', 'tasks.json')
  });
  portable.set('tasks', 'portable-task', {
    id: 'portable-task', artifactDir: managedArtifact, outputMarkdown: path.join(managedArtifact, 'summary.md'), metadataFile: path.join(managedArtifact, 'info.json'),
    nested: { logFile: path.join(managedArtifact, 'tool-runs', 'run.log') }
  });
  portable.set('videoCaches', 'portable-cache', { id: 'portable-cache', videoFile: path.join(managedArtifact, 'merged.mp4') });
  portable.set('ragSessions', 'portable-rag', { id: 'portable-rag', sandboxDir: path.join(oldWorkspace, '.star-note', 'rag-sandboxes', 'session') });
  const pathLookingText = `请原样保留示例路径 ${path.join(oldWorkspace, '用户', '不要改写.txt')}`;
  portable.set('ragMessages', 'portable-message', { id: 'portable-message', role: 'user', content: pathLookingText });
  portable.set('ragProviders', 'portable-provider', { id: 'portable-provider', systemPrompt: pathLookingText, endpoint: 'https://example.invalid/v1' });
  portable.set('workspaces', 'external', { id: 'external', name: 'External', root: externalRoot, isDefault: false });
  portable.set('tasks', 'external-task', { id: 'external-task', artifactDir: path.join(externalRoot, 'keep-me') });
  portable.save();
  portable.db.close();

  const newProject = path.join(root, 'moved-project');
  fs.renameSync(oldProject, newProject);
  const newWorkspace = path.join(newProject, 'workspace');
  const moved = await Store.open(path.join(newWorkspace, 'orchestrator.sqlite'));
  assert(moved.portableRelocation?.updatedRecords >= 5, 'portable workspace relocation did not update stored records');
  assert(path.resolve(moved.get('workspaces', 'default').root) === path.resolve(newWorkspace), 'default workspace root was not relocated');
  assert(moved.get('tasks', 'portable-task').outputMarkdown.startsWith(newWorkspace), 'task output path was not relocated');
  assert(moved.get('tasks', 'portable-task').nested.logFile.startsWith(newWorkspace), 'nested tool log path was not relocated');
  assert(moved.get('videoCaches', 'portable-cache').videoFile.startsWith(newWorkspace), 'video cache path was not relocated');
  assert(moved.get('ragSessions', 'portable-rag').sandboxDir.startsWith(newWorkspace), 'RAG sandbox path was not relocated');
  assert(moved.get('ragMessages', 'portable-message').content === pathLookingText, 'portable relocation rewrote path-looking chat text');
  assert(moved.get('ragProviders', 'portable-provider').systemPrompt === pathLookingText, 'portable relocation rewrote a provider prompt');
  assert(path.resolve(moved.get('tasks', 'external-task').artifactDir) === path.resolve(path.join(externalRoot, 'keep-me')), 'external workspace path was incorrectly relocated');
  moved.db.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log('SQLite recoverable persistence test passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
