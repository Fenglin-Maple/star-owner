const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const MarkdownIt = require('markdown-it');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const { isPrivateNetworkHost, parseHttpUrl } = require('./network-policy');

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.xml', '.yaml', '.yml',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.cpp', '.h', '.hpp',
  '.cs', '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.kts', '.html', '.css', '.scss', '.sql',
  '.ps1', '.cmd', '.bat', '.sh', '.log', '.ini', '.toml', '.env'
]);

const MIME_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.md': 'text/markdown'
};

const TOKEN_CONFIG_VERSION = 2;
const DEFAULT_CONTEXT_WINDOW = 1000000;
const DEFAULT_MAX_OUTPUT_TOKENS = 128000;
const knowledgeMarkdownParser = new MarkdownIt({ html: false, linkify: false, typographer: false });

class RagAssistant {
  constructor({ store, workspaceRoot, encryptSecret, decryptSecret, emit, requestApproval, browseHidden, openExternal }) {
    this.store = store;
    this.workspaceRoot = workspaceRoot;
    this.encryptSecret = encryptSecret;
    this.decryptSecret = decryptSecret;
    this.emit = emit;
    this.requestApproval = requestApproval;
    this.browseHidden = browseHidden;
    this.openExternal = openExternal;
    this.controllers = new Map();
    this.documentCache = new Map();
    this.sandboxRoot = ensureDir(path.join(workspaceRoot, '.star-note', 'rag-sandboxes'));
    this.migrateTokenConfiguration();
  }

  state(sessionId = '') {
    const sessions = this.listSessions();
    const activeId = sessionId || sessions[0]?.id || '';
    return {
      providers: this.listProviders(),
      sessions,
      activeSession: activeId ? this.sessionDetail(activeId) : null,
      knowledgeCatalog: this.knowledgeCatalog(),
      modelUsage: this.store.list('ragModelUsage').sort((a, b) => Number(b.totalTokens || 0) - Number(a.totalTokens || 0))
    };
  }

  listProviders() {
    return this.store.list('ragProviders').map(publicProvider).sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
  }

