const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Store } = require('../src/core/store');
const { SharedKnowledgeManager, DOCUMENT_META_FILE, MAX_SHARED_FILE_BYTES, validateShareableFiles, stableDocumentId, isShareableBilibiliTask } = require('../src/core/shared-knowledge-manager');
const { deleteCompletedDocument } = require('../src/core/document-lifecycle');

(async () => {
  const root = path.join(__dirname, '..', '.cache', 'shared-knowledge-test');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const store = await Store.open(path.join(root, 'test.sqlite'));
  const workspace = store.addWorkspace({ name: '共享测试', root: path.join(root, 'workspace') });
  store.setDefaultWorkspace(workspace.id);
  store.upsertUser({ id: 'bili-user', mid: 'bili-user', name: '测试B站用户' });
  const collection = store.upsertCollection({ id: 'bili-collection', mediaId: '100', userId: 'bili-user', userName: '测试B站用户', name: '测试收藏夹', collectionKind: 'bilibili', workspaceId: workspace.id, workspaceRoot: workspace.root, collectionRoot: path.join(workspace.root, '测试B站用户', '测试收藏夹'), syncReady: true, syncState: 'ready' });
  const artifact = path.join(collection.collectionRoot, 'BV-SHARED');
  fs.mkdirSync(artifact, { recursive: true });
  fs.writeFileSync(path.join(artifact, 'summary.md'), '# 共享测试\n\n这是可以上传的 B站总结。\n', 'utf8');
  fs.writeFileSync(path.join(artifact, 'cover.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  fs.writeFileSync(path.join(artifact, 'video.mp4'), Buffer.from('must not upload'));
  const task = { id: 'bili-task-1', collectionId: collection.id, bvid: 'BV1SHARED001', title: '共享测试视频', owner: 'UP主', status: 'done', outputMarkdown: path.join(artifact, 'summary.md'), artifactDir: artifact, completedAt: '2026-08-01T00:00:00.000Z' };
  store.upsertTask(task);
  const localArtifact = path.join(workspace.root, 'local-doc');
  fs.mkdirSync(localArtifact, { recursive: true });
  fs.writeFileSync(path.join(localArtifact, 'local.md'), '# 本地文档', 'utf8');
  store.upsertTask({ id: 'local-task', collectionId: collection.id, sourceType: 'local-document', status: 'done', outputMarkdown: path.join(localArtifact, 'local.md'), artifactDir: localArtifact });
  store.commit();

  const requests = [];
  const puts = [];
  const remoteRoot = '123456/bilibili-远程用户/远程收藏夹/remote-document';
  const remoteMeta = { schemaVersion: 2, documentId: 'remote-document', sourceType: 'bilibili-video-summary', bvid: 'BVREMOTE001', title: '远程共享视频', owner: '远程作者', collectionName: '远程收藏夹', parentDocumentId: '', partId: '', uploadedAt: '2026-08-01T00:00:00.000Z', completedAt: '2026-07-31T00:00:00.000Z' };
  const remoteFiles = new Map([
    [`${remoteRoot}/${DOCUMENT_META_FILE}`, Buffer.from(`${JSON.stringify(remoteMeta)}\n`, 'utf8')],
    [`${remoteRoot}/summary.md`, Buffer.from('# 远程共享视频\n', 'utf8')],
    [`${remoteRoot}/cover.png`, Buffer.from('89504e470d0a1a0a', 'hex')]
  ]);
  const request = async (endpoint, options = {}) => {
    requests.push({ endpoint, options });
    if (endpoint === '/user') return { login: 'alice', id: 123456 };
    if (endpoint.includes('/git/ref/heads/')) return { object: { sha: 'base-sha' } };
    if (endpoint === '/repos/alice/Blibili-Markdowns') { const error = new Error('not found'); error.status = 404; throw error; }
    if (endpoint.endsWith('/forks')) return { owner: { login: 'alice' }, name: 'Blibili-Markdowns' };
    if (options.method === 'POST' && endpoint.endsWith('/git/refs')) return { ref: 'refs/heads/test' };
    if (options.method === 'POST' && endpoint.endsWith('/pulls')) return { number: 7, html_url: 'https://github.com/Fenglin-Maple/Blibili-Markdowns/pull/7' };
    if (options.method === 'PUT' && endpoint.includes('/contents/')) {
      const remotePath = decodeContentPath(endpoint);
      puts.push({ remotePath, body: options.body });
      return { content: { path: remotePath } };
    }
    if (endpoint.includes('/git/trees/')) return { sha: 'tree-sha', tree: [...remoteFiles.keys()].map((item) => ({ type: 'blob', path: item, sha: `sha-${item}` })) };
    if (endpoint.includes('/contents/')) {
      const remotePath = decodeContentPath(endpoint);
      const body = remoteFiles.get(remotePath);
      if (!body) { const error = new Error('not found'); error.status = 404; throw error; }
      return { content: body.toString('base64'), encoding: 'base64', sha: `sha-${remotePath}` };
    }
    throw new Error(`unhandled mock endpoint: ${endpoint}`);
  };
  const manager = new SharedKnowledgeManager({
    store,
    encryptSecret: (value) => ({ mode: 'test', value }),
    decryptSecret: (secret) => secret.value,
    openExternal: async () => {},
    request
  });

  await manager.setToken('test-token');
  const browserStore = await Store.open(path.join(root, 'browser-auth.sqlite'));
  const browserManager = new SharedKnowledgeManager({
    store: browserStore,
    encryptSecret: (value) => ({ mode: 'test', value }),
    decryptSecret: (secret) => secret.value,
    request: async (endpoint) => endpoint === '/user' ? { login: 'browser-user', id: 654321 } : (() => { throw new Error(`unexpected browser endpoint: ${endpoint}`); })(),
    gitRuntime: { browserLogin: async () => ({ username: 'browser-user', password: 'browser-token' }), state: () => ({ available: true, isolated: true, path: 'test-git' }) }
  });
  const browserAuth = await browserManager.browserLogin();
  assert.strictEqual(browserAuth.authMethod, 'browser', '浏览器 GitHub 授权没有记录授权方式');
  assert.strictEqual(browserManager.state().login, 'browser-user', '浏览器授权没有保存 GitHub 用户');
  const stableOne = manager.prepareDocument({ ...task, id: 'task-id-one', githubUserId: '123456' });
  const stableTwo = manager.prepareDocument({ ...task, id: 'task-id-two', githubUserId: '123456' });
  assert.strictEqual(stableOne.documentId, stableTwo.documentId, 'stable shared document id changed with local task id');
  const upload = await manager.upload({ taskIds: [task.id] });
  assert.strictEqual(upload.prNumber, 7, '共享上传没有创建 PR');
  assert(puts.length > 0 && puts.every((item) => item.remotePath.startsWith('123456/')), '共享目录没有使用 GitHub 数字 ID');
  assert(puts.some((item) => item.remotePath.endsWith('summary.md')), '共享上传缺少 Markdown');
  assert(!puts.some((item) => item.remotePath.endsWith('video.mp4')), '共享上传错误包含原始视频');
  assert(puts.every((item) => /^123456\/(?:bilibili|single|multipart)\/col-[a-f0-9]+\//.test(item.remotePath)), '共享目录没有使用稳定来源收藏夹命名空间');
  assert.throws(() => validateShareableFiles([{ relative: 'too-large.png', buffer: Buffer.alloc(MAX_SHARED_FILE_BYTES + 1) }]), /单文件上限/);
  assert.throws(() => validateShareableFiles([{ relative: 'unsafe.exe', buffer: Buffer.from('x') }]), /不允许的文件/);
  assert.notStrictEqual(
    stableDocumentId({ bvid: task.bvid, sourceBilibiliUid: '9988', multiPartRole: 'parent', githubUserId: '123456' }, { id: 'multipart-one' }),
    stableDocumentId({ bvid: task.bvid, sourceBilibiliUid: '9988', multiPartRole: 'parent', githubUserId: '123456' }, { id: 'multipart-two' }),
    '不同多P收藏夹的同 BV 文档发生稳定 ID 串档'
  );
  assert.throws(() => manager.prepareDocument(store.getTask('local-task')), /只允许上传 B站/);
  assert.strictEqual(isShareableBilibiliTask({ bvid: task.bvid, sourceType: 'local-audio' }, collection), false, '带 BV 的本地音频记录绕过了共享来源校验');
  assert.strictEqual(isShareableBilibiliTask({ ...task, singleTask: true }, { ...collection, mediaId: '' , internal: true }), true, '内置单视频总结没有被识别为可共享来源');
  assert.strictEqual(isShareableBilibiliTask({ ...task, multiPartRole: 'parent' }, { ...collection, collectionKind: 'bilibili-multipart', internal: true, mediaId: '' }), true, '多P父任务没有被识别为可共享来源');
  assert.throws(() => manager.prepareDocument({ ...task, multiPartRole: 'part' }), /多P视频请从父任务目录上传/);

  const catalog = await manager.remoteCatalog();
  const secondRoot = remoteRoot.replace('remote-document', 'remote-document-2');
  const secondMeta = { ...remoteMeta, documentId: 'remote-document-2', title: 'remote second document' };
  remoteFiles.set(`${secondRoot}/${DOCUMENT_META_FILE}`, Buffer.from(`${JSON.stringify(secondMeta)}\n`, 'utf8'));
  remoteFiles.set(`${secondRoot}/summary.md`, Buffer.from('# remote second document\n', 'utf8'));
  assert.strictEqual(catalog.total, 1, '远程目录没有读取元数据文件');
  const mounted = await manager.mount({ documents: [{ path: 'renderer-forged/path/_star-owner-document.json' }], remotePrefix: remoteRoot, collectionName: '远程挂载' });
  assert.strictEqual(mounted.remoteDocumentCount, 1, '共享挂载没有记录远程文档');
  const sharedTask = store.listTasks({ collectionId: mounted.collectionId }).find((item) => item.sourceType === 'shared-bilibili');
  assert(sharedTask?.status === 'done' && fs.existsSync(sharedTask.outputMarkdown), '远程文档没有挂载为本地完成文档');
  await manager.syncMount(mounted.id, { documents: [] });
  assert.strictEqual(store.getTask(sharedTask.id).remoteState, 'remote-deleted', '远程删除没有保留本地文档并标记失效');
  assert(manager.state().collections.some((item) => item.collectionKind === 'shared'), '共享用户收藏夹没有暴露到状态');
  fs.rmSync(root, { recursive: true, force: true });
  const exactMount = await manager.mount({ documents: catalog.documents, paths: [catalog.documents[0].path], collectionName: 'single-document mount' });
  const secondDocument = { ...secondMeta, path: `${secondRoot}/${DOCUMENT_META_FILE}`, metadataPath: `${secondRoot}/${DOCUMENT_META_FILE}`, remoteSha: 'sha-second' };
  await manager.syncMount(exactMount.id, { documents: [catalog.documents[0], secondDocument] });
  assert.strictEqual(store.listTasks({ collectionId: exactMount.collectionId }).filter((item) => item.sourceType === 'shared-bilibili').length, 1, 'single-document mount expanded to a sibling document');

  const multiRoot = '123456/multipart/doc-multi';
  const multiMeta = {
    ...remoteMeta,
    documentId: 'doc-multi',
    title: '远程多P父任务',
    documentType: 'multipart-parent',
    multiPartRole: 'parent',
    parentDocumentId: 'doc-multi',
    partId: '',
    parts: [
      { cid: '201', page: 1, part: '第一 P', title: '远程多P父任务 P1', completedAt: '2026-08-01T00:00:00.000Z' },
      { cid: '202', page: 2, part: '第二 P', title: '远程多P父任务 P2', completedAt: '2026-08-01T00:00:00.000Z' }
    ]
  };
  remoteFiles.set(`${multiRoot}/${DOCUMENT_META_FILE}`, Buffer.from(`${JSON.stringify(multiMeta)}\n`, 'utf8'));
  remoteFiles.set(`${multiRoot}/index.md`, Buffer.from('# 远程多P父任务\n', 'utf8'));
  remoteFiles.set(`${multiRoot}/summary.md`, Buffer.from('# 不应作为多P父文档主入口\n', 'utf8'));
  remoteFiles.set(`${multiRoot}/parts/cid-201/summary.md`, Buffer.from('# 远程 P1\n', 'utf8'));
  remoteFiles.set(`${multiRoot}/parts/cid-202/summary.md`, Buffer.from('# 远程 P2\n', 'utf8'));
  const multiCatalog = await manager.remoteCatalog();
  const multiDocument = multiCatalog.documents.find((item) => item.documentId === 'doc-multi');
  assert(multiDocument, '远程多P父文档没有出现在目录');
  const multiMount = await manager.mount({ documents: multiCatalog.documents, remotePrefix: multiRoot, collectionName: '远程多P挂载' });
  const multiTasks = store.listTasks({ collectionId: multiMount.collectionId });
  const multiParent = multiTasks.find((item) => item.sourceType === 'shared-bilibili-multipart-summary' && item.multiPartRole === 'parent');
  const multiParts = multiTasks.filter((item) => item.sourceType === 'shared-bilibili-multipart-summary' && item.multiPartRole === 'part');
  assert(multiParent?.status === 'done' && multiParts.length === 2 && multiParts.every((item) => fs.existsSync(item.outputMarkdown)), '远程多P父文档或 P 子文档没有正确挂载');
  assert.strictEqual(path.basename(multiParent.outputMarkdown), 'index.md', '多P父文档没有优先使用 index.md');
  assert(multiParts.every((item) => item.parentDocumentId === multiParent.sharedDocumentId), '多P P 子文档没有绑定父文档 ID');
  await manager.syncMount(multiMount.id, { documents: [] });
  assert(store.getTask(multiParent.id).remoteState === 'remote-deleted' && multiParts.every((item) => store.getTask(item.id).remoteState === 'remote-deleted'), '远程删除没有标记多P父/子文档失效');

  const duplicateMount = await manager.mount({ remotePrefix: multiRoot, collectionId: multiMount.collectionId });
  assert.strictEqual(duplicateMount.id, multiMount.id, '重复挂载同一远程收藏夹没有复用原挂载');
  const importedParent = store.listTasks({ collectionId: multiMount.collectionId }).find((item) => item.multiPartRole === 'parent' && item.sourceType === 'shared-bilibili-multipart-summary');
  assert(importedParent, '重复挂载后没有恢复多P父文档');
  const deleted = deleteCompletedDocument({ store, taskId: importedParent.id });
  assert.strictEqual(deleted.removed, true, '共享多P父文档删除没有删除本地任务');
  assert(!store.getTask(importedParent.id) && !store.listTasks({ collectionId: multiMount.collectionId }).some((item) => item.multiPartParentId === importedParent.id), '共享多P父文档删除后仍残留 P 子任务');
  assert(store.list('sharedExclusions').length > 0, '删除共享文档没有生成本地排除记录');
  await manager.syncMount(multiMount.id, multiCatalog);
  assert(!store.listTasks({ collectionId: multiMount.collectionId }).some((item) => item.sharedRemotePath === multiDocument.path), '用户删除的共享文档被同步自动恢复');
  const restoredMount = await manager.mount({ remotePrefix: multiRoot, collectionId: multiMount.collectionId });
  assert.strictEqual(restoredMount.id, multiMount.id, '明确重新挂载没有复用原挂载');
  assert(store.listTasks({ collectionId: multiMount.collectionId }).some((item) => item.sharedRemotePath === multiDocument.path), '明确重新挂载没有恢复共享文档');

  const emptyManager = new SharedKnowledgeManager({
    store,
    encryptSecret: (value) => ({ mode: 'test', value }),
    decryptSecret: (secret) => secret.value,
    openExternal: async () => {},
    request: async (endpoint) => {
      if (endpoint.includes('/git/trees/')) { const error = new Error('Git Repository is empty.'); error.status = 409; throw error; }
      throw new Error(`unexpected empty repository endpoint: ${endpoint}`);
    },
    gitRuntime: { state: () => ({ available: true, isolated: true, path: 'test-git' }) }
  });
  const emptyCatalog = await emptyManager.remoteCatalog();
  assert.strictEqual(emptyCatalog.empty, true, 'empty GitHub repository was not represented as an empty catalog');
  assert.strictEqual(emptyCatalog.total, 0, 'empty GitHub repository returned a nonzero document count');

  const rollbackRoot = path.join(__dirname, '..', '.cache', 'shared-knowledge-rollback-test');
  fs.rmSync(rollbackRoot, { recursive: true, force: true });
  const rollbackStore = await Store.open(path.join(rollbackRoot, 'test.sqlite'));
  const rollbackWorkspace = rollbackStore.addWorkspace({ name: '回滚测试', root: path.join(rollbackRoot, 'workspace') });
  rollbackStore.setDefaultWorkspace(rollbackWorkspace.id);
  let rollbackCalls = 0;
  let rollbackMetadataRead = false;
  const rollbackManager = new SharedKnowledgeManager({
    store: rollbackStore,
    encryptSecret: (value) => ({ mode: 'test', value }),
    decryptSecret: (secret) => secret.value,
    request: async (endpoint) => {
      rollbackCalls += 1;
      if (endpoint.includes('/git/trees/')) return { sha: 'rollback-tree', tree: [{ type: 'blob', path: `${remoteRoot}/${DOCUMENT_META_FILE}`, sha: 'bad-meta' }] };
      if (endpoint.includes('/contents/') && !rollbackMetadataRead) {
        rollbackMetadataRead = true;
        return { content: Buffer.from(`${JSON.stringify(remoteMeta)}\n`, 'utf8').toString('base64'), encoding: 'base64', sha: 'bad-meta' };
      }
      if (endpoint.includes('/contents/')) throw new Error('模拟远程文档下载中断');
      throw new Error(`unhandled rollback endpoint: ${endpoint}`);
    },
    gitRuntime: { state: () => ({ available: true, isolated: true, path: 'test-git' }) }
  });
  await assert.rejects(() => rollbackManager.mount({ remotePrefix: remoteRoot, collectionName: '不会留下的挂载' }), /模拟远程文档下载中断/);
  assert.strictEqual(rollbackCalls > 0, true, '共享挂载回滚测试没有触发远程读取');
  assert(!rollbackStore.list('sharedMounts').length, '共享挂载失败后仍残留挂载记录');
  assert(!rollbackStore.listCollections().some((item) => item.collectionKind === 'shared'), '新建共享收藏夹在挂载失败后仍残留');
  fs.rmSync(rollbackRoot, { recursive: true, force: true });
  console.log('shared knowledge manager test passed');
})().catch((error) => { console.error(error); process.exit(1); });

function decodeContentPath(endpoint) {
  const marker = '/contents/';
  const start = endpoint.indexOf(marker) + marker.length;
  const raw = endpoint.slice(start).split('?')[0];
  return raw.split('/').map((part) => decodeURIComponent(part)).join('/');
}
