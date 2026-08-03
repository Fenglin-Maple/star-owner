const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const { execFile, spawnSync } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { pathToFileURL } = require('url');
const MarkdownIt = require('markdown-it');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const { projectRuntimeEnvironment, resolveSystemExecutable } = require('./child-process-io');
const { collectionKindInfo, favoriteStatus } = require('./collection-state');
const { isPrivateNetworkHost, parseHttpUrl } = require('./network-policy');
const { assertSafeWindowsPath, ensureDir: ensureWorkspaceDir } = require('./workspace');

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.xml', '.yaml', '.yml',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.cpp', '.h', '.hpp',
  '.cs', '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.kts', '.html', '.css', '.scss', '.sql',
  '.ps1', '.cmd', '.bat', '.sh', '.log', '.ini', '.toml', '.env'
]);

const MIME_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.md': 'text/markdown'
};

const TOKEN_CONFIG_VERSION = 2;
const DEFAULT_CONTEXT_WINDOW = 1000000;
const DEFAULT_MAX_OUTPUT_TOKENS = 128000;
const RAG_AUTO_COMPACT_TRIGGER = 0.75;
const MAX_RAG_TOOL_ROUNDS = 24;
const MAX_RAG_TOOL_CALLS = 24;
const MAX_KNOWLEDGE_READ_CHARACTERS = 60000;
const MAX_TOOL_CONTEXT_CHARACTERS = 60000;
const PROVIDER_REQUEST_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_ATTACHMENT_BYTES = 250 * 1024 * 1024;
const MAX_EXTRACTABLE_DOCUMENT_BYTES = 64 * 1024 * 1024;
const MAX_DOCUMENT_CACHE_ENTRIES = 128;
const MAX_INDEX_DOCUMENT_CHARACTERS = 4 * 1024 * 1024;
const MAX_RAG_SEARCH_DOCUMENTS = 2000;
const MAX_RAG_SEARCH_CHUNKS = 12000;
const MAX_RAG_SEARCH_RESULT_CHARACTERS = 50000;
const RAG_SEARCH_TIME_BUDGET_MS = 5000;
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

  setWorkspaceRoot(workspaceRoot) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.sandboxRoot = ensureDir(path.join(this.workspaceRoot, '.star-note', 'rag-sandboxes'));
    return this.sandboxRoot;
  }

  state(sessionId = '') {
    const sessions = this.listSessions();
    const requestedId = String(sessionId || '');
    const activeId = sessions.some((session) => session.id === requestedId)
      ? requestedId
      : (sessions[0]?.id || '');
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

  rememberProviderRoot(provider, root) {
    if (!provider || provider.resolvedBaseUrl === root) return;
    provider.resolvedBaseUrl = root;
    if (provider.id && this.store.get('ragProviders', provider.id)) {
      provider.updatedAt = new Date().toISOString();
      this.store.set('ragProviders', provider.id, provider);
      this.store.save();
    }
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
      let providerChanged = false;
      if (Number(provider.tokenConfigVersion || 0) < TOKEN_CONFIG_VERSION) {
        if (!provider.maxOutputTokens || Number(provider.maxOutputTokens) === 8192) provider.maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
        provider.enabledModels = (provider.enabledModels || []).map(migrateLegacyModel);
        provider.remoteModels = (provider.remoteModels || []).map(migrateLegacyModel);
        provider.tokenConfigVersion = TOKEN_CONFIG_VERSION;
        providerChanged = true;
      }
      const safeHeaders = {};
      for (const [name, rawValue] of Object.entries(provider.extraHeaders || {})) {
        const lower = String(name).trim().toLowerCase();
        if (/^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-access-token|x-goog-api-key)$/.test(lower)) {
          if (!provider.encryptedApiKey && lower !== 'cookie' && lower !== 'set-cookie' && lower !== 'proxy-authorization') {
            const secret = String(rawValue || '').replace(/^bearer\s+/i, '').trim();
            if (secret) provider.encryptedApiKey = this.encryptSecret(secret);
          }
          providerChanged = true;
          continue;
        }
        safeHeaders[name] = rawValue;
      }
      try {
        provider.extraHeaders = normalizeHeaders(safeHeaders);
      } catch {
        provider.extraHeaders = {};
        providerChanged = true;
      }
      if (providerChanged) {
        provider.updatedAt = new Date().toISOString();
        this.store.set('ragProviders', provider.id, provider);
        changed = true;
      }
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
    if (this.controllers.has(session.id)) throw new Error('Stop the current response before changing this session.');
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
    if (this.controllers.has(session.id)) throw new Error('Stop the current response before deleting this session.');
    for (const message of this.store.list('ragMessages').filter((item) => item.sessionId === id)) this.store.delete('ragMessages', message.id);
    const attachments = this.store.list('ragAttachments').filter((item) => item.sessionId === id);
    for (const attachment of attachments) {
      removeManagedAttachmentFile(session, attachment);
      this.store.delete('ragAttachments', attachment.id);
    }
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
    const attachments = this.store.list('ragAttachments').filter((item) => item.sessionId === id).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const attachmentMap = new Map(attachments.map((item) => [item.id, item]));
    const messages = this.store.list('ragMessages').filter((item) => item.sessionId === id).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).map((message) => ({
      ...message,
      attachments: (message.attachments || []).map((item) => publicAttachment(attachmentMap.get(item.id) || item))
    }));
    const model = this.sessionModel(session);
    const context = this.contextPlan(session, model, 0, messages);
    return {
      ...session,
      messages,
      attachments: attachments.map(publicAttachment),
      modelCapabilities: model,
      contextTokens: context.inputTokens,
      contextWindow: model.contextWindow,
      contextPercent: context.contextPercent,
      autoCompactionThresholdPercent: context.thresholdPercent
    };
  }

  sessionModel(session) {
    const provider = session.providerId ? this.store.get('ragProviders', session.providerId) : null;
    return normalizeModel(provider?.enabledModels?.find((item) => item.id === session.modelId) || { id: session.modelId });
  }

  knowledgeCatalog() {
    const tasks = this.store.listTasks().filter(knowledgeEligible);
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
        kindInfo: collectionKindInfo(collection),
        documentCount: documents.length,
        updatedAt: documents.map((task) => task.completedAt || task.updatedAt || '').sort().at(-1) || collection.updatedAt || ''
      };
    }).filter(Boolean).sort((a, b) => `${a.userName}/${a.name}`.localeCompare(`${b.userName}/${b.name}`, 'zh-Hans-CN'));
  }

  async importFiles(sessionId, filePaths) {
    const session = this.requireSession(sessionId);
    const destination = managedAttachmentsRoot(session);
    const imported = [];
    const createdFiles = [];
    try {
      for (const source of filePaths || []) {
        const stat = fs.statSync(source);
        if (!stat.isFile()) continue;
        if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment exceeds 250 MiB: ${path.basename(source)}`);
        const id = `attachment-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
        const name = safeFilename(path.basename(source));
        const target = uniqueFile(destination, `${id}-${name}`);
        fs.copyFileSync(source, target);
        createdFiles.push(target);
        const extractedText = await extractText(target);
        const extension = path.extname(target).toLowerCase();
        const mimeType = MIME_TYPES[extension] || 'application/octet-stream';
        if (mimeType.startsWith('image/') && !matchesImageSignature(fs.readFileSync(target), mimeType)) {
          throw new Error(`Attachment image content does not match its extension: ${path.basename(source)}`);
        }
        const record = {
          id,
          sessionId,
          name,
          path: target,
          managedRoot: realPath(destination),
          mimeType,
          size: stat.size,
          previewUrl: (MIME_TYPES[extension] || '').startsWith('image/') ? pathToFileURL(target).href : '',
          extractedText: extractedText.slice(0, 120000),
          managed: true,
          createdAt: new Date().toISOString()
        };
        this.store.set('ragAttachments', id, record);
        imported.push(record);
      }
    } catch (error) {
      for (const record of imported) {
        this.store.delete('ragAttachments', record.id);
      }
      for (const file of createdFiles) if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      throw error;
    }
    this.store.save();
    return imported;
  }

  async importBuffer(sessionId, input = {}) {
    const session = this.requireSession(sessionId);
    const mimeType = String(input.mimeType || '').toLowerCase();
    const extensions = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
    const extension = extensions[mimeType];
    if (!extension) throw new Error('Clipboard image type is not supported.');
    const buffer = Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer || '');
    if (!buffer.length) throw new Error('Clipboard does not contain a readable image.');
    if (buffer.length > 15 * 1024 * 1024) throw new Error('Clipboard image exceeds 15 MiB.');
    if (!matchesImageSignature(buffer, mimeType)) throw new Error('Clipboard image data does not match its declared type.');
    const destination = managedAttachmentsRoot(session);
    const id = `attachment-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const name = safeFilename(String(input.name || `clipboard-image${extension}`));
    const target = uniqueFile(destination, `${id}-${name.endsWith(extension) ? name : `${name}${extension}`}`);
    fs.writeFileSync(target, buffer);
    const record = {
      id,
      sessionId,
      name: path.basename(target).replace(`${id}-`, ''),
      path: target,
      managedRoot: realPath(destination),
      mimeType,
      size: buffer.length,
      previewUrl: pathToFileURL(target).href,
      extractedText: '',
      managed: true,
      createdAt: new Date().toISOString()
    };
    this.store.set('ragAttachments', id, record);
    this.store.save();
    return record;
  }

  discardAttachment(sessionId, attachmentId) {
    const session = this.requireSession(sessionId);
    const attachment = this.store.get('ragAttachments', String(attachmentId || ''));
    if (!attachment || attachment.sessionId !== session.id) return { removed: false };
    const inMessage = this.store.list('ragMessages').some((message) => message.sessionId === session.id
      && (message.attachments || []).some((item) => item.id === attachment.id));
    if (inMessage) throw new Error('已经发送的附件不能从会话历史中单独删除。');
    removeManagedAttachmentFile(session, attachment);
    this.store.delete('ragAttachments', attachment.id);
    this.store.save();
    return { removed: true, id: attachment.id };
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
    if (attachments.length !== attachmentIds.length) throw new Error('One or more attachments are missing or belong to another session. Reattach them before sending.');
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
      await this.maybeAutoCompact(session, userMessage.id, attachments, controller.signal);
      const result = await this.runConversation(this.requireSession(session.id), { ...userMessage, attachments }, assistantId, controller.signal);
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

  shutdown() {
    const cancelled = this.controllers.size;
    for (const controller of this.controllers.values()) controller.abort();
    return { cancelled };
  }

  async runConversation(session, userMessage, assistantId, signal) {
    const provider = this.rawProvider(session.providerId);
    const model = this.sessionModel(session);
    const history = await this.hydrateHistoryAttachments(this.buildHistory(session, model, userMessage.id), model);
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
    let toolRounds = 0;
    let toolCallsUsed = 0;
    const toolContextLimit = toolContextCharacterLimit(model);
    while (toolRounds <= MAX_RAG_TOOL_ROUNDS) {
      assertApiContextBudget(apiMessages, model, this.outputTokenLimit(provider, model));
      const availableTools = toolCallsUsed < MAX_RAG_TOOL_CALLS ? tools : [];
      const result = await this.streamCompletion(provider, {
        model: session.modelId,
        messages: apiMessages,
        tools: availableTools.length ? availableTools : undefined,
        tool_choice: availableTools.length ? 'auto' : undefined,
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
      if (toolRounds >= MAX_RAG_TOOL_ROUNDS) break;
      toolRounds += 1;
      apiMessages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls.map(toApiToolCall) });
      for (const call of result.toolCalls) {
        if (toolCallsUsed >= MAX_RAG_TOOL_CALLS) {
          apiMessages.push({ role: 'tool', tool_call_id: call.id, content: `ERROR: This response reached the ${MAX_RAG_TOOL_CALLS}-tool-call safety limit.` });
          continue;
        }
        toolCallsUsed += 1;
        const event = { id: call.id, name: call.name, status: 'running', arguments: call.arguments, startedAt: new Date().toISOString() };
        toolEvents.push(event);
        this.emit({ type: 'tool', sessionId: session.id, messageId: assistantId, tool: event });
        try {
          const outcome = normalizeToolResult(await this.executeTool(session, model, call, signal));
          event.status = 'succeeded';
          event.output = truncate(outcome.text, 30000);
          if (outcome.images.length) event.images = outcome.images;
          event.finishedAt = new Date().toISOString();
          apiMessages.push({ role: 'tool', tool_call_id: call.id, content: truncate(outcome.text, toolContextLimit) });
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
      if (toolCallsUsed >= MAX_RAG_TOOL_CALLS) {
        apiMessages.push({ role: 'system', content: `The ${MAX_RAG_TOOL_CALLS}-tool-call budget is exhausted. Answer now from the evidence already collected; do not request more tools.` });
      }
    }
    if (!finished && toolEvents.length) throw new Error(`The model exceeded the ${MAX_RAG_TOOL_CALLS}-tool-call limit. Refine the request and try again.`);
    if (!content.trim() && !reasoning.trim()) throw new Error('The model returned an empty response. Check the model and provider compatibility settings.');
    return { content, reasoning, usage, toolEvents };
  }

  buildHistory(session, model, excludeMessageId = '') {
    const storedMessages = this.store.list('ragMessages').filter((item) => item.sessionId === session.id && item.id !== excludeMessageId && ['user', 'assistant'].includes(item.role) && item.status === 'complete').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const messages = this.activeHistoryMessages(session, storedMessages);
    const system = this.systemPrompt(session, model);
    const contextWindow = positiveInteger(model.contextWindow, null, DEFAULT_CONTEXT_WINDOW);
    const outputReserve = Math.min(this.outputTokenLimit(this.rawProvider(session.providerId), model), Math.floor(contextWindow * 0.5));
    const protocolReserve = Math.min(16000, Math.max(512, Math.floor(contextWindow * 0.05)));
    const historyBudget = Math.max(512, contextWindow - outputReserve - estimateTokens(system) - protocolReserve);
    const recent = [];
    let used = 0;
    for (let index = messages.length - 1; index >= 0 && recent.length < 500; index -= 1) {
      const message = messages[index];
      const tokens = estimateMessageTokens(message, model, this.store) + 8;
      if (recent.length >= 4 && used + tokens > historyBudget) break;
      recent.unshift(message);
      used += tokens;
    }
    return [{ role: 'system', content: system }, ...recent.map((message) => ({
      role: message.role,
      content: message.content || '',
      attachmentIds: message.role === 'user' ? (message.attachments || []).map((item) => item.id).filter(Boolean) : []
    }))];
  }

  async hydrateHistoryAttachments(messages, model) {
    const hydrated = [];
    for (const message of messages) {
      if (message.role !== 'user' || !message.attachmentIds?.length) {
        hydrated.push({ role: message.role, content: message.content });
        continue;
      }
      const attachments = message.attachmentIds.map((id) => this.store.get('ragAttachments', id)).filter(Boolean);
      hydrated.push(await this.userApiMessage({ content: message.content, attachments }, model));
    }
    return hydrated;
  }

  systemPrompt(session, model) {
    return [
      'You are the built-in RAG assistant of 星藏家. Help the user inspect, compare, organize, and analyze their accepted Bilibili Markdown knowledge library.',
      'Use knowledge_search before making claims about selected local libraries. Cite the source title and collection in the answer. Never fabricate missing facts.',
      model.supportsTools ? 'You can inspect selected knowledge without summarization: use knowledge_list_documents to discover document ids, knowledge_read_document to read the exact original Markdown in line ranges, and knowledge_view_images to inspect original local images when vision is enabled.' : '',
      model.supportsTools ? 'Knowledge document metadata includes both the Bilibili publish date and the date when the user added the video to favorites. Preserve the distinction and use these fields when the user asks about chronology or freshness.' : '',
      model.supportsTools ? 'Knowledge metadata also states whether a completed document is still in Bilibili favorites, was removed from the favorites folder, or belongs to a Bilibili folder that was deleted. Archived documents remain valid knowledge; never describe an archived item as currently favorited.' : '',
      model.supportsTools && model.supportsVision ? 'When an inspected knowledge image is useful to the user, include the exact star-rag-image URI returned by knowledge_view_images in Markdown image syntax so the desktop app can display it. Do not claim that only an index is available.' : '',
      `Your working sandbox is: ${session.sandboxDir}`,
      session.permissionMode === 'full' ? 'The user enabled full filesystem and command access.' : 'You have restricted access. Operations outside the sandbox or command execution require explicit user approval.',
      session.knowledgeCollectionIds.length ? `Selected collection ids: ${session.knowledgeCollectionIds.join(', ')}` : 'No local knowledge collection is selected.',
      session.systemPrompt,
      session.compressedSummary ? `Compressed earlier context:\n${session.compressedSummary}` : ''
    ].filter(Boolean).join('\n\n');
  }

  activeHistoryMessages(session, messagesInput) {
    const messages = [...(messagesInput || [])].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    if (!session.compressedSummary) return messages;
    if (session.compressedThroughMessageId) {
      const index = messages.findIndex((message) => message.id === session.compressedThroughMessageId);
      if (index >= 0) return messages.slice(index + 1);
    }
    const legacyBoundary = session.compressedThroughAt || session.compressedAt;
    if (legacyBoundary) return messages.filter((message) => String(message.createdAt || '') > String(legacyBoundary));
    return messages;
  }

  contextPlan(session, model, extraTokens = 0, messagesInput = null) {
    const messages = messagesInput || this.store.list('ragMessages').filter((item) => item.sessionId === session.id && ['user', 'assistant'].includes(item.role) && item.status === 'complete');
    const activeMessages = this.activeHistoryMessages(session, messages);
    const systemTokens = estimateTokens(this.systemPrompt(session, model));
    const messageTokens = activeMessages.reduce((sum, message) => {
      const attachments = (message.attachments || []).map((item) => this.store.get('ragAttachments', item.id)).filter(Boolean);
      return sum + estimateTokens(message.content || '') + estimateAttachmentTokens(attachments, model) + 8;
    }, 0);
    const inputTokens = systemTokens + messageTokens + Math.max(0, Number(extraTokens || 0));
    const contextWindow = positiveInteger(model.contextWindow, null, DEFAULT_CONTEXT_WINDOW);
    const provider = session.providerId ? this.store.get('ragProviders', session.providerId) : null;
    const outputReserve = Math.min(this.outputTokenLimit(provider || {}, model), Math.floor(contextWindow * 0.5));
    const protocolReserve = Math.min(16000, Math.max(512, Math.floor(contextWindow * 0.05)));
    const thresholdTokens = Math.max(512, Math.min(Math.floor(contextWindow * RAG_AUTO_COMPACT_TRIGGER), contextWindow - outputReserve - protocolReserve - 512));
    return {
      inputTokens,
      contextWindow,
      contextPercent: Math.min(100, Math.round((inputTokens / Math.max(1, contextWindow)) * 1000) / 10),
      thresholdTokens,
      thresholdPercent: Math.max(0, Math.round((thresholdTokens / Math.max(1, contextWindow)) * 1000) / 10),
      shouldCompact: inputTokens >= thresholdTokens
    };
  }

  async maybeAutoCompact(session, currentMessageId, attachments, signal) {
    const model = this.sessionModel(session);
    const plan = this.contextPlan(session, model);
    if (!plan.shouldCompact) return { compacted: false, plan };
    if (!model.supportsCompression) {
      throw new Error(`当前会话上下文已达到自动压缩阈值（${plan.contextPercent}%），但所选模型未启用上下文压缩。请手动切换支持压缩的模型，或新建会话。`);
    }
    const stored = this.store.list('ragMessages').filter((item) => item.sessionId === session.id && item.id !== currentMessageId && ['user', 'assistant'].includes(item.role) && item.status === 'complete');
    const candidates = this.activeHistoryMessages(session, stored);
    if (!candidates.length && !session.compressedSummary) return { compacted: false, plan };
    this.emit({ type: 'context-compaction', phase: 'started', automatic: true, sessionId: session.id, contextPercent: plan.contextPercent, thresholdPercent: plan.thresholdPercent });
    const detail = await this.compactContext(session, { automatic: true, excludeMessageId: currentMessageId, signal });
    this.emit({ type: 'context-compaction', phase: 'completed', automatic: true, sessionId: session.id, contextPercent: plan.contextPercent, thresholdPercent: plan.thresholdPercent, detail });
    return { compacted: true, plan, detail };
  }

  async userApiMessage(message, model) {
    const textParts = [message.content || ''];
    const parts = [];
    for (const attachment of message.attachments || []) {
      if (attachment.extractedText) {
        textParts.push(`\n\n[Attachment: ${attachment.name}; local path: ${attachment.path}]\n${attachment.extractedText.slice(0, 30000)}\n[The text above is an extracted prefix. Use read_file on the local path when exact additional text is needed.]`);
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

  conversationTranscript(message) {
    const attachmentNotes = (message.attachments || []).map((item) => {
      const attachment = this.store.get('ragAttachments', item.id);
      if (!attachment) return `[Attachment no longer available: ${item.name || item.id}]`;
      if (attachment.extractedText) return `[Attachment: ${attachment.name}]\n${attachment.extractedText.slice(0, 30000)}`;
      return `[Attachment: ${attachment.name}; type=${attachment.mimeType}; size=${attachment.size} bytes]`;
    });
    return [`[${String(message.role || '').toUpperCase()} | ${message.createdAt || '-'} | ${message.id}]`, message.content || '', ...attachmentNotes].filter(Boolean).join('\n');
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
        tool('knowledge_read_document', 'Read an exact, unsummarized range from one original Markdown document. Continue with both next_start_line and next_start_column until End of document.', { document_id: { type: 'string' }, start_line: { type: 'integer' }, start_column: { type: 'integer' }, line_count: { type: 'integer' } }, ['document_id']),
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
    if (call.name === 'knowledge_read_document') return this.readKnowledgeDocument(session, args.document_id, args.start_line, args.line_count, args.start_column, toolContextCharacterLimit(model));
    if (call.name === 'knowledge_view_images') return this.viewKnowledgeImages(session, model, args.document_id, args.image_indices);
    if (call.name === 'list_files') {
      const target = await this.authorizePath(session, args.path || '.', 'list directory');
      return fs.readdirSync(target, { withFileTypes: true }).slice(0, 300).map((item) => `${item.isDirectory() ? '[dir]' : '[file]'} ${item.name}`).join('\n');
    }
    if (call.name === 'read_file') {
      const target = await this.authorizePath(session, args.path, 'read file');
      return readUtf8Prefix(target, 80000);
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
      const parsed = parseHttpUrl(args.url);
      if (parsed.username || parsed.password) throw new Error('Browser URLs cannot contain embedded account credentials.');
      const url = parsed.toString();
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
    const commandShell = resolveSystemExecutable('cmd.exe');
    if (!commandShell) throw new Error('Windows 系统缺少 cmd.exe，无法执行命令。');
    return new Promise((resolve, reject) => {
      let aborted = false;
      let timedOut = false;
      let timer;
      const onAbort = () => {
        aborted = true;
        killProcessTree(child);
      };
      const finish = (callback) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        callback();
      };
      const utf8Command = `chcp 65001>nul & ${String(command)}`;
      const child = execFile(commandShell, ['/d', '/s', '/c', utf8Command], { cwd: workingDirectory, encoding: 'utf8', env: projectRuntimeEnvironment(), windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (aborted) return finish(() => reject(abortError()));
        if (timedOut) return finish(() => reject(new Error('Command timed out after 120 seconds.')));
        if (error) return finish(() => reject(new Error(`${error.message}\n${stderr || stdout}`.trim())));
        finish(() => resolve(truncate(`${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`, 60000)));
      });
      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, 120000);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  async browseUrl(session, value) {
    const url = parseHttpUrl(value).toString();
    const host = new URL(url).hostname;
    const privateAddress = await resolvesToPrivateHost(host);
    if (session.permissionMode !== 'full' && privateAddress) await this.approve(session, { action: 'browse private or local address', target: url, detail: 'This address may access a local service or private network.' });
    return this.browseHidden(url, {
      allowPrivate: privateAddress,
      allowedPrivateHosts: privateAddress && session.permissionMode !== 'full' ? [host] : undefined
    });
  }

  async searchKnowledge(session, query, limit = 8) {
    const selected = new Set(session.knowledgeCollectionIds || []);
    if (!selected.size) return 'No knowledge library is selected.';
    const terms = queryTerms(String(query || ''));
    const tasks = this.store.listTasks().filter((task) => selected.has(task.collectionId) && knowledgeEligible(task));
    const collections = new Map(this.store.listCollections().map((item) => [item.id, item]));
    const scored = [];
    const startedAt = Date.now();
    let inspectedDocuments = 0;
    let skippedDocuments = 0;
    let inspectedChunks = 0;
    let truncatedByBudget = false;
    for (const task of tasks.slice(0, MAX_RAG_SEARCH_DOCUMENTS)) {
      if (Date.now() - startedAt >= RAG_SEARCH_TIME_BUDGET_MS || inspectedChunks >= MAX_RAG_SEARCH_CHUNKS) {
        truncatedByBudget = true;
        break;
      }
      inspectedDocuments += 1;
      let chunks;
      try {
        chunks = this.documentChunks(task.outputMarkdown);
      } catch {
        skippedDocuments += 1;
        continue;
      }
      for (const chunk of chunks) {
        inspectedChunks += 1;
        if (Date.now() - startedAt >= RAG_SEARCH_TIME_BUDGET_MS || inspectedChunks > MAX_RAG_SEARCH_CHUNKS) {
          truncatedByBudget = true;
          break;
        }
        const collection = collections.get(task.collectionId);
        const membership = knowledgeFavoriteMetadata(task, collection);
        const haystack = `${task.title || ''}\n${task.owner || ''}\n${task.publishedAt || ''}\n${task.favoriteAddedAt || ''}\n${membership}\n${chunk}`.toLowerCase();
        const score = terms.reduce((sum, term) => sum + countOccurrences(haystack, term), 0) + (terms.some((term) => String(task.title || '').toLowerCase().includes(term)) ? 6 : 0);
        if (score > 0 || !terms.length) scored.push({ score, task, chunk, collection });
      }
      if (truncatedByBudget) break;
    }
    const wanted = Math.max(1, Math.min(20, Number(limit) || 8));
    const results = scored.sort((a, b) => b.score - a.score).slice(0, wanted);
    const notice = [
      skippedDocuments ? `Skipped ${skippedDocuments} unavailable or unreadable document(s).` : '',
      truncatedByBudget || tasks.length > inspectedDocuments ? `Search budget reached; inspected ${inspectedDocuments}/${tasks.length} document(s) and ${inspectedChunks} chunk(s).` : ''
    ].filter(Boolean).join('\n');
    if (!results.length) return `${notice}${notice ? '\n' : ''}No matching passages found across ${tasks.length} selected documents.`;
    const resultText = results.map((item, index) => `[#${index + 1}] Document ID: ${item.task.id}\nUser: ${item.collection?.userName || '-'} | Collection: ${item.collection?.name || '-'} | Title: ${item.task.title || item.task.bvid}\nBVID: ${item.task.bvid || '-'} | UP: ${item.task.owner || '-'}\nPublished at: ${item.task.publishedAt || '-'}\nFavorited at: ${item.task.favoriteAddedAt || '-'}\n${knowledgeFavoriteMetadata(item.task, item.collection)}\n${item.chunk}`).join('\n\n---\n\n');
    return truncate(`${notice}${notice ? '\n\n' : ''}${resultText}`, MAX_RAG_SEARCH_RESULT_CHARACTERS);
  }

  listKnowledgeDocuments(session, query = '', offset = 0, limit = 50) {
    const terms = queryTerms(String(query || ''));
    const collections = new Map(this.store.listCollections().map((item) => [item.id, item]));
    const all = this.knowledgeTasks(session).filter((task) => {
      if (!terms.length) return true;
      const collection = collections.get(task.collectionId);
      const value = `${task.id} ${task.bvid || ''} ${task.title || ''} ${task.owner || ''} ${task.publishedAt || ''} ${task.favoriteAddedAt || ''} ${collection?.name || ''} ${knowledgeFavoriteMetadata(task, collection)}`.toLowerCase();
      return terms.every((term) => value.includes(term));
    });
    const start = Math.max(0, Number(offset) || 0);
    const count = Math.max(1, Math.min(200, Number(limit) || 50));
    const page = all.slice(start, start + count);
    const rows = page.map((task, index) => {
      const collection = collections.get(task.collectionId);
      return `[${start + index + 1}] Document ID: ${task.id}\nTitle: ${task.title || task.bvid} | BVID: ${task.bvid || '-'} | UP: ${task.owner || '-'}\nUser: ${collection?.userName || '-'} | Collection: ${collection?.name || '-'}\nPublished at: ${task.publishedAt || '-'} | Favorited at: ${task.favoriteAddedAt || '-'}\n${knowledgeFavoriteMetadata(task, collection)}`;
    });
    return `Selected documents: ${all.length}. Showing ${page.length} from offset ${start}.\n\n${rows.join('\n\n') || 'No matching documents.'}`;
  }

  readKnowledgeDocument(session, documentId, startLine = 1, lineCount = 300, startColumn = 0, maximumCharactersInput = MAX_KNOWLEDGE_READ_CHARACTERS) {
    const task = this.requireKnowledgeDocument(session, documentId);
    const collection = this.store.getCollectionById(task.collectionId);
    const start = Math.max(1, Number(startLine) || 1);
    const column = Math.max(0, Number(startColumn) || 0);
    const wanted = Math.max(1, Math.min(2000, Number(lineCount) || 300));
    const maximumCharacters = Math.max(2000, Math.min(MAX_KNOWLEDGE_READ_CHARACTERS, Number(maximumCharactersInput) || MAX_KNOWLEDGE_READ_CHARACTERS));
    const range = readUtf8LineRange(task.outputMarkdown, start, wanted, column, maximumCharacters);
    return [
      `Document ID: ${task.id}`,
      `Title: ${task.title || task.bvid}`,
      `BVID: ${task.bvid || '-'}`,
      `UP: ${task.owner || '-'}`,
      `Published at: ${task.publishedAt || '-'}`,
      `Favorited at: ${task.favoriteAddedAt || '-'}`,
      knowledgeFavoriteMetadata(task, collection),
      `Exact original Markdown range starts at line ${start}, column ${column}; returned through line ${range.endLine}${range.totalLinesKnown ? ` of ${range.totalLines}` : ''}.`,
      range.next ? `next_start_line: ${range.next.line}\nnext_start_column: ${range.next.column}` : 'End of document.',
      '\n--- RAW MARKDOWN START ---\n',
      range.selected,
      '\n--- RAW MARKDOWN END ---'
    ].join('\n');
  }

  viewKnowledgeImages(session, model, documentId, imageIndices = []) {
    if (!model.supportsVision) throw new Error('The selected model is not configured for vision input.');
    const task = this.requireKnowledgeDocument(session, documentId);
    const collection = this.store.getCollectionById(task.collectionId);
    const images = this.knowledgeDocumentImages(task);
    if (!images.length) return 'This Markdown document has no readable local images.';
    const requested = Array.isArray(imageIndices) && imageIndices.length ? imageIndices : images.slice(0, 4).map((_, index) => index + 1);
    const indices = [...new Set(requested.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 1 && value <= images.length))].slice(0, 4);
    if (!indices.length) throw new Error(`No valid image index was supplied. This document has ${images.length} local images.`);
    const selected = indices.map((value) => ({ ...images[value - 1], index: value, uri: knowledgeImageUri(task.id, value) }));
    return {
      text: [
        `Loaded ${selected.length} original image(s) from document ${task.id} (${task.title || task.bvid}) into the multimodal request.`,
        `Published at: ${task.publishedAt || '-'} | Favorited at: ${task.favoriteAddedAt || '-'}`,
        knowledgeFavoriteMetadata(task, collection),
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
    return this.store.listTasks().filter((task) => selected.has(task.collectionId) && knowledgeEligible(task));
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
      const identity = process.platform === 'win32' ? target.toLowerCase() : target;
      if (!isInside(root, target) || !mimeType.startsWith('image/') || !fs.existsSync(target) || seen.has(identity)) continue;
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.size > 15 * 1024 * 1024 || !isInside(realPath(root), realPath(target))) continue;
      if (!matchesImageSignature(fs.readFileSync(target), mimeType)) continue;
      seen.add(identity);
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
    if (cached?.mtimeMs === stat.mtimeMs && cached?.size === stat.size) {
      this.documentCache.delete(file);
      this.documentCache.set(file, cached);
      return cached.chunks;
    }
    const text = readUtf8Prefix(file, MAX_INDEX_DOCUMENT_CHARACTERS).replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '');
    const chunks = [];
    const sections = text.split(/(?=^#{1,3}\s+)/m);
    for (const section of sections) {
      for (let offset = 0; offset < section.length; offset += 1600) chunks.push(section.slice(offset, offset + 1900));
    }
    this.documentCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, chunks: chunks.filter((item) => item.trim()) });
    while (this.documentCache.size > MAX_DOCUMENT_CACHE_ENTRIES) this.documentCache.delete(this.documentCache.keys().next().value);
    return this.documentCache.get(file).chunks;
  }

  async compact(sessionId) {
    const session = this.requireSession(sessionId);
    if (this.controllers.has(session.id)) throw new Error('Stop the current response before compressing this session.');
    const model = this.sessionModel(session);
    if (!model.supportsCompression) throw new Error('Context compression is disabled for this model.');
    const controller = new AbortController();
    this.controllers.set(session.id, controller);
    try {
      return await this.compactContext(session, { automatic: false, signal: controller.signal });
    } finally {
      this.controllers.delete(session.id);
    }
  }

  async compactContext(sessionInput, options = {}) {
    const session = this.requireSession(sessionInput.id);
    const provider = this.rawProvider(session.providerId);
    const model = this.sessionModel(session);
    const messages = this.store.list('ragMessages')
      .filter((item) => item.sessionId === session.id && item.id !== options.excludeMessageId && ['user', 'assistant'].includes(item.role) && item.status === 'complete')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const activeMessages = this.activeHistoryMessages(session, messages);
    if (!session.compressedSummary && activeMessages.length < (options.automatic ? 1 : 4)) throw new Error('There is not enough conversation history to compress.');
    const transcript = [
      session.compressedSummary ? `[PREVIOUS DURABLE SUMMARY]\n${session.compressedSummary}` : '',
      ...activeMessages.map((item) => this.conversationTranscript(item))
    ].filter(Boolean).join('\n\n---\n\n');
    if (!transcript.trim()) throw new Error('There is no compressible conversation context.');
    const summary = await this.summarizeConversationContext(session, provider, model, transcript, options.signal);
    const latest = this.requireSession(session.id);
    const lastMessage = activeMessages.at(-1);
    latest.compressedSummary = summary;
    latest.compressedAt = new Date().toISOString();
    if (lastMessage) {
      latest.compressedThroughMessageId = lastMessage.id;
      latest.compressedThroughAt = lastMessage.createdAt || latest.compressedAt;
    }
    latest.compactionCount = Number(latest.compactionCount || 0) + 1;
    if (options.automatic) {
      latest.autoCompactionCount = Number(latest.autoCompactionCount || 0) + 1;
      latest.lastAutoCompressedAt = latest.compressedAt;
    }
    latest.lastCompactionMode = options.automatic ? 'automatic' : 'manual';
    latest.updatedAt = new Date().toISOString();
    this.store.set('ragSessions', latest.id, latest);
    this.store.save();
    const detail = this.sessionDetail(latest.id);
    return detail;
  }

  async summarizeConversationContext(session, provider, model, transcript, signal) {
    const contextWindow = positiveInteger(model.contextWindow, null, DEFAULT_CONTEXT_WINDOW);
    const maxTokens = Math.max(256, Math.min(6000, this.outputTokenLimit(provider, model), Math.floor(contextWindow * 0.2)));
    const system = 'Compress conversation context into durable working memory. Preserve user goals, decisions, facts, source titles and citations, dates, file paths, constraints, preferences, unfinished work, errors, and uncertainty. Do not add facts. Do not omit unresolved requirements.';
    const protocolReserve = Math.min(8000, Math.max(512, Math.floor(contextWindow * 0.05)));
    const chunkBudget = Math.max(256, contextWindow - maxTokens - protocolReserve - estimateTokens(system) - 256);
    let chunks = splitTextByTokenBudget(transcript, chunkBudget);
    let summaries = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const prompt = chunks.length === 1
        ? `Create one durable working-memory summary from the complete conversation below.\n\n${chunks[index]}`
        : `Summarize conversation chunk ${index + 1}/${chunks.length}. Preserve every durable fact and unresolved item so a later merge can reconstruct the working state.\n\n${chunks[index]}`;
      summaries.push(await this.completeAndRecordCompression(session, provider, model, system, prompt, maxTokens, signal));
    }
    for (let mergeRound = 0; summaries.length > 1 && mergeRound < 6; mergeRound += 1) {
      const mergeSource = summaries.map((summary, index) => `[SUMMARY CHUNK ${index + 1}/${summaries.length}]\n${summary}`).join('\n\n---\n\n');
      chunks = splitTextByTokenBudget(mergeSource, chunkBudget);
      const merged = [];
      for (let index = 0; index < chunks.length; index += 1) {
        const prompt = `Merge summary group ${index + 1}/${chunks.length} into durable working memory. Remove repetition only; preserve all goals, facts, dates, citations, paths, constraints, unfinished work, errors, and uncertainty.\n\n${chunks[index]}`;
        merged.push(await this.completeAndRecordCompression(session, provider, model, system, prompt, maxTokens, signal));
      }
      summaries = merged;
    }
    if (summaries.length > 1) throw new Error('Conversation context could not be reduced within the model context window.');
    const summary = String(summaries[0] || '').trim();
    if (!summary) throw new Error('The context compression model returned an empty summary.');
    return summary;
  }

  async completeAndRecordCompression(session, provider, model, system, prompt, maxTokens, signal) {
    const result = await this.complete(provider, {
      model: session.modelId,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: maxTokens
    }, signal);
    this.recordUsage(session, result.usage || estimateUsage([], result.content));
    return String(result.content || '');
  }

  async streamCompletion(provider, body, signal, onDelta) {
    try {
      return await this.streamCompletionRequest(provider, body, signal, onDelta);
    } catch (error) {
      throw normalizeProviderError(error, signal);
    }
  }

  async streamCompletionRequest(provider, body, signal, onDelta) {
    const response = await this.requestCompletion(provider, { ...body, stream: true, stream_options: { include_usage: true } }, signal);
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) {
      const payload = parseJson(await response.text(), 'Model provider returned invalid JSON data.');
      const payloadError = responsePayloadError(payload);
      if (payloadError) throw providerPayloadError(payloadError);
      const choice = payload.choices?.[0] || {};
      const message = choice.message || choice.delta || {};
      const normalized = normalizeResponseMessage(message);
      if (normalized.content) onDelta?.({ content: normalized.content });
      if (normalized.reasoning) onDelta?.({ reasoning: normalized.reasoning });
      return {
        content: normalized.content,
        reasoning: normalized.reasoning,
        usage: normalizeUsage(payload.usage || {}),
        toolCalls: normalizeToolCalls(message.tool_calls || []),
        finishReason: String(choice.finish_reason || payload.finish_reason || '')
      };
    }
    if (!response.body) throw new Error('Model response did not include a stream.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning = '';
    let usage = null;
    let finishReason = '';
    const toolCalls = new Map();
    const inlineReasoning = new InlineReasoningStreamParser();
    const consumeEvent = (event) => {
      for (const line of event.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        const payload = parseJson(data, 'Invalid SSE payload from model provider.');
        const payloadError = responsePayloadError(payload);
        if (payloadError) throw providerPayloadError(payloadError);
        if (payload.usage) usage = normalizeUsage(payload.usage);
        for (const choice of payload.choices || []) {
          if (choice.finish_reason !== undefined && choice.finish_reason !== null) finishReason = String(choice.finish_reason);
          const delta = choice.delta || choice.message || {};
          const text = normalizeContent(delta.content);
          const thought = normalizeContent(delta.reasoning_content ?? delta.reasoning ?? delta.thinking);
          if (text) {
            const parsed = inlineReasoning.push(text);
            if (parsed.content) { content += parsed.content; onDelta?.({ content: parsed.content }); }
            if (parsed.reasoning) { reasoning += parsed.reasoning; onDelta?.({ reasoning: parsed.reasoning }); }
          }
          if (thought) { reasoning += thought; onDelta?.({ reasoning: thought }); }
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
    const inlineTail = inlineReasoning.finish();
    if (inlineTail.content) { content += inlineTail.content; onDelta?.({ content: inlineTail.content }); }
    if (inlineTail.reasoning) { reasoning += inlineTail.reasoning; onDelta?.({ reasoning: inlineTail.reasoning }); }
    return { content, reasoning, usage, toolCalls: [...toolCalls.values()], finishReason };
  }

  async complete(provider, body, signal) {
    try {
      const response = await this.requestCompletion(provider, { ...body, stream: false }, signal);
      const text = await response.text();
      if (!response.ok) throw providerHttpError(response.status, text);
      const payload = parseJson(text, 'Model provider returned non-JSON data.');
      const payloadError = responsePayloadError(payload);
      if (payloadError) throw providerPayloadError(payloadError);
      const choice = payload.choices?.[0] || {};
      const message = choice.message || {};
      const normalized = normalizeResponseMessage(message);
      return { content: normalized.content, reasoning: normalized.reasoning, usage: normalizeUsage(payload.usage || {}), finishReason: String(choice.finish_reason || payload.finish_reason || '') };
    } catch (error) {
      throw normalizeProviderError(error, signal);
    }
  }

  async requestCompletion(provider, body, signal) {
    const roots = candidateApiRoots(provider);
    const errors = [];
    let lastError = null;
    for (const root of roots) {
      let requestBody = { ...body };
      const attemptedVariants = new Set([requestVariantSignature(requestBody)]);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        let response;
        try {
          response = await providerFetch(`${root}/chat/completions`, {
            method: 'POST',
            headers: this.providerHeaders(provider),
            body: JSON.stringify(requestBody)
          }, signal);
        } catch (error) {
          if (signal?.aborted) throw error;
          lastError = error;
          errors.push(`${root}/chat/completions: ${error.message || String(error)}`);
          break;
        }
        if (response.ok) {
          this.rememberProviderRoot(provider, root);
          return response;
        }
        const errorText = await response.text();
        const compatibleBody = nextCompatibleRequestBody(requestBody, response.status, errorText);
        if (compatibleBody && !attemptedVariants.has(requestVariantSignature(compatibleBody))) {
          attemptedVariants.add(requestVariantSignature(compatibleBody));
          requestBody = compatibleBody;
          continue;
        }
        if (shouldTryAnotherApiRoot(response.status, errorText) && root !== roots.at(-1)) {
          errors.push(`${root}/chat/completions: HTTP ${response.status}: ${errorText.slice(0, 500)}`);
          break;
        }
        throw providerHttpError(response.status, errorText);
      }
    }
    if (lastError && !errors.length) throw lastError;
    const error = new Error(`No compatible chat completion endpoint responded. ${errors.join(' | ').slice(0, 1600)}`);
    error.code = 'MODEL_PROVIDER_FAILURE';
    error.failureKind = 'infrastructure';
    error.possibleCauses = ['供应商 Base URL 可能缺少或错误包含 /v1', '供应商接口暂时不可用或网络连接失败', '检查 AI 模型配置中的 Base URL、API Key 和接口兼容性'];
    error.cause = lastError;
    throw error;
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
  const previewUrl = attachment.previewUrl || (attachment.path && String(attachment.mimeType || '').startsWith('image/') && fs.existsSync(attachment.path) ? pathToFileURL(attachment.path).href : '');
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    previewUrl,
    createdAt: attachment.createdAt
  };
}

function matchesImageSignature(buffer, mimeType) {
  if (mimeType === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9;
  if (mimeType === 'image/gif') return ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'));
  if (mimeType === 'image/webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (mimeType === 'image/bmp') return buffer.subarray(0, 2).toString('ascii') === 'BM';
  return false;
}

function normalizeModel(item = {}) {
  const id = String(item.id || item.name || '');
  const lower = id.toLowerCase();
  const defaults = inferModelTokenLimits(lower);
  const capability = (name) => modelCapability(item, name);
  return {
    id,
    name: String(item.name || item.id || ''),
    contextWindow: positiveInteger(item.contextWindow || item.context_window || item.contextLength || item.context_length || item.max_context_tokens || item.max_context_length || item.max_model_len || item.input_token_limit, null, defaults.contextWindow),
    maxOutputTokens: positiveInteger(item.maxOutputTokens || item.max_output_tokens || item.output_token_limit || item.max_completion_tokens || item.max_tokens, null, defaults.maxOutputTokens),
    supportsTools: capability('tools') ?? true,
    supportsReasoning: capability('reasoning') ?? /reason|thinking|o[1-9]|r1|deepseek/.test(lower),
    supportsVision: capability('vision') ?? /vision|gpt-4o|gpt-5|gemini|claude|vl/.test(lower),
    supportsAudio: capability('audio') ?? /audio|omni|realtime/.test(lower),
    supportsImages: capability('images') ?? /image|gpt-4o|gpt-5|gemini/.test(lower),
    supportsCompression: capability('compression') ?? true,
    supportsSubagents: capability('subagents') ?? true
  };
}

function modelCapability(item, name) {
  const aliases = {
    tools: ['supportsTools', 'supports_tools', 'toolCalling', 'tool_calling', 'functionCalling', 'function_calling'],
    reasoning: ['supportsReasoning', 'supports_reasoning', 'reasoning', 'thinking'],
    vision: ['supportsVision', 'supports_vision', 'vision', 'multimodal', 'imageInput', 'image_input'],
    audio: ['supportsAudio', 'supports_audio', 'audioInput', 'audio_input'],
    images: ['supportsImages', 'supports_images', 'imageOutput', 'image_output'],
    compression: ['supportsCompression', 'supports_compression'],
    subagents: ['supportsSubagents', 'supports_subagents']
  };
  for (const key of aliases[name] || []) {
    const value = explicitBoolean(item, key);
    if (value !== undefined) return value;
  }
  for (const source of [item.capabilities, item.features, item.metadata]) {
    if (!source || typeof source !== 'object') continue;
    for (const key of aliases[name] || []) {
      const value = explicitBoolean(source, key);
      if (value !== undefined) return value;
    }
  }

  const supportedParameters = firstArray(item.supported_parameters, item.supportedParameters, item.capabilities?.supported_parameters, item.capabilities?.supportedParameters);
  if (supportedParameters) {
    const values = supportedParameters.map((value) => String(value).toLowerCase());
    if (name === 'tools') return values.some((value) => /tool|function/.test(value));
    if (name === 'reasoning') return values.some((value) => /reason|thinking/.test(value));
  }

  const architecture = item.architecture && typeof item.architecture === 'object' ? item.architecture : {};
  const inputModalities = firstArray(item.input_modalities, item.inputModalities, architecture.input_modalities, architecture.inputModalities);
  const outputModalities = firstArray(item.output_modalities, item.outputModalities, architecture.output_modalities, architecture.outputModalities);
  const modalitiesText = [item.modality, item.modalities, architecture.modality, inputModalities, outputModalities].flat(Infinity).filter(Boolean).join(' ').toLowerCase();
  if (name === 'vision' && (inputModalities || item.modalities || architecture.modality)) return /image|vision|video/.test(modalitiesText);
  if (name === 'audio' && (inputModalities || item.modalities || architecture.modality)) return /audio|speech|video/.test(modalitiesText);
  if (name === 'images' && outputModalities) return outputModalities.some((value) => /image/.test(String(value).toLowerCase()));
  return undefined;
}

function explicitBoolean(source, key) {
  if (!Object.prototype.hasOwnProperty.call(source || {}, key)) return undefined;
  const value = source[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    if (/^(?:true|yes|on|1)$/i.test(value.trim())) return true;
    if (/^(?:false|no|off|0)$/i.test(value.trim())) return false;
  }
  return undefined;
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return null;
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

function nextCompatibleRequestBody(body, status, responseText) {
  if (![400, 404, 405, 415, 422].includes(Number(status))) return null;
  const text = String(responseText || '');
  const lower = text.toLowerCase();
  if (body.stream_options && /stream[_ -]?options|include[_ -]?usage|unknown field|additional propert|不支持.*stream|stream.*不支持/i.test(text)) {
    const next = { ...body };
    delete next.stream_options;
    return next;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'max_tokens') && /max[_ -]?tokens/.test(lower) && /unsupported|not support|unknown|invalid|unrecognized|use max[_ -]?completion[_ -]?tokens|不支持|未知|无效|改用/i.test(text)) {
    const next = { ...body, max_completion_tokens: body.max_tokens };
    delete next.max_tokens;
    return next;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'max_completion_tokens') && /max[_ -]?completion[_ -]?tokens/.test(lower) && /unsupported|not support|unknown|invalid|unrecognized|use max[_ -]?tokens|不支持|未知|无效|改用/i.test(text)) {
    const next = { ...body, max_tokens: body.max_completion_tokens };
    delete next.max_completion_tokens;
    return next;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'temperature')) {
    if (/(?:temperature|温度).{0,80}(?:unsupported|not support|unknown|not allowed|不支持|不接受|未知)/i.test(text)) {
      const next = { ...body };
      delete next.temperature;
      return next;
    }
    const fixed = fixedTemperatureFromError(text);
    if (fixed !== null && Number(body.temperature) !== fixed) return { ...body, temperature: fixed };
  }
  return null;
}

function fixedTemperatureFromError(value) {
  const text = String(value || '');
  const match = text.match(/(?:temperature|温度).{0,100}?(?:only|must(?:\s+be)?|fixed(?:\s+at)?|只能|必须|固定为)[^\d]{0,20}(0(?:\.\d+)?|1(?:\.0+)?)(?![\d.])/i);
  if (!match) return null;
  const number = Number(match[1]);
  return number >= 0 && number <= 1 ? number : null;
}

function shouldTryAnotherApiRoot(status, responseText) {
  if ([404, 405, 501].includes(Number(status))) return true;
  if (Number(status) !== 400) return false;
  return /route|endpoint|path|not found|cannot post|method not allowed|unknown url|不存在|路径|接口/i.test(String(responseText || ''));
}

function requestVariantSignature(body = {}) {
  return JSON.stringify({
    max_tokens: body.max_tokens,
    max_completion_tokens: body.max_completion_tokens,
    temperature: body.temperature,
    stream_options: body.stream_options ? 'present' : 'absent'
  });
}

function normalizeBaseUrl(value) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  const url = new URL(text);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Base URL must use HTTP or HTTPS.');
  if (url.username || url.password) throw new Error('Base URL cannot contain embedded credentials.');
  if (url.search || url.hash) throw new Error('Base URL cannot contain a query string or fragment.');
  if (url.protocol === 'http:' && !isPrivateNetworkHost(url.hostname)) {
    throw new Error('Public model endpoints must use HTTPS. Plain HTTP is allowed only for localhost or private-network endpoints.');
  }
  return text;
}

