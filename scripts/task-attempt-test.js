const fs = require('fs');
const path = require('path');
const { Store } = require('../src/core/store');
const { ToolRunner } = require('../src/core/tool-runner');
const { abortTaskAttempt } = require('../src/core/task-attempt');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const root = path.join(__dirname, '..', '.cache', 'task-attempt-test');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const store = await Store.open(path.join(root, 'test.sqlite'));

  const regularRoot = path.join(root, 'regular-root');
  const regularArtifact = path.join(regularRoot, 'attempt');
  fs.mkdirSync(path.join(regularArtifact, 'frames'), { recursive: true });
  fs.writeFileSync(path.join(regularArtifact, 'frames', 'frame.jpg'), 'partial');
  fs.writeFileSync(path.join(regularArtifact, 'summary-draft.md'), '# partial');
  store.upsertTask({ id: 'task-regular', collectionId: 'collection-regular', bvid: 'BVREGULAR001', status: 'claimed', claimedBy: 'worker-regular', claimedAt: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), allowedRoot: regularRoot, workspaceRoot: regularRoot, workspaceId: 'workspace-1', artifactDir: regularArtifact, outputMarkdown: path.join(regularArtifact, 'summary-draft.md'), metadataFile: path.join(regularArtifact, 'info.json'), coverFile: path.join(regularArtifact, 'cover.jpg'), cachedVideoFile: path.join(regularArtifact, 'merged.mp4'), completedAt: 'unexpected' });
  store.createToolRun({ id: 'run-regular', taskId: 'task-regular', workerId: 'worker-regular', status: 'queued', createdAt: new Date().toISOString() });
  store.createToolRun({ id: 'run-regular-legacy-owner', taskId: 'task-regular', workerId: 'stale-worker', status: 'running', createdAt: new Date().toISOString() });
  const fakeRunner = {
    cancel: (runId) => store.updateToolRun(runId, { status: 'cancelled', stage: 'cancelled', finishedAt: new Date().toISOString() })
  };
  const regular = abortTaskAttempt({ store, toolRunner: fakeRunner, taskId: 'task-regular', workerId: 'worker-regular', reason: 'manual test stop', source: 'test' });
  assert(regular.task.status === 'pending' && !regular.task.claimedBy && !regular.task.artifactDir && !regular.task.allowedRoot && !regular.task.outputMarkdown && !regular.task.metadataFile && !regular.task.coverFile && !regular.task.cachedVideoFile, 'regular task state or deleted-file references were not reset');
  assert(!fs.existsSync(regularArtifact) && store.getToolRun('run-regular').status === 'cancelled' && store.getToolRun('run-regular-legacy-owner').status === 'cancelled', 'regular attempt files or an associated run survived abort');

  const cacheRoot = path.join(root, 'cache-root');
  const cacheArtifact = path.join(cacheRoot, 'cached-video');
  fs.mkdirSync(path.join(cacheArtifact, 'audio'), { recursive: true });
  fs.mkdirSync(path.join(cacheArtifact, 'frames'), { recursive: true });
  fs.mkdirSync(path.join(cacheArtifact, 'tool-runs'), { recursive: true });
  const videoFile = path.join(cacheArtifact, 'merged.mp4');
  const metadataFile = path.join(cacheArtifact, 'info.json');
  const coverFile = path.join(cacheArtifact, 'cover.jpg');
  for (const [file, content] of [[videoFile, 'video'], [metadataFile, '{}'], [coverFile, 'cover'], [path.join(cacheArtifact, 'cache-record.json'), '{}'], [path.join(cacheArtifact, 'audio', 'audio.wav'), 'partial'], [path.join(cacheArtifact, 'frames', 'frame.jpg'), 'partial'], [path.join(cacheArtifact, 'tool-runs', 'run.log'), 'partial'], [path.join(cacheArtifact, 'agent-draft-1.md'), '# partial'], [path.join(cacheArtifact, 'manifest.json'), '{}']]) {
    fs.writeFileSync(file, content);
  }
  store.upsertVideoCache({ id: 'cache-1', taskId: 'task-cache', artifactDir: cacheArtifact, videoFile, metadataFile, coverFile, allowedRoot: cacheRoot });
  store.upsertTask({ id: 'task-cache', collectionId: 'collection-cache', bvid: 'BVCACHED0001', status: 'claimed', claimedBy: 'worker-cache', allowedRoot: cacheRoot, workspaceRoot: cacheRoot, workspaceId: 'workspace-1', artifactDir: cacheArtifact, cachedVideoId: 'cache-1', cachedVideoFile: videoFile, coverFile });
  const cached = abortTaskAttempt({ store, toolRunner: fakeRunner, taskId: 'task-cache', workerId: 'worker-cache', reason: 'cached task stopped', source: 'test' });
  assert(cached.task.status === 'pending' && cached.task.artifactDir === cacheArtifact && cached.task.cachedVideoFile === videoFile, 'cached task source references were not preserved');
  for (const file of [videoFile, metadataFile, coverFile, path.join(cacheArtifact, 'cache-record.json')]) assert(fs.existsSync(file), `cached source was deleted: ${file}`);
  for (const file of [path.join(cacheArtifact, 'audio'), path.join(cacheArtifact, 'frames'), path.join(cacheArtifact, 'tool-runs'), path.join(cacheArtifact, 'agent-draft-1.md'), path.join(cacheArtifact, 'manifest.json')]) assert(!fs.existsSync(file), `cached attempt artifact survived: ${file}`);

  const restartRoot = path.join(root, 'restart-root');
  const restartArtifact = path.join(restartRoot, 'attempt');
  fs.mkdirSync(restartArtifact, { recursive: true });
  fs.writeFileSync(path.join(restartArtifact, 'partial.txt'), 'partial');
  store.upsertTask({ id: 'task-restart', collectionId: 'collection-restart', bvid: 'BVRESTART001', status: 'claimed', claimedBy: 'worker-restart', allowedRoot: restartRoot, workspaceRoot: restartRoot, artifactDir: restartArtifact });
  store.createToolRun({ id: 'run-restart', taskId: 'task-restart', collectionId: 'collection-restart', toolId: 'clean-cache', toolName: '清理视频缓存', workerId: 'worker-restart', status: 'queued', artifactDir: restartArtifact, options: {}, timeoutMs: 60_000, createdAt: new Date().toISOString() });
  const runner = new ToolRunner({ store });
  await runner.initialize({ startGpuService: false });
  assert(store.getTask('task-restart').status === 'pending' && !fs.existsSync(restartArtifact), 'restart recovery did not roll back the interrupted attempt');
  assert(store.getToolRun('run-restart').status === 'cancelled', 'restart recovery resumed an interrupted summary tool run');
  runner.shutdown();

  fs.rmSync(root, { recursive: true, force: true });
  console.log('task attempt rollback test passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
