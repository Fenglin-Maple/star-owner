const fs = require('fs');
const http = require('http');
const path = require('path');
const MarkdownIt = require('markdown-it');
const { Store } = require('../src/core/store');
const { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT_TOKENS, MAX_RAG_SEARCH_CHUNKS, MAX_RAG_TOOL_ROUNDS, RAG_AUTO_COMPACT_TRIGGER, RagAssistant, normalizeModel, splitTextByTokenBudget, readUtf8LineRange, estimateAttachmentTokens } = require('../src/core/rag-assistant');
const { wrapMarkdownTables } = require('../src/core/markdown');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function catalogItem(catalog, id) {
  const item = catalog.find((entry) => String(entry.id) === String(id));
  assert(item, `missing knowledge catalog entry: ${id}`);
  return item;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

function sse(response, payloads) {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  for (const payload of payloads) response.write(`data: ${JSON.stringify(payload)}\n\n`);
  response.end('data: [DONE]\n\n');
}

function latestUserText(messages) {
  const content = [...messages].reverse().find((item) => item.role === 'user')?.content || '';
  if (typeof content === 'string') return content;
  return content.map((part) => part.text || '').join('');
}

async function startFakeProvider() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [
        { id: 'fake-agent', context_length: 65536, max_output_tokens: 4096, architecture: { modality: 'text+image->text' }, supported_parameters: ['tools', 'reasoning_effort'] },
        { id: 'fake-reader', context_window: 8192, max_completion_tokens: 2048, input_modalities: ['text'] }
      ] }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    const body = await readBody(request);
    requests.push(body);
    const userText = latestUserText(body.messages || []);
    const toolResult = [...(body.messages || [])].reverse().find((item) => item.role === 'tool');
    if (userText.includes('COMPAT_PARAMETERS')) {
      if (request.url === '/chat/completions') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'route not found' } }));
        return;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'max_tokens')) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'max_tokens is not supported; use max_completion_tokens' } }));
        return;
      }
      if (body.stream_options) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'stream_options is not supported' } }));
        return;
      }
      if (Number(body.temperature) !== 1) {
        response.writeHead(422, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'temperature must be 1' } }));
        return;
      }
      sse(response, [{ choices: [{ delta: { content: '兼容参数成功。' } }] }]);
      return;
    }
    if (userText.includes('COMPAT_NO_TEMPERATURE')) {
      if (Object.prototype.hasOwnProperty.call(body, 'temperature')) {
        response.writeHead(422, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'temperature is not supported' } }));
        return;
      }
      sse(response, [{ choices: [{ delta: { content: '无温度参数兼容成功。' } }] }]);
      return;
    }
    if (userText.includes('HTTP_200_JSON_ERROR')) {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: 'resource pool exhausted' } }));
      return;
    }
    if (userText.includes('HTTP_200_SSE_ERROR')) {
      sse(response, [{ error: { message: 'no concurrency slot available' } }]);
      return;
    }
    if (body.stream === false) {
      if (userText.includes('COMPACT_DELAY')) await new Promise((resolve) => setTimeout(resolve, 60));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: '保留目标、事实、引用和未完成工作。' } }], usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 } }));
      return;
    }
    if (userText.includes('PROVIDER_FAILURE')) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'temporary upstream outage' } }));
      return;
    }
    if (userText.includes('THINK_TAG_TEST')) {
      sse(response, [
        { choices: [{ delta: { content: '正文前<thi' } }] },
        { choices: [{ delta: { content: 'nk>隐藏推理' } }] },
        { choices: [{ delta: { content: '</thi' } }] },
        { choices: [{ delta: { content: 'nk>正文后' } }] }
      ]);
      return;
    }
    if (userText.includes('JSON_FALLBACK')) {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ choices: [{ message: { reasoning_content: '普通 JSON 推理', content: '普通 JSON 兼容成功。' } }], usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 } }));
      return;
    }
    if (userText.includes('TOOL_ROUND_LIMIT')) {
      const completedToolRounds = (body.messages || []).filter((item) => item.role === 'tool').length;
      if (completedToolRounds < MAX_RAG_TOOL_ROUNDS) {
        sse(response, [
          { choices: [{ delta: { tool_calls: [{ index: 0, id: `call-round-${completedToolRounds + 1}`, type: 'function', function: { name: 'knowledge_search', arguments: '{"query":"星藏家","limit":1}' } }] } }] }
        ]);
      } else {
        sse(response, [
          { choices: [{ delta: { content: `已完成 ${completedToolRounds} 轮知识库检索。` } }] },
          { choices: [], usage: { prompt_tokens: 90, completion_tokens: 12, total_tokens: 102 } }
        ]);
      }
      return;
    }
    if (userText.includes('IMAGE_TEST') && !toolResult) {
      sse(response, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-image', type: 'function', function: { name: 'knowledge_view_images', arguments: '{"document_id":"rag-task","image_indices":[1]}' } }] } }] }
      ]);
      return;
    }
    if (userText.includes('TOOL_POSITION_TEST')) {
      if (!toolResult) {
        sse(response, [
          { choices: [{ delta: { content: '工具前。' } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-position', type: 'function', function: { name: 'knowledge_search', arguments: '{"query":"星藏家","limit":1}' } }] } }] }
        ]);
      } else {
        sse(response, [{ choices: [{ delta: { content: '工具后。' } }] }]);
      }
      return;
    }
    if (userText.includes('TOOL_THEN_FAILURE')) {
      if (!toolResult) {
        sse(response, [
          { choices: [{ delta: { content: '失败前。' } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-before-failure', type: 'function', function: { name: 'knowledge_search', arguments: '{"query":"星藏家","limit":1}' } }] } }] }
        ]);
      } else {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'upstream resource pool exhausted after tool call' } }));
      }
      return;
    }
    const fullConversationText = JSON.stringify(body.messages || []);
    if (fullConversationText.includes('IMAGE_MULTI_BATCH_TEST')) {
      const loadedBatches = (body.messages || []).filter((message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url')).length;
      if (loadedBatches < 2) {
        const indices = loadedBatches === 0 ? [1, 2, 3, 4] : [5, 6, 7, 8];
        sse(response, [
          { choices: [{ delta: { tool_calls: [{ index: 0, id: `call-image-batch-${loadedBatches + 1}`, type: 'function', function: { name: 'knowledge_view_images', arguments: JSON.stringify({ document_id: 'rag-task', image_indices: indices }) } }] } }] }
        ]);
      } else {
        sse(response, [{ choices: [{ delta: { content: '已分两批查看八张图片。' } }] }]);
      }
      return;
    }
    if (toolResult) {
      sse(response, [
        { choices: [{ delta: { content: '根据本地知识库，' } }] },
        { choices: [{ delta: { content: toolResult.content.includes('星藏家测试文档') ? '已找到测试文档。' : '未找到资料。' } }] },
        { choices: [], usage: { prompt_tokens: 60, completion_tokens: 11, total_tokens: 71 } }
      ]);
      return;
    }
    if (userText.includes('知识库')) {
      sse(response, [
        { choices: [{ delta: { reasoning_content: '先检索已选知识库。' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-knowledge', type: 'function', function: { name: 'knowledge_', arguments: '{"query":"星收藏' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ id: 'call-knowledge', function: { name: 'search', arguments: '家 RAG","limit":3}' } }] } }] }
      ]);
      return;
    }
    sse(response, [
      { choices: [{ delta: { content: '测试回复。' } }] },
      { choices: [], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }
    ]);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

(async () => {
  const root = path.join(__dirname, '..', '.cache', 'rag-assistant-test');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const fake = await startFakeProvider();
  try {
    const store = await Store.open(path.join(root, 'rag-test.sqlite'));
    const markdown = path.join(root, 'knowledge.md');
    fs.writeFileSync(markdown, '# 星藏家测试文档\n\nRAG 助手可以检索收藏夹中的 Markdown 内容。\n', 'utf8');
    const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const knowledgeImage = path.join(root, 'frame.png');
    fs.writeFileSync(knowledgeImage, tinyPng);
    const largeKnowledgeImage = path.join(root, 'large-frame.png');
    fs.writeFileSync(largeKnowledgeImage, Buffer.concat([tinyPng, Buffer.alloc(4 * 1024 * 1024)]));
    const additionalKnowledgeImages = [];
    for (let index = 3; index <= 8; index += 1) {
      const file = path.join(root, `frame-${index}.png`);
      fs.writeFileSync(file, tinyPng);
      additionalKnowledgeImages.push(file);
    }
    fs.appendFileSync(markdown, `\n![测试关键帧](frame.png)\n\n![大体积原图](large-frame.png)\n\n${additionalKnowledgeImages.map((file, index) => `![补充图片 ${index + 3}](${path.basename(file)})`).join('\n\n')}\n`, 'utf8');
    store.upsertUser({ id: 'rag-user', mid: 'rag-user', name: '测试用户' });
    store.upsertCollection({ id: 'rag-collection', name: 'AI 收藏夹', userId: 'rag-user', userName: '测试用户' });
    store.upsertTask({ id: 'rag-task', collectionId: 'rag-collection', bvid: 'BVRAGTEST', title: '星藏家测试文档', owner: '测试 UP', status: 'done', outputMarkdown: markdown, publishedAt: '2026-06-18T08:00:00.000Z', favoriteAddedAt: '2026-06-20T09:30:00.000Z', completedAt: new Date().toISOString() });
    const extraKnowledgeMarkdown = path.join(root, 'extra-knowledge.md');
    fs.writeFileSync(extraKnowledgeMarkdown, '# 额外知识库测试文档\n\n用于验证目录层级。\n', 'utf8');
    store.upsertCollection({ id: 'rag-same-name-collection', name: '同名用户收藏夹', userId: 'rag-user-2', userName: '测试用户' });
    store.upsertTask({ id: 'rag-same-name-task', collectionId: 'rag-same-name-collection', bvid: 'BVRAGSAMENAME', title: '同名用户测试文档', owner: '测试 UP 2', status: 'done', outputMarkdown: extraKnowledgeMarkdown, completedAt: new Date().toISOString() });
    store.upsertCollection({ id: 'rag-multimodal-collection', name: '本地多模态资料', userId: 'builtin-agent-user', userName: '内置用户', internal: true, collectionKind: 'multimodal-document' });
    store.upsertTask({ id: 'rag-multimodal-task', collectionId: 'rag-multimodal-collection', bvid: 'RAGMULTIMODAL', title: '本地多模态测试文档', owner: '内置处理器', status: 'done', outputMarkdown: extraKnowledgeMarkdown, completedAt: new Date().toISOString() });
    store.upsertCollection({ id: 'rag-archive-collection', name: '本地文档归档', userId: 'builtin-agent-user', userName: '内置用户', internal: true, collectionKind: 'document-archive' });
    store.upsertTask({ id: 'rag-archive-task', collectionId: 'rag-archive-collection', bvid: 'RAGARCHIVE', title: '本地归档测试文档', owner: '内置处理器', status: 'done', outputMarkdown: extraKnowledgeMarkdown, completedAt: new Date().toISOString() });
    store.upsertCollection({ id: 'rag-shared-collection', name: '共享知识资料', userId: 'shared-user', userName: '共享用户', internal: true, collectionKind: 'shared' });
    store.upsertTask({ id: 'rag-shared-task', collectionId: 'rag-shared-collection', bvid: 'RAGSHARED', title: '共享测试文档', owner: '共享挂载', status: 'done', outputMarkdown: extraKnowledgeMarkdown, completedAt: new Date().toISOString() });
    const historicalMarkdown = path.join(root, 'historical.md');
    fs.writeFileSync(historicalMarkdown, '# 旧版本\n\n不应默认进入 RAG。\n', 'utf8');
    store.upsertTask({ id: 'rag-task-old', collectionId: 'rag-collection', bvid: 'BVRAGTEST', title: '星藏家测试文档旧版本', status: 'done', outputMarkdown: historicalMarkdown, singleTask: true, knowledgeActive: false, completedAt: '2026-06-17T08:00:00.000Z' });
    store.set('ragProviders', 'legacy-provider', { id: 'legacy-provider', name: 'Legacy', type: 'openai', baseUrl: fake.url, maxOutputTokens: 8192, enabledModels: [{ id: 'gpt-5.4-mini', contextWindow: 128000 }], remoteModels: [] });
    store.commit();

    const events = [];
    const approvals = [];
    const preparedVisionFiles = [];
    const assistant = new RagAssistant({
      store,
      workspaceRoot: root,
      encryptSecret: (value) => ({ value }),
      decryptSecret: (secret) => secret.value,
      emit: (event) => events.push(event),
      requestApproval: async (request) => { approvals.push(request); return { approved: false }; },
      browseHidden: async (url) => `BROWSED ${url}`,
      openExternal: async () => {},
      prepareVisionImage: (file) => {
        preparedVisionFiles.push(file);
        return { buffer: tinyPng, mimeType: 'image/png', width: 1, height: 1 };
      }
    });

    const migrated = assistant.rawProvider('legacy-provider');
    const emptyStateWithStaleSession = assistant.state('rag-session-that-no-longer-exists');
    assert(emptyStateWithStaleSession.activeSession === null && emptyStateWithStaleSession.sessions.length === 0, 'stale RAG session id did not fall back to the empty state');
    const initialCatalog = assistant.knowledgeCatalog();
    assert(catalogItem(initialCatalog, 'rag-collection').documentCount === 1, 'superseded single-video document was included in the default RAG catalog');
    assert(catalogItem(initialCatalog, 'rag-collection').userKindInfo?.code === 'bilibili' && catalogItem(initialCatalog, 'rag-collection').userKindInfo.label === '哔哩哔哩用户', 'Bilibili catalog entries did not expose the user type');
    assert(catalogItem(initialCatalog, 'rag-same-name-collection').userId === 'rag-user-2', 'catalog did not preserve a same-name user identity');
    assert(catalogItem(initialCatalog, 'rag-multimodal-collection').kindInfo?.code === 'multimodal-document', 'multimodal catalog classification failed');
    assert(catalogItem(initialCatalog, 'rag-archive-collection').kindInfo?.code === 'document-archive' && catalogItem(initialCatalog, 'rag-archive-collection').kindInfo.label === '本地文档归档', 'document archive catalog classification failed');
    assert(catalogItem(initialCatalog, 'rag-shared-collection').userKindInfo?.code === 'shared', 'shared catalog entries did not expose the user type');
    assert(migrated.maxOutputTokens === DEFAULT_MAX_OUTPUT_TOKENS && migrated.enabledModels[0].contextWindow === 400000 && migrated.enabledModels[0].maxOutputTokens === 128000, 'legacy token defaults were not migrated');
    assert(normalizeModel({ id: 'unknown-modern-model' }).contextWindow === DEFAULT_CONTEXT_WINDOW, 'modern default context window is incorrect');
    assert(MAX_RAG_SEARCH_CHUNKS === 60000 && MAX_RAG_TOOL_ROUNDS === 24 && RAG_AUTO_COMPACT_TRIGGER === 0.75, 'RAG search/tool/auto-compression limits are incorrect');
    const tableHtml = wrapMarkdownTables(new MarkdownIt()).render('| 名称 | 日期 |\n| --- | --- |\n| 测试 | 2026-06-18 |');
    assert(tableHtml.includes('<div class="rag-table-wrap"><table>') && tableHtml.includes('<th>名称</th>') && tableHtml.includes('</table></div>'), 'RAG Markdown table wrapper was not rendered');
    const splitFixture = `${'第一段完整上下文。'.repeat(500)}\n${'second complete context line. '.repeat(500)}`;
    assert(splitTextByTokenBudget(splitFixture, 700).join('') === splitFixture, 'RAG context chunking dropped or reordered source text');
    const estimatedLargeImageTokens = estimateAttachmentTokens([{ mimeType: 'image/png', size: 15 * 1024 * 1024 }], { supportsVision: true });
    assert(estimatedLargeImageTokens >= 800 && estimatedLargeImageTokens <= 12000, 'RAG image context estimation still treats Base64 transport characters as text tokens');
    const lineRangeFixture = path.join(root, 'line-range.md');
    fs.writeFileSync(lineRangeFixture, `第一行\n第二行-中间分页\n${'长文本'.repeat(30000)}`, 'utf8');
    const firstLinePage = readUtf8LineRange(lineRangeFixture, 1, 1, 0, 1000);
    assert(firstLinePage.selected === '第一行\n' && firstLinePage.next?.line === 2 && firstLinePage.next?.column === 0, 'line-range reader did not preserve line/page boundaries');
    const longLinePage = readUtf8LineRange(lineRangeFixture, 3, 1, 0, 50000);
    assert(longLinePage.selected.length === 50000 && longLinePage.next?.line === 3 && longLinePage.next?.column === 50000, 'line-range reader did not paginate a long UTF-8 line by character column');
    const resumedLongLinePage = readUtf8LineRange(lineRangeFixture, 3, 1, longLinePage.next.column, 50000);
    assert(resumedLongLinePage.selected.length > 0 && resumedLongLinePage.selected === '长文本'.repeat(30000).slice(50000), 'line-range reader could not resume a long UTF-8 line');
    const noTrailingNewlineFixture = path.join(root, 'no-trailing-newline.md');
    fs.writeFileSync(noTrailingNewlineFixture, '有换行\n末行无换行', 'utf8');
    const finalLinePage = readUtf8LineRange(noTrailingNewlineFixture, 1, 10, 0, 1000);
    assert(finalLinePage.selected === '有换行\n末行无换行' && finalLinePage.next === null && finalLinePage.totalLines === 2, 'line-range reader mishandled the final line without a trailing newline');
    store.delete('ragProviders', 'legacy-provider');
    store.commit();

    const provider = assistant.saveProvider({ name: 'Fake NewAPI', type: 'newapi', baseUrl: fake.url.replace(/\/v1$/, ''), apiKey: 'secret' });
    const remoteModels = await assistant.fetchModels(provider.id);
    assert(remoteModels.length === 2, 'remote model list was not fetched');
    assert(remoteModels[0].contextWindow === 65536 && remoteModels[0].maxOutputTokens === 4096 && remoteModels[0].supportsVision && remoteModels[0].supportsTools && remoteModels[0].supportsReasoning, 'model endpoint metadata was not mapped to context or capabilities');
    assert(remoteModels[1].contextWindow === 8192 && remoteModels[1].maxOutputTokens === 2048 && !remoteModels[1].supportsVision, 'text-only model metadata was not respected');
    assert(assistant.rawProvider(provider.id).resolvedBaseUrl === fake.url, 'NewAPI /v1 endpoint was not discovered');
    assistant.updateProviderModels(provider.id, [
      { id: 'fake-agent', contextWindow: 4096, maxOutputTokens: 2048, supportsTools: true, supportsReasoning: true, supportsVision: true, supportsCompression: true, supportsSubagents: true },
      { id: 'fake-tools', contextWindow: 32768, maxOutputTokens: 2048, supportsTools: true, supportsReasoning: true, supportsVision: true, supportsCompression: true, supportsSubagents: true }
    ]);
    const session = assistant.createSession({ providerId: provider.id, modelId: 'fake-agent', knowledgeCollectionIds: ['rag-collection'] });
    assert(assistant.state('rag-session-that-no-longer-exists').activeSession?.id === session.id, 'stale RAG session id did not fall back to the first available session');

    const scopedSession = assistant.createSession({ providerId: provider.id, modelId: 'fake-agent', knowledgeCollectionIds: ['rag-collection', 'rag-shared-collection'], title: 'Collection scope test' });
    const scopedCollections = assistant.listKnowledgeCollections(assistant.requireSession(scopedSession.id));
    assert(scopedCollections.includes('Collection ID: rag-collection') && scopedCollections.includes('Collection ID: rag-shared-collection') && /Available completed documents: 1/.test(scopedCollections), 'collection listing did not expose exact selected IDs and counts');
    const sharedDocuments = assistant.listKnowledgeDocuments(assistant.requireSession(scopedSession.id), '', 0, 50, ['rag-shared-collection']);
    assert(sharedDocuments.includes('Selected documents: 1') && sharedDocuments.includes('Document ID: rag-shared-task') && !sharedDocuments.includes('Document ID: rag-task\n'), 'collection-scoped document listing leaked another collection');
    const sharedSearch = await assistant.searchKnowledge(assistant.requireSession(scopedSession.id), '用于验证目录层级', 20, ['rag-shared-collection']);
    assert(sharedSearch.includes('Collection scope: 1 selected collection(s); 1 eligible document(s).') && sharedSearch.includes('Document ID: rag-shared-task') && !sharedSearch.includes('rag-same-name-task'), 'collection-scoped search did not isolate the requested collection');
    let unavailableCollectionError = null;
    try { await assistant.searchKnowledge(assistant.requireSession(scopedSession.id), '资料', 8, ['rag-multimodal-collection']); }
    catch (error) { unavailableCollectionError = error; }
    assert(/not selected in this session/.test(unavailableCollectionError?.message || ''), 'collection scope accepted an ID outside the current session');
    const collectionTool = assistant.toolDefinitions(assistant.requireSession(scopedSession.id), assistant.sessionModel(assistant.requireSession(scopedSession.id))).find((item) => item.function?.name === 'knowledge_list_collections');
    assert(collectionTool?.function?.parameters?.properties?.query?.type === 'string', 'collection discovery tool schema was not exposed');

    const attachmentFile = path.join(root, 'attachment.md');
    fs.writeFileSync(attachmentFile, '# 附件\n\n附件文字。', 'utf8');
    const attachments = await assistant.importFiles(session.id, [attachmentFile]);
    assert(attachments[0]?.extractedText.includes('附件文字'), 'Markdown attachment extraction failed');
    const publicSessionAttachment = assistant.sessionDetail(session.id).attachments[0];
    assert(!publicSessionAttachment.path && !publicSessionAttachment.extractedText && !publicSessionAttachment.managedRoot, 'RAG session state exposed private attachment storage details to the renderer');

    const first = await assistant.send(session.id, { content: '请查阅知识库并回答。', attachmentIds: [attachments[0].id] });
    assert(first.content.includes('已找到测试文档'), 'knowledge tool round trip failed');
    assert(first.reasoning.includes('先检索'), 'reasoning stream was not captured');
    assert(first.toolEvents[0]?.name === 'knowledge_search' && first.toolEvents[0]?.status === 'succeeded', 'streamed tool call was not assembled');
    assert(first.toolEvents[0].output.includes('星藏家测试文档'), 'knowledge retrieval did not return the selected document');
    assert(first.startedAt && first.finishedAt && Number(first.durationMs) >= 0 && first.toolCallCount === first.toolEvents.length, 'assistant run statistics were not persisted');
    assert(first.toolEvents[0].sequence === 1 && Number.isInteger(first.toolEvents[0].contentOffset) && first.toolEvents[0].startedAt && first.toolEvents[0].finishedAt, 'tool event position and timing metadata were not persisted');
    const firstApiRequest = fake.requests.find((item) => item.stream === true);
    assert(firstApiRequest.messages.filter((item) => item.role === 'user').length === 1, 'current user message was duplicated in model history');
    assert(firstApiRequest.max_tokens === 2048, 'model-specific output token limit was not used');
    const storedUser = store.list('ragMessages').find((item) => item.role === 'user');
    assert(!storedUser.attachments[0].extractedText && !storedUser.attachments[0].path, 'message storage duplicated private attachment content');

    const positionedReply = await assistant.send(session.id, { content: 'TOOL_POSITION_TEST' });
    assert(positionedReply.content === '工具前。工具后。' && positionedReply.toolEvents.length === 1 && positionedReply.toolEvents[0].contentOffset === '工具前。'.length, 'tool event was not anchored to the actual response position');
    const toolFailureSession = assistant.createSession({ providerId: provider.id, modelId: 'fake-agent', knowledgeCollectionIds: ['rag-collection'], title: 'Tool failure timeline test' });
    let toolFailure = null;
    try { await assistant.send(toolFailureSession.id, { content: 'TOOL_THEN_FAILURE' }); }
    catch (error) { toolFailure = error; }
    const persistedToolFailure = assistant.sessionDetail(toolFailureSession.id).messages.at(-1);
    assert(toolFailure?.code === 'MODEL_PROVIDER_FAILURE' && persistedToolFailure?.status === 'failed' && persistedToolFailure.content === '失败前。' && persistedToolFailure.toolEvents?.[0]?.name === 'knowledge_search' && persistedToolFailure.toolCallCount === 1, 'tool timeline or partial output was lost when the provider failed after a tool call');

    const documentList = assistant.listKnowledgeDocuments(assistant.requireSession(session.id));
    assert(documentList.includes('Document ID: rag-task'), 'knowledge document ids were not listed');
    assert(documentList.includes('Published at: 2026-06-18T08:00:00.000Z') && documentList.includes('Favorited at: 2026-06-20T09:30:00.000Z'), 'knowledge document index omitted publish/favorite dates');
    const exactDocument = assistant.readKnowledgeDocument(assistant.requireSession(session.id), 'rag-task', 1, 20);
    assert(exactDocument.includes('RAG 助手可以检索收藏夹中的 Markdown 内容。'), 'exact original Markdown could not be read');
    assert(exactDocument.includes('Published at: 2026-06-18T08:00:00.000Z') && exactDocument.includes('Favorited at: 2026-06-20T09:30:00.000Z'), 'exact document metadata omitted publish/favorite dates');
    const hugeMarkdown = path.join(root, 'huge-knowledge.md');
    fs.writeFileSync(hugeMarkdown, `# Huge\n\n${'x'.repeat(90000)}`, 'utf8');
    store.upsertTask({ id: 'rag-huge-task', collectionId: 'rag-collection', bvid: 'BVRAGHUGE', title: 'Huge knowledge fixture', status: 'done', outputMarkdown: hugeMarkdown, completedAt: new Date().toISOString() });
    const boundedExact = assistant.readKnowledgeDocument(assistant.requireSession(session.id), 'rag-huge-task', 1, 20);
    assert(boundedExact.length < 62000 && boundedExact.includes('next_start_column:'), 'exact knowledge reads can still flood one model tool response');
    store.upsertTask({ ...store.getTask('rag-task'), title: '星藏家测试文档（已移出收藏夹）', sourceTitle: '星藏家测试文档', favoriteState: 'removed', removedFromFavorites: true, removedFromFavoritesAt: '2026-07-01T00:00:00.000Z' });
    store.commit();
    const archivedDocument = assistant.listKnowledgeDocuments(assistant.requireSession(session.id));
    assert(archivedDocument.includes('已移出B站收藏夹 (removed)') && archivedDocument.includes('Status changed at: 2026-07-01T00:00:00.000Z'), 'RAG document index omitted removed-favorite status');
    store.upsertCollection({ ...store.getCollectionById('rag-collection'), name: 'AI 收藏夹（已在B站删除的收藏夹）', biliDeleted: true, biliDeletedAt: '2026-07-02T00:00:00.000Z' });
    const deletedCollectionDocument = assistant.readKnowledgeDocument(assistant.requireSession(session.id), 'rag-task', 1, 20);
    assert(deletedCollectionDocument.includes('B站收藏夹已删除 (collection-deleted)') && deletedCollectionDocument.includes('completed local artifacts are retained'), 'RAG exact read omitted deleted-collection archive status');
    const imageReply = await assistant.send(session.id, { content: 'IMAGE_TEST' });
    assert(imageReply.toolEvents[0]?.name === 'knowledge_view_images' && imageReply.toolEvents[0]?.images?.length === 1, 'knowledge image tool did not expose a displayable original image');
    const imageRequest = [...fake.requests].reverse().find((item) => item.messages?.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url')));
    assert(imageRequest, 'original knowledge image was not sent as multimodal model input');
    const sentImageUrl = imageRequest.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).find((part) => part.type === 'image_url')?.image_url?.url || '';
    assert(sentImageUrl.length < 1024 && preparedVisionFiles.includes(knowledgeImage), 'knowledge image model input was not passed through the bounded vision-image preparation path');
    const imageUri = imageReply.toolEvents[0].images[0].uri;
    assert(assistant.resolveKnowledgeImage(session.id, imageUri) === knowledgeImage, 'safe knowledge image URI did not resolve to the original file');
    const imageTool = assistant.toolDefinitions(assistant.requireSession(session.id), assistant.sessionModel(assistant.requireSession(session.id))).find((item) => item.function?.name === 'knowledge_view_images');
    const imageIndicesSchema = imageTool?.function?.parameters?.properties?.image_indices;
    assert(imageIndicesSchema?.maxItems === 4 && imageIndicesSchema?.items?.minimum === 1 && /one-based/i.test(imageIndicesSchema?.description || ''), 'knowledge image tool did not declare its four-image, one-based index contract');
    const zeroBasedSingle = assistant.viewKnowledgeImages(assistant.requireSession(session.id), assistant.sessionModel(assistant.requireSession(session.id)), 'rag-task', [0]);
    assert(zeroBasedSingle.images.length === 1 && zeroBasedSingle.images[0].index === 1, 'obvious zero-based first-image input was not normalized to image 1');
    const zeroBasedBatch = assistant.viewKnowledgeImages(assistant.requireSession(session.id), assistant.sessionModel(assistant.requireSession(session.id)), 'rag-task', [0, 1, 2, 3]);
    assert(zeroBasedBatch.images.map((item) => item.index).join(',') === '1,2,3,4', 'obvious zero-based image batch was not normalized as one index set');
    const multiBatchSession = assistant.createSession({ providerId: provider.id, modelId: 'fake-tools', knowledgeCollectionIds: ['rag-collection'], title: 'Multi-batch vision test' });
    const multiBatchReply = await assistant.send(multiBatchSession.id, { content: 'IMAGE_MULTI_BATCH_TEST' });
    assert(multiBatchReply.content === '已分两批查看八张图片。' && multiBatchReply.toolEvents.length === 2 && multiBatchReply.toolEvents.every((event) => event.status === 'succeeded'), 'RAG could not inspect more than four images through repeated four-image batches in one response');
    const finalMultiBatchRequest = [...fake.requests].reverse().find((item) => JSON.stringify(item.messages || []).includes('IMAGE_MULTI_BATCH_TEST'));
    const finalMultiBatchImages = (finalMultiBatchRequest?.messages || []).flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((part) => part.type === 'image_url');
    assert(finalMultiBatchImages.length === 8, 'RAG retained a fixed per-response image-count limit instead of dynamic budgets');
    const largeImageOutcome = assistant.viewKnowledgeImages(assistant.requireSession(session.id), assistant.sessionModel(assistant.requireSession(session.id)), 'rag-task', [2]);
    assert(largeImageOutcome.visionParts[0].image_url.url.length < 1024 && preparedVisionFiles.includes(largeKnowledgeImage), 'large local-document image was sent to the model without optimization');
    assert(assistant.resolveKnowledgeImage(session.id, largeImageOutcome.images[0].uri) === largeKnowledgeImage, 'optimized model input replaced the original full-resolution display image');

    const clipboardImage = await assistant.importBuffer(session.id, {
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
      mimeType: 'image/png',
      name: 'clipboard-test.png'
    });
    assert(clipboardImage.previewUrl.startsWith('file:') && fs.existsSync(clipboardImage.path), 'clipboard image was not imported with a local preview');
    const disposableImage = await assistant.importBuffer(session.id, {
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
      mimeType: 'image/png',
      name: 'discard-before-send.png'
    });
    assert(assistant.discardAttachment(session.id, disposableImage.id).removed && !fs.existsSync(disposableImage.path) && !store.get('ragAttachments', disposableImage.id), 'unsent attachment discard left a file or record behind');
    const fallback = await assistant.send(session.id, { content: 'JSON_FALLBACK', attachmentIds: [clipboardImage.id] });
    assert(fallback.content === '普通 JSON 兼容成功。' && fallback.reasoning === '普通 JSON 推理', 'non-SSE JSON fallback failed');
    const clipboardRequest = [...fake.requests].reverse().find((item) => latestUserText(item.messages || []).includes('JSON_FALLBACK'));
    assert(clipboardRequest.messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url')), 'clipboard image was not sent as multimodal input');
    const clipboardMessage = assistant.sessionDetail(session.id).messages.find((message) => message.role === 'user' && message.content === 'JSON_FALLBACK');
    assert(clipboardMessage.attachments[0]?.previewUrl.startsWith('file:'), 'sent clipboard image did not retain a conversation preview');

    const thinkTagSession = assistant.createSession({ providerId: provider.id, modelId: 'fake-agent', title: 'Inline reasoning tag test' });
    const thinkTagReply = await assistant.send(thinkTagSession.id, { content: 'THINK_TAG_TEST' });
    assert(thinkTagReply.content === '正文前正文后' && thinkTagReply.reasoning === '隐藏推理' && !/<\/?think>/i.test(thinkTagReply.content), 'inline think tags were not separated from the final answer');

    const compatibilityProvider = assistant.saveProvider({ name: 'Compatibility fallback', type: 'openai', baseUrl: fake.url.replace(/\/v1$/, ''), apiKey: 'secret' });
    assistant.updateProviderModels(compatibilityProvider.id, [{ id: 'fake-agent', contextWindow: 32768, maxOutputTokens: 2048, supportsTools: false, supportsReasoning: false, supportsCompression: true }]);
    const compatibilitySession = assistant.createSession({ providerId: compatibilityProvider.id, modelId: 'fake-agent', title: 'Provider compatibility test' });
    const compatibilityReply = await assistant.send(compatibilitySession.id, { content: 'COMPAT_PARAMETERS' });
    assert(compatibilityReply.content === '兼容参数成功。', 'provider parameter compatibility retries did not complete');
    assert(assistant.rawProvider(compatibilityProvider.id).resolvedBaseUrl === fake.url, 'chat completion did not remember the working /v1 endpoint');
    const compatibilityRequests = fake.requests.filter((item) => latestUserText(item.messages || []).includes('COMPAT_PARAMETERS'));
    assert(compatibilityRequests.some((item) => item.max_tokens !== undefined) && compatibilityRequests.some((item) => item.max_completion_tokens !== undefined && !item.stream_options && item.temperature === 1), 'provider compatibility retries did not switch output parameter, stream options, and fixed temperature');
    const noTemperatureSession = assistant.createSession({ providerId: compatibilityProvider.id, modelId: 'fake-agent', title: 'No temperature compatibility test' });
    const noTemperatureReply = await assistant.send(noTemperatureSession.id, { content: 'COMPAT_NO_TEMPERATURE' });
    assert(noTemperatureReply.content === '无温度参数兼容成功。' && fake.requests.some((item) => latestUserText(item.messages || []).includes('COMPAT_NO_TEMPERATURE') && item.temperature === undefined), 'unsupported temperature parameter was not removed on retry');

    const disposableSession = assistant.createSession({ providerId: provider.id, modelId: 'fake-agent', title: 'Attachment cleanup test' });
    const disposableSessionImage = await assistant.importBuffer(disposableSession.id, {
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
      mimeType: 'image/png',
      name: 'delete-with-session.png'
    });
    assistant.updateSession(disposableSession.id, { sandboxDir: path.join(root, 'replacement-sandbox') });
    assistant.deleteSession(disposableSession.id);
    assert(!fs.existsSync(disposableSessionImage.path) && !store.get('ragAttachments', disposableSessionImage.id), 'deleting a RAG session after changing sandboxes left its managed attachment copy behind');

    const linkedSession = assistant.createSession({ providerId: provider.id, modelId: 'fake-agent', title: 'Linked attachment deletion guard' });
    const linkedImage = await assistant.importBuffer(linkedSession.id, {
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
      mimeType: 'image/png',
      name: 'linked-delete.png'
    });
    const linkedParent = path.dirname(linkedImage.path);
    const originalParent = `${linkedParent}-original`;
    const outsideAttachments = path.join(root, 'outside-attachments');
    fs.renameSync(linkedParent, originalParent);
    fs.mkdirSync(outsideAttachments, { recursive: true });
    const outsideImage = path.join(outsideAttachments, path.basename(linkedImage.path));
    fs.copyFileSync(path.join(originalParent, path.basename(linkedImage.path)), outsideImage);
    let linkCreated = false;
    try {
      fs.symlinkSync(outsideAttachments, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
      linkCreated = true;
      assistant.deleteSession(linkedSession.id);
      assert(fs.existsSync(outsideImage), 'session deletion followed a replaced attachments-directory link outside its managed root');
    } catch (error) {
      if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error;
      if (store.get('ragSessions', linkedSession.id)) assistant.deleteSession(linkedSession.id);
    } finally {
      if (linkCreated && fs.existsSync(linkedParent)) fs.rmSync(linkedParent, { recursive: true, force: true });
    }

    const historySession = assistant.createSession({ providerId: provider.id, modelId: 'fake-agent', title: 'Long context test' });
    for (let index = 0; index < 60; index += 1) {
      store.set('ragMessages', `history-${index}`, { id: `history-${index}`, sessionId: historySession.id, role: index % 2 ? 'assistant' : 'user', content: `short history message ${index}`, status: 'complete', createdAt: new Date(Date.now() + index).toISOString() });
    }
    const longHistory = assistant.buildHistory(assistant.requireSession(historySession.id), normalizeModel({ id: 'unknown-modern-model' }));
    assert(longHistory.length === 61, 'large-context history is still truncated to the legacy fixed message count');

    for (let index = 0; index < 8; index += 1) {
      store.set('ragMessages', `auto-history-${index}`, { id: `auto-history-${index}`, sessionId: historySession.id, role: index % 2 ? 'assistant' : 'user', content: `AUTO_HISTORY_MARKER_${index} ${'long context '.repeat(110)}`, status: 'complete', createdAt: new Date(Date.now() + 1000 + index).toISOString() });
    }
    store.save();
    const usageBeforeAuto = assistant.state(historySession.id).modelUsage.find((item) => item.providerId === provider.id && item.modelId === 'fake-agent')?.requests || 0;
    const autoReply = await assistant.send(historySession.id, { content: 'AUTO_COMPACT_TEST：请继续回答当前问题。' });
    assert(autoReply.content.includes('测试回复'), 'automatic context compression did not continue the current answer');
    const autoDetail = assistant.sessionDetail(historySession.id);
    assert(autoDetail.autoCompactionCount === 1 && autoDetail.lastCompactionMode === 'automatic' && autoDetail.compressedThroughMessageId === 'auto-history-7', 'automatic context compression state was not persisted');
    assert(autoDetail.contextPercent < autoDetail.autoCompactionThresholdPercent, 'automatic compression did not reduce active context below its trigger');
    const autoRequest = [...fake.requests].reverse().find((item) => latestUserText(item.messages || []).includes('AUTO_COMPACT_TEST'));
    assert(autoRequest.messages[0].content.includes('Compressed earlier context') && !JSON.stringify(autoRequest.messages).includes('AUTO_HISTORY_MARKER_0'), 'compressed history was duplicated into the post-compression model request');
    const usageAfterAuto = assistant.state(historySession.id).modelUsage.find((item) => item.providerId === provider.id && item.modelId === 'fake-agent')?.requests || 0;
    assert(usageAfterAuto >= usageBeforeAuto + 2, 'automatic compression model calls were not included in usage accounting');
    assert(events.some((item) => item.type === 'context-compaction' && item.phase === 'completed' && item.automatic), 'automatic compression UI event was not emitted');

    const toolRoundSession = assistant.createSession({ providerId: provider.id, modelId: 'fake-tools', title: 'Tool round accounting test' });
    const usageBeforeToolRounds = assistant.state(toolRoundSession.id).modelUsage.find((item) => item.providerId === provider.id && item.modelId === 'fake-tools')?.requests || 0;
    const manyToolRounds = await assistant.send(toolRoundSession.id, { content: 'TOOL_ROUND_LIMIT：连续检索后给出答案。' });
    assert(manyToolRounds.toolEvents.length === 24 && manyToolRounds.content.includes('24 轮'), 'RAG assistant did not allow 24 complete knowledge-tool rounds plus a final answer');
    const usageAfterToolRounds = assistant.state(toolRoundSession.id).modelUsage.find((item) => item.providerId === provider.id && item.modelId === 'fake-tools')?.requests || 0;
    assert(usageAfterToolRounds === usageBeforeToolRounds + 1, 'multi-round answer usage should be recorded as one conversation turn');

    const providerFailureSession = assistant.createSession({ providerId: provider.id, modelId: 'fake-agent', title: 'Provider failure classification' });
    let providerFailure = null;
    try { await assistant.send(providerFailureSession.id, { content: 'PROVIDER_FAILURE' }); }
    catch (error) { providerFailure = error; }
    assert(providerFailure?.code === 'MODEL_PROVIDER_FAILURE' && providerFailure.failureKind === 'infrastructure' && Array.isArray(providerFailure.possibleCauses), 'provider request failure was not classified as infrastructure');

    for (const marker of ['HTTP_200_JSON_ERROR', 'HTTP_200_SSE_ERROR']) {
      const payloadErrorSession = assistant.createSession({ providerId: provider.id, modelId: 'fake-agent', title: `${marker} classification` });
      let payloadError = null;
      try { await assistant.send(payloadErrorSession.id, { content: marker }); }
      catch (error) { payloadError = error; }
      assert(payloadError?.code === 'MODEL_PROVIDER_FAILURE' && payloadError.failureKind === 'infrastructure' && payloadError.explicitProviderError === true, `${marker} was treated as an empty successful response`);
    }

    await assistant.send(session.id, { content: '再补一轮测试。' });
    const compacted = await assistant.compact(session.id);
    assert(compacted.compressedSummary.includes('保留目标'), 'context compression failed');
    assert(compacted.tokenUsage.total >= 150, 'token accounting did not accumulate requests');

    const compactLockSession = assistant.createSession({ providerId: provider.id, modelId: 'fake-agent', title: 'Compaction lock test' });
    for (let index = 0; index < 4; index += 1) {
      store.set('ragMessages', `compact-lock-${index}`, { id: `compact-lock-${index}`, sessionId: compactLockSession.id, role: index % 2 ? 'assistant' : 'user', content: `COMPACT_DELAY message ${index}`, status: 'complete', createdAt: new Date(Date.now() + index).toISOString() });
    }
    store.save();
    const firstCompaction = assistant.compact(compactLockSession.id);
    let concurrentCompactionError = null;
    try { await assistant.compact(compactLockSession.id); } catch (error) { concurrentCompactionError = error; }
    assert(/Stop the current response/.test(concurrentCompactionError?.message || ''), 'concurrent manual context compaction was not rejected');
    await firstCompaction;

    const outside = path.join(root, '..', 'outside.txt');
    fs.writeFileSync(outside, 'outside', 'utf8');
    let denied = false;
    try { await assistant.executeTool(assistant.requireSession(session.id), assistant.sessionModel(assistant.requireSession(session.id)), { name: 'read_file', arguments: JSON.stringify({ path: outside }) }); }
    catch (error) { denied = /denied/.test(error.message); }
    assert(denied && approvals.length === 1, 'restricted outside-sandbox approval was not enforced');

    const state = assistant.state(session.id);
    assert(catalogItem(state.knowledgeCatalog, 'rag-collection').documentCount === 2, 'knowledge catalog classification failed');
    assert(state.modelUsage.reduce((sum, item) => sum + Number(item.requests || 0), 0) >= 8, 'per-model request count did not include extended RAG and compression calls');
    assert(events.some((item) => item.type === 'assistant-delta') && events.some((item) => item.type === 'tool'), 'stream events were not emitted');
    const shutdownController = new AbortController();
    assistant.controllers.set('shutdown-fixture', shutdownController);
    assert(assistant.shutdown().cancelled === 1, 'RAG shutdown did not report the active request');
    assert(shutdownController.signal.aborted === true, 'RAG shutdown left a running provider request or command alive');
    assistant.controllers.delete('shutdown-fixture');
    console.log('RAG assistant integration test passed.');
  } finally {
    await fake.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