async function providerFetch(url, options, signal) {
  const timeout = AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return fetch(url, { ...options, signal: requestSignal });
}

function providerHttpError(status, body) {
  const detail = String(body || '').slice(0, 1600);
  const error = new Error(`Model request failed (${status}): ${detail}`);
  error.code = 'MODEL_PROVIDER_FAILURE';
  error.failureKind = 'infrastructure';
  error.status = Number(status) || 0;
  error.explicitProviderError = true;
  error.providerMessage = detail;
  error.possibleCauses = status === 401 || status === 403
    ? ['模型供应商 API Key 无效、过期或权限不足', '供应商 Base URL 与密钥不匹配']
    : status === 429
      ? ['模型供应商额度、速率或并发限制已触发', '稍后恢复 Agent，或检查供应商账户额度']
      : ['模型供应商接口不可用或接口规范不兼容', 'Base URL、模型名或模型参数配置错误'];
  return error;
}

function responsePayloadError(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.error) return payload.error;
  if (String(payload.type || '').toLowerCase() === 'error') return payload;
  if (payload.success === false && (payload.message || payload.detail || payload.code)) return payload;
  if (/^(?:error|failed)$/i.test(String(payload.status || '')) && (payload.message || payload.detail || payload.code)) return payload;
  return null;
}

