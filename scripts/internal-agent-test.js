const fs = require('fs');
const path = require('path');
const { Store } = require('../src/core/store');
const { InternalAgentManager, normalizeGeneratedMarkdown, planGenerationRequest, splitTextByTokenBudget } = require('../src/core/internal-agent-manager');
const { isLoginRequiredMessage, isVideoUnavailableMessage } = require('../src/core/media-errors');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const normalized = normalizeGeneratedMarkdown('# Test\n\n## 小结\n\nSummary\n\n## 目录\n\n- Body\n\n## 正文\n\nContent\n\n## 处理记录\n\nDone', { bvid: 'BVTEST', title: 'Test video' }, { comments: [] });
  assert(normalized.indexOf('## 小结') < normalized.indexOf('## 思维导图') && normalized.indexOf('## 思维导图') < normalized.indexOf('## 目录'), 'generated Markdown opening was not normalized');
  assert(normalized.includes('```mermaid\nmindmap') && normalized.includes('## 评论分析'), 'generated Markdown required sections were not repaired');
  const oversizedPlan = planGenerationRequest({
    session: { workerId: 'worker-budget', modelId: 'small-context', taskRequirements: '保留事实。' },
    task: { bvid: 'BVBUDGET0001', title: '超长素材', owner: '测试 UP', duration: 7200 },
    collection: { name: '预算测试' },
    materials: { info: { title: '超长素材' }, manifest: {}, station: '站内字幕。'.repeat(30000), asr: '语音识别字幕。'.repeat(30000), comments: [], frames: [] },
    template: '# 模板\n'.repeat(8000),
    model: { contextWindow: 24000, maxOutputTokens: 8192, supportsVision: false },
    provider: { maxOutputTokens: 8192 }
  });
  assert(oversizedPlan.requiresSemanticCompaction && oversizedPlan.contextPercent > 82, 'oversized video material did not activate semantic context fallback');
  const completeTranscript = `${'[00:00] 第一段字幕。'.repeat(4000)}\n${'[10:00] second segment with code foo();'.repeat(3000)}`;
  const transcriptChunks = splitTextByTokenBudget(completeTranscript, 1800);
  assert(transcriptChunks.length > 2 && transcriptChunks.join('') === completeTranscript, 'semantic compactor chunking dropped or reordered transcript text');
  const root = path.join(__dirname, '..', '.cache', 'internal-agent-test');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const store = await Store.open(path.join(root, 'test.sqlite'));
  const workspace = store.addWorkspace({ name: 'Agent test', root: path.join(root, 'workspace') });
  store.setDefaultWorkspace(workspace.id);
  store.set('ragProviders', 'provider-test', {
    id: 'provider-test', name: 'Test provider', type: 'openai', baseUrl: 'http://127.0.0.1:1/v1',
    enabledModels: [{ id: 'model-test', name: 'model-test', contextWindow: 128000, supportsTools: true, supportsVision: false }],
    remoteModels: [], temperature: 0, maxOutputTokens: 8192
  });
  store.save();

  const completionBodies = [];
  let forceContextLimitOnce = false;
  const rag = {
    listProviders: () => [{ id: 'provider-test', name: 'Test provider', type: 'openai', baseUrl: 'http://127.0.0.1:1/v1', enabledModels: [{ id: 'model-test', name: 'model-test' }] }],
    rawProvider: () => store.get('ragProviders', 'provider-test'),
    sessionModel: () => ({ id: 'model-test', contextWindow: 128000, maxOutputTokens: 8192, supportsVision: false }),
    streamCompletion: async (_provider, body, _signal, onDelta) => {
      completionBodies.push(body);
      if (forceContextLimitOnce) {
        forceContextLimitOnce = false;
        throw new Error('maximum context length exceeded');
      }
      const bvid = body.messages?.at(-1)?.content?.match(/"bvid"\s*:\s*"([^"]+)"/)?.[1] || 'BV1234567890';
      const markdown = validMarkdown(bvid);
      onDelta({ reasoning: '先核对字幕和关键帧。' });
      onDelta({ content: markdown });
      return { content: markdown, reasoning: '先核对字幕和关键帧。', usage: { input: 120, output: 240, total: 360 } };
    },
    recordModelUsage: () => ({})
  };

  let forceLoginFailure = false;
  let forceInfrastructureFailure = false;
  let forceUnavailableFailure = false;
  let holdToolRuns = false;
  let infrastructureArtifactDir = '';
  const toolRunner = {
    start: ({ task, tool, workerId, collection: runCollection }) => {
      const id = `run-${tool.id}-${Date.now()}`;
      const loginBlocked = forceLoginFailure && tool.id === 'material-bundle' && !runCollection?.cookieFile;
      const infrastructureBlocked = forceInfrastructureFailure && tool.id === 'material-bundle';
      const unavailable = forceUnavailableFailure && tool.id === 'material-bundle';
      if (tool.id === 'material-bundle' && !loginBlocked && !unavailable) writeMaterials(task.artifactDir);
      if (infrastructureBlocked) infrastructureArtifactDir = task.artifactDir;
      const waiting = holdToolRuns && tool.id === 'material-bundle';
      store.createToolRun({ id, taskId: task.id, collectionId: task.collectionId, toolId: tool.id, toolName: tool.name, workerId, status: waiting ? 'running' : (loginBlocked || infrastructureBlocked || unavailable ? 'failed' : 'succeeded'), stage: waiting ? 'test-hold' : (loginBlocked || infrastructureBlocked || unavailable ? 'error' : 'complete'), error: loginBlocked ? 'This video is only available for registered users. Use --cookies.' : (infrastructureBlocked ? 'GPU ASR 常驻服务连续 3 次启动失败，应用已停止相关 Agent。' : (unavailable ? 'Bilibili 视频已删除、下架或不可用：已失效视频' : '')), errorCode: infrastructureBlocked ? 'ASR_INFRASTRUCTURE_FAILURE' : (unavailable ? 'BILIBILI_VIDEO_UNAVAILABLE' : ''), failureKind: infrastructureBlocked ? 'infrastructure' : (unavailable ? 'terminal-video' : ''), possibleCauses: infrastructureBlocked ? ['CTranslate2 原生运行库访问冲突', '项目依赖损坏'] : [], createdAt: new Date().toISOString(), finishedAt: waiting ? '' : new Date().toISOString() });
      return store.getToolRun(id);
    },
    cancel: (runId) => {
      const run = store.getToolRun(runId);
      if (!run || ['succeeded', 'failed', 'cancelled', 'timeout'].includes(run.status)) return run;
      return store.updateToolRun(runId, { status: 'cancelled', stage: 'cancelled', finishedAt: new Date().toISOString() });
    }
  };

  const events = [];
  let currentUser = null;
  const cookieFixture = path.join(root, 'login-cookies.txt');
  const manager = new InternalAgentManager({ store, toolRunner, ragAssistant: rag, bili: { exportCookies: async () => { fs.writeFileSync(cookieFixture, 'cookie'); return cookieFixture; } }, getCurrentUser: () => currentUser, emit: (event) => events.push(event) });
  const collection = manager.listInternalCollections()[0];
  const tasksBeforeInvalidModel = store.listTasks().length;
  let invalidSingleModelRejected = false;
  try { await manager.createSingleTask({ video: 'BVINVALID001', collectionId: collection.id, providerId: 'provider-test', modelId: 'missing-model' }); }
  catch { invalidSingleModelRejected = true; }
  assert(invalidSingleModelRejected && store.listTasks().length === tasksBeforeInvalidModel, 'invalid single-video model configuration left an orphan task');
  const session = await manager.createSingleTask({
    video: 'https://www.bilibili.com/video/BV1234567890',
    collectionId: collection.id,
    providerId: 'provider-test',
    modelId: 'model-test',
    taskRequirements: '保留测试参数。',
    taskOptions: { frames: 8, commentLimit: 3 }
  });
  assert(store.getTask(session.singleTaskId)?.publicAttempt === true && !store.getTask(session.singleTaskId)?.cookieFile, 'single task must try public access first');
  await Promise.all([manager.start(session.id), manager.start(session.id)]);
  const finished = await waitForSession(manager, session.id);
  assert(finished.status === 'completed', `single session did not complete: ${finished.lastError || finished.status}`);
  assert(finished.completed === 1, 'completed count was not updated');
  assert(!finished.externalOutput && finished.lastOutput && fs.existsSync(finished.lastOutput), 'single task did not use its canonical internal artifact as the only output');
  const task = store.getTask(finished.singleTaskId);
  assert(task.status === 'done' && fs.existsSync(task.outputMarkdown), 'accepted internal document is missing');
  assert(task.outputMarkdown.includes('内置用户') || task.artifactDir.includes('内置用户'), 'internal collection artifact path is incorrect');
  assert(manager.collectionOutputDirectory(collection.id) === collection.collectionRoot, 'single-task collection output directory is incorrect');
  assert(manager.sessionOutputDirectory(finished.id) === task.artifactDir, 'completed session did not resolve its artifact directory');
  const duplicateInspection = await manager.inspectSingleTask({ video: task.bvid, collectionId: collection.id });
  assert(duplicateInspection.latestCompleted?.taskId === task.id, 'single-video duplicate inspection did not find the accepted document');
  let duplicateRejected = false;
  try { await manager.createSingleTask({ video: task.bvid, collectionId: collection.id, providerId: 'provider-test', modelId: 'model-test' }); }
  catch (error) { duplicateRejected = error.message.includes('已经存在'); }
  assert(duplicateRejected, 'single-video creation bypassed the completed-document decision');
  const regeneratedSession = await manager.createSingleTask({ video: task.bvid, collectionId: collection.id, providerId: 'provider-test', modelId: 'model-test', duplicateAction: 'regenerate' });
  await manager.start(regeneratedSession.id);
  const regenerated = await waitForSession(manager, regeneratedSession.id);
  const regeneratedTask = store.getTask(regenerated.singleTaskId);
  assert(regenerated.status === 'completed' && regeneratedTask.status === 'done', 'single-video regeneration did not complete');
  assert(regeneratedTask.revision === 2 && regeneratedTask.revisionOfTaskId === task.id && regeneratedTask.artifactDir !== task.artifactDir, 'single-video regeneration did not create a separate version');
  assert(store.getTask(task.id).knowledgeActive === false && regeneratedTask.knowledgeActive === true, 'RAG-active document version was not switched after regeneration acceptance');

  store.upsertTask({
    ...regeneratedTask,
    status: 'pending',
    outputMarkdown: '',
    artifactDir: '',
    completedAt: '',
    documentDeletedAt: new Date().toISOString()
  });
  store.commit();
  const tasksBeforeDeletedVersionReuse = store.listTasks({ collectionId: collection.id }).length;
  const reusedDeletedVersion = await manager.createSingleTask({
    video: task.bvid,
    collectionId: collection.id,
    providerId: 'provider-test',
    modelId: 'model-test',
    duplicateAction: 'regenerate'
  });
  assert(reusedDeletedVersion.singleTaskId === regeneratedTask.id && reusedDeletedVersion.reusedTask === true, 'a deleted latest version was not rebuilt in place');
  assert(store.listTasks({ collectionId: collection.id }).length === tasksBeforeDeletedVersionReuse, 'rebuilding a deleted latest version created an orphan task version');
  store.delete('tasks', regeneratedTask.id);
  store.delete('internalAgentSessions', reusedDeletedVersion.id);
  store.upsertTask({ ...task, knowledgeActive: true });
  store.commit();

  const pendingSession = await manager.createSingleTask({ video: 'BVREUSABLE01', collectionId: collection.id, providerId: 'provider-test', modelId: 'model-test' });
  const tasksBeforeReuse = store.listTasks({ collectionId: collection.id }).length;
  const reusedSession = await manager.createSingleTask({ video: 'BVREUSABLE01', collectionId: collection.id, providerId: 'provider-test', modelId: 'model-test' });
  assert(reusedSession.id === pendingSession.id && reusedSession.reusedTask === true && store.listTasks({ collectionId: collection.id }).length === tasksBeforeReuse, 'recoverable single-video task was duplicated instead of rebuilt in place');
  store.delete('tasks', pendingSession.singleTaskId);
  store.delete('internalAgentSessions', pendingSession.id);
  store.commit();
  const switchedWorkspace = store.addWorkspace({ name: 'Agent switched workspace', root: path.join(root, 'workspace-switched') });
  store.setDefaultWorkspace(switchedWorkspace.id);
  const switchedOutput = manager.collectionOutputDirectory(collection.id);
  assert(switchedOutput.startsWith(path.resolve(switchedWorkspace.root)), 'internal collection output did not follow the newly selected default workspace');
  store.setDefaultWorkspace(workspace.id);
  assert(store.getWorker(finished.workerId)?.tool === 'star-owner-internal', 'internal worker identity was not registered');
  assert(finished.contextCycle === 1 && finished.contextPercent > 0 && finished.contextCompactions === 0, 'ordinary single task unexpectedly used context fallback');
  assert(completionBodies[0]?.messages?.length === 2 && completionBodies[0].messages[0].role === 'system' && completionBodies[0].messages[1].role === 'user', 'video generation request unexpectedly carried prior task history');
  assert(completionBodies[0].messages[1].content.includes('00:00:02,000 --> 00:00:04,500') && completionBodies[0].messages[1].content.includes('00:00:01,000 --> 00:00:03,000'), 'internal Agent prompt did not receive sentence-level ASR and station subtitle timestamps');
  assert(events.some((event) => event.type === 'stream') && events.some((event) => event.type === 'session-updated'), 'internal agent events were not emitted');
  assert(isLoginRequiredMessage('This video is only available for registered users. Use --cookies.'), 'login-required classifier missed yt-dlp guidance');
  assert(!isLoginRequiredMessage('network timeout while downloading'), 'ordinary network failure was misclassified as login-required');
  assert(isVideoUnavailableMessage('ERROR: video is no longer available'), 'unavailable-video classifier missed yt-dlp output');
  assert(!isVideoUnavailableMessage('HTTP 429: too many requests'), 'temporary network failure was misclassified as unavailable');

  forceContextLimitOnce = true;
  const requestsBeforeRetry = completionBodies.length;
  const contextRetrySession = await manager.createSingleTask({ video: 'BVCONTEXT001', collectionId: collection.id, providerId: 'provider-test', modelId: 'model-test' });
  await manager.start(contextRetrySession.id);
  const contextRetried = await waitForSession(manager, contextRetrySession.id);
  assert(contextRetried.status === 'completed' && completionBodies.length > requestsBeforeRetry + 2, 'context-limit error did not use independent compactor requests before retry');
  assert(completionBodies.slice(requestsBeforeRetry).some((body) => body.messages?.[0]?.content?.includes('上下文整理 Agent')), 'context fallback did not use the same model as a dedicated compactor role');
  assert(contextRetried.contextCompactions >= 1 && contextRetried.logs.some((item) => item.message.includes('上下文整理 Agent')), 'context retry was not reported in session state');

  const queueTaskIds = ['BVCYCLE00001', 'BVCYCLE00002'].map((bvid) => {
    const id = `${collection.id}:${bvid}:queue-test`;
    store.upsertTask({ id, collectionId: collection.id, bvid, title: bvid, status: 'pending', enabled: true, attempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    return id;
  });
  store.commit();
  const queueSession = manager.createSession({ title: '上下文轮换测试', collectionId: collection.id, providerId: 'provider-test', modelId: 'model-test' });
  await manager.start(queueSession.id);
  const queueFinished = await waitForStatus(manager, queueSession.id, 'idle');
  assert(queueFinished.completed === 2 && queueFinished.contextCycle === 2, 'continuous Agent did not create one fresh context per video');
  const queueClaims = store.list('taskEvents').filter((event) => queueTaskIds.includes(event.taskId) && event.type === 'claimed');
  assert(new Set(queueClaims.map((event) => event.workerId)).size === 1 && queueClaims[0]?.workerId === queueSession.workerId, 'continuous context rotation changed the Worker ID');
  assert(new Set(queueClaims.map((event) => event.workId)).size === 2, 'continuous Agent reused a workId across videos');

  holdToolRuns = true;
  const stoppedSession = await manager.createSingleTask({ video: 'BVMANUAL0001', collectionId: collection.id, providerId: 'provider-test', modelId: 'model-test' });
  await manager.start(stoppedSession.id);
  const working = await waitForCurrentTask(manager, stoppedSession.id);
  const workingTask = store.getTask(working.currentTaskId);
  const interruptedArtifactDir = workingTask.artifactDir;
  assert(workingTask.workId?.startsWith('work-'), 'internal Agent claim did not create a workId');
  assert(fs.existsSync(path.join(interruptedArtifactDir, 'manifest.json')), 'manual stop fixture did not create partial artifacts');
  manager.stop(stoppedSession.id);
  const stopped = await waitForSession(manager, stoppedSession.id);
  assert(stopped.status === 'stopped' && stopped.phase.includes('缓存已清理'), 'manual stop did not report attempt cleanup');
  const stoppedTask = store.getTask(stoppedSession.singleTaskId);
  assert(stoppedTask.status === 'pending' && !stoppedTask.workId && !stoppedTask.claimedBy && !stoppedTask.artifactDir, 'manual stop did not reset the workId or task claim');
  assert(!fs.existsSync(interruptedArtifactDir), 'manual stop left partial task files behind');
  holdToolRuns = false;

  forceLoginFailure = true;
  const loginSession = await manager.createSingleTask({ video: 'BV0987654321', collectionId: collection.id, providerId: 'provider-test', modelId: 'model-test' });
  await manager.start(loginSession.id);
  const waiting = await waitForStatus(manager, loginSession.id, 'waiting-login');
  assert(waiting.lastError.includes('Bilibili'), 'single task did not preserve login-required reason');
  assert(events.some((event) => event.type === 'login-required' && event.sessionId === loginSession.id), 'login-required UI event was not emitted');
  currentUser = { isLogin: true, name: '测试登录用户', mid: '100' };
  await manager.start(loginSession.id);
  const retried = await waitForSession(manager, loginSession.id);
  assert(retried.status === 'completed', `logged-in retry did not complete: ${retried.lastError || retried.status}`);
  assert(store.getTask(loginSession.singleTaskId)?.publicAttempt === false, 'logged-in retry did not switch from public access');

  forceLoginFailure = false;
  forceInfrastructureFailure = true;
  const blockedSession = await manager.createSingleTask({ video: 'BVINFRA00001', collectionId: collection.id, providerId: 'provider-test', modelId: 'model-test' });
  await manager.start(blockedSession.id);
  const blocked = await waitForStatus(manager, blockedSession.id, 'blocked');
  assert(blocked.content.includes('Agent 因基础设施故障停止') && blocked.content.includes('可能原因'), 'blocked Agent did not report the infrastructure problem and likely causes');
  assert(blocked.acceptNewTasks === false && store.getWorker(blocked.workerId)?.status === 'paused', 'blocked Agent continued accepting work');
  assert(store.getTask(blocked.singleTaskId)?.status === 'pending', 'infrastructure failure did not return the video task to pending');
  assert(infrastructureArtifactDir && !fs.existsSync(infrastructureArtifactDir), 'infrastructure failure left partial task files behind');
  assert(events.some((event) => event.type === 'infrastructure-stopped' && event.sessionId === blocked.id), 'infrastructure stop event was not emitted');
  forceInfrastructureFailure = false;
  forceUnavailableFailure = true;
  const unavailableSession = await manager.createSingleTask({ video: 'BVDELETED001', collectionId: collection.id, providerId: 'provider-test', modelId: 'model-test' });
  await manager.start(unavailableSession.id);
  const unavailable = await waitForStatus(manager, unavailableSession.id, 'unavailable');
  assert(unavailable.skipped === 1 && unavailable.failed === 0, 'unavailable video was counted as an ordinary Agent failure');
  assert(!store.getTask(unavailableSession.singleTaskId), 'unavailable video remained in task inventory');
  assert(store.get('unavailableTasks', unavailableSession.singleTaskId)?.bvid === 'BVDELETED001', 'unavailable video tombstone was not persisted');
  assert(events.some((event) => event.type === 'video-unavailable' && event.sessionId === unavailable.id), 'unavailable video event was not emitted');
  forceUnavailableFailure = false;
  holdToolRuns = true;
  const modelSession = await manager.createSingleTask({ video: 'BVMCFG000001', collectionId: collection.id, providerId: 'provider-test', modelId: 'model-test' });
  await manager.start(modelSession.id);
  const modelWorking = await waitForCurrentTask(manager, modelSession.id);
  const modelTaskArtifact = store.getTask(modelWorking.currentTaskId).artifactDir;
  const providerWithoutModel = store.get('ragProviders', 'provider-test');
  providerWithoutModel.enabledModels = [];
  store.set('ragProviders', providerWithoutModel.id, providerWithoutModel);
  store.save();
  manager.reconcileModelAvailability('provider-test');
  await waitForStatus(manager, modelSession.id, 'model-unavailable');
  const modelUnavailable = manager.publicSession(manager.listSessions().find((item) => item.id === modelSession.id));
  assert(modelUnavailable.modelAvailable === false && modelUnavailable.modelUnavailableReason.includes('删除或停用'), 'removed model was not exposed as unavailable');
  assert(store.getTask(modelSession.singleTaskId)?.status === 'pending', 'model removal did not return the active task to pending');
  assert(!fs.existsSync(modelTaskArtifact), 'model removal left current task cache files behind');
  assert(store.getWorker(modelSession.workerId)?.status === 'paused', 'model removal did not pause the internal worker');
  providerWithoutModel.enabledModels = [{ id: 'model-test', name: 'model-test', contextWindow: 128000, supportsTools: true, supportsVision: false }];
  store.set('ragProviders', providerWithoutModel.id, providerWithoutModel);
  store.save();
  manager.reconcileModelAvailability('provider-test');
  const modelRestored = manager.publicSession(manager.listSessions().find((item) => item.id === modelSession.id));
  assert(modelRestored.modelAvailable === true && modelRestored.status === 'stopped', 'restored model did not make the Agent restartable');
  assert(manager.listSessions()[0].id === modelSession.id, 'Agent sessions were not ordered by newest creation time');
  assert(Number.isFinite(modelRestored.collectionProgress?.progress) && modelRestored.collectionProgress.enabled >= modelRestored.collectionProgress.done, 'collection progress was not included in Agent state');
  const biliCollection = store.upsertCollection({
    id: '100:agent-sync-guard', mediaId: 'agent-sync-guard', userId: '100', userName: '测试用户', name: '同步护栏测试',
    storageName: '同步护栏测试', syncReady: true, syncState: 'ready', lastSyncedAt: new Date().toISOString()
  });
  const guardedSession = manager.createSession({ title: '同步护栏', collectionId: biliCollection.id, providerId: 'provider-test', modelId: 'model-test' });
  store.upsertCollection({ ...store.getCollectionById(biliCollection.id), syncReady: false, syncState: 'needs-sync' });
  let syncGuarded = false;
  try { await manager.start(guardedSession.id); } catch (error) { syncGuarded = error.message.includes('尚未完成任务同步'); }
  assert(syncGuarded, 'internal Agent restarted before its Bilibili collection completed synchronization');
  store.upsertCollection({ ...store.getCollectionById(biliCollection.id), syncReady: false, syncState: 'deleted', biliDeleted: true });
  const guardedPublic = manager.publicSession(manager.listSessions().find((item) => item.id === guardedSession.id));
  assert(guardedPublic.collectionAvailable === false && guardedPublic.collectionUnavailableReason.includes('B站收藏夹已删除'), 'deleted collection was not exposed as unavailable to the internal Agent UI');
  holdToolRuns = false;
  manager.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
  console.log('internal agent integration test passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

function writeMaterials(directory) {
  fs.mkdirSync(path.join(directory, 'frames'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'asr'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'subtitles'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'comments'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'info.json'), JSON.stringify({ title: '内置 Agent 测试视频', owner: { name: '测试 UP' }, duration: 120, timestamp: 1767225600, tags: ['AI', 'Test'] }));
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ outputs: { frames: 'frames/', asr: 'asr/' } }));
  fs.writeFileSync(path.join(directory, 'frames', 'frame-001.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  fs.writeFileSync(path.join(directory, 'asr', 'transcript.srt'), '1\n00:00:02,000 --> 00:00:04,500\nASR 测试字幕。\n');
  fs.writeFileSync(path.join(directory, 'asr', 'asr-transcript.txt'), '[00:00:02,000 --> 00:00:04,500] ASR 测试字幕。\n');
  fs.writeFileSync(path.join(directory, 'asr', 'asr-result.json'), JSON.stringify({ segments: [{ id: 0, start: 2, end: 4.5, text: 'ASR 测试字幕。' }] }));
  fs.writeFileSync(path.join(directory, 'subtitles', 'part-1.srt'), '1\n00:00:01,000 --> 00:00:03,000\n站内测试字幕。\n');
  fs.writeFileSync(path.join(directory, 'subtitles', 'part-1.txt'), '站内旧版纯文本，不应优先读取。');
  fs.writeFileSync(path.join(directory, 'comments', 'comments.json'), JSON.stringify([{ message: '测试热评' }]));
}

function validMarkdown(bvid = 'BV1234567890') {
  return `# 内置 Agent 测试视频

## 小结

这是经过素材核对的测试总结。

## 思维导图

\`\`\`mermaid
mindmap
  root((测试视频))
    字幕
    关键帧
\`\`\`

## 目录

- [核心内容](#核心内容)
- [字幕比对](#字幕比对)

## 核心内容

### 测试章节 [00:00](https://www.bilibili.com/video/${bvid}?t=0)

完整说明测试视频内容。

![测试关键帧](frames/frame-001.jpg)

## 字幕比对

站内字幕与本次 ASR 均已运行并比对，本测试采用 ASR 与站内字幕互相校验。

## 评论分析

热评前三条中可获取一条测试评论，仅作为观众观点。

## 处理记录

- Worker ID：由应用分配
- 清理缓存：已通过应用工具完成
`;
}

function waitForSession(manager, id) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const session = manager.listSessions().find((item) => item.id === id);
      if (session && ['completed', 'error', 'stopped'].includes(session.status)) {
        clearInterval(timer);
        resolve(session);
      } else if (Date.now() - started > 10000) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for internal agent session.'));
      }
    }, 60);
  });
}

function waitForStatus(manager, id, status) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const session = manager.listSessions().find((item) => item.id === id);
      if (session?.status === status) {
        clearInterval(timer);
        resolve(session);
      } else if (Date.now() - started > 10000) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for internal agent status: ${status}`));
      }
    }, 60);
  });
}

function waitForCurrentTask(manager, id) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const session = manager.listSessions().find((item) => item.id === id);
      if (session?.currentTaskId && session.currentRunId) {
        clearInterval(timer);
        resolve(session);
      } else if (Date.now() - started > 10000) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for an active internal Agent task.'));
      }
    }, 30);
  });
}
