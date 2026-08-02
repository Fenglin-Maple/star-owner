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
  const internalAgentManager = {
    running: new Map(),
    listSessions: () => [...sessions.values()],
    createSession: (input) => {
      const session = { id: `session-${sessions.size + 1}`, status: 'idle', ...input };
      sessions.set(session.id, session);
      return session;
    },
    start: async (id) => { const session = sessions.get(id); session.status = 'running'; return session; },
    stop: (id) => { const session = sessions.get(id); if (session) session.status = 'stopped'; return session; },
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
  fs.writeFileSync(path.join(partOne.preallocatedArtifactDir, 'summary.md'), '# P1\n', 'utf8');
  store.upsertTask({ ...partOne, status: 'done', outputMarkdown: path.join(partOne.preallocatedArtifactDir, 'summary.md'), completedAt: new Date().toISOString() });
  store.commit();
  manager.handleAgentEvent({ taskId: partOne.id, parentId: created.id });
  assert.strictEqual(manager.state().parents[0].completed, 1, '多P完成进度没有回写父任务');

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
  await manager.stop(created.id);
  assert(sessions.size === 2 && [...sessions.values()].every((item) => item.status === 'stopped'), '多P工作流停止没有生效');
  manager.handleAgentEvent({ type: 'session-finished', sessionId: 'session-1', status: 'stopped', parentId: created.id });
  assert.strictEqual(manager.state().parents[0].status, 'stopped', '多P会话结束后父任务状态没有保持为已停止');

  await manager.delete(created.id);
  assert.strictEqual(store.get('multiPartParents', created.id), null, '多P父任务没有删除');
  assert.strictEqual(store.listTasks({ collectionId: created.collectionId }).length, 0, '多P父任务删除后仍残留任务');
  assert.strictEqual(fs.existsSync(created.parentRoot || ''), false, '多P产物目录没有删除');
  fs.rmSync(root, { recursive: true, force: true });
  console.log('multipart manager test passed');
})().catch((error) => { console.error(error); process.exit(1); });

function page(number, cid, part) { return { page: number, cid, part, duration: 120 }; }