function providerPayloadError(payload) {
  const detail = typeof payload === 'string'
    ? payload
    : String(payload?.message || payload?.detail || payload?.code || JSON.stringify(payload || {}));
  const error = new Error(`模型供应商明确返回错误：${detail.slice(0, 1600)}`);
  error.code = 'MODEL_PROVIDER_FAILURE';
  error.failureKind = 'infrastructure';
  error.explicitProviderError = true;
  error.providerMessage = detail;
  error.providerCode = String(payload?.code || payload?.type || payload?.status || '');
  error.possibleCauses = [
    '模型供应商资源池、额度或账户并发当前不可用',
    '供应商 Base URL、API Key、模型名或请求参数不兼容'
  ];
  return error;
}

function normalizeProviderError(error, signal) {
  if (signal?.aborted) return abortError();
  if (error?.failureKind === 'infrastructure') return error;
  const wrapped = new Error(`模型供应商请求无法完成：${error?.message || String(error)}`);
  wrapped.code = 'MODEL_PROVIDER_FAILURE';
  wrapped.failureKind = 'infrastructure';
  wrapped.possibleCauses = [
    error?.name === 'TimeoutError' ? '模型供应商在一小时内未返回结果' : '网络连接、供应商服务或兼容接口响应异常',
    '检查 AI 模型配置中的 Base URL、API Key、模型名和上下文/输出上限'
  ];
  wrapped.cause = error;
  return wrapped;
}

