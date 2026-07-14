const fs = require('fs');
const path = require('path');
const { ApiServer } = require('../src/core/api-server');
const { assetIdFor } = require('../src/core/knowledge-api');
const { Store } = require('../src/core/store');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const root = path.join(__dirname, '..', '.cache', 'knowledge-api-test');
  const outside = path.join(__dirname, '..', '.cache', 'knowledge-api-outside');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const store = await Store.open(path.join(root, 'test.sqlite'));
  const workspace = store.addWorkspace({ name: 'Knowledge API test', root: path.join(root, 'workspace') });
  store.setDefaultWorkspace(workspace.id);
  store.upsertUser({ id: 'user-knowledge', name: '知识库用户' });
  store.upsertCollection({ id: 'collection-active', mediaId: '10', name: '活跃收藏夹', userId: 'user-knowledge', userName: '知识库用户', syncReady: true, syncState: 'ready' });
  store.upsertCollection({ id: 'collection-removed', mediaId: '11', name: '历史收藏夹', userId: 'user-knowledge', userName: '知识库用户', syncReady: true, syncState: 'ready' });

  const first = writeDocument(workspace.root, 'first', '# 第一篇\n\n逐字原文 alpha。\n\n结束。\n');
  const second = writeDocument(workspace.root, 'second', '# 第二篇\n\n逐字原文 beta。\n');
  store.upsertTask(completedTask('doc-first', 'collection-active', first, {
    bvid: 'BVKNOWLEDGE1', title: '第一篇知识', owner: 'UP甲', tags: ['AI', '工具'],
    publishedAt: '2026-01-02T00:00:00.000Z', favoriteAddedAt: '2026-02-03T00:00:00.000Z', completedAt: '2026-03-04T00:00:00.000Z'
  }));
  store.upsertTask(completedTask('doc-second', 'collection-removed', second, {
    bvid: 'BVKNOWLEDGE2', title: '第二篇知识', owner: 'UP乙', tags: ['经验'],
    publishedAt: '2025-01-02T00:00:00.000Z', favoriteAddedAt: '2025-02-03T00:00:00.000Z', completedAt: '2025-03-04T00:00:00.000Z',
    removedFromFavorites: true, favoriteState: 'removed'
  }));
  const unmanagedMarkdown = path.join(outside, 'outside.md');
  fs.writeFileSync(unmanagedMarkdown, '# unmanaged\n', 'utf8');
  store.upsertTask(completedTask('doc-unmanaged', 'collection-active', { artifactDir: outside, markdown: unmanagedMarkdown, image: '' }, {
    bvid: 'BVUNMANAGED1', title: '未托管文档', completedAt: '2026-04-01T00:00:00.000Z'
  }));
  store.commit();

  const api = new ApiServer({ store });
  await api.start(0);
  try {
    const manifest = await json(api.url() + '/api/manifest');
    assert(manifest.response.status === 200 && manifest.body.protocolVersion === '3.0' && manifest.body.access.readOnly, 'knowledge manifest contract failed');

    const catalog = await json(api.url() + '/api/knowledge/catalog');
    assert(catalog.body.totals.documents === 3 && catalog.body.totals.collections === 2, 'catalog totals failed');

    const directory = await json(api.url() + '/api/knowledge/documents?collectionId=collection-active&limit=1&sort=completed-desc');
    assert(directory.body.total === 2 && directory.body.documents.length === 1 && directory.body.nextOffset === 1, 'document pagination failed');
    assert(!JSON.stringify(directory.body).includes(path.resolve(workspace.root)), 'document directory exposed a local path');

    const activeOnly = await json(api.url() + '/api/knowledge/documents?bvid=BVKNOWLEDGE1&publishedFrom=2026-01-01&publishedTo=2026-01-31');
    assert(activeOnly.body.total === 1 && activeOnly.body.documents[0].favoriteMembership.code === 'active', 'metadata/date filtering failed');
    const removed = await json(api.url() + '/api/knowledge/documents?bvid=BVKNOWLEDGE2');
    assert(removed.body.documents[0].favoriteMembership.code === 'removed', 'removed-favorite metadata was lost');

    const pageOne = await json(api.url() + '/api/knowledge/documents/doc-first/content?startLine=1&lineCount=2');
    assert(pageOne.body.content === '# 第一篇\n' && pageOne.body.nextStartLine === 3 && pageOne.body.exactSource, 'raw Markdown first page failed');
    const pageTwo = await json(api.url() + '/api/knowledge/documents/doc-first/content?startLine=' + pageOne.body.nextStartLine + '&lineCount=100');
    assert(pageTwo.body.content.includes('逐字原文 alpha。') && pageTwo.body.nextStartLine === null, 'raw Markdown continuation failed');

    const assets = await json(api.url() + '/api/knowledge/documents/doc-first/assets');
    assert(assets.body.assets.length === 1 && assets.body.assets[0].mimeType === 'image/png', 'asset type validation failed');
    const image = await fetch(assets.body.assets[0].url);
    const etag = image.headers.get('etag');
    assert(image.status === 200 && etag && (await image.arrayBuffer()).byteLength > 8, 'asset binary response failed');
    const cached = await fetch(assets.body.assets[0].url, { headers: { 'if-none-match': etag } });
    assert(cached.status === 304, 'asset ETag fallback failed');

    const search = await json(api.url() + '/api/knowledge/search?q=alpha&collectionId=collection-active');
    assert(search.body.results[0]?.id === 'doc-first' && search.body.scannedDocuments >= 1, 'full Markdown search failed');

    const invalidRange = await json(api.url() + '/api/knowledge/documents/doc-first/content?startLine=9999');
    assert(invalidRange.response.status === 416 && invalidRange.body.code === 'KNOWLEDGE_LINE_RANGE_INVALID', 'invalid line range was silently clamped');
    const invalidDate = await json(api.url() + '/api/knowledge/documents?publishedFrom=not-a-date');
    assert(invalidDate.response.status === 400 && invalidDate.body.code === 'KNOWLEDGE_DATE_FILTER_INVALID', 'invalid date filter was accepted');
    const invalidQuery = await json(api.url() + '/api/knowledge/search?q=%21%21%21');
    assert(invalidQuery.response.status === 400 && invalidQuery.body.code === 'KNOWLEDGE_QUERY_INVALID', 'invalid search query was accepted');
    const unmanaged = await json(api.url() + '/api/knowledge/documents/doc-unmanaged/content');
    assert(unmanaged.response.status === 409 && unmanaged.body.code === 'KNOWLEDGE_ARTIFACT_INVALID' && !JSON.stringify(unmanaged.body).includes(outside), 'unmanaged path was readable or leaked');
    const traversal = await json(api.url() + '/api/knowledge/documents/doc-first/assets/' + encodeURIComponent(assetIdFor('../outside.png')));
    assert(traversal.response.status === 400 && traversal.body.code === 'KNOWLEDGE_ASSET_ID_INVALID', 'asset traversal identifier was accepted');
    const retired = await json(api.url() + '/api/tasks/claim', { method: 'POST' });
    assert(retired.response.status === 410 && retired.body.code === 'EXTERNAL_VIDEO_WORKFLOW_DISABLED', 'retired external video API remained active');
    const writeAttempt = await json(api.url() + '/api/knowledge/catalog', { method: 'POST' });
    assert(writeAttempt.response.status === 405 && writeAttempt.body.code === 'METHOD_NOT_ALLOWED', 'knowledge write method was accepted');
  } finally {
    api.stop();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
  console.log('knowledge API integration test passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

function completedTask(id, collectionId, artifact, patch = {}) {
  return {
    id, collectionId, bvid: id, title: id, owner: '', tags: [], status: 'done', enabled: true,
    artifactDir: artifact.artifactDir, outputMarkdown: artifact.markdown, coverFile: artifact.image,
    allowedRoot: artifact.artifactDir, workspaceRoot: artifact.artifactDir,
    publishedAt: '', favoriteAddedAt: '', completedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
    ...patch
  };
}

function writeDocument(workspaceRoot, name, markdown) {
  const artifactDir = path.join(workspaceRoot, '知识库用户', '测试收藏夹', name);
  const markdownFile = path.join(artifactDir, name + '.md');
  const image = path.join(artifactDir, 'cover.png');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(markdownFile, markdown, 'utf8');
  fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  fs.writeFileSync(path.join(artifactDir, 'notes.txt'), 'not exposed', 'utf8');
  return { artifactDir, markdown: markdownFile, image };
}

async function json(url, options) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}
