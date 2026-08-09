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
  let videoInfoCalls = 0;
  const cookieFile = path.join(root, 'bilibili-cookies.txt');
  fs.writeFileSync(cookieFile, '# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\ttest-session\n', 'utf8');
  const bili = {
    getVideoInfo: async () => {
      videoInfoCalls += 1;
      return { bvid: 'BV1MULTIPART', aid: '9001', title: '多P测试视频', owner: { mid: '42', name: '测试作者' }, pic: '', pages: currentPages, duration: 600, rights: {}, fetchedAt: new Date().toISOString() };
    },
    exportCookies: async () => cookieFile
  };
  const sessions = new Map();
  let failNextStart = false;
  let listSessionCalls = 0;
  const internalAgentManager = {
    running: new Map(),
    listSessions: () => { listSessionCalls += 1; return [...sessions.values()]; },
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
    getCurrentUser: () => ({ isLogin: true, id: '42', mid: '42', name: '测试作者', cookieFile }),
    emit: () => {}
  });

  assert.throws(() => assertMultipartVideoSupported({ url: 'https://www.bilibili.com/bangumi/play/ep1' }, { pages: [{ cid: '101' }, { cid: '102' }] }), /PGC/);
  assert.throws(() => assertMultipartVideoSupported({ bvid: 'BV1MULTIPART' }, { rights: { is_stein_gate: true } }), /互动视频/);

  const inspected = await manager.inspect({ bvid: 'BV1MULTIPART' });
  assert.strictEqual(inspected.pages.length, 3, '多P检查没有返回完整 P 列表');
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
  assert.strictEqual(videoInfoCalls, 1, '检查后立即创建多P父任务时重复请求了同一 BV 元数据');
  assert.strictEqual(created.sourceInfo, undefined, '父任务内部元数据快照暴露到了渲染层');
  for (const cid of ['101', '102', '103']) {
    const task = store.getTask(`${created.id}:part:${cid}`);
    const info = JSON.parse(fs.readFileSync(path.join(task.preallocatedArtifactDir, 'info.json'), 'utf8'));
    assert.strictEqual(info.cid, cid, `子 P ${cid} 没有复用父任务元数据`);
    assert.strictEqual(info.pages.length, 1, `子 P ${cid} 的元数据没有限定到当前 P`);
  }

  const partOne = store.getTask(`${created.id}:part:101`);
  fs.mkdirSync(partOne.preallocatedArtifactDir, { recursive: true });
  fs.mkdirSync(path.join(partOne.preallocatedArtifactDir, 'frames'), { recursive: true });
  fs.writeFileSync(path.join(partOne.preallocatedArtifactDir, 'frames', 'frame-001.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const parentRoot = path.resolve(partOne.preallocatedArtifactDir, '..', '..');
  fs.writeFileSync(path.join(parentRoot, 'cover.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(partOne.preallocatedArtifactDir, 'summary.md'), '# P1\n\n## 小结\n\n这是第一 P 应写入父目录的小结。\n\n![代表画面](frames/frame-001.jpg)\n\n### 小结内要点\n\n- 保留结构化要点。\n\n## 思维导图\n\n不应复制到父目录的小结区域。\n', 'utf8');
  store.upsertTask({ ...partOne, status: 'done', outputMarkdown: path.join(partOne.preallocatedArtifactDir, 'summary.md'), completedAt: new Date().toISOString() });
  store.commit();
  manager.handleAgentEvent({ taskId: partOne.id, parentId: created.id });
  assert.strictEqual(manager.state().parents[0].completed, 1, '多P完成进度没有回写父任务');
  const indexFile = path.join(partOne.preallocatedArtifactDir, '..', '..', 'index.md');
  const completedIndex = fs.readFileSync(indexFile, 'utf8');
  assert(fs.existsSync(path.join(parentRoot, 'cover.jpg')), 'multipart parent cover was not copied from the P1 frame');
  assert(!fs.existsSync(path.join(parentRoot, 'cover.png')), 'stale multipart parent cover extension was not removed');
  assert(completedIndex.includes('cover.jpg') && completedIndex.includes('!['), 'multipart index did not include a local cover reference');
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
  assert.strictEqual(store.getCollectionById(created.collectionId).cookieFile, cookieFile, '多P子任务没有继承当前 B站登录 Cookie');
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
  listSessionCalls = 0;
  for (let index = 0; index < 1000; index += 1) manager.handleAgentEvent({ type: 'stream', sessionId: sessionOne.id, parentId: created.id, mode: 'multipart' });
  assert.strictEqual(listSessionCalls, 0, '多P流式增量仍在每个 token 上扫描全部 Agent 会话');

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

  for (const taskId of [partTwo.id, partThree.id]) {
    const task = store.getTask(taskId);
    store.upsertTask({ ...task, status: 'pending', enabled: false, multiPartStopped: true, multiPartFailed: false, multiPartPhase: 'stopped' });
  }
  store.commit();
  const continued = await manager.start({ parentId: created.id, selectedPages: ['102', '103'], providerId: 'provider-multipart', modelId: 'model-multipart', concurrency: 2 });
  assert.strictEqual(continued.sessions.length, 2, 'batch continue did not restore all selected stopped P tasks');
  assert(['102', '103'].every((cid) => {
    const task = store.getTask(`${created.id}:part:${cid}`);
    return task.enabled === true && task.multiPartStopped === false;
  }), 'batch continue left a stopped P disabled');
  await manager.stop(created.id);

  for (const taskId of [partTwo.id, partThree.id]) {
    const task = store.getTask(taskId);
    store.upsertTask({ ...task, status: 'pending', enabled: false, multiPartStopped: false, multiPartFailed: true, multiPartFailureReason: 'simulated failure', multiPartPhase: 'failed; retry available' });
  }
  store.commit();
  manager.invalidatePartTaskCache(created.id);
  const failedParent = manager.state().parents.find((item) => item.id === created.id);
  assert.strictEqual(failedParent.failed, 2, 'failed P tasks were not exposed to the parent viewer');
  assert(failedParent.parts.filter((item) => ['102', '103'].includes(item.cid)).every((item) => item.displayStatus === 'failed'), 'failed P tasks did not expose retryable status');
  const retried = await manager.start({ parentId: created.id, selectedPages: ['102', '103'], providerId: 'provider-multipart', modelId: 'model-multipart', concurrency: 2 });
  assert.strictEqual(retried.sessions.length, 2, 'batch retry did not start all selected failed P tasks');
  assert(['102', '103'].every((cid) => store.getTask(`${created.id}:part:${cid}`).multiPartFailed === false), 'batch retry did not clear the previous failure marker');
  await manager.stop(created.id);

  // Completion is derived from the real standard artifacts, not only from the
  // database status. Exercise stale pointers, a missing child artifact, and multiple
  // parents sharing one collection so one parent's incomplete P cannot affect
  // the other parent's progress.
  const consistencyRoot = path.join(root, 'consistency');
  const completeParentId = 'multipart:consistency:complete';
  const incompleteParentId = 'multipart:consistency:incomplete';
  const stoppedParentId = 'multipart:consistency:stopped';
  const completeParentRoot = path.join(consistencyRoot, 'complete');
  const incompleteParentRoot = path.join(consistencyRoot, 'incomplete');
  const stoppedParentRoot = path.join(consistencyRoot, 'stopped');
  const completePartRoot = path.join(completeParentRoot, 'parts', 'cid-301');
  const incompletePartRoot = path.join(incompleteParentRoot, 'parts', 'cid-401');
  const stoppedPartRoot = path.join(stoppedParentRoot, 'parts', 'cid-501');
  fs.mkdirSync(completePartRoot, { recursive: true });
  fs.mkdirSync(incompletePartRoot, { recursive: true });
  fs.mkdirSync(stoppedPartRoot, { recursive: true });
  fs.writeFileSync(path.join(completePartRoot, 'summary.md'), '# 完整父任务 P1\n', 'utf8');
  fs.writeFileSync(path.join(stoppedPartRoot, 'summary.md'), '# 已停止父任务 P1\n', 'utf8');
  fs.writeFileSync(path.join(completeParentRoot, 'index.md'), '# 完整父任务目录\n', 'utf8');
  fs.writeFileSync(path.join(incompleteParentRoot, 'index.md'), '# 不完整父任务目录\n', 'utf8');
  fs.writeFileSync(path.join(stoppedParentRoot, 'index.md'), '# 已停止父任务目录\n', 'utf8');
  const makeParent = (id, bvid, title, parentRoot, cid) => ({
    id, parentDocumentId: id, bvid, title, owner: '测试作者', collectionId: created.collectionId,
    collectionName: created.collectionName, collectionKind: 'bilibili-multipart', parentRoot,
    pages: [{ page: 1, cid, part: `${title} P1`, duration: 120 }], selectedCids: [cid],
    settings: {}, status: 'completed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastRefreshedAt: new Date().toISOString()
  });
  store.set('multiPartParents', completeParentId, makeParent(completeParentId, 'BVCONSIST01', '完整父任务', completeParentRoot, '301'));
  store.set('multiPartParents', incompleteParentId, makeParent(incompleteParentId, 'BVCONSIST02', '不完整父任务', incompleteParentRoot, '401'));
  store.set('multiPartParents', stoppedParentId, {
    ...makeParent(stoppedParentId, 'BVCONSIST03', '已停止父任务', stoppedParentRoot, '501'),
    pages: [page(1, '501', '已完成 P'), page(2, '502', '待继续 P')],
    selectedCids: ['501', '502'],
    status: 'stopped'
  });
  store.upsertTask({ id: completeParentId, collectionId: created.collectionId, bvid: 'BVCONSIST01', title: '完整父任务 · 多P目录', status: 'done', outputMarkdown: path.join(completeParentRoot, 'stale-index.md'), artifactDir: completeParentRoot, multiPartRole: 'parent', multiPartParentId: completeParentId });
  store.upsertTask({ id: `${completeParentId}:part:301`, collectionId: created.collectionId, bvid: 'BVCONSIST01', title: '完整父任务 P1', status: 'done', outputMarkdown: path.join(completePartRoot, 'stale-summary.md'), artifactDir: completePartRoot, preallocatedArtifactDir: completePartRoot, multiPartRole: 'part', multiPartParentId: completeParentId, cid: '301', multiPartId: '301', page: 1, pageState: 'active' });
  store.upsertTask({ id: incompleteParentId, collectionId: created.collectionId, bvid: 'BVCONSIST02', title: '不完整父任务 · 多P目录', status: 'done', outputMarkdown: path.join(incompleteParentRoot, 'index.md'), artifactDir: incompleteParentRoot, multiPartRole: 'parent', multiPartParentId: incompleteParentId });
  store.upsertTask({ id: `${incompleteParentId}:part:401`, collectionId: created.collectionId, bvid: 'BVCONSIST02', title: '不完整父任务 P1', status: 'done', outputMarkdown: path.join(incompletePartRoot, 'summary.md'), artifactDir: incompletePartRoot, preallocatedArtifactDir: incompletePartRoot, multiPartRole: 'part', multiPartParentId: incompleteParentId, cid: '401', multiPartId: '401', page: 1, pageState: 'active' });
  store.upsertTask({ id: stoppedParentId, collectionId: created.collectionId, bvid: 'BVCONSIST03', title: '已停止父任务 · 多P目录', status: 'done', outputMarkdown: path.join(stoppedParentRoot, 'index.md'), artifactDir: stoppedParentRoot, multiPartRole: 'parent', multiPartParentId: stoppedParentId });
  store.upsertTask({ id: `${stoppedParentId}:part:501`, collectionId: created.collectionId, bvid: 'BVCONSIST03', title: '已停止父任务 P1', status: 'done', outputMarkdown: path.join(stoppedPartRoot, 'stale-summary.md'), artifactDir: stoppedPartRoot, preallocatedArtifactDir: stoppedPartRoot, multiPartRole: 'part', multiPartParentId: stoppedParentId, cid: '501', multiPartId: '501', page: 1, pageState: 'active' });
  store.upsertTask({ id: `${stoppedParentId}:part:502`, collectionId: created.collectionId, bvid: 'BVCONSIST03', title: '已停止父任务 P2', status: 'pending', outputMarkdown: '', artifactDir: '', preallocatedArtifactDir: path.join(stoppedParentRoot, 'parts', 'cid-502'), multiPartRole: 'part', multiPartParentId: stoppedParentId, cid: '502', multiPartId: '502', page: 2, pageState: 'active', multiPartStopped: true });
  store.commit();
  manager.invalidatePartTaskCache();
  const consistencyState = manager.state();
  const completeView = consistencyState.parents.find((item) => item.id === completeParentId);
  const incompleteView = consistencyState.parents.find((item) => item.id === incompleteParentId);
  const stoppedView = consistencyState.parents.find((item) => item.id === stoppedParentId);
  assert(completeView && completeView.completed === 1 && completeView.progress === 1, '完整多P父任务在同收藏夹存在其它父任务时没有保持完成状态');
  assert(store.getTask(`${completeParentId}:part:301`).outputMarkdown === path.join(completePartRoot, 'summary.md'), '多P完成子任务的失效 outputMarkdown 指针没有修正');
  assert(incompleteView && incompleteView.completed === 0 && incompleteView.parts[0].displayStatus === 'failed', '缺少真实 summary.md 的多P子任务仍被错误显示为完成');
  assert(store.get('multiPartParents', incompleteParentId).status !== 'completed', '产物缺失的多P父任务仍保留 completed 状态');
  assert(stoppedView && stoppedView.status === 'stopped' && store.getTask(`${stoppedParentId}:part:501`).outputMarkdown === path.join(stoppedPartRoot, 'summary.md'), '修正失效产物指针时错误清除了父任务的手动停止状态');
  for (const id of [completeParentId, incompleteParentId, stoppedParentId]) {
    store.delete('multiPartParents', id);
    for (const task of store.listTasks().filter((item) => item.id === id || item.multiPartParentId === id)) store.delete('tasks', task.id);
  }
  store.commit();

  await manager.delete(created.id);
  assert.strictEqual(store.get('multiPartParents', created.id), null, '多P父任务没有删除');
  assert.strictEqual(store.listTasks({ collectionId: created.collectionId }).length, 0, '多P父任务删除后仍残留任务');
  assert.strictEqual(fs.existsSync(created.parentRoot || ''), false, '多P产物目录没有删除');
  fs.rmSync(root, { recursive: true, force: true });
  console.log('multipart manager test passed');
})().catch((error) => { console.error(error); process.exit(1); });

function page(number, cid, part) { return { page: number, cid, part, duration: 120 }; }