function removeManagedAttachmentFile(session, attachment) {
  if (!attachment?.path) return false;
  const target = path.resolve(attachment.path);
  const expectedPrefix = `${String(attachment.id || '')}-`;
  if (attachment.managed === false || !expectedPrefix || !path.basename(target).startsWith(expectedPrefix) || path.basename(path.dirname(target)).toLowerCase() !== 'attachments' || !fs.existsSync(target)) return false;
  try {
    const parent = path.dirname(target);
    const parentStat = fs.lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return false;
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const resolvedParent = realPath(parent);
    const resolvedTarget = realPath(target);
    const managedRoot = attachment.managedRoot ? path.resolve(attachment.managedRoot) : resolvedParent;
    if (!samePath(resolvedParent, managedRoot) || !isInside(managedRoot, resolvedTarget)) return false;
    fs.rmSync(target, { force: true });
    return true;
  } catch {
    return false;
  }
}

function managedAttachmentsRoot(session) {
  const sandbox = ensureDir(path.resolve(session.sandboxDir));
  const destination = ensureDir(path.join(sandbox, 'attachments'));
  const destinationStat = fs.lstatSync(destination);
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
    throw new Error('The attachments path must be a regular directory, not a link.');
  }
  if (!isInside(fs.realpathSync(sandbox), fs.realpathSync(destination))) {
    throw new Error('The attachments directory resolves outside the session sandbox. Remove the link or choose another sandbox.');
  }
  return destination;
}