  saveProvider(input = {}) {
    const id = String(input.id || `provider-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
    const current = this.store.get('ragProviders', id) || {};
    const baseUrl = normalizeBaseUrl(input.baseUrl || current.baseUrl);
    if (!baseUrl) throw new Error('Base URL is required. Use the service root or the API root that contains /models and /chat/completions.');
    const extraHeaders = normalizeHeaders(input.extraHeaders === undefined ? current.extraHeaders : input.extraHeaders);
    const next = {
      ...current,
      id,
      name: String(input.name || current.name || 'OpenAI compatible').trim(),
      type: ['openai', 'newapi'].includes(input.type) ? input.type : (current.type || 'openai'),
      baseUrl,
      extraHeaders,
      temperature: finiteNumber(input.temperature, current.temperature, 0.2),
      maxOutputTokens: positiveInteger(input.maxOutputTokens, current.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS),
      tokenConfigVersion: TOKEN_CONFIG_VERSION,
      resolvedBaseUrl: baseUrl === current.baseUrl ? (current.resolvedBaseUrl || '') : '',
      enabledModels: Array.isArray(input.enabledModels) ? input.enabledModels.map(normalizeModel) : (current.enabledModels || []),
      remoteModels: current.remoteModels || [],
      updatedAt: new Date().toISOString(),
      createdAt: current.createdAt || new Date().toISOString()
    };
    const apiKey = String(input.apiKey || '');
    if (apiKey) next.encryptedApiKey = this.encryptSecret(apiKey);
    this.store.set('ragProviders', id, next);
    this.store.save();
    return publicProvider(next);
  }

  deleteProvider(id) {
    const providerId = String(id || '');
    if (this.listSessions().some((session) => session.providerId === providerId)) {
      throw new Error('This provider is used by an existing session. Switch or delete those sessions first.');
    }
    this.store.delete('ragProviders', providerId);
    this.store.save();
    return { deleted: true, id: providerId };
  }

  async fetchModels(providerId) {
    const provider = this.rawProvider(providerId);
    let source = null;
    const errors = [];
    for (const root of candidateApiRoots(provider)) {
      try {
        const response = await fetch(`${root}/models`, { headers: this.providerHeaders(provider), signal: AbortSignal.timeout(30000) });
        const text = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
        const payload = parseJson(text, 'non-JSON response');
        const candidate = Array.isArray(payload.data) ? payload.data : (Array.isArray(payload.models) ? payload.models : null);
        if (!candidate) throw new Error('response did not contain a model list');
        source = candidate;
        provider.resolvedBaseUrl = root;
        break;
      } catch (error) {
        errors.push(`${root}/models: ${error.message || String(error)}`);
      }
    }
    if (!source) throw new Error(`Model list failed. ${errors.join(' | ').slice(0, 1600)}`);
    const models = source.map((item) => normalizeModel(typeof item === 'string' ? { id: item } : item)).filter((item) => item.id);
    provider.remoteModels = models;
    provider.updatedAt = new Date().toISOString();
    this.store.set('ragProviders', provider.id, provider);
    this.store.save();
    return models;
  }

  updateProviderModels(providerId, models) {
    const provider = this.rawProvider(providerId);
    provider.enabledModels = (models || []).map(normalizeModel).filter((item) => item.id);
    provider.updatedAt = new Date().toISOString();
    this.store.set('ragProviders', provider.id, provider);
    this.store.save();
    return publicProvider(provider);
  }

  rawProvider(id) {
    const provider = this.store.get('ragProviders', String(id || ''));
    if (!provider) throw new Error('RAG provider not found.');
    return provider;
  }

  providerHeaders(provider) {
    const headers = { accept: 'application/json', 'content-type': 'application/json', ...provider.extraHeaders };
    if (provider.encryptedApiKey) headers.authorization = `Bearer ${this.decryptSecret(provider.encryptedApiKey)}`;
    return headers;
  }

  providerEndpoint(provider, resource) {
    return `${provider.resolvedBaseUrl || provider.baseUrl}/${String(resource || '').replace(/^\/+/, '')}`;
  }

  outputTokenLimit(provider, modelInput) {
    const model = typeof modelInput === 'string'
      ? normalizeModel(provider?.enabledModels?.find((item) => item.id === modelInput) || { id: modelInput })
      : normalizeModel(modelInput || {});
    return positiveInteger(model.maxOutputTokens, provider?.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS);
  }

  migrateTokenConfiguration() {
    let changed = false;
    for (const provider of this.store.list('ragProviders')) {
      if (Number(provider.tokenConfigVersion || 0) >= TOKEN_CONFIG_VERSION) continue;
      if (!provider.maxOutputTokens || Number(provider.maxOutputTokens) === 8192) provider.maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
      provider.enabledModels = (provider.enabledModels || []).map(migrateLegacyModel);
      provider.remoteModels = (provider.remoteModels || []).map(migrateLegacyModel);
      provider.tokenConfigVersion = TOKEN_CONFIG_VERSION;
      provider.updatedAt = new Date().toISOString();
      this.store.set('ragProviders', provider.id, provider);
      changed = true;
    }
    if (changed) this.store.save();
  }

  listSessions() {
    return this.store.list('ragSessions').sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  createSession(input = {}) {
    const provider = input.providerId ? this.rawProvider(input.providerId) : this.store.list('ragProviders')[0];
    const model = String(input.modelId || provider?.enabledModels?.[0]?.id || '');
    const id = `rag-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const sandboxDir = ensureDir(input.sandboxDir || path.join(this.sandboxRoot, id));
    const session = {
      id,
      title: String(input.title || '新对话'),
      providerId: provider?.id || '',
      modelId: model,
      knowledgeCollectionIds: uniqueStrings(input.knowledgeCollectionIds || []),
      sandboxDir,
      permissionMode: input.permissionMode === 'full' ? 'full' : 'restricted',
      systemPrompt: String(input.systemPrompt || ''),
      tokenUsage: { input: 0, output: 0, total: 0 },
      compressedSummary: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.store.set('ragSessions', id, session);
    this.store.save();
    return this.sessionDetail(id);
  }

  updateSession(id, patch = {}) {
    const session = this.requireSession(id);
    const next = { ...session };
    if (patch.title !== undefined) next.title = String(patch.title || '新对话').trim();
    if (patch.providerId !== undefined) next.providerId = this.rawProvider(patch.providerId).id;
    if (patch.modelId !== undefined) next.modelId = String(patch.modelId || '');
    if (patch.knowledgeCollectionIds !== undefined) next.knowledgeCollectionIds = uniqueStrings(patch.knowledgeCollectionIds);
    if (patch.sandboxDir !== undefined) next.sandboxDir = ensureDir(path.resolve(String(patch.sandboxDir)));
    if (patch.permissionMode !== undefined) next.permissionMode = patch.permissionMode === 'full' ? 'full' : 'restricted';
    if (patch.systemPrompt !== undefined) next.systemPrompt = String(patch.systemPrompt || '');
    next.updatedAt = new Date().toISOString();
    this.store.set('ragSessions', next.id, next);
    this.store.save();
    return this.sessionDetail(next.id);
  }

  deleteSession(id) {
    const session = this.requireSession(id);
    this.cancel(id);
    for (const message of this.store.list('ragMessages').filter((item) => item.sessionId === id)) this.store.delete('ragMessages', message.id);
    for (const attachment of this.store.list('ragAttachments').filter((item) => item.sessionId === id)) this.store.delete('ragAttachments', attachment.id);
    this.store.delete('ragSessions', id);
    this.store.save();
    return { deleted: true, id: session.id };
  }

  requireSession(id) {
    const session = this.store.get('ragSessions', String(id || ''));
    if (!session) throw new Error('RAG session not found.');
    return session;
  }

  sessionDetail(id) {
    const session = this.requireSession(id);
    const messages = this.store.list('ragMessages').filter((item) => item.sessionId === id).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const attachments = this.store.list('ragAttachments').filter((item) => item.sessionId === id).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const model = this.sessionModel(session);
    const contextTokens = estimateTokens(JSON.stringify(messages.slice(session.compressedSummary ? -8 : 0))) + estimateTokens(session.compressedSummary || '');
    return {
      ...session,
      messages,
      attachments,
      modelCapabilities: model,
      contextTokens,
      contextWindow: model.contextWindow,
      contextPercent: Math.min(100, Math.round((contextTokens / Math.max(1, model.contextWindow)) * 1000) / 10)
    };
  }

  sessionModel(session) {
    const provider = session.providerId ? this.store.get('ragProviders', session.providerId) : null;
    return normalizeModel(provider?.enabledModels?.find((item) => item.id === session.modelId) || { id: session.modelId });
  }

  knowledgeCatalog() {
    const tasks = this.store.listTasks().filter((task) => task.status === 'done' && task.outputMarkdown && fs.existsSync(task.outputMarkdown));
    const collections = this.store.listCollections();
    const users = new Map(this.store.list('users').map((user) => [String(user.id), user]));
    return collections.map((collection) => {
      const documents = tasks.filter((task) => task.collectionId === collection.id);
      if (!documents.length) return null;
      const user = users.get(String(collection.userId || ''));
      return {
        id: collection.id,
        name: collection.name,
        userId: collection.userId || user?.id || '',
        userName: collection.userName || user?.name || '未知用户',
        documentCount: documents.length,
        updatedAt: documents.map((task) => task.completedAt || task.updatedAt || '').sort().at(-1) || collection.updatedAt || ''
      };
    }).filter(Boolean).sort((a, b) => `${a.userName}/${a.name}`.localeCompare(`${b.userName}/${b.name}`, 'zh-Hans-CN'));
  }

  async importFiles(sessionId, filePaths) {
    const session = this.requireSession(sessionId);
    const destination = ensureDir(path.join(session.sandboxDir, 'attachments'));
    const imported = [];
    for (const source of filePaths || []) {
      const stat = fs.statSync(source);
      if (!stat.isFile()) continue;
      const id = `attachment-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      const name = safeFilename(path.basename(source));
      const target = uniqueFile(destination, `${id}-${name}`);
      fs.copyFileSync(source, target);
      const extractedText = await extractText(target);
      const extension = path.extname(target).toLowerCase();
      const record = {
        id,
        sessionId,
        name,
        path: target,
        mimeType: MIME_TYPES[extension] || 'application/octet-stream',
        size: stat.size,
        extractedText: extractedText.slice(0, 120000),
        createdAt: new Date().toISOString()
      };
      this.store.set('ragAttachments', id, record);
      imported.push(record);
    }
    this.store.save();
    return imported;
  }

  async send(sessionId, input = {}) {
    const session = this.requireSession(sessionId);
    if (!session.providerId || !session.modelId) throw new Error('Select a provider and model before sending a message.');
    const provider = this.rawProvider(session.providerId);
    if (!(provider.enabledModels || []).some((model) => model.id === session.modelId)) throw new Error('The selected model is not enabled for this provider.');
    if (this.controllers.has(sessionId)) throw new Error('This session is already generating a response.');
    const content = String(input.content || '').trim();
    const attachmentIds = uniqueStrings(input.attachmentIds || []);
    if (!content && !attachmentIds.length) throw new Error('Message or attachment is required.');
    const attachments = attachmentIds.map((id) => this.store.get('ragAttachments', id)).filter((item) => item?.sessionId === sessionId);
    const userMessage = this.saveMessage({ sessionId, role: 'user', content, attachments: attachments.map(publicAttachment), status: 'complete' });
    if (session.title === '新对话' && content) {
      session.title = content.replace(/\s+/g, ' ').slice(0, 36);
      session.updatedAt = new Date().toISOString();
      this.store.set('ragSessions', session.id, session);
      this.store.save();
    }
    this.emit({ type: 'message', sessionId, message: userMessage });

    const assistantId = `message-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const controller = new AbortController();
    this.controllers.set(sessionId, controller);
    this.emit({ type: 'assistant-start', sessionId, messageId: assistantId });
    try {
      const result = await this.runConversation(session, { ...userMessage, attachments }, assistantId, controller.signal);
      const assistant = this.saveMessage({
        id: assistantId,
        sessionId,
        role: 'assistant',
        content: result.content,
        reasoning: result.reasoning,
        toolEvents: result.toolEvents,
        usage: result.usage,
        status: 'complete'
      });
      this.recordUsage(session, result.usage);
      this.emit({ type: 'assistant-complete', sessionId, message: assistant, detail: this.sessionDetail(sessionId) });
      return assistant;
    } catch (error) {
      const message = error.name === 'AbortError' ? '生成已停止。' : (error.message || String(error));
      const failed = this.saveMessage({ id: assistantId, sessionId, role: 'assistant', content: '', reasoning: '', toolEvents: [], status: error.name === 'AbortError' ? 'cancelled' : 'failed', error: message });
      this.emit({ type: 'assistant-error', sessionId, message: failed, error: message });
      if (error.name !== 'AbortError') throw error;
      return failed;
    } finally {
      this.controllers.delete(sessionId);
    }
  }

  cancel(sessionId) {
    const controller = this.controllers.get(String(sessionId || ''));
    if (controller) controller.abort();
    return { cancelled: Boolean(controller) };
  }

  async runConversation(session, userMessage, assistantId, signal) {
    const provider = this.rawProvider(session.providerId);
    const model = this.sessionModel(session);
    const history = this.buildHistory(session, model, userMessage.id);
    const userApiMessage = await this.userApiMessage(userMessage, model);
    let apiMessages = [...history, userApiMessage];
    if (!model.supportsTools && session.knowledgeCollectionIds.length) {
      const context = await this.searchKnowledge(session, userMessage.content, 8);
      apiMessages.splice(1, 0, { role: 'system', content: `Relevant local knowledge:\n\n${context}` });
    }
    const tools = model.supportsTools ? this.toolDefinitions(session, model) : [];
    let content = '';
    let reasoning = '';
    let usage = { input: 0, output: 0, total: 0 };
    const toolEvents = [];
    let finished = false;
    for (let round = 0; round < 6; round += 1) {
      const result = await this.streamCompletion(provider, {
        model: session.modelId,
        messages: apiMessages,
        tools: tools.length ? tools : undefined,
        tool_choice: tools.length ? 'auto' : undefined,
        temperature: provider.temperature,
        max_tokens: this.outputTokenLimit(provider, model)
      }, signal, (delta) => {
        if (delta.content) content += delta.content;
        if (delta.reasoning) reasoning += delta.reasoning;
        this.emit({ type: 'assistant-delta', sessionId: session.id, messageId: assistantId, ...delta });
      });
      usage = addUsage(usage, result.usage || estimateUsage(apiMessages, result.content));
      if (!result.toolCalls.length) {
        finished = true;
        break;
      }
      apiMessages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls.map(toApiToolCall) });
      for (const call of result.toolCalls) {
        const event = { id: call.id, name: call.name, status: 'running', arguments: call.arguments, startedAt: new Date().toISOString() };
        toolEvents.push(event);
        this.emit({ type: 'tool', sessionId: session.id, messageId: assistantId, tool: event });
        try {
          const outcome = normalizeToolResult(await this.executeTool(session, model, call, signal));
          event.status = 'succeeded';
          event.output = truncate(outcome.text, 30000);
          if (outcome.images.length) event.images = outcome.images;
          event.finishedAt = new Date().toISOString();
          apiMessages.push({ role: 'tool', tool_call_id: call.id, content: truncate(outcome.text, 200000) });
          if (outcome.visionParts.length) {
            apiMessages.push({
              role: 'user',
              content: [{ type: 'text', text: 'The desktop application attached the original knowledge-base images requested by the preceding tool call. Inspect these pixels as source material; they are not a new user question.' }, ...outcome.visionParts]
            });
          }
        } catch (error) {
          event.status = 'failed';
          event.output = error.message || String(error);
          event.finishedAt = new Date().toISOString();
          apiMessages.push({ role: 'tool', tool_call_id: call.id, content: `ERROR: ${event.output}` });
        }
        this.emit({ type: 'tool', sessionId: session.id, messageId: assistantId, tool: event });
      }
    }
    if (!finished && toolEvents.length) throw new Error('The model exceeded the six-round tool-call limit. Refine the request and try again.');
    if (!content.trim() && !reasoning.trim()) throw new Error('The model returned an empty response. Check the model and provider compatibility settings.');
    return { content, reasoning, usage, toolEvents };
  }

  buildHistory(session, model, excludeMessageId = '') {
    const messages = this.store.list('ragMessages').filter((item) => item.sessionId === session.id && item.id !== excludeMessageId && ['user', 'assistant'].includes(item.role) && item.status === 'complete').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const system = [
      'You are the built-in RAG assistant of 星藏家. Help the user inspect, compare, organize, and analyze their accepted Bilibili Markdown knowledge library.',
      'Use knowledge_search before making claims about selected local libraries. Cite the source title and collection in the answer. Never fabricate missing facts.',
      model.supportsTools ? 'You can inspect selected knowledge without summarization: use knowledge_list_documents to discover document ids, knowledge_read_document to read the exact original Markdown in line ranges, and knowledge_view_images to inspect original local images when vision is enabled.' : '',
      model.supportsTools && model.supportsVision ? 'When an inspected knowledge image is useful to the user, include the exact star-rag-image URI returned by knowledge_view_images in Markdown image syntax so the desktop app can display it. Do not claim that only an index is available.' : '',
      `Your working sandbox is: ${session.sandboxDir}`,
      session.permissionMode === 'full' ? 'The user enabled full filesystem and command access.' : 'You have restricted access. Operations outside the sandbox or command execution require explicit user approval.',
      session.knowledgeCollectionIds.length ? `Selected collection ids: ${session.knowledgeCollectionIds.join(', ')}` : 'No local knowledge collection is selected.',
      session.systemPrompt,
      session.compressedSummary ? `Compressed earlier context:\n${session.compressedSummary}` : ''
    ].filter(Boolean).join('\n\n');
    const contextWindow = positiveInteger(model.contextWindow, null, DEFAULT_CONTEXT_WINDOW);
    const outputReserve = Math.min(this.outputTokenLimit(this.rawProvider(session.providerId), model), Math.floor(contextWindow * 0.5));
    const protocolReserve = Math.min(16000, Math.max(512, Math.floor(contextWindow * 0.05)));
    const historyBudget = Math.max(512, contextWindow - outputReserve - estimateTokens(system) - protocolReserve);
    const recent = [];
    let used = 0;
    for (let index = messages.length - 1; index >= 0 && recent.length < 500; index -= 1) {
      const message = messages[index];
      const tokens = estimateTokens(message.content || '') + 8;
      if (recent.length >= 4 && used + tokens > historyBudget) break;
      recent.unshift(message);
      used += tokens;
    }
    return [{ role: 'system', content: system }, ...recent.map((message) => ({ role: message.role, content: message.content || '' }))];
  }

  async userApiMessage(message, model) {
    const textParts = [message.content || ''];
    const parts = [];
    for (const attachment of message.attachments || []) {
      if (attachment.extractedText) {
        textParts.push(`\n\n[Attachment: ${attachment.name}]\n${attachment.extractedText.slice(0, 30000)}`);
      } else if (model.supportsVision && attachment.mimeType.startsWith('image/') && attachment.size <= 15 * 1024 * 1024) {
        parts.push({ type: 'image_url', image_url: { url: `data:${attachment.mimeType};base64,${fs.readFileSync(attachment.path).toString('base64')}` } });
        textParts.push(`\n[Image attachment: ${attachment.name}]`);
      } else if (model.supportsAudio && attachment.mimeType.startsWith('audio/') && attachment.size <= 20 * 1024 * 1024) {
        parts.push({ type: 'input_audio', input_audio: { data: fs.readFileSync(attachment.path).toString('base64'), format: audioFormat(attachment.path) } });
        textParts.push(`\n[Audio attachment: ${attachment.name}]`);
      } else {
        textParts.push(`\n[Local attachment available through file tools: ${attachment.name} at ${attachment.path}]`);
      }
    }
    if (!parts.length) return { role: 'user', content: textParts.join('') };
    return { role: 'user', content: [{ type: 'text', text: textParts.join('') }, ...parts] };
  }

  toolDefinitions(session, model) {
    const tools = [
      tool('list_files', 'List files in a directory. Relative paths resolve inside the session sandbox.', { path: { type: 'string' } }),
      tool('read_file', 'Read a UTF-8 text file. Outside-sandbox access may require approval.', { path: { type: 'string' } }, ['path']),
      tool('write_file', 'Create or replace a UTF-8 file. Outside-sandbox access may require approval.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
      tool('run_command', 'Run a Windows CMD command in the session sandbox. Restricted sessions require approval.', { command: { type: 'string' }, cwd: { type: 'string' } }, ['command']),
      tool('web_search', 'Search the public web with the built-in invisible browser.', { query: { type: 'string' } }, ['query']),
      tool('browse_url', 'Read a public HTTP(S) page with the built-in invisible browser.', { url: { type: 'string' } }, ['url']),
      tool('open_browser', 'Open an HTTP(S) URL in the user default browser.', { url: { type: 'string' } }, ['url'])
    ];
    if (session.knowledgeCollectionIds.length) {
      tools.unshift(
        tool('knowledge_list_documents', 'List original Markdown documents in the selected libraries. Returns stable document ids for exact reading and image inspection.', { query: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }),
        tool('knowledge_read_document', 'Read an exact, unsummarized line range from one original Markdown document. Call again with next_start_line until complete.', { document_id: { type: 'string' }, start_line: { type: 'integer' }, line_count: { type: 'integer' } }, ['document_id']),
        tool('knowledge_search', 'Search selected local Markdown knowledge libraries. Results include document ids; use knowledge_read_document when exact wording or complete context matters.', { query: { type: 'string' }, limit: { type: 'integer' } }, ['query'])
      );
      if (model.supportsVision) tools.unshift(tool('knowledge_view_images', 'Load original local images from a selected Markdown document into this multimodal conversation. Returns safe image URIs that can be embedded in the answer.', { document_id: { type: 'string' }, image_indices: { type: 'array', items: { type: 'integer' }, maxItems: 4 } }, ['document_id']));
    }
    if (model.supportsSubagents) tools.push(tool('spawn_subagent', 'Delegate one focused research or analysis subtask to an isolated call of the current model.', { task: { type: 'string' } }, ['task']));
    return tools;
  }

  async executeTool(session, model, call, signal) {
    const args = parseJson(call.arguments || '{}', `Invalid arguments for ${call.name}.`);
    if (call.name === 'knowledge_search') return this.searchKnowledge(session, args.query, args.limit);
    if (call.name === 'knowledge_list_documents') return this.listKnowledgeDocuments(session, args.query, args.offset, args.limit);
    if (call.name === 'knowledge_read_document') return this.readKnowledgeDocument(session, args.document_id, args.start_line, args.line_count);
    if (call.name === 'knowledge_view_images') return this.viewKnowledgeImages(session, model, args.document_id, args.image_indices);
    if (call.name === 'list_files') {
      const target = await this.authorizePath(session, args.path || '.', 'list directory');
      return fs.readdirSync(target, { withFileTypes: true }).slice(0, 300).map((item) => `${item.isDirectory() ? '[dir]' : '[file]'} ${item.name}`).join('\n');
    }
    if (call.name === 'read_file') {
      const target = await this.authorizePath(session, args.path, 'read file');
      return truncate(fs.readFileSync(target, 'utf8'), 80000);
    }
    if (call.name === 'write_file') {
      const target = await this.authorizePath(session, args.path, 'write file');
      ensureDir(path.dirname(target));
      fs.writeFileSync(target, String(args.content || ''), 'utf8');
      return `Wrote ${Buffer.byteLength(String(args.content || ''), 'utf8')} bytes to ${target}`;
    }
    if (call.name === 'run_command') return this.runCommand(session, args.command, args.cwd, signal);
    if (call.name === 'web_search') return this.browseHidden(`https://www.bing.com/search?q=${encodeURIComponent(String(args.query || ''))}`);
    if (call.name === 'browse_url') return this.browseUrl(session, args.url);
    if (call.name === 'open_browser') {
      const url = parseHttpUrl(args.url).toString();
      if (session.permissionMode !== 'full') await this.approve(session, { action: 'open default browser', target: url, detail: 'The model wants to open a page in your default browser.' });
      await this.openExternal(url);
      return `Opened ${url}`;
    }
    if (call.name === 'spawn_subagent') {
      if (!model.supportsSubagents) throw new Error('The selected model is not configured for subagents.');
      const provider = this.rawProvider(session.providerId);
      const prompt = `You are a focused subagent. Complete only this task and return a concise evidence-based report.\n\nTask: ${String(args.task || '')}`;
      const context = session.knowledgeCollectionIds.length ? await this.searchKnowledge(session, args.task, 6) : '';
      const result = await this.complete(provider, { model: session.modelId, messages: [{ role: 'system', content: prompt }, { role: 'user', content: context || 'No local context was selected.' }], temperature: provider.temperature, max_tokens: Math.min(this.outputTokenLimit(provider, model), 6000) }, signal);
      return result.content;
    }
    throw new Error(`Unsupported tool: ${call.name}`);
  }

  async authorizePath(session, requested, action) {
    if (!requested) throw new Error('A path is required.');
    const target = path.resolve(path.isAbsolute(String(requested)) ? String(requested) : path.join(session.sandboxDir, String(requested)));
    if (session.permissionMode === 'full') return target;
    const sandboxBoundary = realPath(session.sandboxDir);
    const targetBoundary = realPath(existingAncestor(target));
    if (isInside(session.sandboxDir, target) && isInside(sandboxBoundary, targetBoundary)) return target;
    await this.approve(session, { action, target, detail: 'This path is outside the current session sandbox.' });
    return target;
  }

  async approve(session, request) {
    const decision = await this.requestApproval({ sessionId: session.id, ...request });
    if (!decision?.approved) throw new Error('User denied this operation.');
    if (decision.fullAccess) {
      session.permissionMode = 'full';
      session.updatedAt = new Date().toISOString();
      this.store.set('ragSessions', session.id, session);
      this.store.save();
      this.emit({ type: 'session-updated', sessionId: session.id, session: this.sessionDetail(session.id) });
    }
  }

  async runCommand(session, command, cwd, signal) {
    if (!String(command || '').trim()) throw new Error('Command is required.');
    if (signal?.aborted) throw abortError();
    const workingDirectory = cwd ? await this.authorizePath(session, cwd, 'use command working directory') : session.sandboxDir;
    if (session.permissionMode !== 'full') await this.approve(session, { action: 'run CMD command', target: String(command), detail: `Working directory: ${workingDirectory}` });
    return new Promise((resolve, reject) => {
      let aborted = false;
      const child = execFile('cmd.exe', ['/d', '/s', '/c', String(command)], { cwd: workingDirectory, windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (aborted) return reject(abortError());
        if (error) return reject(new Error(`${error.message}\n${stderr || stdout}`.trim()));
        resolve(truncate(`${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`, 60000));
      });
      signal?.addEventListener('abort', () => {
        aborted = true;
        child.kill();
      }, { once: true });
    });
  }

  async browseUrl(session, value) {
    const url = parseHttpUrl(value).toString();
    const host = new URL(url).hostname;
    const privateAddress = isPrivateNetworkHost(host);
    if (session.permissionMode !== 'full' && privateAddress) await this.approve(session, { action: 'browse private or local address', target: url, detail: 'This address may access a local service or private network.' });
    return this.browseHidden(url, { allowPrivate: privateAddress });
  }

  async searchKnowledge(session, query, limit = 8) {
    const selected = new Set(session.knowledgeCollectionIds || []);
    if (!selected.size) return 'No knowledge library is selected.';
    const terms = queryTerms(String(query || ''));
    const tasks = this.store.listTasks().filter((task) => selected.has(task.collectionId) && task.status === 'done' && task.outputMarkdown && fs.existsSync(task.outputMarkdown));
    const collections = new Map(this.store.listCollections().map((item) => [item.id, item]));
    const scored = [];
    for (const task of tasks) {
      const chunks = this.documentChunks(task.outputMarkdown);
      for (const chunk of chunks) {
        const haystack = `${task.title || ''}\n${task.owner || ''}\n${chunk}`.toLowerCase();
        const score = terms.reduce((sum, term) => sum + countOccurrences(haystack, term), 0) + (terms.some((term) => String(task.title || '').toLowerCase().includes(term)) ? 6 : 0);
        if (score > 0 || !terms.length) scored.push({ score, task, chunk, collection: collections.get(task.collectionId) });
      }
    }
    const wanted = Math.max(1, Math.min(20, Number(limit) || 8));
    const results = scored.sort((a, b) => b.score - a.score).slice(0, wanted);
    if (!results.length) return `No matching passages found across ${tasks.length} selected documents.`;
    return results.map((item, index) => `[#${index + 1}] Document ID: ${item.task.id}\nUser: ${item.collection?.userName || '-'} | Collection: ${item.collection?.name || '-'} | Title: ${item.task.title || item.task.bvid}\nBVID: ${item.task.bvid || '-'}\n${item.chunk}`).join('\n\n---\n\n');
  }

  listKnowledgeDocuments(session, query = '', offset = 0, limit = 50) {
    const terms = queryTerms(String(query || ''));
    const collections = new Map(this.store.listCollections().map((item) => [item.id, item]));
    const all = this.knowledgeTasks(session).filter((task) => {
      if (!terms.length) return true;
      const collection = collections.get(task.collectionId);
      const value = `${task.id} ${task.bvid || ''} ${task.title || ''} ${task.owner || ''} ${collection?.name || ''}`.toLowerCase();
      return terms.every((term) => value.includes(term));
    });
    const start = Math.max(0, Number(offset) || 0);
    const count = Math.max(1, Math.min(200, Number(limit) || 50));
    const page = all.slice(start, start + count);
    const rows = page.map((task, index) => {
      const collection = collections.get(task.collectionId);
      return `[${start + index + 1}] Document ID: ${task.id}\nTitle: ${task.title || task.bvid} | BVID: ${task.bvid || '-'} | UP: ${task.owner || '-'}\nUser: ${collection?.userName || '-'} | Collection: ${collection?.name || '-'}`;
    });
    return `Selected documents: ${all.length}. Showing ${page.length} from offset ${start}.\n\n${rows.join('\n\n') || 'No matching documents.'}`;
  }

  readKnowledgeDocument(session, documentId, startLine = 1, lineCount = 300) {
    const task = this.requireKnowledgeDocument(session, documentId);
    const source = fs.readFileSync(task.outputMarkdown, 'utf8');
    const lines = source.match(/[^\n]*\n|[^\n]+$/g) || [];
    const start = Math.max(1, Number(startLine) || 1);
    const wanted = Math.max(1, Math.min(2000, Number(lineCount) || 300));
    let selected = lines.slice(start - 1, start - 1 + wanted).join('');
    if (selected.length > 200000) selected = selected.slice(0, 200000);
    const consumedLines = (selected.match(/\n/g) || []).length + (selected && !selected.endsWith('\n') ? 1 : 0);
    const end = Math.min(lines.length, start - 1 + consumedLines);
    const next = end < lines.length ? end + 1 : null;
    return [
      `Document ID: ${task.id}`,
      `Title: ${task.title || task.bvid}`,
      `BVID: ${task.bvid || '-'}`,
      `Exact original Markdown lines ${start}-${end} of ${lines.length}.`,
      next ? `next_start_line: ${next}` : 'End of document.',
      '\n--- RAW MARKDOWN START ---\n',
      selected,
      '\n--- RAW MARKDOWN END ---'
    ].join('\n');
  }

  viewKnowledgeImages(session, model, documentId, imageIndices = []) {
    if (!model.supportsVision) throw new Error('The selected model is not configured for vision input.');
    const task = this.requireKnowledgeDocument(session, documentId);
    const images = this.knowledgeDocumentImages(task);
    if (!images.length) return 'This Markdown document has no readable local images.';
    const requested = Array.isArray(imageIndices) && imageIndices.length ? imageIndices : images.slice(0, 4).map((_, index) => index + 1);
    const indices = [...new Set(requested.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 1 && value <= images.length))].slice(0, 4);
    if (!indices.length) throw new Error(`No valid image index was supplied. This document has ${images.length} local images.`);
    const selected = indices.map((value) => ({ ...images[value - 1], index: value, uri: knowledgeImageUri(task.id, value) }));
    return {
      text: [
        `Loaded ${selected.length} original image(s) from document ${task.id} (${task.title || task.bvid}) into the multimodal request.`,
        `The document contains ${images.length} readable local image(s).`,
        ...selected.map((item) => `[Image ${item.index}] ${item.alt || item.name}\nDisplay URI: ${item.uri}`),
        'Inspect the pixels directly. To show an image to the user, copy its Display URI exactly into Markdown image syntax: ![description](Display URI)'
      ].join('\n\n'),
      images: selected.map((item) => ({ index: item.index, name: item.name, alt: item.alt, uri: item.uri })),
      visionParts: selected.map((item) => ({ type: 'image_url', image_url: { url: `data:${item.mimeType};base64,${fs.readFileSync(item.path).toString('base64')}` } }))
    };
  }

  knowledgeTasks(session) {
    const selected = new Set(session.knowledgeCollectionIds || []);
    return this.store.listTasks().filter((task) => selected.has(task.collectionId) && task.status === 'done' && task.outputMarkdown && fs.existsSync(task.outputMarkdown));
  }

  requireKnowledgeDocument(session, documentId) {
    const task = this.knowledgeTasks(session).find((item) => String(item.id) === String(documentId || ''));
    if (!task) throw new Error('The requested document is not available in this session\'s selected knowledge libraries.');
    return task;
  }

  knowledgeDocumentImages(task) {
    const markdown = fs.readFileSync(task.outputMarkdown, 'utf8');
    const sources = [];
    for (const token of knowledgeMarkdownParser.parse(markdown, {})) {
      for (const child of token.children || []) {
        if (child.type === 'image') sources.push({ src: child.attrGet('src') || '', alt: child.content || '' });
      }
    }
    const root = path.resolve(path.dirname(task.outputMarkdown));
    const seen = new Set();
    const images = [];
    for (const item of sources) {
      if (!item.src || /^[a-z][a-z0-9+.-]*:/i.test(item.src) || item.src.startsWith('#')) continue;
      let decoded;
      try { decoded = decodeURIComponent(item.src.split('#')[0].split('?')[0]); } catch { continue; }
      const target = path.resolve(root, decoded);
      const extension = path.extname(target).toLowerCase();
      const mimeType = MIME_TYPES[extension] || '';
      if (!isInside(root, target) || !mimeType.startsWith('image/') || !fs.existsSync(target) || seen.has(target)) continue;
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.size > 15 * 1024 * 1024 || !isInside(realPath(root), realPath(target))) continue;
      seen.add(target);
      images.push({ path: target, name: path.basename(target), alt: item.alt, mimeType, size: stat.size });
    }
    return images;
  }

