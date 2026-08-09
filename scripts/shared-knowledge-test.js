const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Store } = require('../src/core/store');
const { SharedKnowledgeManager, DOCUMENT_META_FILE, MAX_SHARED_FILE_BYTES, MAX_SHARED_PR_DOCUMENTS, githubCommitAuthor, parseRepositoryInput, validateShareableFiles, stableDocumentId, isShareableBilibiliTask } = require('../src/core/shared-knowledge-manager');
const { deleteCompletedDocument } = require('../src/core/document-lifecycle');
const { sharedRepositoryTemplate } = require('../src/core/shared-repository-template');

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
  const finalMarkdown = path.join(artifact, '[BV-BV1SHARED001][标题-真实长文件名总结].md');
  fs.writeFileSync(finalMarkdown, '# 共享测试\n\n这是可以上传的 B站最终总结。\n', 'utf8');
  fs.writeFileSync(path.join(artifact, 'agent-draft-1.md'), '# Agent 过程草稿\n', 'utf8');
  fs.mkdirSync(path.join(artifact, 'asr'), { recursive: true });
  fs.writeFileSync(path.join(artifact, 'asr', 'asr-result.json'), '{"process":"cache"}\n', 'utf8');
  fs.writeFileSync(path.join(artifact, 'cover.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  fs.writeFileSync(path.join(artifact, 'video.mp4'), Buffer.from('must not upload'));
  const task = { id: 'bili-task-1', collectionId: collection.id, bvid: 'BV1SHARED001', title: '共享测试视频', owner: 'UP主', status: 'done', outputMarkdown: finalMarkdown, artifactDir: artifact, completedAt: '2026-08-01T00:00:00.000Z' };
  store.upsertTask(task);
  const localArtifact = path.join(workspace.root, 'local-doc');
  fs.mkdirSync(localArtifact, { recursive: true });
  fs.writeFileSync(path.join(localArtifact, 'local.md'), '# 本地文档', 'utf8');
  store.upsertTask({ id: 'local-task', collectionId: collection.id, sourceType: 'local-document', status: 'done', outputMarkdown: path.join(localArtifact, 'local.md'), artifactDir: localArtifact });
  store.commit();

  const requests = [];
  const puts = [];
  const sharedEvents = [];
  const remoteRoot = '123456/bilibili-远程用户/远程收藏夹/remote-document';
  const remoteSummary = Buffer.from('# 远程共享视频\n', 'utf8');
  const remoteCover = Buffer.from('89504e470d0a1a0a', 'hex');
  const remoteMeta = { schemaVersion: 3, documentId: 'remote-document', sourceType: 'bilibili-video-summary', documentType: 'single-video', bvid: 'BVREMOTE001', title: '远程共享视频', owner: '远程作者', collectionName: '远程收藏夹', parentDocumentId: '', partId: '', entryMarkdown: 'summary.md', contentSha256: sha256(remoteSummary), assetSha256: { 'cover.png': sha256(remoteCover) }, uploadedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', completedAt: '2026-07-31T00:00:00.000Z' };
  const repositoryMarker = (repository = 'Fenglin-Maple/Blibili-Markdowns', defaultBranch = 'main') => Buffer.from(`${JSON.stringify({ schemaVersion: 1, type: 'star-owner-shared-knowledge', repository, defaultBranch, capabilities: ['bilibili-summary', 'single-video-summary', 'multipart-summary', 'catalog-v1'] }, null, 2)}\n`, 'utf8');
  const remoteFiles = new Map([
    ['_star-owner-repository.json', repositoryMarker()],
    [`${remoteRoot}/${DOCUMENT_META_FILE}`, Buffer.from(`${JSON.stringify(remoteMeta)}\n`, 'utf8')],
    [`${remoteRoot}/summary.md`, remoteSummary],
    [`${remoteRoot}/cover.png`, remoteCover]
  ]);
  const request = async (endpoint, options = {}) => {
    requests.push({ endpoint, options });
    if (endpoint === '/user') return { login: 'alice', id: 123456 };
    if (endpoint === '/repos/Fenglin-Maple/Blibili-Markdowns') return { name: 'Blibili-Markdowns', default_branch: 'main', private: false, html_url: 'https://github.com/Fenglin-Maple/Blibili-Markdowns', owner: { login: 'Fenglin-Maple', id: 124229028 } };
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
      const body = remotePath === 'catalog.json' ? buildCatalog(remoteFiles) : remoteFiles.get(remotePath);
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
    request,
    emit: (event) => sharedEvents.push(event)
  });

  await manager.setToken('test-token');
  const browserStore = await Store.open(path.join(root, 'browser-auth.sqlite'));
  const browserManager = new SharedKnowledgeManager({
    store: browserStore,
    encryptSecret: (value) => ({ mode: 'test', value }),
    decryptSecret: (secret) => secret.value,
    request: async (endpoint) => endpoint === '/user' ? { login: 'browser-user', id: 654321 } : (() => { throw new Error(`unexpected browser endpoint: ${endpoint}`); })(),
    gitRuntime: { browserLogin: async () => ({ username: 'browser-user', password: 'browser-token' }), clearCredentialStore: async () => ({ cleared: true, scope: 'application-dpapi' }), state: () => ({ available: true, isolated: true, path: 'test-git' }) }
  });
  const browserAuth = await browserManager.browserLogin();
  assert.strictEqual(browserAuth.authMethod, 'browser', '浏览器 GitHub 授权没有记录授权方式');
  assert.strictEqual(browserManager.state().login, 'browser-user', '浏览器授权没有保存 GitHub 用户');
  assert.deepStrictEqual(githubCommitAuthor({ login: 'browser-user', id: 654321 }), { name: 'browser-user', email: '654321+browser-user@users.noreply.github.com' }, '共享提交没有绑定实际 GitHub 贡献者作者');
  const clearedBrowserAuth = await browserManager.clearToken();
  assert.strictEqual(clearedBrowserAuth.scope, 'application-only', '清除共享授权没有限制在星藏家应用范围');
  assert.strictEqual(clearedBrowserAuth.gitCredential.scope, 'application-dpapi', '清除共享授权没有清理内置 Git 私有凭据');
  assert.strictEqual(browserManager.state().authenticated, false, '清除共享授权后应用仍显示已授权');
  const githubAuthStore = await Store.open(path.join(root, 'github-auth-fallback.sqlite'));
  const githubAuthManager = new SharedKnowledgeManager({
    store: githubAuthStore,
    encryptSecret: (value) => ({ mode: 'test', value }),
    decryptSecret: (secret) => secret.value,
    gitRuntime: { state: () => ({ available: true, isolated: true, path: 'test-git' }) }
  });
  const originalFetch = global.fetch;
  const originalEnvironmentToken = process.env.STAR_OWNER_GITHUB_TOKEN;
  const githubFetches = [];
  try {
    delete process.env.STAR_OWNER_GITHUB_TOKEN;
    global.fetch = async (url, options = {}) => {
      githubFetches.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          content: Buffer.from(`${JSON.stringify({ schemaVersion: 1, generatedAt: '', total: 0, documents: [] })}\n`, 'utf8').toString('base64'),
          sha: 'anonymous-catalog'
        })
      };
    };
    const anonymousCatalog = await githubAuthManager.remoteCatalog();
    assert.strictEqual(anonymousCatalog.total, 0, '未登录时无法匿名读取公开共享目录');
    assert.strictEqual(githubFetches.length, 1, '匿名目录索引读取发出了额外 GitHub 请求');
    assert(!githubFetches[0].options.headers.authorization, '未登录的公开目录读取错误携带 Authorization 请求头');

    githubAuthStore.set('settings', 'sharedGithub', {
      id: 'sharedGithub',
      encryptedToken: { mode: 'test', value: 'expired-token' },
      login: 'expired-user',
      userId: '123456',
      authMethod: 'browser'
    });
    githubAuthStore.save();
    githubFetches.length = 0;
    global.fetch = async (url, options = {}) => {
      githubFetches.push({ url: String(url), options });
      return { ok: false, status: 401, text: async () => JSON.stringify({ message: 'Bad credentials' }) };
    };
    await assert.rejects(
      () => githubAuthManager.remoteCatalog(),
      (error) => error?.code === 'GITHUB_AUTH_INVALID' && /重新登录 GitHub/.test(error.message),
      '失效 GitHub Token 没有返回可操作的重新授权提示'
    );
    assert.strictEqual(githubFetches.length, 1, '失效 Token 的目录请求仍回退 Git Tree 或匿名重试');
    assert.strictEqual(githubFetches[0].options.headers.authorization, 'Bearer expired-token', '失效 Token 测试没有携带已保存授权');
  } finally {
    global.fetch = originalFetch;
    if (originalEnvironmentToken === undefined) delete process.env.STAR_OWNER_GITHUB_TOKEN;
    else process.env.STAR_OWNER_GITHUB_TOKEN = originalEnvironmentToken;
  }
  const stableOne = manager.prepareDocument({ ...task, id: 'task-id-one', githubUserId: '123456' });
  const stableTwo = manager.prepareDocument({ ...task, id: 'task-id-two', githubUserId: '123456' });
  assert.strictEqual(stableOne.documentId, stableTwo.documentId, 'stable shared document id changed with local task id');
  assert(stableOne.files.some((file) => file.relative === 'summary.md' && file.sourcePath && !file.buffer), '共享上传仍把所有文档资源长期保存在内存 Buffer 中');
  assert.strictEqual(stableOne.files.find((file) => file.relative === 'summary.md').sourcePath, finalMarkdown, '长文件名最终总结没有规范映射为 summary.md');
  assert.strictEqual(stableOne.metadata.entryMarkdown, 'summary.md', '共享元数据没有声明规范入口 Markdown');
  assert.strictEqual(stableOne.metadata.contentSha256, stableOne.metadata.markdownSha256['summary.md'], '正文哈希没有绑定最终总结 Markdown');
  assert(!stableOne.files.some((file) => /agent-draft|asr-result/i.test(file.relative) || (/\.json$/i.test(file.relative) && file.relative !== DOCUMENT_META_FILE)), '共享包错误包含 Agent 草稿、ASR 或过程 JSON');
  const multipartCollection = store.upsertCollection({ id: 'multipart-collection', userId: 'internal-user', userName: '内置用户', name: '多P共享测试', collectionKind: 'bilibili-multipart', internal: true, workspaceId: workspace.id, workspaceRoot: workspace.root, collectionRoot: path.join(workspace.root, '内置用户', '多P共享测试') });
  const multipartRoot = path.join(multipartCollection.collectionRoot, 'parent-BV1MULTIP001');
  const multipartPartRoot = path.join(multipartRoot, 'parts', 'cid-101');
  fs.mkdirSync(path.join(multipartPartRoot, 'frames'), { recursive: true });
  fs.writeFileSync(path.join(multipartRoot, 'index.md'), '# 多P目录\n\n- [P1](parts/cid-101/summary.md)\n', 'utf8');
  fs.writeFileSync(path.join(multipartPartRoot, 'summary.md'), '# P1 最终总结\n', 'utf8');
  fs.writeFileSync(path.join(multipartPartRoot, 'agent-draft-1.md'), '# P1 草稿\n', 'utf8');
  fs.writeFileSync(path.join(multipartPartRoot, 'frames', 'frame-001.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  fs.writeFileSync(path.join(multipartRoot, 'metadata.json'), `${JSON.stringify({ parts: [{ cid: '101', page: 1, part: '第一P', title: '多P共享测试 P1', duration: 60, status: 'done' }] })}\n`, 'utf8');
  const multipartParent = { id: 'multipart-parent', collectionId: multipartCollection.id, bvid: 'BV1MULTIP001', title: '多P共享测试', owner: 'UP主', status: 'done', outputMarkdown: path.join(multipartRoot, 'index.md'), artifactDir: multipartRoot, multiPartRole: 'parent', completedAt: '2026-08-01T00:00:00.000Z' };
  const multipartPart = { id: 'multipart-parent:part:101', collectionId: multipartCollection.id, bvid: multipartParent.bvid, title: '多P共享测试 P1', owner: 'UP主', status: 'done', outputMarkdown: path.join(multipartPartRoot, 'summary.md'), artifactDir: multipartPartRoot, multiPartRole: 'part', multiPartParentId: multipartParent.id, multiPartId: '101', cid: '101', page: 1, pageState: 'active' };
  store.upsertTask(multipartParent);
  store.upsertTask(multipartPart);
  const multipartPackage = manager.prepareDocument({ ...multipartParent, githubUserId: '123456' });
  assert.deepStrictEqual(multipartPackage.files.filter((file) => /\.md$/i.test(file.relative)).map((file) => file.relative).sort(), ['index.md', 'parts/cid-101/summary.md'], '多P共享包没有规范化目录和 P 正文');
  assert(multipartPackage.files.some((file) => file.relative === 'parts/cid-101/frames/frame-001.png'), '多P共享包遗漏 P 总结图片');
  assert(!multipartPackage.files.some((file) => /agent-draft|metadata\.json/i.test(file.relative)), '多P共享包包含过程草稿或本地元数据');
  assert.strictEqual(multipartPackage.metadata.entryMarkdown, 'index.md', '多P共享包入口不是 index.md');
  const siblingParent = { ...multipartParent, id: 'multipart-sibling-parent', bvid: 'BV1MULTIP002', title: '同收藏夹未完成父任务', outputMarkdown: path.join(multipartRoot, 'missing-sibling-index.md') };
  const siblingPart = { ...multipartPart, id: 'multipart-sibling-parent:part:201', bvid: siblingParent.bvid, cid: '201', multiPartId: '201', multiPartParentId: siblingParent.id, status: 'pending', outputMarkdown: '' };
  store.upsertTask(siblingParent);
  store.upsertTask(siblingPart);
  store.upsertTask({ ...multipartPart, outputMarkdown: path.join(multipartPartRoot, 'stale-summary-pointer.md') });
  store.commit();
  const fallbackPackage = manager.prepareDocument({ ...multipartParent, outputMarkdown: path.join(multipartRoot, 'stale-index-pointer.md') });
  assert(fallbackPackage.files.some((file) => file.relative === 'index.md' && file.sourcePath === path.join(multipartRoot, 'index.md')), '多P父任务没有从标准位置恢复失效的 index.md 指针');
  assert(fallbackPackage.files.some((file) => file.relative === 'parts/cid-101/summary.md' && file.sourcePath === path.join(multipartPartRoot, 'summary.md')), '多P子任务没有从标准位置恢复失效的 summary.md 指针');
  assert(!fallbackPackage.files.some((file) => file.relative.includes('cid-201')), '同收藏夹其它未完成父任务错误混入当前多P共享包');
  assert.strictEqual(MAX_SHARED_PR_DOCUMENTS, 1000, '共享上传单批数量没有提升到 1000 篇');
  assert.deepStrictEqual(parseRepositoryInput('https://github.com/example/shared-docs.git'), { owner: 'example', name: 'shared-docs', branch: '' }, '共享仓库 URL 解析失败');
  const upload = await manager.upload({ taskIds: [task.id] });
  assert.strictEqual(upload.prNumber, 7, '共享上传没有创建 PR');
  assert(puts.length > 0 && puts.every((item) => item.remotePath.startsWith('123456/')), '共享目录没有使用 GitHub 数字 ID');
  assert(puts.some((item) => item.remotePath.endsWith('summary.md')), '共享上传缺少 Markdown');
  const uploadedSummary = puts.find((item) => item.remotePath.endsWith('summary.md'));
  assert(Buffer.from(uploadedSummary.body.content, 'base64').toString('utf8').includes('最终总结'), '共享上传把过程草稿当成了最终正文');
  const uploadedMetadata = puts.find((item) => item.remotePath.endsWith(DOCUMENT_META_FILE));
  assert.strictEqual(JSON.parse(Buffer.from(uploadedMetadata.body.content, 'base64').toString('utf8')).contributorGithubLogin, 'alice', '共享元数据没有保存可读的 GitHub 用户名');
  assert(!puts.some((item) => item.remotePath.endsWith('video.mp4')), '共享上传错误包含原始视频');
  assert(!puts.some((item) => /agent-draft|\/asr\/|\/subtitles\/|\/comments\//i.test(item.remotePath)), '共享上传错误包含过程缓存');
  assert(puts.every((item) => /^123456\/(?:bilibili|single|multipart)\/col-[a-f0-9]+\//.test(item.remotePath)), '共享目录没有使用稳定来源收藏夹命名空间');
  let ownerPullRequest = null;
  manager.requestOverride = async (endpoint, options = {}) => {
    if (endpoint === '/user') return { login: 'Fenglin-Maple', id: 998877 };
    if (endpoint === '/repos/Fenglin-Maple/Blibili-Markdowns') return { name: 'Blibili-Markdowns', default_branch: 'main', private: false, html_url: 'https://github.com/Fenglin-Maple/Blibili-Markdowns', owner: { login: 'Fenglin-Maple', id: 998877 } };
    if (endpoint.includes('/git/ref/heads/')) return { object: { sha: 'owner-base-sha' } };
    if (endpoint.endsWith('/branches/main/protection')) {
      if (options.method === 'PUT') return { url: endpoint };
      const error = new Error('not protected'); error.status = 404; throw error;
    }
    if (options.method === 'POST' && endpoint.endsWith('/git/refs')) return { ref: options.body.ref };
    if (options.method === 'PUT' && endpoint.includes('/contents/')) return { content: { path: decodeContentPath(endpoint) } };
    if (endpoint.includes('/contents/')) {
      const remotePath = decodeContentPath(endpoint);
      if (remotePath === '_star-owner-repository.json') return { content: repositoryMarker().toString('base64'), encoding: 'base64', sha: 'owner-marker' };
      const error = new Error('not found'); error.status = 404; throw error;
    }
    if (options.method === 'POST' && endpoint.endsWith('/pulls')) { ownerPullRequest = options.body; return { number: 8, html_url: 'https://github.com/Fenglin-Maple/Blibili-Markdowns/pull/8' }; }
    throw new Error(`unhandled owner endpoint: ${endpoint}`);
  };
  await manager.setToken('owner-token');
  const ownerUpload = await manager.upload({ taskIds: [task.id] });
  assert.strictEqual(ownerUpload.prNumber, 8, '共享仓库主人没有直接创建分支 PR');
  assert(ownerPullRequest?.head?.startsWith('star-owner/') && !ownerPullRequest.head.includes(':'), '共享仓库主人仍使用了 Fork head 格式');
  manager.requestOverride = request;
  await manager.setToken('test-token');
  const conflictingForkManager = new SharedKnowledgeManager({
    store,
    encryptSecret: (value) => ({ mode: 'test', value }),
    decryptSecret: (secret) => secret.value,
    request: async (endpoint) => endpoint === '/repos/alice/Blibili-Markdowns' ? { fork: false, full_name: 'alice/Blibili-Markdowns' } : (() => { throw new Error(`unexpected conflicting endpoint: ${endpoint}`); })(),
    gitRuntime: { state: () => ({ available: true, isolated: true, path: 'test-git' }) }
  });
  await assert.rejects(() => conflictingForkManager.ensureFork('alice', 'test-token'), /同名但不是共享仓库 Fork/);
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

  const repositoryStore = await Store.open(path.join(root, 'repository-settings.sqlite'));
  const initializedFiles = [];
  const initializedContents = new Map();
  const protectionBodies = [];
  const statusCheckBodies = [];
  let existingProtection = null;
  const repositoryEvents = [];
  const repositoryManager = new SharedKnowledgeManager({
    store: repositoryStore,
    encryptSecret: (value) => ({ mode: 'test', value }),
    decryptSecret: (secret) => secret.value,
    request: async (endpoint, options = {}) => {
      if (endpoint === '/user') return { login: 'repo-owner', id: 778899 };
      if (endpoint === '/repos/example/shared-docs') return { name: 'shared-docs', default_branch: 'trunk', private: false, html_url: 'https://github.com/example/shared-docs', owner: { login: 'example', id: 112233 } };
      if (endpoint === '/repos/example/not-star-owner') return { name: 'not-star-owner', default_branch: 'main', private: false, html_url: 'https://github.com/example/not-star-owner', owner: { login: 'example', id: 112233 } };
      if (endpoint === '/user/repos' && options.method === 'POST') return { name: options.body.name, default_branch: 'main', private: false, html_url: `https://github.com/repo-owner/${options.body.name}`, owner: { login: 'repo-owner', id: 778899 } };
      if (endpoint.includes('/repos/example/shared-docs/contents/')) {
        const remotePath = decodeContentPath(endpoint);
        if (remotePath === '_star-owner-repository.json') return { content: repositoryMarker('example/shared-docs', 'trunk').toString('base64'), encoding: 'base64', sha: 'example-marker' };
        const error = new Error('not found'); error.status = 404; throw error;
      }
      if (endpoint.includes('/repos/example/not-star-owner/contents/')) { const error = new Error('not found'); error.status = 404; throw error; }
      if (endpoint.includes('/repos/repo-owner/star-owner-shared/contents/')) {
        const remotePath = decodeContentPath(endpoint);
        if (options.method === 'PUT') { initializedFiles.push(remotePath); initializedContents.set(remotePath, Buffer.from(options.body.content, 'base64')); return { content: { path: remotePath } }; }
        if (initializedContents.has(remotePath)) return { content: initializedContents.get(remotePath).toString('base64'), encoding: 'base64', sha: `initialized-${remotePath}` };
        const error = new Error('not found'); error.status = 404; throw error;
      }
      if (options.method === 'POST' && endpoint.endsWith('/branches/main/protection/required_status_checks/contexts')) {
        statusCheckBodies.push({ method: options.method, body: options.body });
        existingProtection = {
          ...existingProtection,
          required_status_checks: {
            ...existingProtection.required_status_checks,
            contexts: [...new Set([...(existingProtection.required_status_checks?.contexts || []), ...(options.body.contexts || [])])]
          }
        };
        return options.body;
      }
      if (endpoint.endsWith('/branches/main/protection')) {
        if (options.method !== 'PUT') {
          if (existingProtection) return existingProtection;
          const error = new Error('not protected'); error.status = 404; throw error;
        }
        protectionBodies.push(options.body);
        existingProtection = options.body;
        return { url: endpoint };
      }
      throw new Error(`unexpected repository endpoint: ${endpoint}`);
    },
    gitRuntime: { state: () => ({ available: true, isolated: true, path: 'test-git' }) },
    emit: (event) => repositoryEvents.push(event)
  });
  const switched = await repositoryManager.setRepository({ repository: 'https://github.com/example/shared-docs' });
  assert.strictEqual(switched.repository.branch, 'trunk', '切换共享仓库没有读取远程默认分支');
  await assert.rejects(() => repositoryManager.setRepository({ repository: 'example/not-star-owner' }), /不是星藏家共享文档仓库/);
  assert.strictEqual(repositoryManager.repository.name, 'shared-docs', '非规范仓库校验失败后仍覆盖了当前共享仓库');
  assert(!repositoryManager.state().repositories.some((item) => item.name === 'not-star-owner'), '非规范仓库被写入已验证仓库下拉注册表');
  await repositoryManager.setToken('repo-token');
  const createdRepository = await repositoryManager.createRepository({ name: 'star-owner-shared' });
  assert.strictEqual(createdRepository.repository.ownerId, '778899', '个人共享仓库没有绑定当前 GitHub 数字 ID');
  assert(createdRepository.contract.requiredValidation === true && createdRepository.contract.requiredValidationContext === 'validate-shared-docs', '个人共享仓库没有启用合并前必需校验');
  assert(protectionBodies.length === 1 && protectionBodies[0].required_status_checks?.contexts?.includes('validate-shared-docs'), '一键建仓没有通过 GitHub API 设置 validate-shared-docs 必需检查');
  existingProtection = {
    required_status_checks: { strict: false, contexts: ['existing-ci'] },
    required_pull_request_reviews: { required_approving_review_count: 2, require_code_owner_reviews: true },
    enforce_admins: { enabled: true }
  };
  await repositoryManager.configureRequiredValidation(createdRepository.repository, 'repo-token');
  assert(statusCheckBodies.length === 1 && statusCheckBodies[0].method === 'POST' && statusCheckBodies[0].body.contexts.length === 1 && statusCheckBodies[0].body.contexts[0] === 'validate-shared-docs', '已有分支保护没有通过追加接口加入共享校验');
  assert.strictEqual(protectionBodies.length, 1, '已有分支保护被整体 PUT 覆盖，可能清除审核或仓库限制规则');
  assert.strictEqual(existingProtection.required_pull_request_reviews.required_approving_review_count, 2, '追加必需检查时破坏了已有 PR 审核规则');
  await repositoryManager.configureRequiredValidation(createdRepository.repository, 'repo-token');
  assert.strictEqual(statusCheckBodies.length, 1, '已经存在的共享必需检查被重复写入');
  assert(initializedFiles.includes('README.md') && initializedFiles.includes('.github/workflows/validate-shared-docs.yml') && initializedFiles.includes('scripts/build-catalog.mjs'), '个人共享仓库缺少 README、GitHub Action 或目录脚本');
  assert(repositoryManager.state().repositories.some((item) => item.owner === 'repo-owner' && item.name === 'star-owner-shared' && item.verified), '验证通过的共享仓库没有加入仓库下拉注册表');
  assert(repositoryEvents.some((event) => event.type === 'shared-operation-progress' && event.operation?.type === 'repository-create' && event.operation.progress > 0), '一键建仓没有发出可显示的进度事件');
  assert(repositoryEvents.some((event) => event.type === 'shared-operation-finished' && event.operation?.status === 'completed'), '共享仓库操作没有发出完成事件');
  const templateRoot = path.join(root, 'template-check');
  for (const file of sharedRepositoryTemplate({ owner: 'repo-owner', name: 'star-owner-shared' })) {
    const target = path.join(templateRoot, file.relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.buffer);
  }
  for (const file of stableOne.files) {
    const target = path.join(templateRoot, stableOne.remoteRoot, file.relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.buffer || fs.readFileSync(file.sourcePath));
  }
  for (const file of multipartPackage.files) {
    const target = path.join(templateRoot, multipartPackage.remoteRoot, file.relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.buffer || fs.readFileSync(file.sourcePath));
  }
  execFileSync(process.execPath, ['--check', path.join(templateRoot, 'scripts', 'validate-shared-docs.mjs')]);
  execFileSync(process.execPath, ['--check', path.join(templateRoot, 'scripts', 'build-catalog.mjs')]);
  execFileSync(process.execPath, ['--check', path.join(templateRoot, 'scripts', 'publish-shared-catalog.mjs')]);
  execFileSync(process.execPath, [path.join(templateRoot, 'scripts', 'validate-shared-docs.mjs')], { cwd: templateRoot, stdio: 'pipe' });
  const templateSummary = path.join(templateRoot, stableOne.remoteRoot, 'summary.md');
  fs.appendFileSync(templateSummary, '\n被篡改的正文\n', 'utf8');
  assert.throws(() => execFileSync(process.execPath, [path.join(templateRoot, 'scripts', 'validate-shared-docs.mjs')], { cwd: templateRoot, stdio: 'pipe' }), '共享仓库校验脚本没有发现正文 SHA-256 不匹配');
  fs.writeFileSync(templateSummary, fs.readFileSync(finalMarkdown));
  fs.writeFileSync(path.join(templateRoot, 'unlisted.md'), '# 不允许的仓库根文件\n', 'utf8');
  assert.throws(() => execFileSync(process.execPath, [path.join(templateRoot, 'scripts', 'validate-shared-docs.mjs')], { cwd: templateRoot, stdio: 'pipe' }), '共享仓库校验脚本允许了白名单外文件');
  fs.rmSync(path.join(templateRoot, 'unlisted.md'), { force: true });
  const bundledGit = path.join(__dirname, '..', 'runtime', 'git', 'cmd', process.platform === 'win32' ? 'git.exe' : 'git');
  if (fs.existsSync(bundledGit)) {
    execFileSync(bundledGit, ['init', '-b', 'main'], { cwd: templateRoot, stdio: 'pipe' });
    execFileSync(bundledGit, ['-c', 'user.name=Star Owner Test', '-c', 'user.email=test@example.invalid', 'add', '--all'], { cwd: templateRoot, stdio: 'pipe' });
    execFileSync(bundledGit, ['-c', 'user.name=Star Owner Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'baseline'], { cwd: templateRoot, stdio: 'pipe' });
    const baseSha = execFileSync(bundledGit, ['rev-parse', 'HEAD'], { cwd: templateRoot, encoding: 'utf8' }).trim();
    fs.appendFileSync(templateSummary, '\nPR 作者身份测试。\n', 'utf8');
    const templateMetadataFile = path.join(templateRoot, stableOne.remoteRoot, DOCUMENT_META_FILE);
    const templateMetadata = JSON.parse(fs.readFileSync(templateMetadataFile, 'utf8'));
    templateMetadata.contentSha256 = sha256(fs.readFileSync(templateSummary));
    templateMetadata.markdownSha256['summary.md'] = templateMetadata.contentSha256;
    fs.writeFileSync(templateMetadataFile, `${JSON.stringify(templateMetadata, null, 2)}\n`, 'utf8');
    execFileSync(bundledGit, ['-c', 'user.name=Star Owner Test', '-c', 'user.email=test@example.invalid', 'add', '--all'], { cwd: templateRoot, stdio: 'pipe' });
    execFileSync(bundledGit, ['-c', 'user.name=Star Owner Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'docs: update own contribution'], { cwd: templateRoot, stdio: 'pipe' });
    const eventFile = path.join(root, 'pull-request-event.json');
    fs.writeFileSync(eventFile, `${JSON.stringify({ pull_request: { base: { sha: baseSha }, user: { id: 123456 } }, sender: { id: 999999 } })}\n`, 'utf8');
    const validatorEnv = { ...process.env, PATH: `${path.dirname(bundledGit)}${path.delimiter}${process.env.PATH || ''}`, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventFile };
    execFileSync(process.execPath, [path.join(templateRoot, 'scripts', 'validate-shared-docs.mjs')], { cwd: templateRoot, env: validatorEnv, stdio: 'pipe' });
    fs.writeFileSync(eventFile, `${JSON.stringify({ pull_request: { base: { sha: baseSha }, user: { id: 888888 } }, sender: { id: 123456 } })}\n`, 'utf8');
    assert.throws(() => execFileSync(process.execPath, [path.join(templateRoot, 'scripts', 'validate-shared-docs.mjs')], { cwd: templateRoot, env: validatorEnv, stdio: 'pipe' }), '共享仓库校验错误信任 sender 或 workflow actor 身份');
    fs.rmSync(eventFile, { force: true });
  }
  const trunkTemplate = sharedRepositoryTemplate({ owner: 'repo-owner', name: 'trunk-shared', branch: 'trunk' });
  const trunkWorkflow = trunkTemplate.find((file) => file.relative === '.github/workflows/validate-shared-docs.yml')?.buffer.toString('utf8') || '';
  assert(trunkWorkflow.includes('branches: ["trunk"]'), '一键建仓模板没有使用仓库实际默认分支');
  assert(trunkWorkflow.includes('name: validate-shared-docs'), '共享校验 Action 没有稳定的必需检查名称');
  const validatorTemplate = trunkTemplate.find((file) => file.relative === 'scripts/validate-shared-docs.mjs')?.buffer.toString('utf8') || '';
  const catalogWorkflow = trunkTemplate.find((file) => file.relative === '.github/workflows/build-catalog.yml')?.buffer.toString('utf8') || '';
  assert(catalogWorkflow.includes('name: build-shared-catalog'), '共享目录 Action 没有稳定的工作名称');
  const catalogScript = trunkTemplate.find((file) => file.relative === 'scripts/build-catalog.mjs')?.buffer.toString('utf8') || '';
  const publishCatalogScript = trunkTemplate.find((file) => file.relative === 'scripts/publish-shared-catalog.mjs')?.buffer.toString('utf8') || '';
  assert(validatorTemplate.includes('event.pull_request?.user?.id') && !validatorTemplate.includes('GITHUB_ACTOR_ID'), '共享校验没有使用 Pull Request 真实作者 ID');
  assert(catalogWorkflow.includes('concurrency:')
    && catalogWorkflow.includes('name: build-shared-catalog')
    && catalogWorkflow.includes('checks: read')
    && catalogWorkflow.includes('pull-requests: write')
    && catalogWorkflow.includes('statuses: write')
    && catalogWorkflow.includes('GITHUB_TOKEN: ${{ github.token }}')
    && catalogWorkflow.includes('publish-shared-catalog.mjs'), '共享目录 Action 缺少保护分支发布权限、令牌注入或发布脚本');
  assert(publishCatalogScript.includes(':refs/heads/')
    && publishCatalogScript.includes("context = 'validate-shared-docs'")
    && publishCatalogScript.includes('GITHUB_API_URL')
    && publishCatalogScript.includes('reportValidatedCommit'), '共享目录发布脚本没有先验证临时提交再推进保护分支');
  assert(catalogScript.includes('totalBytes:') && catalogScript.includes('fileCount:'), '共享目录没有提供挂载容量预检字段');

  const privateStore = await Store.open(path.join(root, 'private-repository.sqlite'));
  let privateTreeAuthorized = false;
  let privateContentAuthorized = false;
  let privateCatalogAuthorized = false;
  const privateRemoteRoot = '778899/bilibili/col-aaaaaaaaaaaaaaaaaaaaaaaa/doc-bbbbbbbbbbbbbbbbbbbbbbbb';
  const privateMetadata = { ...remoteMeta, documentId: 'doc-bbbbbbbbbbbbbbbbbbbbbbbb', contributorGithubId: '778899' };
  const privateManager = new SharedKnowledgeManager({
    store: privateStore,
    encryptSecret: (value) => ({ mode: 'test', value }),
    decryptSecret: (secret) => secret.value,
    request: async (endpoint, options = {}) => {
      if (endpoint === '/user') return { login: 'private-user', id: 778899 };
      if (endpoint === '/repos/private-user/private-shared') return { name: 'private-shared', default_branch: 'main', private: true, html_url: 'https://github.com/private-user/private-shared', owner: { login: 'private-user', id: 778899 } };
      if (endpoint.endsWith('/branches/main/protection')) {
        if (options.method === 'PUT') return { url: endpoint };
        const error = new Error('not protected'); error.status = 404; throw error;
      }
      if (endpoint.includes('/git/trees/')) {
        privateTreeAuthorized = options.token === 'private-token';
        return { sha: 'private-tree', tree: [{ type: 'blob', path: `${privateRemoteRoot}/${DOCUMENT_META_FILE}`, sha: 'private-meta' }] };
      }
      if (endpoint.includes('/contents/')) {
        privateContentAuthorized = options.token === 'private-token';
        const remotePath = decodeContentPath(endpoint);
        if (remotePath === '_star-owner-repository.json') return { content: repositoryMarker('private-user/private-shared').toString('base64'), encoding: 'base64', sha: 'private-marker' };
        if (remotePath === 'catalog.json') {
          privateCatalogAuthorized = options.token === 'private-token';
          const privateFiles = new Map([[`${privateRemoteRoot}/${DOCUMENT_META_FILE}`, Buffer.from(`${JSON.stringify(privateMetadata)}\n`, 'utf8')]]);
          return { content: buildCatalog(privateFiles).toString('base64'), encoding: 'base64', sha: 'private-catalog' };
        }
        return { content: Buffer.from(`${JSON.stringify(privateMetadata)}\n`, 'utf8').toString('base64'), encoding: 'base64', sha: 'private-meta' };
      }
      throw new Error(`unexpected private repository endpoint: ${endpoint}`);
    },
    gitRuntime: { state: () => ({ available: true, isolated: true, path: 'test-git' }) }
  });
  await privateManager.setToken('private-token');
  await privateManager.setRepository({ repository: 'private-user/private-shared' });
  const privateCatalog = await privateManager.remoteCatalog();
  assert.strictEqual(privateCatalog.total, 1, '已授权私有共享仓库目录无法读取');
  assert(!privateTreeAuthorized && privateCatalogAuthorized && privateContentAuthorized, '私有共享仓库目录索引没有使用星藏家私有授权');

  manager.requestOverride = request;
  await manager.setToken('test-token');
  const canceledUpload = manager.upload({ taskIds: [task.id] });
  const cancelResult = manager.cancelUpload();
  assert.strictEqual(cancelResult.canceled, true, '共享上传事务无法由用户中止');
  await assert.rejects(() => canceledUpload, /已由用户中止/);
  assert.strictEqual(manager.state().upload, null, '中止共享上传后仍残留活动事务');

  let snapshotDownloads = 0;
  manager.gitRuntime = createSnapshotRuntime(remoteFiles, () => { snapshotDownloads += 1; });

  requests.length = 0;
  const catalog = await manager.remoteCatalog();
  assert.strictEqual(catalog.catalogSource, 'index', '远程目录没有优先使用 Action 生成的 catalog.json');
  assert(!requests.some((item) => item.endpoint.includes('/git/trees/')), 'catalog.json 可用时仍读取了完整 Git tree');
  assert.strictEqual(requests.filter((item) => item.endpoint.includes('/contents/catalog.json')).length, 1, '远程目录索引没有保持为单次读取');
  const secondRoot = remoteRoot.replace('remote-document', 'remote-document-2');
  const secondSummary = Buffer.from('# remote second document\n', 'utf8');
  const secondMeta = { ...remoteMeta, documentId: 'remote-document-2', title: 'remote second document', contentSha256: sha256(secondSummary), assetSha256: {} };
  remoteFiles.set(`${secondRoot}/${DOCUMENT_META_FILE}`, Buffer.from(`${JSON.stringify(secondMeta)}\n`, 'utf8'));
  remoteFiles.set(`${secondRoot}/summary.md`, secondSummary);
  assert.strictEqual(catalog.total, 1, '远程目录没有读取元数据文件');
  const snapshotsBeforeFirstMount = snapshotDownloads;
  requests.length = 0;
  const mounted = await manager.mount({ documents: [{ path: 'renderer-forged/path/_star-owner-document.json' }], remotePrefix: remoteRoot, collectionName: '远程挂载' });
  assert.strictEqual(snapshotDownloads, snapshotsBeforeFirstMount + 1, '一批共享文档没有使用一次性 Git 快照');
  assert(!requests.some((item) => item.endpoint.includes('/git/trees/')), 'Git 快照挂载仍重复读取 GitHub 文件树');
  assert.strictEqual(mounted.remoteDocumentCount, 1, '共享挂载没有记录远程文档');
  const sharedTask = store.listTasks({ collectionId: mounted.collectionId }).find((item) => item.sourceType === 'shared-bilibili');
  assert(sharedTask?.status === 'done' && fs.existsSync(sharedTask.outputMarkdown), '远程文档没有挂载为本地完成文档');
  await manager.syncMount(mounted.id, { documents: [] });
  assert.strictEqual(store.getTask(sharedTask.id).remoteState, 'remote-deleted', '远程删除没有保留本地文档并标记失效');
  assert(manager.state().collections.some((item) => item.collectionKind === 'shared'), '共享用户收藏夹没有暴露到状态');
  fs.rmSync(root, { recursive: true, force: true });
  const exactMount = await manager.mount({ documents: catalog.documents, paths: [catalog.documents[0].path], collectionName: 'single-document mount' });
  const collectionPrefix = remoteRoot.split('/').slice(0, 3).join('/');
  assert.strictEqual(exactMount.scope, 'documents', '单篇挂载没有使用远程收藏夹下的文档选择范围');
  assert.strictEqual(exactMount.remotePrefix, collectionPrefix, '单篇挂载没有从一开始归属于对应远程收藏夹挂载源');
  assert.strictEqual(exactMount.remoteCollectionName, '远程收藏夹', '远程收藏夹挂载源缺少可读名称');
  const secondDocument = { ...secondMeta, path: `${secondRoot}/${DOCUMENT_META_FILE}`, metadataPath: `${secondRoot}/${DOCUMENT_META_FILE}`, remoteSha: 'sha-second' };
  await manager.syncMount(exactMount.id, { documents: [catalog.documents[0], secondDocument] });
  assert.strictEqual(store.listTasks({ collectionId: exactMount.collectionId }).filter((item) => item.sourceType === 'shared-bilibili').length, 1, 'single-document mount expanded to a sibling document');
  const batchSync = await manager.syncMounts([exactMount.id]);
  assert.strictEqual(batchSync.synced, 1, '选中挂载批量同步没有返回正确数量');
  assert(sharedEvents.some((event) => event.type === 'shared-operation-progress' && event.operation?.type === 'mount-sync-batch'), '选中挂载批量同步没有发出进度事件');
  const expandedCatalog = await manager.remoteCatalog();
  const snapshotsBeforeSecondDocument = snapshotDownloads;
  const secondPartialMount = await manager.mount({ paths: [secondDocument.path], collectionId: exactMount.collectionId });
  assert.strictEqual(secondPartialMount.id, exactMount.id, '同一远程收藏夹追加单篇文档时创建了第二个挂载源');
  assert.strictEqual(secondPartialMount.scope, 'documents', '追加单篇文档错误地改成完整收藏夹挂载');
  assert.strictEqual(secondPartialMount.remoteDocumentCount, 2, '同一远程收藏夹挂载源没有记录追加文档');
  assert.strictEqual(store.list('sharedMounts').filter((item) => item.collectionId === exactMount.collectionId).length, 1, '单篇与多篇文档挂载没有统一为一个远程收藏夹来源');
  assert.strictEqual(snapshotDownloads, snapshotsBeforeSecondDocument + 1, '同一远程收藏夹追加文档没有使用一次性 Git 快照');
  const snapshotsBeforeExpandedMount = snapshotDownloads;
  const expandedMount = await manager.mount({ remotePrefix: collectionPrefix, collectionId: exactMount.collectionId });
  const expandedMounts = store.list('sharedMounts').filter((item) => item.collectionId === exactMount.collectionId);
  assert.strictEqual(expandedMounts.length, 1, '同一远程收藏夹的完整挂载错误创建了第二个来源记录');
  assert.strictEqual(expandedMount.id, exactMount.id, '完整收藏夹操作没有复用从单篇起建立的远程收藏夹挂载源');
  assert.strictEqual(expandedMounts[0].scope, 'collection', '远程收藏夹挂载源没有切换为自动跟随完整收藏夹');
  assert.strictEqual(store.listTasks({ collectionId: exactMount.collectionId }).filter((item) => item.sourceType === 'shared-bilibili').length, 2, '整收藏夹挂载没有补入远程新增文档');
  assert.strictEqual(snapshotDownloads, snapshotsBeforeExpandedMount, '已完整下载的远程收藏夹在切换自动跟随模式时仍重复下载仓库快照');
  const snapshotsBeforeNoChange = snapshotDownloads;
  const unchangedMount = await manager.mount({ remotePrefix: collectionPrefix, collectionId: exactMount.collectionId });
  assert.strictEqual(unchangedMount.id, expandedMount.id, '重复挂载同一远程收藏夹没有复用规范化后的挂载');
  assert.strictEqual(unchangedMount.unchanged, true, '远程收藏夹无变化时没有返回无需更新状态');
  assert.strictEqual(snapshotDownloads, snapshotsBeforeNoChange, '远程收藏夹无变化时仍重复下载仓库快照');
  assert.strictEqual(expandedCatalog.total, 2, '扩展收藏夹测试目录没有包含新增文档');
  const updatedSecondSummary = Buffer.from('# remote second document v2\n', 'utf8');
  const updatedSecondMeta = { ...secondMeta, updatedAt: '2026-08-02T00:00:00.000Z', contentSha256: sha256(updatedSecondSummary) };
  remoteFiles.set(`${secondRoot}/${DOCUMENT_META_FILE}`, Buffer.from(`${JSON.stringify(updatedSecondMeta)}\n`, 'utf8'));
  remoteFiles.set(`${secondRoot}/summary.md`, updatedSecondSummary);
  const changedCatalog = await manager.remoteCatalog();
  const snapshotsBeforeChangedSync = snapshotDownloads;
  const changedSync = await manager.syncMount(expandedMount.id, changedCatalog);
  const changedTask = store.listTasks({ collectionId: exactMount.collectionId }).find((item) => item.sharedRemotePath === `${secondRoot}/${DOCUMENT_META_FILE}`);
  assert.strictEqual(changedSync.downloaded, 1, '远程收藏夹单篇更新没有保持增量导入');
  assert.strictEqual(snapshotDownloads, snapshotsBeforeChangedSync + 1, '远程内容更新没有通过单次 Git 快照下载');
  assert(changedTask && fs.readFileSync(changedTask.outputMarkdown, 'utf8').includes('v2'), '目录索引缺少 blob SHA 时远程更新没有覆盖本地旧文档');

  const otherRoot = '123456/bilibili-远程用户/其它收藏夹/other-document';
  const otherSummary = Buffer.from('# other remote document\n', 'utf8');
  const otherMeta = { ...remoteMeta, documentId: 'other-document', bvid: 'BVREMOTE999', title: '其它收藏夹视频', collectionName: '其它收藏夹', contentSha256: sha256(otherSummary), assetSha256: {} };
  remoteFiles.set(`${otherRoot}/${DOCUMENT_META_FILE}`, Buffer.from(`${JSON.stringify(otherMeta)}\n`, 'utf8'));
  remoteFiles.set(`${otherRoot}/summary.md`, otherSummary);
  const crossCollectionCatalog = await manager.remoteCatalog();
  const otherDocument = crossCollectionCatalog.documents.find((item) => item.documentId === 'other-document');
  const firstDocument = crossCollectionCatalog.documents.find((item) => item.documentId === 'remote-document');
  const snapshotsBeforeCrossCollectionMount = snapshotDownloads;
  const crossCollectionMount = await manager.mount({ paths: [firstDocument.path, otherDocument.path], collectionName: '多个远程来源' });
  const crossCollectionMounts = store.list('sharedMounts').filter((item) => item.collectionId === crossCollectionMount.collectionId);
  assert.strictEqual(crossCollectionMount.mountCount, 2, '一次挂载多个远程收藏夹没有创建两个独立来源节点');
  assert.strictEqual(crossCollectionMounts.length, 2, '本地共享收藏夹没有按远程收藏夹拆分挂载源');
  assert.strictEqual(new Set(crossCollectionMounts.map((item) => item.remotePrefix)).size, 2, '不同远程收藏夹被错误合并为一个挂载源');
  assert(crossCollectionMounts.every((item) => item.scope === 'documents' && item.remotePaths.length === 1), '远程收藏夹单篇挂载的数据范围不统一');
  assert.strictEqual(snapshotDownloads, snapshotsBeforeCrossCollectionMount + 1, '跨多个远程收藏夹的批量挂载重复浅克隆了仓库');

  const multiRoot = '123456/multipart/doc-multi';
  const multiMeta = {
    ...remoteMeta,
    documentId: 'doc-multi',
    title: '远程多P父任务',
    documentType: 'multipart-parent',
    multiPartRole: 'parent',
    parentDocumentId: 'doc-multi',
    partId: '',
    entryMarkdown: 'index.md',
    contentSha256: sha256(Buffer.from('# 远程多P父任务\n', 'utf8')),
    assetSha256: {},
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
  const collisionCid = '909090';
  const collisionParts = [{ cid: collisionCid, page: 1, part: '同 CID', title: '跨仓库同 CID' }];
  const collisionParents = [
    { ...multiParent, id: `${multiParent.id}:repo-one`, sharedRepository: { owner: 'owner-one', name: 'shared', branch: 'main' }, sharedMountId: 'mount-one' },
    { ...multiParent, id: `${multiParent.id}:repo-two`, sharedRepository: { owner: 'owner-two', name: 'shared', branch: 'main' }, sharedMountId: 'mount-two' }
  ];
  for (let index = 0; index < collisionParents.length; index += 1) {
    const parentRoot = path.join(workspace.root, `cross-repository-${index + 1}`);
    const partRoot = path.join(parentRoot, 'parts', `cid-${collisionCid}`);
    fs.mkdirSync(partRoot, { recursive: true });
    fs.writeFileSync(path.join(partRoot, 'summary.md'), `# 跨仓库 P ${index + 1}\n`, 'utf8');
    manager.importMultipartParts({ parts: collisionParts }, parentRoot, collisionParents[index], `${privateRemoteRoot}/${DOCUMENT_META_FILE}`, new Date().toISOString());
  }
  const isolatedParts = store.listTasks({ collectionId: multiMount.collectionId }).filter((item) => item.cid === collisionCid);
  assert.strictEqual(isolatedParts.length, 2, '不同共享仓库的同一多P文档发生子任务覆盖');
  assert.strictEqual(new Set(isolatedParts.map((item) => item.id)).size, 2, '多仓库 P 子任务 ID 没有按父任务隔离');
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
      if (endpoint.includes('/contents/') && decodeContentPath(endpoint) === 'catalog.json') { const error = new Error('not found'); error.status = 404; throw error; }
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

  const existingRollbackRoot = path.join(__dirname, '..', '.cache', 'shared-existing-mount-rollback-test');
  fs.rmSync(existingRollbackRoot, { recursive: true, force: true });
  const existingRollbackStore = await Store.open(path.join(existingRollbackRoot, 'test.sqlite'));
  const existingRollbackWorkspace = existingRollbackStore.addWorkspace({ name: '已有挂载回滚测试', root: path.join(existingRollbackRoot, 'workspace') });
  existingRollbackStore.setDefaultWorkspace(existingRollbackWorkspace.id);
  const transactionPrefix = '123456/bilibili/col-transaction';
  const transactionRootA = `${transactionPrefix}/doc-a`;
  const transactionRootB = `${transactionPrefix}/doc-b`;
  const transactionSummaryV1 = Buffer.from('# transaction v1\n', 'utf8');
  const transactionFiles = new Map([
    [`${transactionRootA}/${DOCUMENT_META_FILE}`, Buffer.from(`${JSON.stringify({ ...remoteMeta, documentId: 'doc-a', title: '事务文档 A', contentSha256: sha256(transactionSummaryV1), assetSha256: {}, updatedAt: '2026-08-01T00:00:00.000Z' })}\n`, 'utf8')],
    [`${transactionRootA}/summary.md`, transactionSummaryV1]
  ]);
  const transactionRequest = async (endpoint) => {
    if (endpoint === '/repos/Fenglin-Maple/Blibili-Markdowns') return { name: 'Blibili-Markdowns', size: 1024, default_branch: 'main', private: false, owner: { login: 'Fenglin-Maple', id: 124229028 } };
    if (endpoint.includes('/contents/catalog.json')) return { content: buildCatalog(transactionFiles).toString('base64'), encoding: 'base64', sha: 'transaction-catalog' };
    const error = new Error(`not found: ${endpoint}`); error.status = 404; throw error;
  };
  const transactionManager = new SharedKnowledgeManager({
    store: existingRollbackStore,
    encryptSecret: (value) => ({ mode: 'test', value }),
    decryptSecret: (secret) => secret.value,
    request: transactionRequest,
    gitRuntime: createSnapshotRuntime(transactionFiles, () => {})
  });
  const transactionMount = await transactionManager.mount({ remotePrefix: transactionPrefix, collectionName: '已有挂载回滚' });
  const transactionTaskBefore = existingRollbackStore.listTasks({ collectionId: transactionMount.collectionId }).find((item) => item.sharedRemotePath === `${transactionRootA}/${DOCUMENT_META_FILE}`);
  const mountBefore = existingRollbackStore.get('sharedMounts', transactionMount.id);
  assert(transactionTaskBefore && fs.readFileSync(transactionTaskBefore.outputMarkdown, 'utf8').includes('v1'), '已有挂载回滚基线没有建立');
  const transactionSummaryV2 = Buffer.from('# transaction v2\n', 'utf8');
  transactionFiles.set(`${transactionRootA}/${DOCUMENT_META_FILE}`, Buffer.from(`${JSON.stringify({ ...remoteMeta, documentId: 'doc-a', title: '事务文档 A', contentSha256: sha256(transactionSummaryV2), assetSha256: {}, updatedAt: '2026-08-04T00:00:00.000Z' })}\n`, 'utf8'));
  transactionFiles.set(`${transactionRootA}/summary.md`, transactionSummaryV2);
  transactionFiles.set(`${transactionRootB}/${DOCUMENT_META_FILE}`, Buffer.from(`${JSON.stringify({ ...remoteMeta, documentId: 'doc-b', title: '事务文档 B', contentSha256: sha256(Buffer.from('# missing\n')), assetSha256: {}, updatedAt: '2026-08-03T00:00:00.000Z' })}\n`, 'utf8'));
  await transactionManager.remoteCatalog();
  await assert.rejects(() => transactionManager.mount({ remotePrefix: transactionPrefix, collectionId: transactionMount.collectionId }), /缺少 Markdown/);
  const mountAfter = existingRollbackStore.get('sharedMounts', transactionMount.id);
  const transactionTasksAfter = existingRollbackStore.listTasks({ collectionId: transactionMount.collectionId }).filter((item) => item.sourceType === 'shared-bilibili');
  assert.deepStrictEqual(mountAfter.remotePaths, mountBefore.remotePaths, '已有挂载失败后 remotePaths 没有恢复');
  assert.strictEqual(transactionTasksAfter.length, 1, '已有挂载失败后残留了半完成文档任务');
  assert(fs.readFileSync(transactionTasksAfter[0].outputMarkdown, 'utf8').includes('v1'), '已有文档在后续批量挂载失败后没有恢复旧版本');
  assert(!fs.readdirSync(path.dirname(transactionTasksAfter[0].artifactDir)).some((name) => name.includes('.rollback-') || name.includes('.incoming-')), '共享挂载回滚后残留事务目录');
  fs.rmSync(existingRollbackRoot, { recursive: true, force: true });

  const migrationRoot = path.join(__dirname, '..', '.cache', 'shared-mount-migration-test');
  fs.rmSync(migrationRoot, { recursive: true, force: true });
  const migrationStore = await Store.open(path.join(migrationRoot, 'test.sqlite'));
  const migrationWorkspace = migrationStore.addWorkspace({ name: '挂载迁移测试', root: path.join(migrationRoot, 'workspace') });
  migrationStore.setDefaultWorkspace(migrationWorkspace.id);
  const migrationCollection = migrationStore.upsertCollection({ id: 'legacy-shared-collection', userId: 'shared-user', userName: '共享', name: '旧共享收藏夹', collectionKind: 'shared', internal: true, workspaceId: migrationWorkspace.id, workspaceRoot: migrationWorkspace.root, collectionRoot: path.join(migrationWorkspace.root, '共享', '旧共享收藏夹') });
  const legacyMountId = 'mount:legacy-flat-record';
  const legacyPaths = [`${remoteRoot}/${DOCUMENT_META_FILE}`, `${otherRoot}/${DOCUMENT_META_FILE}`];
  migrationStore.set('sharedMounts', legacyMountId, { id: legacyMountId, collectionId: migrationCollection.id, collectionName: migrationCollection.name, scope: 'documents', remotePrefix: '123456/bilibili-远程用户', remotePaths: legacyPaths, repository: { owner: 'Fenglin-Maple', name: 'Blibili-Markdowns', branch: 'main' }, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' });
  for (let index = 0; index < legacyPaths.length; index += 1) migrationStore.upsertTask({ id: `legacy-shared-task-${index + 1}`, collectionId: migrationCollection.id, sourceType: 'shared-bilibili', status: 'done', title: `旧共享文档 ${index + 1}`, sharedRemotePath: legacyPaths[index], sharedRepository: { owner: 'Fenglin-Maple', name: 'Blibili-Markdowns', branch: 'main' }, sharedMountId: legacyMountId, sharedMountIds: [legacyMountId] });
  migrationStore.commit();
  new SharedKnowledgeManager({ store: migrationStore, encryptSecret: (value) => value, decryptSecret: (value) => value, gitRuntime: { state: () => ({ available: true, isolated: true, path: 'test-git' }) } });
  const migratedMounts = migrationStore.list('sharedMounts');
  assert.strictEqual(migratedMounts.length, 2, '旧版跨收藏夹扁平挂载没有迁移为两个远程收藏夹来源');
  assert.strictEqual(new Set(migratedMounts.map((item) => item.remotePrefix)).size, 2, '旧版挂载迁移后远程收藏夹来源仍然混在一起');
  assert(migrationStore.listTasks({ collectionId: migrationCollection.id }).every((item) => item.sharedMountIds.length === 1), '旧版挂载迁移后文档没有重新绑定唯一远程收藏夹来源');
  fs.rmSync(migrationRoot, { recursive: true, force: true });
  console.log('shared knowledge manager test passed');
})().catch((error) => { console.error(error); process.exit(1); });

function decodeContentPath(endpoint) {
  const marker = '/contents/';
  const start = endpoint.indexOf(marker) + marker.length;
  const raw = endpoint.slice(start).split('?')[0];
  return raw.split('/').map((part) => decodeURIComponent(part)).join('/');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function buildCatalog(files) {
  const documents = [];
  for (const [metadataPath, body] of files.entries()) {
    if (!metadataPath.endsWith(`/${DOCUMENT_META_FILE}`)) continue;
    const metadata = JSON.parse(body.toString('utf8'));
    const documentRoot = metadataPath.slice(0, -DOCUMENT_META_FILE.length);
    const documentFiles = [...files.entries()].filter(([relative]) => relative.startsWith(documentRoot));
    documents.push({
      documentId: String(metadata.documentId || ''),
      documentType: String(metadata.documentType || 'single-video'),
      sourceType: String(metadata.sourceType || ''),
      bvid: String(metadata.bvid || ''),
      title: String(metadata.title || ''),
      owner: String(metadata.owner || ''),
      collectionName: String(metadata.collectionName || ''),
      entryMarkdown: String(metadata.entryMarkdown || ''),
      contentSha256: String(metadata.contentSha256 || ''),
      contributorGithubId: String(metadata.contributorGithubId || metadataPath.split('/')[0] || ''),
      totalBytes: documentFiles.reduce((sum, [, value]) => sum + value.length, 0),
      fileCount: documentFiles.length,
      updatedAt: String(metadata.updatedAt || metadata.uploadedAt || ''),
      uploadedAt: String(metadata.uploadedAt || ''),
      metadataPath,
      documentRoot: metadataPath.slice(0, -DOCUMENT_META_FILE.length)
    });
  }
  documents.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)) || left.metadataPath.localeCompare(right.metadataPath));
  return Buffer.from(`${JSON.stringify({ schemaVersion: 1, generatedAt: documents[0]?.updatedAt || '', total: documents.length, documents }, null, 2)}\n`, 'utf8');
}

function createSnapshotRuntime(files, onDownload) {
  return {
    allowCheckoutWithRequestOverride: true,
    state: () => ({ available: true, isolated: true, path: 'test-git' }),
    withReadOnlyCheckout: async ({ onProgress }, callback) => {
      const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'star-owner-shared-checkout-'));
      onDownload();
      try {
        onProgress?.({ stage: 'git-download', progress: 0.1, message: 'test snapshot download' });
        for (const [relative, body] of files.entries()) {
          const destination = path.join(checkout, ...relative.split('/'));
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.writeFileSync(destination, body);
        }
        onProgress?.({ stage: 'git-ready', progress: 1, message: 'test snapshot ready' });
        return await callback({ root: checkout });
      } finally {
        fs.rmSync(checkout, { recursive: true, force: true });
      }
    }
  };
}