function normalizeHeaders(value) {
  if (!value) return {};
  const parsed = typeof value === 'string' ? parseJson(value, 'Extra headers must be valid JSON.') : value;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Extra headers must be a JSON object.');
  const entries = Object.entries(parsed);
  if (entries.length > 64) throw new Error('Extra headers cannot contain more than 64 fields.');
  return Object.fromEntries(entries.map(([key, item]) => {
    const name = String(key).trim();
    const lower = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name)) throw new Error(`Invalid extra header name: ${name || '(empty)'}`);
    if (/^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-access-token|x-goog-api-key)$/i.test(lower)) {
      throw new Error(`Sensitive header ${name} is not allowed in extra headers. Store credentials in the encrypted API Key field.`);
    }
    const text = String(item);
    if (/\r|\n/.test(text)) throw new Error(`Extra header ${name} contains an invalid line break.`);
    return [name, text];
  }));
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

function assertApiContextBudget(messages, model, outputTokens) {
  const contextWindow = positiveInteger(model.contextWindow, null, DEFAULT_CONTEXT_WINDOW);
  const inputTokens = estimateTokens(JSON.stringify(messages || []));
  const outputReserve = Math.min(positiveInteger(outputTokens, null, DEFAULT_MAX_OUTPUT_TOKENS), Math.floor(contextWindow * 0.5));
  const protocolReserve = Math.min(16000, Math.max(128, Math.floor(contextWindow * 0.05)));
  if (inputTokens + outputReserve + protocolReserve > contextWindow) {
    const percent = Math.round((inputTokens / Math.max(1, contextWindow)) * 1000) / 10;
    const error = new Error(`当前请求上下文约 ${percent}%（${inputTokens}/${contextWindow} tokens），加上输出预留后超过模型上限。请先压缩会话、减少附件或切换更大上下文模型。`);
    error.code = 'MODEL_CONTEXT_LIMIT';
    error.failureKind = 'context';
    throw error;
  }
}

