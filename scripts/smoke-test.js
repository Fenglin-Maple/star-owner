const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { initWorkspace, WORKSPACE_ROOT } = require('../src/core/workspace');
const { Store } = require('../src/core/store');
const { ToolRunner } = require('../src/core/tool-runner');
const { buildAnalytics } = require('../src/core/analytics');
const { ApiServer } = require('../src/core/api-server');
const { applySubmissionArtifactPlan, finalizeSubmissionArtifacts, recoverPendingSubmissionFinalizations, stageSubmissionFinalization } = require('../src/core/submission-artifacts');
const { videoArtifactName } = require('../src/core/workspace');
const { assessSubtitle } = require('../tools/video-tool');
const { validateSubmission } = require('../src/core/validation');
const { promoteMindMap } = require('../src/core/markdown');
const { DependencyManager } = require('../src/core/dependency-manager');
const { repairPortablePythonHome } = require('../src/core/portable-runtime');

(async () => {
  if (assessSubtitle([], 120).reason !== 'SUBTITLE_EMPTY') throw new Error('empty subtitle validation failed');
  if (assessSubtitle([{ from: 0, to: 9 }], 120).reason !== 'SUBTITLE_COVERAGE_TOO_LOW') throw new Error('subtitle coverage validation failed');
  if (assessSubtitle([{ from: 0, to: 60 }, { from: 60, to: 120 }, { from: 120, to: 300 }], 120).reason !== 'SUBTITLE_DURATION_MISMATCH') throw new Error('subtitle duration validation failed');
  if (!assessSubtitle([{ from: 0, to: 10 }, { from: 10, to: 20 }, { from: 20, to: 60 }], 120).valid) throw new Error('valid subtitle was rejected');
  const legacyMarkdown = '# Title\n\n## 小结\n\nSummary\n\n## 目录\n\nContents\n\n## 正文\n\nBody\n\n## 思维导图\n\n```mermaid\nmindmap\n  root((Test))\n```\n\n## 处理记录\n\nDone\n';
  const promotedMarkdown = promoteMindMap(legacyMarkdown);
  if (!(promotedMarkdown.indexOf('## 小结') < promotedMarkdown.indexOf('## 思维导图') && promotedMarkdown.indexOf('## 思维导图') < promotedMarkdown.indexOf('## 目录'))) throw new Error('legacy mind-map promotion failed');
  if (!promotedMarkdown.includes('## 正文\n\nBody') || !promotedMarkdown.includes('```mermaid\nmindmap')) throw new Error('mind-map promotion damaged Markdown sections');

  initWorkspace();
  const dbFile = path.join(WORKSPACE_ROOT, 'smoke-orchestrator.sqlite');
  fs.rmSync(dbFile, { force: true });
  fs.rmSync(`${dbFile}.bak`, { force: true });
  fs.rmSync(`${dbFile}.tmp`, { force: true });

  const store = await Store.open(dbFile);
  const dependencyRoot = path.join(WORKSPACE_ROOT, 'smoke-dependency-root');
  fs.rmSync(dependencyRoot, { recursive: true, force: true });
  fs.mkdirSync(dependencyRoot, { recursive: true });
  const portableFixture = path.join(dependencyRoot, 'portable-runtime');
  const portablePythonHome = path.join(portableFixture, 'runtime', 'python', 'cpython-test');
  const portableConfig = path.join(portableFixture, 'runtime', 'faster-whisper', 'pyvenv.cfg');
  const portablePython = path.join(portablePythonHome, process.platform === 'win32' ? 'python.exe' : 'bin/python');
  fs.mkdirSync(path.dirname(portablePython), { recursive: true });
  fs.mkdirSync(path.dirname(portableConfig), { recursive: true });
  fs.writeFileSync(portablePython, 'fixture');
  fs.writeFileSync(portableConfig, 'home = D:\\old-machine\\python\nversion_info = 3.12.13\n');
  const portableRepair = repairPortablePythonHome(portableFixture);
  if (!portableRepair.changed || !fs.readFileSync(portableConfig, 'utf8').includes(`home = ${portablePythonHome}`)) throw new Error('portable Python home repair failed');
  if (repairPortablePythonHome(portableFixture).changed) throw new Error('portable Python home repair was not idempotent');
  const dependencyManager = new DependencyManager({ store, projectRoot: dependencyRoot, version: '9.9.9' });
  const missingDependencies = dependencyManager.state();
  if (missingDependencies.ready || !missingDependencies.needsPrompt || !missingDependencies.missingRequired.includes('runtime-base') || !missingDependencies.missingRequired.includes('model-small') || !missingDependencies.missingRequired.includes('model-medium')) throw new Error('dependency availability detection failed');
  dependencyManager.acknowledgePrompt(false);
  if (dependencyManager.state().needsPrompt) throw new Error('dependency first-run acknowledgement failed');
  const originalDownloadNow = dependencyManager.downloadNow.bind(dependencyManager);
  let duplicateDownloadCalls = 0;
  dependencyManager.downloadNow = async (id) => { duplicateDownloadCalls += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return { id }; };
  const duplicateDownloads = [dependencyManager.download('model-small'), dependencyManager.download('model-small')];
  if (duplicateDownloads[0] !== duplicateDownloads[1]) throw new Error('duplicate dependency requests did not share one pending operation');
  await Promise.all(duplicateDownloads);
  if (duplicateDownloadCalls !== 1) throw new Error('duplicate dependency request downloaded the same package more than once');
  dependencyManager.downloadNow = originalDownloadNow;
  const originalFetch = global.fetch;
  const dependencyRequests = [];
  global.fetch = async (url) => {
    dependencyRequests.push(String(url));
    if (String(url).includes('/releases?per_page=10')) {
      return new Response(JSON.stringify([{ id: 998, tag_name: 'v9.9.8', assets: [{ name: 'Star-Owner-v9.9.8-model-small.zip', browser_download_url: 'https://example.test/model-small.zip', size: 123 }] }]), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 999, tag_name: 'v9.9.9', assets: [{ name: 'Star-Owner-v9.9.9-win-x64-core.zip', browser_download_url: 'https://example.test/core.zip', size: 456 }] }), { status: 200 });
  };
  try {
    const modelDefinition = dependencyManager.definitions().find((item) => item.id === 'model-small');
    const resolvedHistoricalModel = await dependencyManager.resolveReleaseAsset(modelDefinition);
    if (resolvedHistoricalModel.asset.name !== 'Star-Owner-v9.9.8-model-small.zip' || !dependencyRequests.some((url) => url.includes('/releases?per_page=10'))) throw new Error('dependency resolver did not fall back from a current code-only release to a recent model asset');
  } finally {
    global.fetch = originalFetch;
  }
  const runtimeDefinition = dependencyManager.definitions().find((item) => item.id === 'runtime-base');
  const archiveSource = path.join(dependencyRoot, 'archive-source');
  const portableRoot = path.join(archiveSource, 'Star-Owner-v0.3.0-win-x64-core');
  fs.mkdirSync(path.join(portableRoot, 'runtime', 'python', 'cpython-3.12.13-windows-x86_64-none'), { recursive: true });
  fs.mkdirSync(path.join(portableRoot, 'runtime', 'faster-whisper', 'Lib', 'site-packages', 'faster_whisper'), { recursive: true });
  fs.mkdirSync(path.join(portableRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(portableRoot, 'runtime', 'python', 'cpython-3.12.13-windows-x86_64-none', 'python.exe'), 'test runtime');
  fs.writeFileSync(path.join(portableRoot, 'runtime', 'faster-whisper', 'Lib', 'site-packages', 'faster_whisper', '__init__.py'), 'test runtime');
  fs.writeFileSync(path.join(portableRoot, 'src', 'must-not-extract.txt'), 'application source');
  const legacyArchive = path.join(dependencyRoot, 'legacy-core.zip');
  createArchive(legacyArchive, archiveSource, path.basename(portableRoot));
  let rejectedCoreAsRuntime = false;
  try { await dependencyManager.extractArchive(legacyArchive, runtimeDefinition, false); } catch { rejectedCoreAsRuntime = true; }
  if (!rejectedCoreAsRuntime) throw new Error('ordinary dependency extraction accepted non-runtime core paths');
  await dependencyManager.extractArchive(legacyArchive, runtimeDefinition, true);
  if (!fs.existsSync(path.join(dependencyRoot, runtimeDefinition.probes[0])) || !fs.existsSync(path.join(dependencyRoot, runtimeDefinition.probes[1]))) throw new Error('legacy core runtime fallback extraction failed');
  const interruptedTarget = path.join(dependencyRoot, 'runtime', 'models', 'small');
  const interruptedBackup = path.join(dependencyRoot, 'runtime', '.install-backup-model-small-test', 'runtime', 'models', 'small');
  const interruptedStaging = path.join(dependencyRoot, 'runtime', '.install-staging-model-small-test');
  fs.mkdirSync(interruptedTarget, { recursive: true });
  fs.mkdirSync(interruptedBackup, { recursive: true });
  fs.mkdirSync(interruptedStaging, { recursive: true });
  fs.writeFileSync(path.join(interruptedTarget, 'model.bin'), 'incomplete-new-model');
  fs.writeFileSync(path.join(interruptedBackup, 'model.bin'), 'known-good-old-model');
  fs.writeFileSync(path.join(dependencyRoot, 'runtime', '.install-transaction.json'), JSON.stringify({
    id: 'model-small',
    stagingRoot: interruptedStaging,
    backupRoot: path.join(dependencyRoot, 'runtime', '.install-backup-model-small-test'),
    entries: [{ target: interruptedTarget, backup: interruptedBackup, hadOriginal: true }]
  }));
  new DependencyManager({ store, projectRoot: dependencyRoot, version: '9.9.9' });
  if (fs.readFileSync(path.join(interruptedTarget, 'model.bin'), 'utf8') !== 'known-good-old-model' || fs.existsSync(path.join(dependencyRoot, 'runtime', '.install-transaction.json'))) {
    throw new Error('interrupted dependency installation did not roll back to the previous runtime');
  }
  const corruptJournal = path.join(dependencyRoot, 'runtime', '.install-transaction.json');
  fs.writeFileSync(corruptJournal, '{not valid json', 'utf8');
  const recoveredFromCorruption = new DependencyManager({ store, projectRoot: dependencyRoot, version: '9.9.9' });
  if (!recoveredFromCorruption.state().recovery?.warning || fs.existsSync(corruptJournal)) throw new Error('corrupt dependency recovery journal still blocked startup');
  if (!listCorruptJournals(dependencyRoot).length) throw new Error('corrupt dependency recovery journal was not quarantined');
  if (fs.existsSync(path.join(dependencyRoot, 'src', 'must-not-extract.txt'))) throw new Error('legacy core fallback extracted application files');
  const defaultFilenameMetadata = store.getFilenameMetadata();
  if (Object.values(defaultFilenameMetadata).some((enabled) => enabled !== true)) throw new Error('filename metadata defaults failed');
  store.setFilenameMetadata({ tags: false, title: false });
  if (store.getFilenameMetadata().tags !== false || store.getFilenameMetadata().title !== false || store.getFilenameMetadata().bvid !== true) throw new Error('filename metadata persistence failed');
  store.setFilenameMetadata(defaultFilenameMetadata);
  const artifactName = videoArtifactName({ bvid: 'BVTEST', title: 'Title', owner: 'UP', publishedAt: '2026-01-02T00:00:00Z', favoriteAddedAt: '2026-02-03T00:00:00Z', tags: ['AI', 'Code'] }, { name: 'Collection' });
  if (!artifactName.includes('[BV-BVTEST]') || !artifactName.includes('[\u53d1\u5e03\u65e5-20260102]') || !artifactName.includes('[\u6536\u85cf\u65e5-20260203]') || !artifactName.includes('[\u6807\u7b7e-AI+Code]')) throw new Error('artifact metadata naming failed');
  store.upsertUser({ id: 'u1', name: 'smoke-user', mid: '1' });
  store.upsertCollection({ id: 'c1', name: 'AIcode', userId: 'u1' });
  store.upsertTask({ id: 'c1:BVTEST', collectionId: 'c1', bvid: 'BVTEST', status: 'pending', createdAt: new Date().toISOString() });
  store.upsertTask({ id: 'c1:BVOLD', collectionId: 'c1', bvid: 'BVOLD', title: 'Old favorite', status: 'pending', favoriteAddedAt: '2025-01-01T00:00:00.000Z', createdAt: '2025-01-01T00:00:00.000Z' });
  store.upsertTask({ id: 'c1:BVNEW', collectionId: 'c1', bvid: 'BVNEW', title: 'New favorite', status: 'pending', favoriteAddedAt: '2999-01-01T00:00:00.000Z', createdAt: '2999-01-01T00:00:00.000Z' });
  store.commit();

  const task = store.getTask('c1:BVTEST');
  if (!task || task.status !== 'pending') throw new Error('store smoke failed');
  if (store.listTasks({ collectionId: 'c1' })[0]?.id !== 'c1:BVNEW') throw new Error('favorite-date task sorting failed');
  store.updateTasksEnabled(['c1:BVOLD'], false);
  if (store.getTask('c1:BVOLD')?.enabled !== false) throw new Error('task enable state failed');

  const defaultWorkspace = store.getDefaultWorkspace();
  if (!defaultWorkspace?.isDefault) throw new Error('default workspace initialization failed');
  const extraRoot = path.join(WORKSPACE_ROOT, 'smoke-library');
  const extraWorkspace = store.addWorkspace({ name: 'Smoke library', root: extraRoot });
  store.setDefaultWorkspace(extraWorkspace.id);
  if (store.getDefaultWorkspace()?.id !== extraWorkspace.id) throw new Error('workspace selection failed');

  store.upsertCollection({ id: 'c2', name: 'Claim smoke', userId: 'u1', userName: 'smoke-user', cookieFile: path.join(WORKSPACE_ROOT, 'private-cookie.txt') });
  store.upsertTask({ id: 'c2:BVDISABLED', collectionId: 'c2', bvid: 'BVDISABLED', title: 'Disabled', status: 'pending', enabled: false, favoriteAddedAt: '2999-01-01T00:00:00.000Z' });
  store.upsertTask({ id: 'c2:BVENABLED', collectionId: 'c2', bvid: 'BVENABLED', title: 'Enabled', status: 'pending', enabled: true, favoriteAddedAt: '2025-01-01T00:00:00.000Z', cookieFile: path.join(WORKSPACE_ROOT, 'private-task-cookie.txt') });
  store.commit();
  store.setActiveCollection('c2');
  if (store.getActiveCollection()?.id !== 'c2') throw new Error('active collection persistence failed');
  const healthRunner = new ToolRunner({ store });
  if (healthRunner.config.asrModel !== 'medium') throw new Error('medium ASR model must be the default');
  const canonicalArgs = healthRunner.buildArgs({
    task: { bvid: 'BVTEST', url: 'bilibili://video/123' },
    action: 'info',
    collection: {},
    artifactDir: WORKSPACE_ROOT,
    options: {}
  });
  if (!canonicalArgs.includes('BVTEST') || canonicalArgs.includes('bilibili://video/123')) throw new Error('tool target must prefer bvid over app-deep-link URL');
  const toolHealth = await healthRunner.probeTools(store.listTools());
  if (toolHealth.length !== store.listTools().length || toolHealth.some((item) => !item.responded)) throw new Error('tool interface health probe failed');
  const api = new ApiServer({ store, bili: {}, toolRunner: healthRunner, getCurrentUser: () => null, getToolHealth: () => toolHealth });
  await api.start(0);
  const registerResponse = await fetch(`${api.url()}/api/workers/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'codex', model: 'smoke-model', sessionLabel: 'smoke' })
  });
  const registration = await registerResponse.json();
  if (!registerResponse.ok || !registration.workerId) throw new Error('worker registration failed');
  const manifestResponse = await fetch(`${api.url()}/api/manifest?workerId=${registration.workerId}`);
  const manifest = await manifestResponse.json();
  if (!manifestResponse.ok || manifest.worker?.workerId !== registration.workerId || !manifest.endpoints?.length) throw new Error('API manifest failed');
  if (manifest.protocolVersion !== '2.8' || manifest.activeCollection?.cookieFile) throw new Error('API manifest exposed a cookie path or stale protocol contract');
  const collectionsResponse = await fetch(`${api.url()}/api/collections`);
  const collectionsPayload = await collectionsResponse.json();
  if (!collectionsResponse.ok || collectionsPayload.collections.some((item) => Object.prototype.hasOwnProperty.call(item, 'cookieFile'))) throw new Error('collection API exposed a cookie path');
  const tasksResponse = await fetch(`${api.url()}/api/tasks?collectionId=c2`);
  const tasksPayload = await tasksResponse.json();
  if (!tasksResponse.ok || tasksPayload.tasks.some((item) => Object.prototype.hasOwnProperty.call(item, 'cookieFile'))) throw new Error('task list API exposed a cookie path');
  const templateResponse = await fetch(`${api.url()}/api/templates/video-summary`);
  const template = await templateResponse.json();
  if (!templateResponse.ok || !template.template?.includes('## 字幕比对')) throw new Error('Markdown template API failed');
  const summaryPosition = template.template.indexOf('## 小结');
  const mindMapPosition = template.template.indexOf('## 思维导图');
  const contentsPosition = template.template.indexOf('## 目录');
  if (!(summaryPosition >= 0 && mindMapPosition > summaryPosition && contentsPosition > mindMapPosition)) throw new Error('Markdown opening order failed');
  const healthResponse = await fetch(`${api.url()}/api/tool-health`);
  const healthPayload = await healthResponse.json();
  if (!healthResponse.ok || healthPayload.tools?.length !== toolHealth.length) throw new Error('tool health API failed');
  const activeResponse = await fetch(`${api.url()}/api/active-collection`);
  const active = await activeResponse.json();
  if (!activeResponse.ok || active.collection?.id !== 'c2') throw new Error('active collection API failed');
  store.upsertCollection({ id: 'c-sync-guard', mediaId: 'sync-guard', name: 'Sync guard', userId: 'u1', userName: 'smoke-user', syncReady: false, syncState: 'needs-sync', externalDispatchPaused: true });
  store.setActiveCollection('c-sync-guard');
  const unsyncedClaimResponse = await fetch(`${api.url()}/api/tasks/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workerId: registration.workerId })
  });
  const unsyncedClaim = await unsyncedClaimResponse.json();
  if (unsyncedClaimResponse.status !== 423 || unsyncedClaim.code !== 'COLLECTION_NOT_READY') throw new Error('external Agent bypassed an unsynchronized Bilibili collection');
  store.upsertCollection({ ...store.getCollectionById('c-sync-guard'), syncReady: true, syncState: 'ready', lastSyncedAt: new Date().toISOString(), externalDispatchPaused: true });
  const syncPausedClaimResponse = await fetch(`${api.url()}/api/tasks/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workerId: registration.workerId })
  });
  const syncPausedClaim = await syncPausedClaimResponse.json();
  if (syncPausedClaimResponse.status !== 423 || syncPausedClaim.code !== 'COLLECTION_REACTIVATION_REQUIRED') throw new Error('external Agent bypassed post-sync manual reactivation');
  store.set('removedFavoriteTasks', 'c-sync-guard:BVREMOVED', { id: 'c-sync-guard:BVREMOVED', taskId: 'c-sync-guard:BVREMOVED', bvid: 'BVREMOVED', removedAt: new Date().toISOString() });
  store.commit();
  const removedTaskResponse = await fetch(`${api.url()}/api/tasks/${encodeURIComponent('c-sync-guard:BVREMOVED')}`);
  const removedTask = await removedTaskResponse.json();
  if (removedTaskResponse.status !== 410 || removedTask.code !== 'REMOVED_FROM_FAVORITES') throw new Error('removed favorite did not invalidate the old external work context');
  store.setActiveCollection('c2');
  const claimResponse = await fetch(`${api.url()}/api/tasks/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workerId: registration.workerId })
  });
  const claim = await claimResponse.json();
  if (!claimResponse.ok || claim.task?.bvid !== 'BVENABLED') throw new Error('disabled task was claimable');
  if (Object.prototype.hasOwnProperty.call(claim.task, 'cookieFile')) throw new Error('claimed task exposed a cookie path');
  if (!claim.task.workId?.startsWith('work-')) throw new Error('claim did not return a one-time workId');
  if (!claim.task.abortUsage || !claim.task.requirements?.interruption?.includes('/abort')) throw new Error('claim context omitted attempt-abort instructions');
  const firstWorkId = claim.task.workId;
  const unauthenticatedTaskResponse = await fetch(`${api.url()}/api/tasks/${encodeURIComponent(claim.task.id)}`);
  if (unauthenticatedTaskResponse.status !== 401) throw new Error('active task details were readable without workerId/workId credentials');
  const publicTasks = await (await fetch(`${api.url()}/api/tasks`)).json();
  const publicClaimedTask = publicTasks.tasks.find((item) => item.id === claim.task.id);
  if (publicClaimedTask?.workId || publicClaimedTask?.artifactDir || publicClaimedTask?.workspaceRoot || publicClaimedTask?.cookieFile) {
    throw new Error('public task inventory exposed work credentials or local paths');
  }
  store.createToolRun({
    id: 'conflicting-active-run',
    taskId: claim.task.id,
    collectionId: claim.task.collectionId,
    toolId: 'material-bundle',
    toolName: '素材流水线',
    workerId: registration.workerId,
    workId: firstWorkId,
    status: 'running',
    artifactDir: claim.task.artifactDir,
    createdAt: new Date().toISOString()
  });
  const conflictingToolResponse = await fetch(`${api.url()}/api/tasks/${encodeURIComponent(claim.task.id)}/tools/bili-subtitles/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workerId: registration.workerId, workId: firstWorkId })
  });
  const conflictingTool = await conflictingToolResponse.json();
  if (conflictingToolResponse.status !== 409 || conflictingTool.code !== 'TOOL_RUN_ALREADY_ACTIVE' || conflictingTool.activeRuns?.[0]?.id !== 'conflicting-active-run') {
    throw new Error('a second tool was allowed to write the same active work-attempt directory');
  }
  if (!conflictingTool.directive?.path?.includes(`workerId=${encodeURIComponent(registration.workerId)}`)
    || !conflictingTool.directive?.path?.includes(`workId=${encodeURIComponent(firstWorkId)}`)) {
    throw new Error('duplicate tool guidance omitted the credentials required by its polling endpoint');
  }
  store.updateToolRun('conflicting-active-run', { status: 'cancelled', finishedAt: new Date().toISOString() });
  const missingWorkIdResponse = await fetch(`${api.url()}/api/tasks/${encodeURIComponent(claim.task.id)}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workerId: registration.workerId })
  });
  const missingWorkId = await missingWorkIdResponse.json();
  if (missingWorkIdResponse.status !== 400 || missingWorkId.code !== 'WORK_ID_REQUIRED') throw new Error('task API accepted a missing workId');
  const abortArtifactDir = claim.task.artifactDir;
  fs.writeFileSync(path.join(abortArtifactDir, 'partial.md'), '# interrupted');
  store.createToolRun({
    id: 'abort-run',
    taskId: claim.task.id,
    collectionId: claim.task.collectionId,
    toolId: 'material-bundle',
    toolName: '素材流水线',
    workerId: registration.workerId,
    workId: firstWorkId,
    status: 'queued',
    artifactDir: abortArtifactDir,
    createdAt: new Date().toISOString()
  });
  const abortResponse = await fetch(`${api.url()}/api/tasks/${encodeURIComponent(claim.task.id)}/abort`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workerId: registration.workerId, workId: firstWorkId, reason: 'smoke interruption' })
  });
  const aborted = await abortResponse.json();
  if (!abortResponse.ok || !aborted.aborted || aborted.task?.status !== 'pending') throw new Error('task abort API failed');
  if (aborted.endedWorkId !== firstWorkId || aborted.task?.workId) throw new Error('task abort did not invalidate workId');
  if (fs.existsSync(abortArtifactDir) || store.getToolRun('abort-run')?.status !== 'cancelled') throw new Error('task abort API left attempt files or active runs behind');
  const staleHeartbeatResponse = await fetch(`${api.url()}/api/tasks/${encodeURIComponent(claim.task.id)}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workerId: registration.workerId, workId: firstWorkId })
  });
  const staleHeartbeat = await staleHeartbeatResponse.json();
  if (staleHeartbeatResponse.status !== 409 || staleHeartbeat.code !== 'WORK_ATTEMPT_ENDED' || staleHeartbeat.directive?.action !== 'claim-new-task' || staleHeartbeat.directive?.keepWorkerId !== true) throw new Error('stale workId did not receive claim-new-task guidance');
  const unauthenticatedRunResponse = await fetch(`${api.url()}/api/tool-runs/abort-run?log=1`);
  if (unauthenticatedRunResponse.status !== 401) throw new Error('tool run details and logs were readable without work credentials');
  const endedRunResponse = await fetch(`${api.url()}/api/tool-runs/abort-run?workerId=${encodeURIComponent(registration.workerId)}&workId=${encodeURIComponent(firstWorkId)}`);
  const endedRun = await endedRunResponse.json();
  if (endedRun.workAttempt?.active !== false || endedRun.workAttempt?.code !== 'WORK_ATTEMPT_ENDED') throw new Error('tool polling did not expose ended work attempt');
  const reclaimResponse = await fetch(`${api.url()}/api/tasks/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workerId: registration.workerId })
  });
  const reclaimed = await reclaimResponse.json();
  if (!reclaimResponse.ok || reclaimed.task?.id !== claim.task.id || !reclaimed.task.workId || reclaimed.task.workId === firstWorkId) throw new Error('reclaim did not issue a fresh workId');
  const supersededResponse = await fetch(`${api.url()}/api/tasks/${encodeURIComponent(reclaimed.task.id)}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workerId: registration.workerId, workId: firstWorkId })
  });
  const superseded = await supersededResponse.json();
  if (supersededResponse.status !== 409 || superseded.code !== 'WORK_ATTEMPT_ENDED') throw new Error('old workId became valid after the same task was reclaimed');
  const rejectedResponse = await fetch(`${api.url()}/api/tasks/${encodeURIComponent(reclaimed.task.id)}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workerId: registration.workerId, workId: reclaimed.task.workId, artifactDir: reclaimed.task.artifactDir, markdownFile: path.join(reclaimed.task.artifactDir, 'missing.md'), metadataFile: path.join(reclaimed.task.artifactDir, 'missing-info.json') })
  });
  if (rejectedResponse.status !== 422 || store.getTask(reclaimed.task.id)?.status !== 'rejected') throw new Error('invalid submission did not keep the active work attempt in rejected state');
  const rejectedClaimResponse = await fetch(`${api.url()}/api/tasks/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workerId: registration.workerId })
  });
  const rejectedClaim = await rejectedClaimResponse.json();
  if (rejectedClaimResponse.status !== 409 || rejectedClaim.code !== 'WORKER_ALREADY_HAS_TASK' || rejectedClaim.workId !== reclaimed.task.workId) {
    throw new Error('worker was not directed back to its rejected active work attempt');
  }
  if (!rejectedClaim.directive?.path?.includes(`workerId=${encodeURIComponent(registration.workerId)}`)
    || !rejectedClaim.directive?.path?.includes(`workId=${encodeURIComponent(reclaimed.task.workId)}`)) {
    throw new Error('existing-attempt guidance omitted the credentials required to reopen the task');
  }
  const rejectedStats = buildAnalytics(store);
  const rejectedWorkerStats = rejectedStats.workers.find((item) => item.workerId === registration.workerId);
  if (rejectedWorkerStats?.activeTasks !== 1 || rejectedStats.collections.c2?.claimed !== 1 || rejectedStats.collections.c2?.failed !== 0) {
    throw new Error('active rejected work attempt was reported as inactive or terminally failed');
  }
  store.set('unavailableTasks', 'missing-unavailable-task', { id: 'missing-unavailable-task', taskId: 'missing-unavailable-task', collectionId: 'c1', bvid: 'BVUNAVAILABLE1', title: 'Removed video', reason: 'Uploader removed this video.', source: 'smoke', removedAt: new Date().toISOString() });
  store.commit();
  const unavailableResponse = await fetch(`${api.url()}/api/tasks/missing-unavailable-task`);
  const unavailablePayload = await unavailableResponse.json();
  if (unavailableResponse.status !== 410 || unavailablePayload.unavailable?.reason !== 'Uploader removed this video.' || unavailablePayload.directive?.action !== 'stop') {
    throw new Error('unavailable-task API response dropped tombstone details');
  }
  const secondAbortResponse = await fetch(`${api.url()}/api/tasks/${encodeURIComponent(reclaimed.task.id)}/abort`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workerId: registration.workerId, workId: reclaimed.task.workId, reason: 'finish smoke cleanup' })
  });
  if (!secondAbortResponse.ok) throw new Error('second work attempt cleanup failed');
  const pausedWorker = store.updateWorker(registration.workerId, { status: 'paused', pauseReason: 'smoke pause' });
  if (pausedWorker.status !== 'paused') throw new Error('worker pause failed');
  const pausedClaimResponse = await fetch(`${api.url()}/api/tasks/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workerId: registration.workerId })
  });
  const pausedClaim = await pausedClaimResponse.json();
  api.stop();
  if (pausedClaimResponse.status !== 423 || !pausedClaim.userMessage.startsWith('来自用户的信息，你需要暂停工作') || pausedClaim.directive?.action !== 'stop-and-report' || pausedClaim.directive?.reason !== 'smoke pause') throw new Error('paused worker allocation guard failed');

  store.setDefaultWorkspace(defaultWorkspace.id);
  store.removeWorkspace(extraWorkspace.id);

  store.recordTaskEvent('c1:BVTEST', 'claimed', { workerId: registration.workerId });
  store.recordTaskEvent('c1:BVTEST', 'completed', { workerId: registration.workerId, processingSeconds: 60, videoDuration: 120 });
  store.recordTaskEvent('removed-history', 'claimed', { collectionId: 'c1', workerId: 'historical-worker' });
  store.recordTaskEvent('removed-history', 'completed', { collectionId: 'c1', workerId: 'historical-worker', processingSeconds: 30, videoDuration: 60 });
  const stats = buildAnalytics(store).collections.c1;
  const registeredStats = stats.agents.find((item) => item.workerId === registration.workerId);
  if (registeredStats?.weightedTimeRatio !== 0.5) throw new Error('per-worker weighted analytics failed');
  if (!stats.agents.some((item) => item.workerId === 'historical-worker' && item.completed === 1 && item.weightedTimeRatio === 0.5)) throw new Error('removed task history disappeared from collection analytics');

  const tools = store.listTools();
  if (!tools.some((tool) => tool.id === 'asr' && tool.enabled)) throw new Error('tool registry smoke failed');
  store.createToolRun({
    id: 'run1',
    taskId: 'c1:BVTEST',
    toolId: 'video-info',
    status: 'running',
    createdAt: new Date().toISOString()
  });
  store.updateToolRun('run1', { status: 'succeeded', exitCode: 0 });
  if (store.getToolRun('run1')?.status !== 'succeeded') throw new Error('tool run smoke failed');

  const artifactDir = path.join(WORKSPACE_ROOT, 'smoke-artifact');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'cache.mp4'), 'temporary media');
  fs.writeFileSync(path.join(artifactDir, 'summary.md'), '# keep');
  const namingRoot = path.join(WORKSPACE_ROOT, 'smoke-naming-root');
  const namingDraft = path.join(namingRoot, 'draft');
  fs.mkdirSync(path.join(namingDraft, 'frames'), { recursive: true });
  fs.writeFileSync(path.join(namingDraft, 'draft.md'), '# summary');
  fs.writeFileSync(path.join(namingDraft, 'info.json'), JSON.stringify({ tags: ['AI'] }));
  fs.writeFileSync(path.join(namingDraft, 'frames', 'frame.jpg'), 'frame');
  const finalized = finalizeSubmissionArtifacts({
    task: { bvid: 'BVFINAL', title: 'Final title', owner: 'UP', publishedAt: '2026-01-02T00:00:00Z', favoriteAddedAt: '2026-02-03T00:00:00Z', tags: ['AI'], allowedRoot: namingRoot },
    collection: { name: 'Collection' },
    validation: { artifactDir: namingDraft, markdownFile: path.join(namingDraft, 'draft.md'), metadataFile: path.join(namingDraft, 'info.json') },
    filenameMetadata: defaultFilenameMetadata
  });
  if (!fs.existsSync(finalized.markdownFile) || !fs.existsSync(finalized.metadataFile) || !fs.existsSync(path.join(finalized.artifactDir, 'frames', 'frame.jpg'))) throw new Error('artifact finalization lost files');
  if (path.basename(finalized.markdownFile, '.md') !== path.basename(finalized.artifactDir)) throw new Error('artifact directory and Markdown names diverged');
  const crashRoot = path.join(WORKSPACE_ROOT, 'smoke-finalization-recovery');
  const crashDraft = path.join(crashRoot, 'draft');
  fs.mkdirSync(crashDraft, { recursive: true });
  const crashMarkdown = path.join(crashDraft, 'draft.md');
  const crashMetadata = path.join(crashDraft, 'info.json');
  fs.writeFileSync(crashMarkdown, '# recoverable completion');
  fs.writeFileSync(crashMetadata, '{}');
  const crashTask = { id: 'crash-final-task', collectionId: 'c1', bvid: 'BVCRASH00001', title: 'Crash recovery', owner: 'UP', status: 'claimed', workId: 'work-crash-final', claimedBy: registration.workerId, claimedAt: new Date().toISOString(), allowedRoot: crashRoot, artifactDir: crashDraft };
  store.upsertTask(crashTask);
  store.commit();
  const crashTime = new Date().toISOString();
  const stagedFinalization = stageSubmissionFinalization({
    store,
    task: crashTask,
    collection: { id: 'c1', name: 'Collection' },
    validation: { artifactDir: crashDraft, markdownFile: crashMarkdown, metadataFile: crashMetadata },
    filenameMetadata: defaultFilenameMetadata,
    completedTask: { ...crashTask, status: 'done', workId: '', completedAt: crashTime, updatedAt: crashTime },
    event: { id: 'submission-completed:work-crash-final', taskId: crashTask.id, type: 'completed', createdAt: crashTime, collectionId: 'c1', workerId: registration.workerId, workId: 'work-crash-final' }
  });
  applySubmissionArtifactPlan(stagedFinalization.plan);
  if (!store.get('submissionFinalizations', stagedFinalization.id) || store.getTask(crashTask.id)?.status !== 'claimed') throw new Error('submission recovery fixture did not preserve the crash window');
  const recoveredFinalizations = recoverPendingSubmissionFinalizations(store);
  const recoveredTask = store.getTask(crashTask.id);
  if (!recoveredFinalizations[0]?.ok || recoveredTask?.status !== 'done' || !fs.existsSync(recoveredTask.outputMarkdown) || store.get('submissionFinalizations', stagedFinalization.id)) {
    throw new Error('crash-safe submission finalization did not recover file and database state');
  }
  const validationRoot = path.join(WORKSPACE_ROOT, 'smoke-validation-root');
  fs.mkdirSync(validationRoot, { recursive: true });
  const metadataFile = path.join(validationRoot, 'info.json');
  const validMarkdown = path.join(validationRoot, 'valid.md');
  const invalidMarkdown = path.join(validationRoot, 'invalid.md');
  const opening = '## 小结\n\nSummary\n\n## 思维导图\n\n```mermaid\nmindmap\n  root((Test))\n```\n\n## 目录\n\n- Contents\n\n## 正文\n\n### Test [00:01](https://www.bilibili.com/video/BV1234567890?t=1)\n\n## 字幕比对\n\nASR 选择说明\n\n## 评论分析\n\nNone\n\n## 处理记录\n\nDone\n';
  fs.mkdirSync(path.join(validationRoot, 'asr'), { recursive: true });
  fs.writeFileSync(path.join(validationRoot, 'asr', 'transcript.srt'), '1\n00:00:01,000 --> 00:00:02,000\nTest sentence.\n');
  fs.writeFileSync(path.join(validationRoot, 'asr', 'asr-transcript.txt'), '[00:00:01,000 --> 00:00:02,000] Test sentence.\n');
  fs.writeFileSync(path.join(validationRoot, 'asr', 'asr-result.json'), JSON.stringify({ segments: [{ id: 0, start: 1, end: 2, text: 'Test sentence.' }] }));
  fs.writeFileSync(metadataFile, '{}');
  fs.writeFileSync(validMarkdown, opening);
  fs.writeFileSync(invalidMarkdown, opening.replace('## 思维导图\n\n```mermaid\nmindmap\n  root((Test))\n```\n\n## 目录', '## 目录\n\n## 思维导图\n\nNo diagram'));
  const validationTask = { allowedRoot: validationRoot, artifactDir: validationRoot };
  if (!validateSubmission(validationTask, { artifactDir: validationRoot, markdownFile: validMarkdown, metadataFile }).ok) throw new Error('valid Mermaid opening was rejected');
  if (validateSubmission(validationTask, { artifactDir: validationRoot, markdownFile: invalidMarkdown, metadataFile }).ok) throw new Error('invalid Mermaid opening was accepted');
  const recoveryArtifactDir = path.join(WORKSPACE_ROOT, 'smoke-recovery-artifact');
  fs.mkdirSync(recoveryArtifactDir, { recursive: true });
  fs.writeFileSync(path.join(recoveryArtifactDir, 'recover.mp4'), 'recover me');
  store.createToolRun({
    id: 'recovery-run',
    taskId: 'c1:BVTEST',
    collectionId: 'c1',
    toolId: 'clean-cache',
    toolName: '清理视频缓存',
    action: 'clean-cache',
    workerId: registration.workerId,
    status: 'queued',
    artifactDir: recoveryArtifactDir,
    logFile: path.join(recoveryArtifactDir, 'recovery.log'),
    options: {},
    timeoutMs: 60000,
    createdAt: new Date().toISOString()
  });
  const runner = new ToolRunner({ store });
  await runner.initialize({ startGpuService: false });
  if (runner.getState().config.cpuAsrEnabled !== false || runner.getState().services.cpu.state !== 'stopped') {
    throw new Error('CPU ASR must remain disabled and unloaded by default');
  }
  await waitForRun(store, 'recovery-run');
  if (store.getToolRun('recovery-run')?.status !== 'succeeded' || fs.existsSync(path.join(recoveryArtifactDir, 'recover.mp4'))) {
    throw new Error('persisted queued run recovery failed');
  }
  const cleanTool = store.get('tools', 'clean-cache');
  const run = runner.start({
    task: {
      id: 'c1:BVTEST',
      bvid: 'BVTEST',
      status: 'claimed',
      allowedRoot: WORKSPACE_ROOT,
      artifactDir
    },
    tool: cleanTool,
    collection: {},
    workerId: registration.workerId
  });
  await waitForRun(store, run.id);
  if (store.getToolRun(run.id)?.status !== 'succeeded') throw new Error('tool runner execution smoke failed');
  if (fs.existsSync(path.join(artifactDir, 'cache.mp4'))) throw new Error('clean-cache did not remove media cache');
  if (!fs.existsSync(path.join(artifactDir, 'summary.md'))) throw new Error('clean-cache removed non-cache artifact');
  runner.shutdown();

  fs.rmSync(artifactDir, { recursive: true, force: true });
  fs.rmSync(namingRoot, { recursive: true, force: true });
  fs.rmSync(validationRoot, { recursive: true, force: true });
  fs.rmSync(recoveryArtifactDir, { recursive: true, force: true });
  fs.rmSync(extraRoot, { recursive: true, force: true });
  fs.rmSync(dependencyRoot, { recursive: true, force: true });
  store.db.close();
  fs.rmSync(dbFile, { force: true });
  console.log('smoke ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

function waitForRun(store, runId) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const run = store.getToolRun(runId);
      if (run && ['succeeded', 'failed', 'cancelled', 'timeout'].includes(run.status)) {
        clearInterval(timer);
        resolve(run);
      } else if (Date.now() - started > 10000) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for tool run: ${runId}`));
      }
    }, 100);
  });
}

function createArchive(archive, sourceRoot, item) {
  const result = spawnSync('tar.exe', ['-a', '-c', '-f', archive, '-C', sourceRoot, item], { windowsHide: true, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not create dependency fixture: ${result.stderr || result.stdout}`);
}

function listCorruptJournals(root) {
  const runtime = path.join(root, 'runtime');
  return fs.existsSync(runtime) ? fs.readdirSync(runtime).filter((name) => name.startsWith('.install-transaction.corrupt-')) : [];
}
