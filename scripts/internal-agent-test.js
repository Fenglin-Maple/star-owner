const fs = require('fs');
const path = require('path');
const { Store } = require('../src/core/store');
const { InternalAgentManager } = require('../src/core/internal-agent-manager');
const { isLoginRequiredMessage } = require('../src/core/media-errors');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
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

  const rag = {
    listProviders: () => [{ id: 'provider-test', name: 'Test provider', type: 'openai', baseUrl: 'http://127.0.0.1:1/v1', enabledModels: [{ id: 'model-test', name: 'model-test' }] }],
    rawProvider: () => store.get('ragProviders', 'provider-test'),
    sessionModel: () => ({ id: 'model-test', supportsVision: false }),
    streamCompletion: async (_provider, _body, _signal, onDelta) => {
      onDelta({ reasoning: '先核对字幕和关键帧。' });
      onDelta({ content: validMarkdown() });
      return { content: validMarkdown(), reasoning: '先核对字幕和关键帧。', usage: { input: 120, output: 240, total: 360 } };
    },
    recordModelUsage: () => ({})
  };

  let forceLoginFailure = false;
  let forceInfrastructureFailure = false;
  let holdToolRuns = false;
  let infrastructureArtifactDir = '';
  const toolRunner = {
    start: ({ task, tool, workerId, collection: runCollection }) => {
      const id = `run-${tool.id}-${Date.now()}`;
      const loginBlocked = forceLoginFailure && tool.id === 'material-bundle' && !runCollection?.cookieFile;
      const infrastructureBlocked = forceInfrastructureFailure && tool.id === 'material-bundle';
      if (tool.id === 'material-bundle' && !loginBlocked) writeMaterials(task.artifactDir);
      if (infrastructureBlocked) infrastructureArtifactDir = task.artifactDir;
      const waiting = holdToolRuns && tool.id === 'material-bundle';
      store.createToolRun({ id, taskId: task.id, collectionId: task.collectionId, toolId: tool.id, toolName: tool.name, workerId, status: waiting ? 'running' : (loginBlocked || infrastructureBlocked ? 'failed' : 'succeeded'), stage: waiting ? 'test-hold' : (loginBlocked || infrastructureBlocked ? 'error' : 'complete'), error: loginBlocked ? 'This video is only available for registered users. Use --cookies.' : (infrastructureBlocked ? 'GPU ASR 常驻服务连续 3 次启动失败，应用已停止相关 Agent。' : ''), errorCode: infrastructureBlocked ? 'ASR_INFRASTRUCTURE_FAILURE' : '', failureKind: infrastructureBlocked ? 'infrastructure' : '', possibleCauses: infrastructureBlocked ? ['CTranslate2 原生运行库访问冲突', '项目依赖损坏'] : [], createdAt: new Date().toISOString(), finishedAt: waiting ? '' : new Date().toISOString() });
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
  const outputDir = path.join(root, 'external-output');
  const session = await manager.createSingleTask({
    video: 'https://www.bilibili.com/video/BV1234567890',
    outputDir,
    collectionId: collection.id,
    providerId: 'provider-test',
    modelId: 'model-test',
    taskRequirements: '保留测试参数。',
    taskOptions: { frames: 8, commentLimit: 3 }
  });
  assert(store.getTask(session.singleTaskId)?.publicAttempt === true && !store.getTask(session.singleTaskId)?.cookieFile, 'single task must try public access first');
  manager.start(session.id);
  const finished = await waitForSession(manager, session.id);
  assert(finished.status === 'completed', `single session did not complete: ${finished.lastError || finished.status}`);
  assert(finished.completed === 1, 'completed count was not updated');
  assert(finished.externalOutput && fs.existsSync(finished.externalOutput), 'external artifact copy is missing');
  const task = store.getTask(finished.singleTaskId);
  assert(task.status === 'done' && fs.existsSync(task.outputMarkdown), 'accepted internal document is missing');
  assert(task.outputMarkdown.includes('内置用户') || task.artifactDir.includes('内置用户'), 'internal collection artifact path is incorrect');
  assert(store.getWorker(finished.workerId)?.tool === 'star-owner-internal', 'internal worker identity was not registered');
  assert(events.some((event) => event.type === 'stream') && events.some((event) => event.type === 'session-updated'), 'internal agent events were not emitted');
  assert(isLoginRequiredMessage('This video is only available for registered users. Use --cookies.'), 'login-required classifier missed yt-dlp guidance');
  assert(!isLoginRequiredMessage('network timeout while downloading'), 'ordinary network failure was misclassified as login-required');

  holdToolRuns = true;
  const stoppedSession = await manager.createSingleTask({ video: 'BVMANUAL0001', outputDir: path.join(root, 'stopped-output'), collectionId: collection.id, providerId: 'provider-test', modelId: 'model-test' });
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
  const loginSession = await manager.createSingleTask({ video: 'BV0987654321', outputDir: path.join(root, 'login-output'), collectionId: collection.id, providerId: 'provider-test', modelId: 'model-test' });
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
  const blockedSession = await manager.createSingleTask({ video: 'BVINFRA00001', outputDir: path.join(root, 'blocked-output'), collectionId: collection.id, providerId: 'provider-test', modelId: 'model-test' });
  await manager.start(blockedSession.id);
  const blocked = await waitForStatus(manager, blockedSession.id, 'blocked');
  assert(blocked.content.includes('Agent 因基础设施故障停止') && blocked.content.includes('可能原因'), 'blocked Agent did not report the infrastructure problem and likely causes');
  assert(blocked.acceptNewTasks === false && store.getWorker(blocked.workerId)?.status === 'paused', 'blocked Agent continued accepting work');
  assert(store.getTask(blocked.singleTaskId)?.status === 'pending', 'infrastructure failure did not return the video task to pending');
  assert(infrastructureArtifactDir && !fs.existsSync(infrastructureArtifactDir), 'infrastructure failure left partial task files behind');
  assert(events.some((event) => event.type === 'infrastructure-stopped' && event.sessionId === blocked.id), 'infrastructure stop event was not emitted');
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
  fs.writeFileSync(path.join(directory, 'frames', 'frame-001.jpg'), 'fake-frame');
  fs.writeFileSync(path.join(directory, 'asr', 'asr-transcript.txt'), '[00:00] ASR 测试字幕');
  fs.writeFileSync(path.join(directory, 'subtitles', 'part-1.txt'), '[00:00] 站内测试字幕');
  fs.writeFileSync(path.join(directory, 'comments', 'comments.json'), JSON.stringify([{ message: '测试热评' }]));
}

function validMarkdown() {
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

### 测试章节 [00:00](https://www.bilibili.com/video/BV1234567890?t=0)

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