function estimateTokens(value) {
  return Math.max(0, Math.ceil(String(value || '').length / 3.5));
}

function toolContextCharacterLimit(model = {}) {
  const contextWindow = positiveInteger(model.contextWindow, null, DEFAULT_CONTEXT_WINDOW);
  const sharedBudget = Math.floor(contextWindow * 0.35 * 3.5 / MAX_RAG_TOOL_CALLS);
  return Math.max(4000, Math.min(MAX_TOOL_CONTEXT_CHARACTERS, sharedBudget));
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

function normalizeResponseMessage(message = {}) {
  const content = splitInlineReasoning(normalizeContent(message.content));
  const explicit = splitInlineReasoning(normalizeContent(message.reasoning_content ?? message.reasoning ?? message.thinking));
  return {
    content: content.content,
    reasoning: [explicit.reasoning, explicit.content, content.reasoning].filter(Boolean).join('')
  };
}

function splitInlineReasoning(value) {
  const parser = new InlineReasoningStreamParser();
  const first = parser.push(value);
  const last = parser.finish();
  return {
    content: `${first.content}${last.content}`,
    reasoning: `${first.reasoning}${last.reasoning}`
  };
}

class InlineReasoningStreamParser {
  constructor() {
    this.mode = 'content';
    this.pending = '';
  }

  push(value) {
    this.pending += String(value || '');
    const output = { content: '', reasoning: '' };
    const open = /<\s*(?:think|thinking|analysis)\s*>/i;
    const close = /<\s*\/\s*(?:think|thinking|analysis)\s*>/i;
    while (this.pending) {
      const expression = this.mode === 'content' ? open : close;
      const match = expression.exec(this.pending);
      if (!match) {
        const hold = trailingTagPrefixLength(this.pending, this.mode === 'content' ? ['<think>', '<thinking>', '<analysis>'] : ['</think>', '</thinking>', '</analysis>']);
        const stable = hold ? this.pending.slice(0, -hold) : this.pending;
        if (this.mode === 'content') output.content += stable;
        else output.reasoning += stable;
        this.pending = hold ? this.pending.slice(-hold) : '';
        break;
      }
      const before = this.pending.slice(0, match.index);
      if (this.mode === 'content') output.content += before;
      else output.reasoning += before;
      this.pending = this.pending.slice(match.index + match[0].length);
      this.mode = this.mode === 'content' ? 'reasoning' : 'content';
    }
    return output;
  }

  finish() {
    const output = this.push('');
    if (this.pending) {
      if (this.mode === 'content') output.content += this.pending;
      else output.reasoning += this.pending;
      this.pending = '';
    }
    return output;
  }
}

function trailingTagPrefixLength(value, tags) {
  const lower = String(value || '').toLowerCase();
  let longest = 0;
  for (const tag of tags) {
    const candidate = String(tag).toLowerCase();
    for (let length = 1; length < candidate.length; length += 1) {
      if (lower.endsWith(candidate.slice(0, length))) longest = Math.max(longest, length);
    }
  }
  return longest;
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
  return ensureWorkspaceDir(directory);
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

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function resolvesToPrivateHost(hostname) {
  if (isPrivateNetworkHost(hostname)) return true;
  try {
    const addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    return addresses.some((item) => isPrivateNetworkHost(item.address));
  } catch {
    return false;
  }
}

function safeFilename(value) {
  return String(value || 'attachment').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
}

function uniqueFile(directory, name) {
  const extension = path.extname(name);
  const base = path.basename(name, extension);
  let candidate = assertSafeWindowsPath(path.join(directory, name), 'RAG 附件路径');
  let index = 2;
  while (fs.existsSync(candidate)) candidate = assertSafeWindowsPath(path.join(directory, `${base}-${index++}${extension}`), 'RAG 附件路径');
  return candidate;
}

async function extractText(file) {
  const extension = path.extname(file).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) return readUtf8Prefix(file, 120000);
  if (fs.statSync(file).size > MAX_EXTRACTABLE_DOCUMENT_BYTES) return '';
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

function estimateAttachmentTokens(attachments, model) {
  return (attachments || []).reduce((sum, attachment) => {
    if (attachment.extractedText) return sum + estimateTokens(attachment.extractedText.slice(0, 30000));
    if (model.supportsVision && String(attachment.mimeType || '').startsWith('image/') && Number(attachment.size || 0) <= 15 * 1024 * 1024) {
      return sum + estimateBase64PartTokens(attachment.size, 160);
    }
    if (model.supportsAudio && String(attachment.mimeType || '').startsWith('audio/') && Number(attachment.size || 0) <= 20 * 1024 * 1024) {
      return sum + estimateBase64PartTokens(attachment.size, 120);
    }
    return sum + estimateTokens(`${attachment.name || ''} ${attachment.path || ''}`);
  }, 0);
}

function estimateBase64PartTokens(size, overhead) {
  const bytes = Math.max(0, Number(size) || 0);
  const base64Length = Math.ceil(bytes / 3) * 4;
  return Math.max(1200, Math.ceil((base64Length + Math.max(0, Number(overhead) || 0)) / 3.5));
}

function estimateMessageTokens(message, model, store) {
  const attachments = (message?.attachments || []).map((item) => store?.get?.('ragAttachments', item.id) || item).filter(Boolean);
  return estimateTokens(message?.content || '') + estimateAttachmentTokens(attachments, model);
}

function splitTextByTokenBudget(value, budgetTokens) {
  const text = String(value || '');
  if (!text) return [''];
  if (estimateTokens(text) <= budgetTokens) return [text];
  const chunks = [];
  let current = '';
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || [text]) {
    if (estimateTokens(line) > budgetTokens) {
      if (current) { chunks.push(current); current = ''; }
      let remaining = line;
      while (remaining) {
        const size = prefixLengthForTokenBudget(remaining, budgetTokens);
        chunks.push(remaining.slice(0, size));
        remaining = remaining.slice(size);
      }
      continue;
    }
    if (current && estimateTokens(current + line) > budgetTokens) {
      chunks.push(current);
      current = line;
    } else {
      current += line;
    }
  }
  if (current) chunks.push(current);
  return chunks.filter(Boolean);
}

function prefixLengthForTokenBudget(text, budgetTokens) {
  let low = 1;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, middle)) <= budgetTokens) low = middle;
    else high = middle - 1;
  }
  return Math.max(1, low);
}

