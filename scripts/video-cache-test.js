const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Store } = require('../src/core/store');
const { ToolRunner } = require('../src/core/tool-runner');
const { DEFAULT_CACHE_COLLECTION_ID, VideoCacheManager, resolveBvid } = require('../src/core/video-cache-manager');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const root = path.join(__dirname, '..', '.cache', 'video-cache-test');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const store = await Store.open(path.join(root, 'test.sqlite'));
  const workspace = store.addWorkspace({ name: 'Cache test', root: path.join(root, 'workspace') });
  store.setDefaultWorkspace(workspace.id);

  let requireLogin = false;
  let runCount = 0;
  const runner = {
    start: ({ task, tool, collection }) => {
      runCount += 1;
      const id = `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const logFile = path.join(task.artifactDir, `${id}.log`);
      fs.mkdirSync(task.artifactDir, { recursive: true });
      let status = 'succeeded';
      let error = '';
      if (tool.id === 'video-info') {
        fs.writeFileSync(path.join(task.artifactDir, 'cover.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        fs.writeFileSync(path.join(task.artifactDir, 'info.json'), JSON.stringify({ bvid: task.bvid, title: '缓存测试视频', owner: { name: '测试 UP', mid: 1 }, duration: 125, pubdate: 1767225600, tags: ['AI', '测试'], pic: 'http://i0.hdslb.com/test.jpg', coverFile: 'cover.jpg', dimension: { width: 1080, height: 1920, rotate: 0 } }));
      }
      if (tool.id === 'merged-video') {
        if (requireLogin && !collection.cookieFile) {
          status = 'failed';
          error = 'This video is only available for registered users. Use --cookies.';
        } else {
          fs.writeFileSync(path.join(task.artifactDir, 'merged.mp4'), 'merged video');
        }
      }
      fs.writeFileSync(logFile, error);
      store.createToolRun({ id, taskId: task.id, collectionId: task.collectionId, toolId: tool.id, status, error, logFile, artifactDir: task.artifactDir, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
      return store.getToolRun(id);
    }
  };
  const cookieFile = path.join(root, 'cookies.txt');
  fs.writeFileSync(cookieFile, 'cookie');
  let currentUser = null;
  const manager = new VideoCacheManager({ store, toolRunner: runner, bili: { exportCookies: async () => cookieFile }, getCurrentUser: () => currentUser, pollMs: 25, maxConcurrent: 2 });
  manager.initialize();
  const defaultCollection = store.getCollectionById(DEFAULT_CACHE_COLLECTION_ID);
  assert(defaultCollection?.protected && defaultCollection.collectionKind === 'video-cache', 'protected default cache collection was not created');

  store.createToolRun({
    id: 'cache-run-interrupted',
    taskId: 'cache-task-interrupted',
    toolId: 'merged-video',
    toolName: '合轨视频下载',
    workerId: 'video-cache-manager',
    agentName: 'video-cache-manager',
    status: 'running',
    createdAt: new Date().toISOString()
  });
  const recoveryRunner = Object.create(ToolRunner.prototype);
  recoveryRunner.store = store;
  recoveryRunner.publish = () => {};
  recoveryRunner.enqueuePersistedRun = () => { throw new Error('video cache run must not be restored by the generic tool runner'); };
  const recovery = recoveryRunner.restoreInterruptedRuns();
  assert(recovery.restoredRuns === 0 && store.getToolRun('cache-run-interrupted').signal === 'VIDEO_CACHE_JOB_RECOVERY', 'generic startup recovery restarted a video-cache-owned tool run');

  const activeFixture = store.upsertVideoCacheJob({ id: 'active-cache-job', collectionId: defaultCollection.id, input: 'BV1111111111', bvid: 'BV1111111111', status: 'running', outputRoot: defaultCollection.cacheRoot, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const activeDuplicate = await manager.submit({ inputs: activeFixture.bvid, collectionId: defaultCollection.id });
  assert(activeDuplicate.jobs[0].id === activeFixture.id, 'active cache download was duplicated');
  store.delete('videoCacheJobs', activeFixture.id);
  store.commit();

  const ignoredExternalRoot = path.join(root, 'external-output');
  const first = await manager.submit({ inputs: 'BV1234567890', collectionId: defaultCollection.id, outputDir: ignoredExternalRoot });
  assert(first.jobs[0].outputRoot === defaultCollection.cacheRoot && !fs.existsSync(ignoredExternalRoot), 'cache submission escaped the managed collection directory');
  await waitForJob(store, first.jobs[0].id, 'completed');
  const firstRecord = manager.state().videos.find((item) => item.bvid === 'BV1234567890');
  assert(firstRecord?.fileExists && firstRecord.title === '缓存测试视频', 'cache video and metadata were not persisted');
  assert(firstRecord.cover.startsWith('file:') && firstRecord.orientation === 'portrait' && firstRecord.width === 1080 && firstRecord.height === 1920, 'local cover or portrait metadata was not exposed to the video library');
  const cachedTask = store.getTask(firstRecord.taskId);
  assert(cachedTask?.enabled && cachedTask.cachedVideoId === firstRecord.id && cachedTask.reuseCachedMedia, 'cached video was not exposed as an enabled Agent task');
  store.upsertVideoCacheJob({ id: 'active-delete-guard', collectionId: defaultCollection.id, input: firstRecord.bvid, bvid: firstRecord.bvid, status: 'running', outputRoot: defaultCollection.cacheRoot, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  let activeDeleteRejected = false;
  try { manager.deleteVideos([firstRecord.id]); } catch (error) { activeDeleteRejected = /仍在下载|等待登录/.test(error.message); }
  assert(activeDeleteRejected, 'cache record was deletable while the same video had an active download job');
  store.delete('videoCacheJobs', 'active-delete-guard');
  store.commit();
  const runsBeforeDuplicate = runCount;
  const duplicate = await manager.submit({ inputs: 'BV1234567890', collectionId: defaultCollection.id });
  assert(duplicate.jobs[0].status === 'completed' && runCount === runsBeforeDuplicate, 'existing cache video was downloaded again');
  const buildRunner = new ToolRunner({ store });
  const cleanArgs = buildRunner.buildArgs({ task: cachedTask, action: 'clean-cache', collection: defaultCollection, artifactDir: cachedTask.artifactDir, options: {} });
  assert(cleanArgs.includes('--preserve-video'), 'cached task cleanup did not preserve merged video');
  const cleanupRoot = path.join(root, 'cleanup');
  fs.mkdirSync(path.join(cleanupRoot, 'audio'), { recursive: true });
  fs.writeFileSync(path.join(cleanupRoot, 'merged.mp4'), 'keep');
  fs.writeFileSync(path.join(cleanupRoot, 'audio', 'audio.wav'), 'remove');
  const cleanup = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'video-tool.js'), 'clean-cache', cleanupRoot, '--preserve-video'], { encoding: 'utf8', windowsHide: true });
  assert(cleanup.status === 0 && fs.existsSync(path.join(cleanupRoot, 'merged.mp4')) && !fs.existsSync(path.join(cleanupRoot, 'audio', 'audio.wav')), 'selective cache cleanup failed');

  requireLogin = true;
  const waitingSubmit = await manager.submit({ inputs: 'BV0987654321', collectionId: defaultCollection.id });
  await waitForJob(store, waitingSubmit.jobs[0].id, 'waiting-login');
  currentUser = { isLogin: true, name: '测试用户', mid: '1' };
  const resumed = await manager.resumeWaitingForLogin();
  assert(resumed.resumed === 1, 'waiting login job was not resumed');
  await waitForJob(store, waitingSubmit.jobs[0].id, 'completed');
  assert(store.getCollectionById(defaultCollection.id).cookieFile === cookieFile, 'cache collection did not retain the exported login cookie');

  const waitingRecord = store.getVideoCache(`cache:${defaultCollection.id}:BV0987654321`);
  fs.rmSync(waitingRecord.coverFile, { force: true });
  store.upsertVideoCache({ ...waitingRecord, cover: '' });
  assert(manager.state().videos.find((item) => item.id === waitingRecord.id)?.cover === 'https://i0.hdslb.com/test.jpg', 'existing cache record did not fall back to its task cover over HTTPS');

  fs.rmSync(firstRecord.videoFile, { force: true });
  assert(manager.state().videos.find((item) => item.id === firstRecord.id)?.fileExists === false, 'missing cache file was not detected');
  const completedMarkdown = path.join(firstRecord.artifactDir, 'completed-summary.md');
  fs.writeFileSync(completedMarkdown, '# completed summary');
  store.upsertTask({ ...store.getTask(firstRecord.taskId), status: 'done', outputMarkdown: completedMarkdown, completedAt: new Date().toISOString() });
  const deletedCompleted = manager.deleteVideos([firstRecord.id]);
  assert(!store.getVideoCache(firstRecord.id) && store.getTask(firstRecord.taskId)?.status === 'done' && fs.existsSync(completedMarkdown), 'cache video deletion removed an accepted Markdown document');
  assert(deletedCompleted.preservedDocuments.includes(firstRecord.taskId) && !store.getTask(firstRecord.taskId)?.cachedVideoId, 'preserved document retained a stale cache reference');

  store.createToolRun({ id: 'skipped-cache-run', taskId: 'missing-task', status: 'skipped', error: 'video unavailable', errorCode: 'BILIBILI_VIDEO_UNAVAILABLE', createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
  let skippedTerminated = false;
  try { await manager.waitForRun('skipped-cache-run'); } catch (error) { skippedTerminated = error.code === 'BILIBILI_VIDEO_UNAVAILABLE'; }
  assert(skippedTerminated, 'skipped unavailable-video run did not terminate cache queue polling');

  let protectedRejected = false;
  try { manager.deleteCollection(defaultCollection.id); } catch { protectedRejected = true; }
  assert(protectedRejected, 'protected default cache collection was deletable');
  let externalFetches = 0;
  try { await resolveBvid('https://example.com/video?bilibili=1', async () => { externalFetches += 1; }); } catch { /* expected */ }
  assert(externalFetches === 0, 'non-Bilibili URL reached the network layer');
  const temporary = manager.createCollection('可删除缓存');
  manager.deleteCollection(temporary.id);
  assert(!store.getCollectionById(temporary.id) && store.getCollectionById(DEFAULT_CACHE_COLLECTION_ID), 'cache collection lifecycle failed');

  const partialCollection = manager.createCollection('partial-cleanup-test');
  const partialArtifact = path.join(partialCollection.cacheRoot, '[BV-BVPARTIAL01]');
  const partialTaskId = `cache-task:${partialCollection.id}:BVPARTIAL01`;
  fs.mkdirSync(partialArtifact, { recursive: true });
  fs.writeFileSync(path.join(partialArtifact, 'partial.mp4'), 'partial download');
  store.upsertTask({
    id: partialTaskId,
    collectionId: partialCollection.id,
    bvid: 'BVPARTIAL01',
    title: 'Partial download',
    status: 'pending',
    artifactDir: partialArtifact,
    allowedRoot: partialCollection.cacheRoot,
    enabled: false
  });
  store.upsertVideoCacheJob({
    id: 'partial-cache-job',
    collectionId: partialCollection.id,
    bvid: 'BVPARTIAL01',
    status: 'failed',
    outputRoot: partialCollection.cacheRoot,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  manager.deleteCollection(partialCollection.id);
  assert(!store.getCollectionById(partialCollection.id), 'failed-only cache collection was not deleted');
  assert(!store.getTask(partialTaskId) && !fs.existsSync(partialArtifact), 'deleting a cache collection left a failed task or partial download behind');

  manager.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
  console.log('video cache integration test passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

function waitForJob(store, id, wanted) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const job = store.getVideoCacheJob(id);
      if (job?.status === wanted) {
        clearInterval(timer);
        resolve(job);
      } else if (job && ['failed', 'completed'].includes(job.status) && job.status !== wanted) {
        clearInterval(timer);
        reject(new Error(`Unexpected cache job status: ${job.status} ${job.error || ''}`));
      } else if (Date.now() - started > 10000) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for cache job ${id}: ${wanted}`));
      }
    }, 25);
  });
}