  resolveKnowledgeImage(sessionId, value) {
    const parsed = parseKnowledgeImageUri(value);
    const session = this.requireSession(sessionId);
    const task = this.requireKnowledgeDocument(session, parsed.documentId);
    const image = this.knowledgeDocumentImages(task)[parsed.index - 1];
    if (!image) throw new Error('Knowledge image does not exist.');
    return image.path;
  }

  documentChunks(file) {
    const stat = fs.statSync(file);
    const cached = this.documentCache.get(file);
    if (cached?.mtimeMs === stat.mtimeMs) return cached.chunks;
    const text = fs.readFileSync(file, 'utf8').replace(/^---[\s\S]*?---\s*/m, '');
    const chunks = [];
    const sections = text.split(/(?=^#{1,3}\s+)/m);
    for (const section of sections) {
      for (let offset = 0; offset < section.length; offset += 1600) chunks.push(section.slice(offset, offset + 1900));
    }
    this.documentCache.set(file, { mtimeMs: stat.mtimeMs, chunks: chunks.filter((item) => item.trim()) });
    return this.documentCache.get(file).chunks;
  }

  async compact(sessionId) {
    const session = this.requireSession(sessionId);
    const model = this.sessionModel(session);
    if (!model.supportsCompression) throw new Error('Context compression is disabled for this model.');
    const provider = this.rawProvider(session.providerId);
    const messages = this.store.list('ragMessages').filter((item) => item.sessionId === sessionId && item.status === 'complete').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    if (messages.length < 4) throw new Error('There is not enough conversation history to compress.');
    const transcript = messages.map((item) => `${item.role.toUpperCase()}: ${item.content}`).join('\n\n').slice(-180000);
    const result = await this.complete(provider, { model: session.modelId, messages: [{ role: 'system', content: 'Compress the conversation into a durable working-memory summary. Preserve user goals, decisions, facts, citations, file paths, unfinished work, and constraints. Do not add new facts.' }, { role: 'user', content: transcript }], temperature: 0, max_tokens: Math.min(6000, this.outputTokenLimit(provider, model)) });
    session.compressedSummary = result.content;
    session.compressedAt = new Date().toISOString();
    session.updatedAt = new Date().toISOString();
    this.store.set('ragSessions', session.id, session);
    this.recordUsage(session, result.usage || estimateUsage([], result.content));
    this.store.save();
    return this.sessionDetail(session.id);
  }

  async streamCompletion(provider, body, signal, onDelta) {
    const url = this.providerEndpoint(provider, 'chat/completions');
    const requestBody = { ...body, stream: true, stream_options: { include_usage: true } };
    let response = await fetch(url, { method: 'POST', headers: this.providerHeaders(provider), body: JSON.stringify(requestBody), signal });
    if (!response.ok) {
      const errorText = await response.text();
      if (/stream_options/i.test(errorText)) {
        delete requestBody.stream_options;
        response = await fetch(url, { method: 'POST', headers: this.providerHeaders(provider), body: JSON.stringify(requestBody), signal });
      } else {
        throw new Error(`Model request failed (${response.status}): ${errorText.slice(0, 1600)}`);
      }
    }
    if (!response.ok) throw new Error(`Model request failed (${response.status}): ${(await response.text()).slice(0, 1600)}`);
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) {
      const payload = parseJson(await response.text(), 'Model provider returned invalid JSON data.');
      const message = payload.choices?.[0]?.message || payload.choices?.[0]?.delta || {};
      const content = normalizeContent(message.content);
      const reasoning = normalizeContent(message.reasoning_content ?? message.reasoning ?? message.thinking);
      if (content) onDelta({ content });
      if (reasoning) onDelta({ reasoning });
      return {
        content,
        reasoning,
        usage: normalizeUsage(payload.usage || {}),
        toolCalls: normalizeToolCalls(message.tool_calls || [])
      };
    }
    if (!response.body) throw new Error('Model response did not include a stream.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning = '';
    let usage = null;
    const toolCalls = new Map();
    const consumeEvent = (event) => {
      for (const line of event.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        const payload = parseJson(data, 'Invalid SSE payload from model provider.');
        if (payload.usage) usage = normalizeUsage(payload.usage);
        for (const choice of payload.choices || []) {
          const delta = choice.delta || choice.message || {};
          const text = normalizeContent(delta.content);
          const thought = normalizeContent(delta.reasoning_content ?? delta.reasoning ?? delta.thinking);
          if (text) { content += text; onDelta({ content: text }); }
          if (thought) { reasoning += thought; onDelta({ reasoning: thought }); }
          for (const item of delta.tool_calls || []) {
            const matchingIndex = item.id
              ? [...toolCalls.entries()].find(([, call]) => call.id === item.id)?.[0]
              : undefined;
            const index = item.index ?? matchingIndex ?? (toolCalls.size === 1 ? toolCalls.keys().next().value : toolCalls.size);
            const current = toolCalls.get(index) || { id: item.id || `call-${index}`, name: '', arguments: '' };
            if (item.id) current.id = item.id;
            current.name = mergeStreamFragment(current.name, item.function?.name);
            current.arguments = mergeStreamFragment(current.arguments, item.function?.arguments);
            toolCalls.set(index, current);
          }
        }
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || '';
      for (const event of events) consumeEvent(event);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeEvent(buffer);
    return { content, reasoning, usage, toolCalls: [...toolCalls.values()] };
  }

  async complete(provider, body, signal) {
    const response = await fetch(this.providerEndpoint(provider, 'chat/completions'), { method: 'POST', headers: this.providerHeaders(provider), body: JSON.stringify({ ...body, stream: false }), signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`Model request failed (${response.status}): ${text.slice(0, 1600)}`);
    const payload = parseJson(text, 'Model provider returned non-JSON data.');
    const message = payload.choices?.[0]?.message || {};
    return { content: normalizeContent(message.content), reasoning: normalizeContent(message.reasoning_content ?? message.reasoning ?? message.thinking), usage: normalizeUsage(payload.usage || {}) };
  }

  saveMessage(input) {
    const record = { id: input.id || `message-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`, createdAt: new Date().toISOString(), ...input };
    this.store.set('ragMessages', record.id, record);
    const session = this.requireSession(record.sessionId);
    session.updatedAt = new Date().toISOString();
    this.store.set('ragSessions', session.id, session);
    this.store.save();
    return record;
  }

  recordUsage(session, usageInput) {
    const usage = normalizeUsage(usageInput || {});
    const latest = this.requireSession(session.id);
    latest.tokenUsage = addUsage(latest.tokenUsage || {}, usage);
    latest.updatedAt = new Date().toISOString();
    this.store.set('ragSessions', latest.id, latest);
    this.recordModelUsage(latest.providerId, latest.modelId, usage, false);
    this.store.save();
  }

  recordModelUsage(providerId, modelId, usageInput, save = true) {
    const usage = normalizeUsage(usageInput || {});
    const id = `${providerId}:${modelId}`;
    const current = this.store.get('ragModelUsage', id) || { id, providerId, modelId, inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 };
    current.inputTokens += usage.input;
    current.outputTokens += usage.output;
    current.totalTokens += usage.total;
    current.requests += 1;
    current.updatedAt = new Date().toISOString();
    this.store.set('ragModelUsage', id, current);
    if (save) this.store.save();
    return current;
  }
}

function publicProvider(provider) {
  if (!provider) return null;
  const { encryptedApiKey, ...safe } = provider;
  return { ...safe, hasApiKey: Boolean(encryptedApiKey) };
}

function publicAttachment(attachment) {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    createdAt: attachment.createdAt
  };
}

function normalizeModel(item = {}) {
  const id = String(item.id || item.name || '');
  const lower = id.toLowerCase();
  const defaults = inferModelTokenLimits(lower);
  return {
    id,
    name: String(item.name || item.id || ''),
    contextWindow: positiveInteger(item.contextWindow || item.context_window || item.context_length || item.max_context_tokens || item.input_token_limit, null, defaults.contextWindow),
    maxOutputTokens: positiveInteger(item.maxOutputTokens || item.max_output_tokens || item.output_token_limit || item.max_completion_tokens, null, defaults.maxOutputTokens),
    supportsTools: item.supportsTools === undefined ? true : Boolean(item.supportsTools),
    supportsReasoning: item.supportsReasoning === undefined ? /reason|thinking|o[1-9]|r1|deepseek/.test(lower) : Boolean(item.supportsReasoning),
    supportsVision: item.supportsVision === undefined ? /vision|gpt-4o|gpt-5|gemini|claude|vl/.test(lower) : Boolean(item.supportsVision),
    supportsAudio: item.supportsAudio === undefined ? /audio|omni|realtime/.test(lower) : Boolean(item.supportsAudio),
    supportsImages: item.supportsImages === undefined ? /image|gpt-4o|gpt-5|gemini/.test(lower) : Boolean(item.supportsImages),
    supportsCompression: item.supportsCompression === undefined ? true : Boolean(item.supportsCompression),
    supportsSubagents: item.supportsSubagents === undefined ? true : Boolean(item.supportsSubagents)
  };
}

function inferModelTokenLimits(lowerId) {
  if (/gpt-4o/.test(lowerId)) return { contextWindow: 128000, maxOutputTokens: 16384 };
  if (/^gpt-5(?:[.\-]|$)|codex/.test(lowerId)) return { contextWindow: 400000, maxOutputTokens: 128000 };
  return { contextWindow: DEFAULT_CONTEXT_WINDOW, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS };
}

function migrateLegacyModel(item = {}) {
  const copy = { ...item };
  if (Number(copy.contextWindow) === 128000 && /^gpt-5(?:[.\-]|$)/i.test(String(copy.id || copy.name || ''))) delete copy.contextWindow;
  return normalizeModel(copy);
}

function candidateApiRoots(provider = {}) {
  const roots = [];
  const append = (value) => { const root = String(value || '').replace(/\/+$/, ''); if (root && !roots.includes(root)) roots.push(root); };
  append(provider.resolvedBaseUrl);
  append(provider.baseUrl);
  if (provider.baseUrl && !/\/v1$/i.test(provider.baseUrl)) append(`${provider.baseUrl}/v1`);
  return roots;
}

function normalizeBaseUrl(value) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  const url = new URL(text);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Base URL must use HTTP or HTTPS.');
  return text;
}

function normalizeHeaders(value) {
  if (!value) return {};
  const parsed = typeof value === 'string' ? parseJson(value, 'Extra headers must be valid JSON.') : value;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Extra headers must be a JSON object.');
  return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [String(key), String(item)]));
}

function normalizeUsage(usage = {}) {
  const input = Number(usage.input ?? usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const output = Number(usage.output ?? usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  return { input, output, total: Number(usage.total ?? usage.total_tokens ?? input + output) || input + output };
}

function addUsage(a = {}, b = {}) {
  const left = normalizeUsage(a);
  const right = normalizeUsage(b);
  return { input: left.input + right.input, output: left.output + right.output, total: left.total + right.total };
}

function estimateUsage(messages, output) {
  const input = estimateTokens(JSON.stringify(messages));
  const out = estimateTokens(output);
  return { input, output: out, total: input + out };
}

function estimateTokens(value) {
  return Math.max(0, Math.ceil(String(value || '').length / 3.5));
}

function normalizeContent(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return value ? String(value) : '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (part?.text) return part.text;
    const url = part?.image_url?.url || part?.image_url || part?.url;
    return url ? `\n![model output](${url})\n` : '';
  }).join('');
}

function tool(name, description, properties, required = []) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}

function normalizeToolResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { text: String(value ?? ''), images: [], visionParts: [] };
  return {
    text: String(value.text ?? JSON.stringify(value)),
    images: Array.isArray(value.images) ? value.images : [],
    visionParts: Array.isArray(value.visionParts) ? value.visionParts : []
  };
}

function knowledgeImageUri(documentId, index) {
  return `star-rag-image://local/${encodeURIComponent(String(documentId))}/${Number(index)}`;
}

function parseKnowledgeImageUri(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'star-rag-image:' || url.hostname !== 'local') throw new Error('Invalid knowledge image URI.');
  const parts = url.pathname.split('/').filter(Boolean);
  const documentId = decodeURIComponent(parts[0] || '');
  const index = Number(parts[1]);
  if (!documentId || !Number.isInteger(index) || index < 1) throw new Error('Invalid knowledge image URI.');
  return { documentId, index };
}

function toApiToolCall(call) {
  return { id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments || '{}' } };
}

function normalizeToolCalls(items) {
  return (items || []).map((item, index) => ({
    id: item.id || `call-${index}`,
    name: String(item.function?.name || item.name || ''),
    arguments: typeof (item.function?.arguments ?? item.arguments) === 'string'
      ? (item.function?.arguments ?? item.arguments)
      : JSON.stringify(item.function?.arguments ?? item.arguments ?? {})
  })).filter((item) => item.name);
}