function knowledgeFavoriteMetadata(task, collection) {
  const status = favoriteStatus(task, collection || {});
  const statusAt = status.at ? ` | Status changed at: ${status.at}` : '';
  const collectionState = collection?.biliDeleted ? 'Deleted on Bilibili; completed local artifacts are retained.' : 'Available locally.';
  const multiPart = task.multiPartRole ? `\nMulti-part role: ${task.multiPartRole}; parentDocumentId: ${task.parentDocumentId || task.multiPartParentId || '-'}; partId/cid: ${task.multiPartId || task.cid || '-'}; page: ${task.page || '-'}` : '';
  const shared = String(task.sourceType || '').startsWith('shared-') ? `\nShared remote state: ${task.remoteState || 'active'}; sharedDocumentId: ${task.sharedDocumentId || '-'}; remoteUpdatedAt: ${task.remoteUpdatedAt || '-'}` : '';
  return `Favorite membership status: ${status.label} (${status.code})${statusAt}\nCollection remote status: ${collectionState}${multiPart}${shared}`;
}

function knowledgeEligible(task) {
  return task.knowledgeActive !== false
    && task.status === 'done'
    && Boolean(task.outputMarkdown)
    && fs.existsSync(task.outputMarkdown);
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

function readUtf8Prefix(file, maximumCharacters) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`Not a regular file: ${file}`);
  const maximumBytes = Math.max(4096, Number(maximumCharacters || 80000) * 4);
  const length = Math.min(stat.size, maximumBytes);
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(descriptor, buffer, 0, length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return text.length > maximumCharacters ? `${text.slice(0, maximumCharacters)}\n...[truncated]` : text;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readUtf8LineRange(file, startLine, lineCount, startColumn, maximumCharacters) {
  const descriptor = fs.openSync(file, 'r');
  const decoder = new StringDecoder('utf8');
  const chunkSize = 64 * 1024;
  const buffer = Buffer.alloc(chunkSize);
  let carry = '';
  let lineNumber = 1;
  let selectedLines = 0;
  let selected = '';
  let column = Math.max(0, Number(startColumn) || 0);
  let next = null;
  let stopped = false;
  let bytesRead = 0;

  const processLine = (line) => {
    if (stopped) return;
    if (lineNumber < startLine) {
      lineNumber += 1;
      return;
    }
    if (selectedLines >= lineCount) {
      next = { line: lineNumber, column: 0 };
      stopped = true;
      return;
    }
    const remaining = line.slice(column);
    const capacity = Math.max(0, maximumCharacters - selected.length);
    if (remaining.length > capacity) {
      selected += remaining.slice(0, capacity);
      next = { line: lineNumber, column: column + capacity };
      stopped = true;
      return;
    }
    selected += remaining;
    selectedLines += 1;
    lineNumber += 1;
    column = 0;
  };

  const processText = (text) => {
    if (!text || stopped) return;
    carry += text;
    const lines = carry.split('\n');
    carry = lines.pop() || '';
    for (const line of lines) {
      processLine(`${line}\n`);
      if (stopped) break;
    }
  };

  try {
    while (!stopped && (bytesRead = fs.readSync(descriptor, buffer, 0, chunkSize, null)) > 0) {
      processText(decoder.write(buffer.subarray(0, bytesRead)));
    }
    if (!stopped) {
      processText(decoder.end());
      if (!stopped && carry) processLine(carry);
      if (!stopped) {
        if (selectedLines >= lineCount) next = null;
        lineNumber = Math.max(lineNumber, startLine + selectedLines);
      }
    }
  } finally {
    fs.closeSync(descriptor);
  }

  const reachedEnd = !next && !stopped;
  return {
    selected,
    next,
    endLine: Math.max(startLine, next?.line || (startLine + Math.max(0, selectedLines - 1))),
    totalLinesKnown: reachedEnd,
    totalLines: reachedEnd ? Math.max(0, lineNumber - 1) : 0
  };
}

function killProcessTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    const taskkill = resolveSystemExecutable('taskkill.exe');
    if (taskkill) {
      const result = spawnSync(taskkill, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
      if (result.status === 0) return;
    }
  }
  try { child.kill('SIGTERM'); } catch {}
}

module.exports = {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_RAG_TOOL_ROUNDS,
  RAG_AUTO_COMPACT_TRIGGER,
  RagAssistant,
  normalizeModel,
  readUtf8LineRange,
  splitInlineReasoning,
  splitTextByTokenBudget,
  estimateAttachmentTokens
};
