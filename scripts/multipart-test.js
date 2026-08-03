const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Store } = require('../src/core/store');
const { MultiPartManager, assertMultipartVideoSupported } = require('../src/core/multipart-manager');

(async () => {
  const root = path.join(__dirname, '..', '.cache', 'multipart-test');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const store = await Store.open(path.join(root, 'test.sqlite'));
  const workspace = store.addWorkspace({ name: '多P测试', root: path.join(root, 'workspace') });
  store.setDefaultWorkspace(workspace.id);
  store.set('ragProviders', 'provider-multipart', {
    id: 'provider-multipart',
    name: '模拟供应商',
    enabledModels: [{ id: 'model-multipart', name: '模拟模型' }]
  });
  store.save();

  let currentPages = [page(1, '101', '第一集'), page(2, '102', '第二集'), page(3, '103', '第三集')];
  const bili = { getVideoInfo: async () => ({ bvid: 'BV1MULTIPART', title: '多P测试视频', owner: { name: '测试作者' }, pic: '', pages: currentPages, duration: 600 }) };
  const sessions = new Map();
  let failNextStart = false;
  const internalAgentManager = {
    running: new Map(),
    listSessions: () => [...sessions.values()],
    createSession: (input) => {
      const sequence = sessions.size + 1;
      const session = { id: `session-${sequence}`, workerId: `worker-${sequence}`, status: 'idle', progress: 0, phase: '', currentTaskId: '', ...input };
      sessions.set(session.id, session);
      return session;
    },
    start: async (id) => {
      const session = sessions.get(id);
      if (failNextStart) {
        failNextStart = false;
        throw new Error('模拟补位工作流启动失败');
      }
      session.status = 'running';
      return session;
    },
    stop: (id) => {
      const session = sessions.get(id);
      if (!session) return null;
      session.status = 'stopped';
      if (session.currentTaskId) {
        const task = store.getTask(session.currentTaskId);
        if (task && task.status !== 'done') store.upsertTask({ ...task, status: 'pending', workId: '', claimedBy: '', claimedAt: '', leaseExpiresAt: '', artifactDir: '', updatedAt: new Date().toISOString() });
        session.currentTaskId = '';
      }
      store.commit();
      return session;
    },
    deleteSession: (id) => sessions.delete(id)
  };
  const manager = new MultiPartManager({
    store,
    bili,
    internalAgentManager,
    ragAssistant: { rawProvider: (id) => store.get('ragProviders', id) },
    emit: () => {}
  });

  assert.throws(() => assertMultipartVideoSupported({ url: 'https://www.bilibili.com/bangumi/play/ep1' }, { pages: [{ cid: '101' }, { cid: '102' }] }), /PGC/);
  assert.throws(() => assertMultipartVideoSupported({ bvid: 'BV1MULTIPART' }, { rights: { is_stein_gate: true } }), /互动视频/);

  const created = await manager.create({
    bvid: 'BV1MULTIPART',
    providerId: 'provider-multipart',
    modelId: 'model-multipart',
    collectionName: '多P测试收藏夹',
    selectedPages: ['101', '102', '103'],
    concurrency: 2,
    minimumFrames: 8
  });
  assert.strictEqual(created.total, 3, '多P父任务没有建立全部 P');
  assert.strictEqual(created.collectionKind, 'bilibili-multipart', '多P收藏夹类型错误');
  assert(created.parentDocumentId.includes('BV1MULTIPART'), '父任务稳定 ID 缺少 BV');

  const partOne = store.getTask(`${created.id}:part:101`);
  fs.mkdirSync(partOne.preallocatedArtifactDir, { recursive: true });
  fs.mkdirSync(path.join(partOne.preallocatedArtifactDir, 'frames'), { recursive: true });
  fs.writeFileSync(path.join(partOne.preallocatedArtifactDir, 'frames', 'frame-001.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  fs.writeFileSync(path.join(partOne.preallocatedArtifactDir, 'summary.md'), '# P1\n\n## 小结\n\n这是第一 P 应写入父目录的小结。\n\n![代表画面](frames/frame-001.jpg)\n\n### 小结内要点\n\n- 保留结构化要点。\n\n## 思维导图\n\n不应复制到父目录的小结区域。\n', 'utf8');
  store.upsertTask({ ...partOne, status: 'done', outputMarkdown: path.join(partOne.preallocatedArtifactDir, 'summary.md'), completedAt: new Date().toISOString() });
  store.commit();
  manager.handleAgentEvent({ taskId: partOne.id, parentId: created.id });
  assert.strictEqual(manager.state().parents[0].completed, 1, '多P完成进度没有回写父任务');
  const indexFile = path.join(partOne.preallocatedArtifactDir, '..', '..', 'index.md');
  const completedIndex = fs.readFileSync(indexFile, 'utf8');
  assert(completedIndex.includes('## 每 P 小结') && completedIndex.includes('这是第一 P 应写入父目录的小结。'), '父目录没有包含已完成 P 的小结');
  assert(completedIndex.includes('parts/cid-101/frames/frame-001.jpg'), '父目录中的 P 小结图片没有改写为相对父目录的路径');
  assert(completedIndex.includes('##### 小结内要点'), 'P 小结内部标题没有降级到父目录层级之下');
  assert(!completedIndex.includes('不应复制到父目录的小结区域。'), '父目录错误复制了 P 小结之后的正文');
  assert(completedIndex.includes('该 P 尚未完成；完成后会自动在这里写入小结。'), '父目录没有显示未完成 P 的小结占位状态');

  fs.writeFileSync(indexFile, '# 旧版目录\n', 'utf8');
  const startupManager = new MultiPartManager({
    store,
    bili,
    internalAgentManager,
    ragAssistant: { rawProvider: (id) => store.get('ragProviders', id) },
    emit: () => {}
  });
  assert(fs.readFileSync(indexFile, 'utf8').includes('这是第一 P 应写入父目录的小结。'), '应用启动时没有升级既有多P父目录');
  assert.strictEqual(startupManager.indexRefreshFailures.length, 0, '既有多P父目录启动刷新发生异常');

  currentPages = [...currentPages, page(4, '104', '追加集')];
  const added = await manager.refresh(created.id);
  assert(added.pages.some((item) => item.cid === '104'), '追加 P 没有刷新到父任务');
  assert.strictEqual(store.getTask(`${created.id}:part:104`).status, 'pending', '追加 P 没有进入待处理状态');

  currentPages = currentPages.filter((item) => item.cid !== '101');
  const removed = await manager.refresh(created.id);
  assert.strictEqual(removed.pages.some((item) => item.cid === '101'), false, '远程移除 P 仍显示为当前 P');
  assert.strictEqual(store.getTask(`${created.id}:part:101`).pageState, 'removed', '远程移除 P 没有标记失效');

  const started = await manager.start({ parentId: created.id, selectedPages: ['102', '103', '104'], providerId: 'provider-multipart', modelId: 'model-multipart', concurrency: 2 });
  assert.strictEqual(started.sessions.length, 2, '多P并发工作流数量没有按设置创建');
  assert(started.sessions.every((item) => item.mode === 'multipart' && item.multiPartParentId === created.id), '多P工作流没有绑定父任务');
  const sessionOne = sessions.get('session-1');
  const sessionTwo = sessions.get('session-2');
  const partTwo = store.getTask(`${created.id}:part:102`);
  const partThree = store.getTask(`${created.id}:part:103`);
  Object.assign(sessionOne, { currentTaskId: partTwo.id, progress: 0.42, phase: '模型正在撰写' });
  Object.assign(sessionTwo, { currentTaskId: partThree.id, progress: 0.18, phase: '下载视频 20%' });
  store.upsertTask({ ...partTwo, status: 'claimed', claimedBy: sessionOne.workerId, multiPartProgress: 0.42, multiPartPhase: sessionOne.phase });
  store.upsertTask({ ...partThree, status: 'claimed', claimedBy: sessionTwo.workerId, multiPartProgress: 0.18, multiPartPhase: sessionTwo.phase });
  store.commit();
  const livePart = manager.state().parents[0].parts.find((item) => item.cid === '102');
  assert(livePart.displayStatus === 'running' && livePart.progressPercent === 42 && livePart.phase === '模型正在撰写', '子 P 没有暴露独立实时进度和阶段');
  assert(manager.state().parents[0].progress > 0.25, '父任务总进度没有汇总正在运行的子 P 进度');

  failNextStart = true;
  const stoppedPart = await manager.stopPart({ parentId: created.id, cid: '102' });
  const stoppedTask = store.getTask(partTwo.id);
  assert(stoppedPart.stoppedPart.stopped === true && stoppedTask.status === 'pending' && stoppedTask.enabled === false, '单独停止子 P 没有回退并禁用目标任务');
  assert(sessions.get('session-2').status === 'running', '单独停止一个子 P 错误停止了其它正在工作的子 P');
  assert(stoppedPart.replacementSessions.length === 0 && stoppedPart.replacementWarning.includes('补位工作流未能启动'), '补位失败错误推翻了已经成功的单 P 停止操作');
  assert(![...sessions.values()].some((item) => item.status === 'idle'), '补位启动失败留下了不可用的空闲工作流');
  const replacements = await manager.ensureReplacementSessions(created.id);
  assert(replacements.length === 1 && replacements[0].status === 'running', '单独停止子 P 后没有补充工作流保持其它 P 继续处理');
  manager.handleAgentEvent({ type: 'session-finished', sessionId: 'session-1', status: 'stopped', parentId: created.id });
  assert(manager.state().parents[0].status === 'running', '单独停止子 P 后父任务错误停止');
  await manager.stop(created.id);
  assert(sessions.size === 3 && [...sessions.values()].every((item) => item.status === 'stopped'), '多P工作流停止没有生效');
  manager.handleAgentEvent({ type: 'session-finished', sessionId: 'session-1', status: 'stopped', parentId: created.id });
  assert.strictEqual(manager.state().parents[0].status, 'stopped', '多P会话结束后父任务状态没有保持为已停止');
  const resumed = await manager.start({ parentId: created.id, selectedPages: ['102'], providerId: 'provider-multipart', modelId: 'model-multipart', concurrency: 1 });
  assert(resumed.sessions.length === 1 && store.getTask(partTwo.id).enabled === true && store.getTask(partTwo.id).multiPartStopped === false, '已单独停止的子 P 无法重新选择并继续');
  await manager.stop(created.id);

  await manager.delete(created.id);
  assert.strictEqual(store.get('multiPartParents', created.id), null, '多P父任务没有删除');
  assert.strictEqual(store.listTasks({ collectionId: created.collectionId }).length, 0, '多P父任务删除后仍残留任务');
  assert.strictEqual(fs.existsSync(created.parentRoot || ''), false, '多P产物目录没有删除');
  fs.rmSync(root, { recursive: true, force: true });
  console.log('multipart manager test passed');
})().catch((error) => { console.error(error); process.exit(1); });

function page(number, cid, part) { return { page: number, cid, part, duration: 120 }; }