function mergeStreamFragment(current, incoming) {
  const left = String(current || '');
  const right = String(incoming || '');
  if (!right || left === right || left.endsWith(right)) return left;
  if (!left || right.startsWith(left)) return right;
  return left + right;
}

function parseJson(value, message) {
  try { return JSON.parse(String(value || '{}')); } catch { throw new Error(message); }
}

function finiteNumber(value, current, fallback) {
  const next = Number(value);
  if (Number.isFinite(next)) return next;
  const existing = Number(current);
  return Number.isFinite(existing) ? existing : fallback;
}

function positiveInteger(value, current, fallback) {
  const next = Math.floor(Number(value));
  if (next > 0) return next;
  const existing = Math.floor(Number(current));
  return existing > 0 ? existing : fallback;
}

function uniqueStrings(values) {
  return [...new Set((values || []).map(String).filter(Boolean))];
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return path.resolve(directory);
}

function existingAncestor(target) {
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function realPath(target) {
  return fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target);
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeFilename(value) {
  return String(value || 'attachment').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
}

function uniqueFile(directory, name) {
  const extension = path.extname(name);
  const base = path.basename(name, extension);
  let candidate = path.join(directory, name);
  let index = 2;
  while (fs.existsSync(candidate)) candidate = path.join(directory, `${base}-${index++}${extension}`);
  return candidate;
}

async function extractText(file) {
  const extension = path.extname(file).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) return fs.readFileSync(file, 'utf8');
  if (extension === '.pdf') return (await pdf(fs.readFileSync(file))).text || '';
  if (extension === '.docx') return (await mammoth.extractRawText({ path: file })).value || '';
  return '';
}

function audioFormat(file) {
  const extension = path.extname(file).toLowerCase().slice(1);
  return extension === 'm4a' ? 'mp3' : (extension || 'wav');
}

function abortError() {
  const error = new Error('The operation was cancelled.');
  error.name = 'AbortError';
  return error;
}

function queryTerms(query) {
  const lower = query.toLowerCase();
  const latin = lower.match(/[a-z0-9_+#.-]{2,}/g) || [];
  const chinese = (lower.match(/[\u3400-\u9fff]+/g) || []).flatMap((word) => word.length <= 2 ? [word] : Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2)));
  return uniqueStrings([...latin, ...chinese]).slice(0, 40);
}

function countOccurrences(text, term) {
  if (!term) return 0;
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(term, index)) >= 0) { count += 1; index += term.length; }
  return count;
}

function truncate(value, limit) {
  const text = String(value || '');
  return text.length > limit ? `${text.slice(0, limit)}\n...[truncated]` : text;
}

module.exports = { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT_TOKENS, RagAssistant, normalizeModel };
