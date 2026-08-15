const fs = require('fs');
const path = require('path');
const { Store } = require('../src/core/store');
const { deleteCompletedDocument } = require('../src/core/document-lifecycle');
const { InternalAgentManager, normalizeGeneratedMarkdown, planGenerationRequest, splitTextByTokenBudget } = require('../src/core/internal-agent-manager');
const { isLoginRequiredMessage, isVideoUnavailableMessage } = require('../src/core/media-errors');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const normalized = normalizeGeneratedMarkdown('# Test\n\n## 小结\n\nSummary\n\n## 目录\n\n- Body\n\n## 正文\n\nContent\n\n## 处理记录\n\nDone', { bvid: 'BVTEST', title: 'Test video' }, { comments: [] });
  assert(normalized.indexOf('## 小结') < normalized.indexOf('## 思维导图') && normalized.indexOf('## 思维导图') < normalized.indexOf('## 目录'), 'generated Markdown opening was not normalized');
  assert(normalized.includes('```mermaid\nmindmap') && normalized.includes('## 评论分析'), 'generated Markdown required sections were not repaired');
  const zeroWidthNormalized = normalizeGeneratedMarkdown('\u200b---\ntitle: model output\n---\n\n# Test\n\n## 小结\n\nSummary', { bvid: 'BVZERO', title: 'Zero-width test' }, { comments: [] });
  assert(!zeroWidthNormalized.startsWith('\u200b') && zeroWidthNormalized.startsWith('---'), 'leading zero-width model formatting was not removed before Markdown normalization');
  const repairedOrderAndFrame = normalizeGeneratedMarkdown('# Test\n\n## 1. 目录导航\n\n- Body\n\n## 核心小结\n\nSummary\n\n## 2. 思维导图（Mind Map）\n\n```mermaid\nmindmap\n  root((Test))\n```\n\n## 正文\n\n![frame](frames/frame-%03d.jpg)', { bvid: 'BVTEST', title: 'Test video' }, { comments: [], frames: ['frames/frame-001.jpg'] });
  assert(repairedOrderAndFrame.indexOf('## 小结') < repairedOrderAndFrame.indexOf('## 思维导图') && repairedOrderAndFrame.indexOf('## 思维导图') < repairedOrderAndFrame.indexOf('## 目录'), 'existing generated Markdown sections were not deterministically reordered');
  assert(repairedOrderAndFrame.includes('(frames/frame-001.jpg)') && !repairedOrderAndFrame.includes('frame-%03d'), 'generated frame filename placeholder was not repaired');
  const repairedLocalHeadings = normalizeGeneratedMarkdown('# 本地视频总结\n\n### 一、内容摘要\n\nLocal summary\n\n#### 二、Mind Map\n\n```mermaid\nmindmap\n  root((Local))\n```\n\n### 三、章节导航\n\n- Body\n\n## 正文\n\nContent', { bvid: 'BVLOCALTEST', title: 'Local video', localImported: true }, { comments: [], frames: [] });
  assert(repairedLocalHeadings.startsWith('# 本地视频总结') && repairedLocalHeadings.indexOf('## 小结') < repairedLocalHeadings.indexOf('## 思维导图') && repairedLocalHeadings.indexOf('## 思维导图') < repairedLocalHeadings.indexOf('## 目录'), 'local-video heading levels, numbering, or aliases were not canonicalized before strict validation');
  const rejectedPlaceholder = normalizeGeneratedMarkdown('# Test\n\n## 小结\n\nSummary\n\n## 思维导图\n\n```mermaid\nmindmap\n  root((Test))\n```\n\n## 目录\n\n- Body\n\n![frame](frames/frame-%03d.jpg)', { bvid: 'BVTEST', title: 'Test video' }, { comments: [], frames: ['frames/frame-%03d.jpg'] });
  assert(!rejectedPlaceholder.includes('frame-%03d.jpg'), 'literal FFmpeg placeholder file was treated as a usable keyframe.');
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
  let emptyGenerationResponses = 0;
  let emptyGenerationFinishReason = '';
  let invalidGenerationResponses = 0;
  let transientProviderFailures = 0;
  let forceExplicitProviderError = false;
  const rag = {
    listProviders: () => [{ id: 'provider-test', name: 'Test provider', type: 'openai', baseUrl: 'http://127.0.0.1:1/v1', enabledModels: [{ id: 'model-test', name: 'model-test' }] }],
    rawProvider: () => store.get('ragProviders', 'provider-test'),
    sessionModel: () => ({ id: 'model-test', contextWindow: 128000, maxOutputTokens: 8192, supportsVision: false }),
    streamCompletion: async (_provider, body, _signal, onDelta) => {
      completionBodies.push(body);
      if (transientProviderFailures > 0) {
        transientProviderFailures -= 1;
        const error = new Error('模型供应商明确返回错误：resource pool exhausted; concurrency limit reached');
        error.code = 'MODEL_PROVIDER_FAILURE';
        error.failureKind = 'infrastructure';
        error.explicitProviderError = true;
        error.providerCode = 'rate_limit_exceeded';
        error.possibleCauses = ['模型供应商资源池当前不可用'];
        throw error;
      }
      if (forceExplicitProviderError) {
        const error = new Error('模型供应商明确返回错误：invalid API key');
        error.code = 'MODEL_PROVIDER_FAILURE';
        error.failureKind = 'infrastructure';
        error.explicitProviderError = true;
        error.possibleCauses = ['模型供应商 API Key 无效'];
        throw error;
      }
      if (forceContextLimitOnce) {
        forceContextLimitOnce = false;
        throw new Error('maximum context length exceeded');
      }
      if (emptyGenerationResponses > 0) {
        emptyGenerationResponses -= 1;
        return { content: '', reasoning: '', finishReason: emptyGenerationFinishReason, usage: { input: 40, output: 0, total: 40 } };
      }
      if (invalidGenerationResponses > 0) {
        invalidGenerationResponses -= 1;
        const incomplete = '# 不完整但非空的模型正文';
        onDelta({ content: incomplete });
        return { content: incomplete, reasoning: '', usage: { input: 40, output: 8, total: 48 } };
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
  let forceUnsupportedFailure = false;
  let metadataIncompleteRuns = 0;
  let holdToolRuns = false;
  let infrastructureArtifactDir = '';
  let lastMaterialCollectionCookie = '';
  const metadataRequirementByCollection = new Map();
  const toolRunner = {
    getState: () => ({ hardware: { checkedAt: '', localAsrSupported: false }, config: { cpuAsrEnabled: false } }),
    start: ({ task, tool, workerId, collection: runCollection, options }) => {
      const id = `run-${tool.id}-${Date.now()}`;
      if (tool.id === 'material-bundle') {
        lastMaterialCollectionCookie = String(runCollection?.cookieFile || '');
        metadataRequirementByCollection.set(task.collectionId, options?.requireCompleteMetadata === true);
      }
      const loginBlocked = forceLoginFailure && tool.id === 'material-bundle';
      const infrastructureBlocked = forceInfrastructureFailure && tool.id === 'material-bundle';
      const unavailable = forceUnavailableFailure && tool.id === 'material-bundle';
      const unsupported = forceUnsupportedFailure && tool.id === 'material-bundle';
      const metadataIncomplete = metadataIncompleteRuns > 0 && tool.id === 'material-bundle';
      if (metadataIncomplete) metadataIncompleteRuns -= 1;
      if (tool.id === 'material-bundle' && !loginBlocked && !unavailable && !unsupported && !metadataIncomplete) writeMaterials(task.artifactDir);
      if (infrastructureBlocked) infrastructureArtifactDir = task.artifactDir;
      const waiting = holdToolRuns && tool.id === 'material-bundle';
      store.createToolRun({ id, taskId: task.id, collectionId: task.collectionId, toolId: tool.id, toolName: tool.name, workerId, status: waiting ? 'running' : (unsupported || metadataIncomplete ? 'skipped' : (loginBlocked || infrastructureBlocked || unavailable ? 'failed' : 'succeeded')), stage: waiting ? 'test-hold' : (loginBlocked || infrastructureBlocked || unavailable || unsupported || metadataIncomplete ? 'error' : 'complete'), error: loginBlocked ? 'This video is only available for registered users. Use --cookies.' : (infrastructureBlocked ? 'GPU ASR 常驻服务连续 3 次启动失败，应用已停止相关 Agent。' : (unavailable ? 'Bilibili 视频已删除、下架或不可用：已失效视频' : (unsupported ? '当前版本暂不支持多 P 视频（检测到 2 个分 P），任务已关闭。' : (metadataIncomplete ? 'B站视频元数据不完整（已尝试 3 次）：接口返回 87 个视频，但 pages 只有 1 项。' : '')))), errorCode: infrastructureBlocked ? 'ASR_INFRASTRUCTURE_FAILURE' : (unavailable ? 'BILIBILI_VIDEO_UNAVAILABLE' : (unsupported ? 'UNSUPPORTED_VIDEO_TYPE' : (metadataIncomplete ? 'BILIBILI_METADATA_INCOMPLETE' : ''))), failureKind: infrastructureBlocked ? 'infrastructure' : (unavailable ? 'terminal-video' : (unsupported ? 'unsupported-video' : (metadataIncomplete ? 'metadata-incomplete' : ''))), unsupportedKind: unsupported ? 'multi-part' : '', possibleCauses: infrastructureBlocked ? ['CTranslate2 原生运行库访问冲突', '项目依赖损坏'] : [], createdAt: new Date().toISOString(), finishedAt: waiting ? '' : new Date().toISOString() });
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
  const cookieText = '# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\ttest-session\n';
  let exportedCookieFile = cookieFixture;
  let cookieExportCalls = 0;
  const manager = new InternalAgentManager({
    store,
    toolRunner,
    ragAssistant: rag,
    bili: {
      exportCookies: async () => {
        cookieExportCalls += 1;
        fs.mkdirSync(path.dirname(exportedCookieFile), { recursive: true });
        fs.writeFileSync(exportedCookieFile, cookieText);
        return exportedCookieFile;
      }
    },
    getCurrentUser: () => currentUser,
    emit: (event) => events.push(event),
    emptyResponseRetryDelays: [0, 0, 0, 0, 0]
  });
  const sharedCollection = store.upsertCollection({ id: 'shared-agent-test', userId: 'shared-user', userName: '共享', name: '共享知识测试', internal: true, collectionKind: 'shared', workspaceId: workspace.id, workspaceRoot: workspace.root, collectionRoot: path.join(workspace.root, '共享', '共享知识测试') });
  assert(!manager.state().collections.some((item) => item.id === sharedCollection.id), '共享收藏夹仍出现在 Agent 工作流收藏夹列表');
  assert(!manager.listInternalCollections().some((item) => item.id === sharedCollection.id), '共享收藏夹仍出现在单视频总结收藏夹列表');
  let sharedSessionRejected = false;
  try { manager.createSession({ title: '不应创建', collectionId: sharedCollection.id, providerId: 'provider-test', modelId: 'model-test' }); }
  catch (error) { sharedSessionRejected = /共享收藏夹.*不能/.test(error.message); }
  assert(sharedSessionRejected, 'Agent 后端允许共享收藏夹创建视频总结工作流');
  let sharedSingleRejected = false;
  try { await manager.inspectSingleTask({ video: 'BVSHARED0001', collectionId: sharedCollection.id }); }
  catch (error) { sharedSingleRejected = /共享知识库|普通内置收藏夹/.test(error.message); }
  assert(sharedSingleRejected, '单视频总结后端允许共享收藏夹接收任务');
  const retainedArtifact = path.join(root, 'retained-artifact');
  fs.mkdirSync(path.join(retainedArtifact, 'asr'), { recursive: true });
  fs.mkdirSync(path.join(retainedArtifact, 'subtitles'), { recursive: true });
  fs.writeFileSync(path.join(retainedArtifact, 'merged.mp4'), 'retained video');
  fs.writeFileSync(path.join(retainedArtifact, 'asr', 'transcript.srt'), '1\n00:00:01,000 --> 00:00:02,000\n保留字幕。\n');
  fs.writeFileSync(path.join(retainedArtifact, 'asr', 'asr-transcript.txt'), '[00:00:01,000 --> 00:00:02,000] 保留字幕。\n');
  fs.writeFileSync(path.join(retainedArtifact, 'asr', 'asr-result.json'), JSON.stringify({ segments: [{ start: 1, end: 2, text: '保留字幕。' }] }));
  fs.writeFileSync(path.join(retainedArtifact, 'subtitles', 'part-1.srt'), '1\n00:00:01,000 --> 00:00:02,000\n站内字幕。\n');
  fs.writeFileSync(path.join(retainedArtifact, 'info.json'), JSON.stringify({ title: '保留缓存测试' }));
  const retainedTask = { id: 'retained-task', bvid: 'BVRETAIN001', allowedRoot: root, artifactDir: retainedArtifact, keepVideoCache: false };
  const retainedValidation = require('../src/core/validation').validateSubmission(retainedTask, { artifactDir: retainedArtifact, markdownFile: path.join(retainedArtifact, 'summary.md'), metadataFile: path.join(retainedArtifact, 'info.json') }, { preserveProcessCache: true });
  if (retainedValidation.errors.some((error) => error.includes('Temporary media cache'))) throw new Error('retained process cache was still rejected by relaxed validation');
  const toggleCollection = manager.createInternalCollection('任务开关测试');
  store.upsertTask({ id: `${toggleCollection.id}:disabled`, collectionId: toggleCollection.id, bvid: 'BVDISABLED01', title: '关闭任务', status: 'pending', enabled: false, favoriteAddedAt: '2026-07-15T10:00:00.000Z' });
  store.upsertTask({ id: `${toggleCollection.id}:enabled`, collectionId: toggleCollection.id, bvid: 'BVENABLED001', title: '开启任务', status: 'pending', enabled: true, favoriteAddedAt: '2026-07-14T10:00:00.000Z' });
  store.commit();
  const toggleSession = manager.createSession({ title: '任务开关领取测试', collectionId: toggleCollection.id, providerId: 'provider-test', modelId: 'model-test' });
  assert(toggleSession.collectionName === toggleCollection.name && toggleSession.collectionUserName === toggleCollection.userName, 'Agent session did not retain a stable user/collection display snapshot');
  const toggleClaim = manager.claimNextTask(toggleSession, new Set());
  assert(toggleClaim?.id === `${toggleCollection.id}:enabled`, 'internal Agent claimed a task disabled in Task Overview');
  manager.abortAttempt(toggleClaim.id, toggleSession.workerId, 'test cleanup', 'test');
  const originalStoreSave = store.save.bind(store);
  let ordinaryDeleteSaves = 0;
  store.save = (...args) => { ordinaryDeleteSaves += 1; return originalStoreSave(...args); };
  manager.deleteSession(toggleSession.id);
  store.save = originalStoreSave;
  assert(ordinaryDeleteSaves === 2, 'ordinary Agent deletion did not preserve its immediate Worker and session persistence');
  const deferredDeleteSession = manager.createSession({ title: '批量删除暂存测试', collectionId: toggleCollection.id, providerId: 'provider-test', modelId: 'model-test' });
  let deferredDeleteSaves = 0;
  store.save = (...args) => { deferredDeleteSaves += 1; return originalStoreSave(...args); };
  manager.deleteSession(deferredDeleteSession.id, { persist: false });
  store.save = originalStoreSave;
  assert(deferredDeleteSaves === 0 && !store.get('internalAgentSessions', deferredDeleteSession.id), 'deferred Agent deletion wrote the complete database before its batch commit');
  store.save();
  const collection = manager.listInternalCollections().find((item) => item.id !== toggleCollection.id);
  const multipartFailureTask = {
    id: `${collection.id}:multipart-failure-test`,
    collectionId: collection.id,
    bvid: 'BVMULTIFAIL1',
    title: '多 P 失败重试测试',
    status: 'claimed',
    enabled: true,
    multiPartRole: 'part',
    multiPartParentId: 'multipart-parent-test',
    multiPartId: 'cid-failure-test',
    multiPartProgress: 0.7,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  store.upsertTask(multipartFailureTask);
  store.commit();
  const markedMultipartFailure = manager.markMultipartTaskFailed(multipartFailureTask, '供应商资源池暂不可用', 'infrastructure-failure');
  assert(markedMultipartFailure.status === 'pending' && markedMultipartFailure.enabled === false, 'failed multipart task did not return to a disabled pending state');
  assert(markedMultipartFailure.multiPartFailed === true && markedMultipartFailure.multiPartProgress === 0, 'failed multipart task did not expose a retryable failure marker');
  assert(events.some((event) => event.type === 'multipart-task-failed' && event.taskId === multipartFailureTask.id), 'multipart failure did not notify the parent viewer');
  store.delete('tasks', multipartFailureTask.id);
  store.commit();
  const persistedCollectionRoot = collection.collectionRoot;
  const movedDefaultWorkspace = store.addWorkspace({ name: 'New default workspace', root: path.join(root, 'workspace-new') });
  store.setDefaultWorkspace(movedDefaultWorkspace.id);
  assert(manager.collectionOutputDirectory(collection.id) === persistedCollectionRoot, 'Agent output directory was recomputed from the current default workspace instead of the collection snapshot');
  const tasksBeforeInvalidModel = store.listTasks().length;
  let invalidSingleModelRejected = false;
  try { await manager.createSingleTask({ video: 'BVINVALID001', collectionId: collection.id, providerId: 'provider-test', modelId: 'missing-model' }); }
  catch { invalidSingleModelRejected = true; }
  assert(invalidSingleModelRejected && store.listTasks().length === tasksBeforeInvalidModel, 'invalid single-video model configuration left an orphan task');
  let missingCookieRejected = false;
  try { await manager.createSingleTask({ video: 'BVCOOKIE0001', collectionId: collection.id, providerId: 'provider-test', modelId: 'model-test' }); }
  catch (error) { missingCookieRejected = error.code === 'BILIBILI_COOKIE_REQUIRED'; }
  assert(missingCookieRejected && store.listTasks().length === tasksBeforeInvalidModel, 'single-video creation did not reject a missing B站 login Cookie before creating a task');
  currentUser = { isLogin: true, name: '测试登录用户', mid: '100' };
  const session = await manager.createSingleTask({
    video: 'https://www.bilibili.com/video/BV1234567890',
    collectionId: collection.id,
    providerId: 'provider-test',
    modelId: 'model-test',
    taskRequirements: '保留测试参数。',
    taskOptions: { frames: 8, commentLimit: 3 }
  });
  assert(store.getTask(session.singleTaskId)?.publicAttempt === false && store.getTask(session.singleTaskId)?.cookieFile === cookieFixture, 'single task did not carry the B站 Cookie on its first request');
  await Promise.all([manager.start(session.id), manager.start(session.id)]);
  const finished = await waitForSession(manager, session.id);
  assert(finished.status === 'completed', `single session did not complete: ${finished.lastError || finished.status}`);
  assert(finished.completed === 1, 'completed count was not updated');
  assert(!finished.externalOutput && finished.lastOutput && fs.existsSync(finished.lastOutput), 'single task did not use its canonical internal artifact as the only output');
  const task = store.getTask(finished.singleTaskId);
  assert(task.status === 'done' && fs.existsSync(task.outputMarkdown), 'accepted internal document is missing');
  assert(task.artifactDir.startsWith(persistedCollectionRoot) && (task.outputMarkdown.includes('内置用户') || task.artifactDir.includes('内置用户')), 'internal collection artifact path did not use the persisted collection root');
  assert(manager.collectionOutputDirectory(collection.id) === collection.collectionRoot, 'single-task collection output directory is incorrect');
  assert(manager.sessionOutputDirectory(finished.id) === task.artifactDir, 'completed session did not resolve its artifact directory');
  const duplicateInspection = await manager.inspectSingleTask({ video: task.bvid, collectionId: collection.id });
  assert(duplicateInspection.latestCompleted?.taskId === task.id, 'single-video duplicate inspection did not find the accepted document');
  let duplicateRejected = false;
  try { await manager.createSingleTask({ video: task.bvid, collectionId: collection.id, providerId: 'provider-test', modelId: 'model-test' }); }
  catch (error) { duplicateRejected = error.message.includes('已经存在'); }
  assert(duplicateRejected, 'single-video creation bypassed the completed-document decision');
  const regeneratedSession = await manager.createSingleTask({ video: task.bvid, collectionId: collection.id, providerId: 'provider-test', modelId: 'model-test', duplicateAction: 'overwrite' });
  await manager.start(regeneratedSession.id);
  const regenerated = await waitForSession(manager, regeneratedSession.id);
  const regeneratedTask = store.getTask(regenerated.singleTaskId);
  assert(regenerated.status === 'completed' && regeneratedTask.status === 'done', 'single-video regeneration did not complete');
  assert(regeneratedTask.id === task.id && regeneratedTask.revision === 1 && !regeneratedTask.revisionOfTaskId, 'single-video overwrite created a historical task version');
  assert(store.listTasks({ collectionId: collection.id }).filter((item) => item.singleTask && item.bvid === task.bvid).length === 1, 'single-video overwrite kept more than one task/output version');

  const deletedSingle = deleteCompletedDocument({ store, taskId: regeneratedTask.id });
  assert(deletedSingle.reason === 'single-task-deleted' && !store.getTask(regeneratedTask.id), 'deleting a single-video output did not remove its task record');
  const tasksBeforeNewAfterDelete = store.listTasks({ collectionId: collection.id }).length;
  const newAfterDelete = await manager.createSingleTask({
    video: task.bvid,
    collectionId: collection.id,
    providerId: 'provider-test',
    modelId: 'model-test'
  });
  assert(newAfterDelete.singleTaskId !== regeneratedTask.id && store.listTasks({ collectionId: collection.id }).length === tasksBeforeNewAfterDelete + 1, 'same BV after document deletion did not start as a fresh single-video task');
  store.delete('tasks', newAfterDelete.singleTaskId);
  store.delete('internalAgentSessions', newAfterDelete.id);
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
  assert(switchedOutput === persistedCollectionRoot, 'internal collection output changed when the default workspace changed');
  store.setDefaultWorkspace(workspace.id);
  assert(store.getWorker(finished.workerId)?.tool === 'star-owner-internal', 'internal worker identity was not registered');
  assert(finished.contextCycle === 1 && finished.contextPercent > 0 && finished.contextCompactions === 0, 'ordinary single task unexpectedly used context fallback');
  assert(completionBodies[0]?.messages?.length === 2 && completionBodies[0].messages[0].role === 'system' && completionBodies[0].messages[1].role === 'user', 'video generation request unexpectedly carried prior task history');
  assert(completionBodies[0].messages[1].content.includes('00:00:02,000 --> 00:00:04,500') && completionBodies[0].messages[1].content.includes('00:00:01,000 --> 00:00:03,000'), 'internal Agent prompt did not receive sentence-level ASR and station subtitle timestamps');
  assert(events.some((event) => event.type === 'stream') && events.some((event) => event.type === 'session-updated'), 'internal agent events were not emitted');
  assert(isLoginRequiredMessage('This video is only available for registered users. Use --cookies.'), 'login-required classifier missed yt-dlp guidance');
  assert(!isLoginRequiredMessage('network timeout while downloading'), 'ordinary network failure was misclassified as login-required');
  assert(isVideoUnavailableMessage('ERROR: video is no longer available'), 'unavailable-video classifier missed yt-dlp output');
  assert(isVideoUnavailableMessage('Bilibili API 62012: 仅UP主自己可见'), 'Bilibili terminal API code 62012 was not classified as unavailable');
  assert(!isVideoUnavailableMessage('Referenced image (frames/frame-%03d.jpg) file does not exist'), 'Markdown validation failure was misclassified as an unavailable video');
  assert(!isVideoUnavailableMessage('HTTP 429: too many requests'), 'temporary network failure was misclassified as unavailable');

  forceContextLimitOnce = true;
  const requestsBeforeRetry = completionBodies.length;
  const contextRetrySession = await manager.createSingleTask({ video: 'BVCONTEXT001', collectionId: collection.id, providerId: 'provider-test', modelId: 'model-test' });
  await manager.start(contextRetrySession.id);
  const contextRetried = await waitForSession(manager, contextRetrySession.id);
  assert(contextRetried.status === 'completed' && completionBodies.length > requestsBeforeRetry + 2, 'context-limit error did not use independent compactor requests before retry');
  assert(completionBodies.slice(requestsBeforeRetry).some((body) => body.messages?.[0]?.content?.includes('上下文整理 Agent')), 'context fallback did not use the same model as a dedicated compactor role');
  assert(contextRetried.contextCompactions >= 1 && contextRetried.logs.some((item) => item.message.includes('上下文整理 Agent')), 'context retry was not reported in session state');

  emptyGenerationResponses = 5;
  const requestsBeforeEmptyRecovery = completionBodies.length;
  const emptyRecoverySession = await manager.createSingleTask({ video: 'BVEMPTY00001', collectionId: collection.id, providerId: 'provider-test', modelId: 'model-test' });
  await manager.start(emptyRecoverySession.id);
  const emptyRecovered = await waitForSession(manager, emptyRecoverySession.id);
  const emptyRecoveryLogs = emptyRecovered.logs.filter((item) => item.message.includes('模型接口未返回可用正文'));
  assert(emptyRecovered.status === 'completed' && completionBodies.length - requestsBeforeEmptyRecovery === 6, 'fifth empty-response retry did not recover on the sixth total request');
  assert(emptyRecoveryLogs.length === 5 && emptyRecoveryLogs.at(-1).message.includes('第 5/5 次'), 'empty-response retry count was not reported through the configured limit');
  assert(!emptyRecovered.logs.some((item) => item.message.includes('稿未通过校验')), 'empty provider responses were still reported as Markdown validation failures');
  assert(events.some((event) => event.type === 'stream' && event.sessionId === emptyRecoverySession.id && event.replaceContent === true), 'recovered model output appended to the retry notice instead of replacing it');

  emptyGenerationResponses = 6;
  const requestsBeforeEmptyFailure = completionBodies.length;
  const emptyFailureSession = await manager.createSingleTask({ video: 'BVEMPTY00002', collectionId: collection.id, providerId: 'provider-test', modelId: 'model-test' });
  await manager.start(emptyFailureSession.id);
  const emptyBlocked = await waitForStatus(manager, emptyFailureSession.id, 'blocked');
  assert(completionBodies.length - requestsBeforeEmptyFailure === 6, 'empty provider response exceeded the five-retry limit');
  assert(emptyBlocked.content.includes('Agent 因基础设施故障停止') && emptyBlocked.content.includes('初次请求及 5 次自动重试') && emptyBlocked.content.includes('AI 模型配置'), 'exhausted empty responses did not replace the model pane with a provider-specific infrastructure error');
  assert(!emptyBlocked.logs.some((item) => item.message.includes('稿未通过校验')) && store.getTask(emptyFailureSession.singleTaskId)?.status === 'pending', 'empty response failure entered content validation or consumed the task');

  transientProviderFailures = 2;
  const requestsBeforeBusyRecovery = completionBodies.length;
  const busyRecoverySession = await manager.createSingleTask({ video: 'BVBUSY000001', collectionId: collection.id, providerId: 'provider-test', modelId: 'model-test' });
  await manager.start(busyRecoverySession.id);
  const busyRecovered = await waitForSession(manager, busyRecoverySession.id);
  assert(busyRecovered.status === 'completed' && completionBodies.length - requestsBeforeBusyRecovery === 3, 'provider concurrency exhaustion did not recover through bounded retries');
  assert(busyRecovered.logs.filter((item) => item.message.includes('并发/资源池')).length === 2, 'provider concurrency retry count was not reported');

  forceExplicitProviderError = true;
  const requestsBeforeExplicitFailure = completionBodies.length;
  const explicitFailureSession = await manager.createSingleTask({ video: 'BVEXPLICIT01', collectionId: collection.id, providerId: 'provider-test', modelId: 'model-test' });
  await manager.start(explicitFailureSession.id);
  const explicitBlocked = await waitForStatus(manager, explicitFailureSession.id, 'blocked');
  forceExplicitProviderError = false;
  assert(completionBodies.length - requestsBeforeExplicitFailure === 1, 'a non-transient explicit provider error was retried');
  assert(explicitBlocked.content.includes('invalid API key') && !explicitBlocked.logs.some((item) => item.message.includes('自动重试')), 'non-transient explicit provider error was not displayed directly');

  invalidGenerationResponses = 2;
  const requestsBeforeInvalidDraft = completionBodies.length;
  const invalidDraftSession = await manager.createSingleTask({ video: 'BVINVALID002', collectionId: collection.id, providerId: 'provider-test', modelId: 'model-test' });
  await manager.start(invalidDraftSession.id);
  const invalidDraftFailed = await waitForStatus(manager, invalidDraftSession.id, 'error');
  assert(completionBodies.length - requestsBeforeInvalidDraft === 2 && invalidDraftFailed.logs.filter((item) => item.message.includes('稿未通过校验')).length === 2, 'non-empty malformed Markdown did not retain the two-draft validation flow');
  assert(!invalidDraftFailed.logs.some((item) => item.message.includes('模型接口未返回可用正文')), 'non-empty malformed Markdown was misclassified as an empty provider response');

  store.updateTasksEnabled([emptyFailureSession.singleTaskId, explicitFailureSession.singleTaskId, invalidDraftSession.singleTaskId], false);
  store.commit();

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

  const metadataCollection = store.upsertCollection({
    id: '100:agent-metadata-validation',
    mediaId: 'agent-metadata-validation',
    userId: '100',
    userName: '测试登录用户',
    name: 'B站元数据校验测试',
    storageName: 'B站元数据校验测试',
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    collectionRoot: path.join(workspace.root, '测试登录用户', 'B站元数据校验测试'),
    syncReady: true,
    syncState: 'ready',
    lastSyncedAt: new Date().toISOString()
  });
  const metadataTaskId = `${metadataCollection.id}:BVMETADATA001:queue-test`;
  store.upsertTask({ id: metadataTaskId, collectionId: metadataCollection.id, bvid: 'BVMETADATA001', title: '元数据完整性测试', status: 'pending', enabled: true, attempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  store.commit();
  metadataIncompleteRuns = 1;
  const metadataSession = manager.createSession({ title: '元数据异常跳过测试', collectionId: metadataCollection.id, providerId: 'provider-test', modelId: 'model-test' });
  await manager.start(metadataSession.id);
  const metadataSkipped = await waitForStatus(manager, metadataSession.id, 'idle');
  const metadataTask = store.getTask(metadataTaskId);
  assert(metadataSkipped.skipped === 1 && metadataSkipped.failed === 0 && metadataTask?.enabled === false && metadataTask.metadataIncomplete === true && metadataTask.status === 'pending', 'incomplete Bilibili metadata was not closed and skipped as a retryable task exception');
  assert(events.some((event) => event.type === 'video-metadata-incomplete' && event.taskId === metadataTaskId), 'metadata-incomplete event was not emitted');
  assert(metadataRequirementByCollection.get(metadataCollection.id) === true, 'Bilibili favorite Agent did not receive the complete metadata requirement');
  assert(metadataRequirementByCollection.get(collection.id) === false, 'ordinary internal single-video Agent unexpectedly received the complete metadata requirement');
  store.updateTasksEnabled([metadataTaskId], true);
  await manager.start(metadataSession.id);
  const metadataRecovered = await waitForStatus(manager, metadataSession.id, 'idle');
  assert(metadataRecovered.completed === 1 && store.getTask(metadataTaskId)?.status === 'done' && store.getTask(metadataTaskId)?.metadataIncomplete === false, 'a manually re-enabled metadata task did not recover cleanly');

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
  assert(events.some((event) => event.type === 'bilibili-cookie-required' && event.sessionId === loginSession.id), 'expired Cookie did not emit the bottom-right notification event');
  forceLoginFailure = false;
  currentUser = { isLogin: true, name: '测试登录用户', mid: '100' };
  await manager.start(loginSession.id);
  const retried = await waitForSession(manager, loginSession.id);
  assert(retried.status === 'completed', `logged-in retry did not complete: ${retried.lastError || retried.status}`);
  assert(store.getTask(loginSession.singleTaskId)?.publicAttempt === false, 'logged-in retry did not switch from public access');

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
  forceUnsupportedFailure = true;
  const unsupportedSession = await manager.createSingleTask({ video: 'BVMULTIP0001', collectionId: collection.id, providerId: 'provider-test', modelId: 'model-test' });
  await manager.start(unsupportedSession.id);
  const unsupported = await waitForStatus(manager, unsupportedSession.id, 'unsupported');
  const unsupportedTask = store.getTask(unsupportedSession.singleTaskId);
  assert(unsupported.skipped === 1 && unsupported.failed === 0, 'unsupported video was counted as an Agent failure');
  assert(unsupportedTask?.enabled === false && unsupportedTask.unsupportedKind === 'multi-part' && unsupportedTask.status === 'pending', 'unsupported multi-part task was not permanently disabled');
  assert(!unsupportedTask.workId && !unsupportedTask.claimedBy && !unsupportedTask.artifactDir, 'unsupported multi-part task kept its attempt state or cache');
  assert(events.some((event) => event.type === 'video-unsupported' && event.sessionId === unsupported.id), 'unsupported-video event was not emitted');
  forceUnsupportedFailure = false;
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

  const oldQueueCookie = path.join(root, 'old-queue-cookie.txt');
  fs.writeFileSync(oldQueueCookie, cookieText, 'utf8');
  const refreshedQueueCookie = path.join(root, 'refreshed-queue-cookie.txt');
  exportedCookieFile = refreshedQueueCookie;
  currentUser = { isLogin: true, name: '测试登录用户', mid: '100', cookieFile: oldQueueCookie };
  const authenticatedCollection = store.upsertCollection({
    id: '100:agent-cookie-refresh',
    mediaId: 'agent-cookie-refresh',
    userId: '100',
    userName: '测试登录用户',
    name: 'Agent Cookie 刷新测试',
    storageName: 'Agent Cookie 刷新测试',
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    cookieFile: oldQueueCookie,
    syncReady: true,
    syncState: 'ready',
    lastSyncedAt: new Date().toISOString()
  });
  const authenticatedTaskId = `${authenticatedCollection.id}:BVQUEUEAUTH1`;
  store.upsertTask({ id: authenticatedTaskId, collectionId: authenticatedCollection.id, bvid: 'BVQUEUEAUTH1', title: '队列 Cookie 测试', status: 'pending', enabled: true, attempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  store.commit();
  const authenticatedSession = manager.createSession({ title: '队列 Cookie 测试', collectionId: authenticatedCollection.id, providerId: 'provider-test', modelId: 'model-test' });
  const exportsBeforeQueueStart = cookieExportCalls;
  await manager.start(authenticatedSession.id);
  await waitForCurrentTask(manager, authenticatedSession.id);
  assert(cookieExportCalls === exportsBeforeQueueStart + 1, 'normal Agent startup did not export a fresh B站 Cookie snapshot exactly once');
  assert(store.getCollectionById(authenticatedCollection.id)?.cookieFile === refreshedQueueCookie, 'fresh Agent Cookie was not persisted to the B站 collection before task execution');
  assert(lastMaterialCollectionCookie === refreshedQueueCookie, 'Agent material workflow did not receive the newly persisted collection Cookie');
  manager.stop(authenticatedSession.id);
  await waitForStatus(manager, authenticatedSession.id, 'stopped');

  const nextQueueCookie = path.join(root, 'next-queue-cookie.txt');
  exportedCookieFile = nextQueueCookie;
  currentUser = { isLogin: true, name: '测试登录用户', mid: '100', cookieFile: refreshedQueueCookie };
  await manager.start(authenticatedSession.id);
  await waitForCurrentTask(manager, authenticatedSession.id);
  assert(store.getCollectionById(authenticatedCollection.id)?.cookieFile === nextQueueCookie && lastMaterialCollectionCookie === nextQueueCookie, 'the next Agent start fell back to the previous collection Cookie');
  manager.stop(authenticatedSession.id);
  await waitForStatus(manager, authenticatedSession.id, 'stopped');

  holdToolRuns = false;
  forceLoginFailure = true;
  await manager.start(authenticatedSession.id);
  const queueWaitingForLogin = await waitForStatus(manager, authenticatedSession.id, 'waiting-login');
  assert(queueWaitingForLogin.acceptNewTasks === false && store.getTask(authenticatedTaskId)?.status === 'pending', 'runtime Cookie rejection did not stop the queue Agent and return its task to pending');
  assert(events.some((event) => event.type === 'bilibili-cookie-required' && event.sessionId === authenticatedSession.id), 'queue Agent Cookie rejection did not emit the bottom-right login notification');
  forceLoginFailure = false;
  holdToolRuns = true;

  const exportsBeforeMismatch = cookieExportCalls;
  currentUser = { isLogin: true, name: '其它测试用户', mid: '200', cookieFile: nextQueueCookie };
  let accountMismatchRejected = false;
  try { await manager.start(authenticatedSession.id); }
  catch (error) { accountMismatchRejected = error.code === 'BILIBILI_ACCOUNT_MISMATCH'; }
  assert(accountMismatchRejected, 'Agent startup allowed another B站 account to overwrite the collection Cookie');
  assert(cookieExportCalls === exportsBeforeMismatch && store.getCollectionById(authenticatedCollection.id)?.cookieFile === nextQueueCookie, 'account mismatch modified or re-exported the collection Cookie');
  assert(store.getTask(authenticatedTaskId)?.status === 'pending', 'account mismatch claimed a task before authentication completed');

  currentUser = null;
  let missingQueueLoginRejected = false;
  try { await manager.start(authenticatedSession.id); }
  catch (error) { missingQueueLoginRejected = error.code === 'BILIBILI_COOKIE_REQUIRED'; }
  assert(missingQueueLoginRejected && store.getTask(authenticatedTaskId)?.status === 'pending', 'normal B站 Agent did not stop before task claim when login was missing');

  const localCollectionRoot = path.join(workspace.root, '内置用户', '本地媒体 Agent Cookie 旁路');
  fs.mkdirSync(localCollectionRoot, { recursive: true });
  const localCollection = store.upsertCollection({
    id: 'builtin-video-cache:local-agent-auth-test',
    userId: 'builtin-agent-user',
    userName: '内置用户',
    name: '本地媒体 Agent Cookie 旁路',
    internal: true,
    collectionKind: 'video-cache',
    videoCacheSource: 'local-media',
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    collectionRoot: localCollectionRoot,
    videosDir: localCollectionRoot
  });
  const localArtifact = path.join(localCollectionRoot, 'local-task');
  fs.mkdirSync(localArtifact, { recursive: true });
  fs.writeFileSync(path.join(localArtifact, 'merged.mp4'), 'local media', 'utf8');
  const localTaskId = `${localCollection.id}:LOCAL-AUTH-TEST`;
  store.upsertTask({
    id: localTaskId,
    collectionId: localCollection.id,
    bvid: 'LOCAL-AUTH-TEST',
    title: '本地导入视频',
    status: 'pending',
    enabled: true,
    cachedVideoId: 'local-cache-record',
    artifactDir: localArtifact,
    allowedRoot: localCollectionRoot,
    localImported: true,
    sourceType: 'local-video',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  store.commit();
  const localSession = manager.createSession({ title: '本地媒体无需 Cookie', collectionId: localCollection.id, providerId: 'provider-test', modelId: 'model-test' });
  const exportsBeforeLocalStart = cookieExportCalls;
  await manager.start(localSession.id);
  await waitForCurrentTask(manager, localSession.id);
  assert(cookieExportCalls === exportsBeforeLocalStart, 'local imported video/audio Agent unexpectedly required or exported a B站 Cookie');
  assert(metadataRequirementByCollection.get(localCollection.id) === false, 'local imported video/audio Agent unexpectedly received the Bilibili pages requirement');
  manager.stop(localSession.id);
  await waitForStatus(manager, localSession.id, 'stopped');

  const downloadedCollectionRoot = path.join(workspace.root, '内置用户', '下载缓存 Agent Cookie');
  fs.mkdirSync(downloadedCollectionRoot, { recursive: true });
  const downloadedCollection = store.upsertCollection({
    id: 'builtin-video-cache:downloaded-agent-auth-test',
    userId: 'builtin-agent-user',
    userName: '内置用户',
    name: '下载缓存 Agent Cookie',
    internal: true,
    collectionKind: 'video-cache',
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    collectionRoot: downloadedCollectionRoot,
    videosDir: downloadedCollectionRoot,
    cookieFile: oldQueueCookie
  });
  const downloadedArtifact = path.join(downloadedCollectionRoot, 'downloaded-task');
  fs.mkdirSync(downloadedArtifact, { recursive: true });
  fs.writeFileSync(path.join(downloadedArtifact, 'merged.mp4'), 'downloaded media', 'utf8');
  const downloadedTaskId = `${downloadedCollection.id}:BVCACHEAUTH1`;
  store.upsertTask({
    id: downloadedTaskId,
    collectionId: downloadedCollection.id,
    bvid: 'BVCACHEAUTH1',
    title: 'B站下载缓存视频',
    status: 'pending',
    enabled: true,
    cachedVideoId: 'download-cache-record',
    artifactDir: downloadedArtifact,
    allowedRoot: downloadedCollectionRoot,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  store.commit();
  const downloadedCookie = path.join(root, 'downloaded-cache-agent-cookie.txt');
  exportedCookieFile = downloadedCookie;
  currentUser = { isLogin: true, name: '测试登录用户', mid: '100', cookieFile: nextQueueCookie };
  const downloadedSession = manager.createSession({ title: '下载缓存需要 Cookie', collectionId: downloadedCollection.id, providerId: 'provider-test', modelId: 'model-test' });
  await manager.start(downloadedSession.id);
  await waitForCurrentTask(manager, downloadedSession.id);
  assert(store.getCollectionById(downloadedCollection.id)?.cookieFile === downloadedCookie && lastMaterialCollectionCookie === downloadedCookie, 'B站 downloaded cache Agent did not refresh and use the current login Cookie');
  assert(metadataRequirementByCollection.get(downloadedCollection.id) === false, 'downloaded Bilibili cache Agent unexpectedly received the favorite-collection pages requirement');
  manager.stop(downloadedSession.id);
  await waitForStatus(manager, downloadedSession.id, 'stopped');

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
