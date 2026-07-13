const fs = require('fs');
const http = require('http');
const path = require('path');
const { Store } = require('../src/core/store');
const { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT_TOKENS, RagAssistant, normalizeModel } = require('../src/core/rag-assistant');

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
      response.end(JSON.stringify({ data: [{ id: 'fake-agent' }, { id: 'fake-reader' }] }));
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
    if (body.stream === false) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: '保留目标、事实、引用和未完成工作。' } }], usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 } }));
      return;
    }
    if (userText.includes('JSON_FALLBACK')) {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ choices: [{ message: { reasoning_content: '普通 JSON 推理', content: '普通 JSON 兼容成功。' } }], usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 } }));
      return;
    }
    if (userText.includes('IMAGE_TEST') && !toolResult) {
      sse(response, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-image', type: 'function', function: { name: 'knowledge_view_images', arguments: '{"document_id":"rag-task","image_indices":[1]}' } }] } }] }
      ]);
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
    const knowledgeImage = path.join(root, 'frame.png');
    fs.writeFileSync(knowledgeImage, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
    fs.appendFileSync(markdown, '\n![测试关键帧](frame.png)\n', 'utf8');
    store.upsertUser({ id: 'rag-user', mid: 'rag-user', name: '测试用户' });
    store.upsertCollection({ id: 'rag-collection', name: 'AI 收藏夹', userId: 'rag-user', userName: '测试用户' });
    store.upsertTask({ id: 'rag-task', collectionId: 'rag-collection', bvid: 'BVRAGTEST', title: '星藏家测试文档', owner: '测试 UP', status: 'done', outputMarkdown: markdown, completedAt: new Date().toISOString() });
    store.set('ragProviders', 'legacy-provider', { id: 'legacy-provider', name: 'Legacy', type: 'openai', baseUrl: fake.url, maxOutputTokens: 8192, enabledModels: [{ id: 'gpt-5.4-mini', contextWindow: 128000 }], remoteModels: [] });
    store.commit();

    const events = [];
    const approvals = [];
    const assistant = new RagAssistant({
      store,
      workspaceRoot: root,
      encryptSecret: (value) => ({ value }),
      decryptSecret: (secret) => secret.value,
      emit: (event) => events.push(event),
      requestApproval: async (request) => { approvals.push(request); return { approved: false }; },
      browseHidden: async (url) => `BROWSED ${url}`,
      openExternal: async () => {}
    });

    const migrated = assistant.rawProvider('legacy-provider');
    assert(migrated.maxOutputTokens === DEFAULT_MAX_OUTPUT_TOKENS && migrated.enabledModels[0].contextWindow === 400000 && migrated.enabledModels[0].maxOutputTokens === 128000, 'legacy token defaults were not migrated');
    assert(normalizeModel({ id: 'unknown-modern-model' }).contextWindow === DEFAULT_CONTEXT_WINDOW, 'modern default context window is incorrect');
    store.delete('ragProviders', 'legacy-provider');
    store.commit();

    const provider = assistant.saveProvider({ name: 'Fake NewAPI', type: 'newapi', baseUrl: fake.url.replace(/\/v1$/, ''), apiKey: 'secret' });
    const remoteModels = await assistant.fetchModels(provider.id);
    assert(remoteModels.length === 2, 'remote model list was not fetched');
    assert(assistant.rawProvider(provider.id).resolvedBaseUrl === fake.url, 'NewAPI /v1 endpoint was not discovered');
    assistant.updateProviderModels(provider.id, [{ id: 'fake-agent', contextWindow: 4096, maxOutputTokens: 2048, supportsTools: true, supportsReasoning: true, supportsVision: true, supportsCompression: true, supportsSubagents: true }]);
    const session = assistant.createSession({ providerId: provider.id, modelId: 'fake-agent', knowledgeCollectionIds: ['rag-collection'] });

    const attachmentFile = path.join(root, 'attachment.md');
    fs.writeFileSync(attachmentFile, '# 附件\n\n附件文字。', 'utf8');
    const attachments = await assistant.importFiles(session.id, [attachmentFile]);
    assert(attachments[0]?.extractedText.includes('附件文字'), 'Markdown attachment extraction failed');

    const first = await assistant.send(session.id, { content: '请查阅知识库并回答。', attachmentIds: [attachments[0].id] });
    assert(first.content.includes('已找到测试文档'), 'knowledge tool round trip failed');
    assert(first.reasoning.includes('先检索'), 'reasoning stream was not captured');
    assert(first.toolEvents[0]?.name === 'knowledge_search' && first.toolEvents[0]?.status === 'succeeded', 'streamed tool call was not assembled');
    assert(first.toolEvents[0].output.includes('星藏家测试文档'), 'knowledge retrieval did not return the selected document');
    const firstApiRequest = fake.requests.find((item) => item.stream === true);
    assert(firstApiRequest.messages.filter((item) => item.role === 'user').length === 1, 'current user message was duplicated in model history');
    assert(firstApiRequest.max_tokens === 2048, 'model-specific output token limit was not used');
    const storedUser = store.list('ragMessages').find((item) => item.role === 'user');
    assert(!storedUser.attachments[0].extractedText && !storedUser.attachments[0].path, 'message storage duplicated private attachment content');

    const documentList = assistant.listKnowledgeDocuments(assistant.requireSession(session.id));
    assert(documentList.includes('Document ID: rag-task'), 'knowledge document ids were not listed');
    const exactDocument = assistant.readKnowledgeDocument(assistant.requireSession(session.id), 'rag-task', 1, 20);
    assert(exactDocument.includes('RAG 助手可以检索收藏夹中的 Markdown 内容。'), 'exact original Markdown could not be read');
    const imageReply = await assistant.send(session.id, { content: 'IMAGE_TEST' });
    assert(imageReply.toolEvents[0]?.name === 'knowledge_view_images' && imageReply.toolEvents[0]?.images?.length === 1, 'knowledge image tool did not expose a displayable original image');
    const imageRequest = [...fake.requests].reverse().find((item) => item.messages?.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url')));
    assert(imageRequest, 'original knowledge image was not sent as multimodal model input');
    const imageUri = imageReply.toolEvents[0].images[0].uri;
    assert(assistant.resolveKnowledgeImage(session.id, imageUri) === knowledgeImage, 'safe knowledge image URI did not resolve to the original file');

    const clipboardImage = await assistant.importBuffer(session.id, {
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
      mimeType: 'image/png',
      name: 'clipboard-test.png'
    });
    assert(clipboardImage.previewUrl.startsWith('file:') && fs.existsSync(clipboardImage.path), 'clipboard image was not imported with a local preview');
    const fallback = await assistant.send(session.id, { content: 'JSON_FALLBACK', attachmentIds: [clipboardImage.id] });
    assert(fallback.content === '普通 JSON 兼容成功。' && fallback.reasoning === '普通 JSON 推理', 'non-SSE JSON fallback failed');
    const clipboardRequest = [...fake.requests].reverse().find((item) => latestUserText(item.messages || []).includes('JSON_FALLBACK'));
    assert(clipboardRequest.messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url')), 'clipboard image was not sent as multimodal input');
    const clipboardMessage = assistant.sessionDetail(session.id).messages.find((message) => message.role === 'user' && message.content === 'JSON_FALLBACK');
    assert(clipboardMessage.attachments[0]?.previewUrl.startsWith('file:'), 'sent clipboard image did not retain a conversation preview');

    const historySession = assistant.createSession({ providerId: provider.id, modelId: 'fake-agent', title: 'Long context test' });
    for (let index = 0; index < 60; index += 1) {
      store.set('ragMessages', `history-${index}`, { id: `history-${index}`, sessionId: historySession.id, role: index % 2 ? 'assistant' : 'user', content: `short history message ${index}`, status: 'complete', createdAt: new Date(Date.now() + index).toISOString() });
    }
    const longHistory = assistant.buildHistory(assistant.requireSession(historySession.id), normalizeModel({ id: 'unknown-modern-model' }));
    assert(longHistory.length === 61, 'large-context history is still truncated to the legacy fixed message count');

    await assistant.send(session.id, { content: '再补一轮测试。' });
    const compacted = await assistant.compact(session.id);
    assert(compacted.compressedSummary.includes('保留目标'), 'context compression failed');
    assert(compacted.tokenUsage.total >= 150, 'token accounting did not accumulate requests');

    const outside = path.join(root, '..', 'outside.txt');
    fs.writeFileSync(outside, 'outside', 'utf8');
    let denied = false;
    try { await assistant.executeTool(assistant.requireSession(session.id), assistant.sessionModel(assistant.requireSession(session.id)), { name: 'read_file', arguments: JSON.stringify({ path: outside }) }); }
    catch (error) { denied = /denied/.test(error.message); }
    assert(denied && approvals.length === 1, 'restricted outside-sandbox approval was not enforced');

    const state = assistant.state(session.id);
    assert(state.knowledgeCatalog[0]?.documentCount === 1, 'knowledge catalog classification failed');
    assert(state.modelUsage[0]?.requests === 5, 'per-model request count is incorrect');
    assert(events.some((item) => item.type === 'assistant-delta') && events.some((item) => item.type === 'tool'), 'stream events were not emitted');
    console.log('RAG assistant integration test passed.');
  } finally {
    await fake.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
