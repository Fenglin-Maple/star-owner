(() => {
  const $ = (selector) => document.querySelector(selector);
  const elements = {
    page: $('#page-rag'), sessionList: $('#ragSessionList'), sessionSearch: $('#ragSessionSearch'), newSession: $('#ragNewSession'), openModelCenter: $('#ragOpenModelCenter'), usageSummary: $('#ragUsageSummary'),
    chatTitle: $('#ragChatTitle'), chatMeta: $('#ragChatMeta'), contextPercent: $('#ragContextPercent'), contextBar: $('#ragContextBar'), compact: $('#ragCompact'), deleteSession: $('#ragDeleteSession'), openSessionSettings: $('#ragOpenSessionSettings'),
    messages: $('#ragMessages'), runStatus: $('#ragRunStatus'), pendingAttachments: $('#ragPendingAttachments'), composer: $('#ragComposer'), input: $('#ragInput'), attach: $('#ragAttach'), send: $('#ragSend'), stop: $('#ragStop'),
    providerSelect: $('#ragProviderSelect'), modelSelect: $('#ragModelSelect'), composerProviderSelect: $('#ragComposerProviderSelect'), composerModelSelect: $('#ragComposerModelSelect'), capabilities: $('#ragModelCapabilities'), refreshState: $('#ragRefreshState'), openProviders: $('#ragOpenProviders'),
    knowledgeToggle: $('#ragKnowledgeToggle'), knowledgeMenu: $('#ragKnowledgeMenu'), knowledgeCount: $('#ragKnowledgeCount'), selectedKnowledge: $('#ragSelectedKnowledge'),
    headKnowledgeToggle: $('#ragHeadKnowledgeToggle'), headKnowledgeMenu: $('#ragHeadKnowledgeMenu'), headKnowledgeCount: $('#ragHeadKnowledgeCount'), headKnowledgeLabel: $('#ragHeadKnowledgeLabel'),
    sandboxPath: $('#ragSandboxPath'), chooseSandbox: $('#ragChooseSandbox'), createSandbox: $('#ragCreateSandbox'), permissionBadge: $('#ragPermissionBadge'),
    inputTokens: $('#ragInputTokens'), outputTokens: $('#ragOutputTokens'), totalTokens: $('#ragTotalTokens'), sessionRequests: $('#ragSessionRequests'),
    sessionSettingsModal: $('#ragSessionSettingsModal'), closeSessionSettings: $('#ragCloseSessionSettings'), sessionTitleInput: $('#ragSessionTitleInput'),
    sessionContextMenu: $('#ragSessionContextMenu'), contextEdit: $('#ragContextEdit'), contextDelete: $('#ragContextDelete'),
    providerModal: $('#ragProviderModal'), closeProviders: $('#ragCloseProviders'), providerList: $('#ragProviderList'), newProvider: $('#ragNewProvider'), providerId: $('#ragProviderId'), providerName: $('#ragProviderName'), providerType: $('#ragProviderType'), providerBaseUrl: $('#ragProviderBaseUrl'), providerApiKey: $('#ragProviderApiKey'), providerTemperature: $('#ragProviderTemperature'), providerMaxTokens: $('#ragProviderMaxTokens'), providerHeaders: $('#ragProviderHeaders'), saveProvider: $('#ragSaveProvider'), deleteProvider: $('#ragDeleteProvider'), fetchModels: $('#ragFetchModels'), remoteModels: $('#ragRemoteModels'), remoteModelCount: $('#ragRemoteModelCount'),
    approvalModal: $('#ragApprovalModal'), approvalAction: $('#ragApprovalAction'), approvalTarget: $('#ragApprovalTarget'), approvalDetail: $('#ragApprovalDetail'), denyApproval: $('#ragDenyApproval'), approveOnce: $('#ragApproveOnce'), approveFull: $('#ragApproveFull'),
    imageLightbox: $('#ragImageLightbox'), imageLightboxImage: $('#ragImageLightboxImage'), imageLightboxLabel: $('#ragImageLightboxLabel'), imageLightboxCopy: $('#ragImageLightboxCopy'), imageLightboxClose: $('#ragImageLightboxClose')
  };

  let state = { providers: [], sessions: [], activeSession: null, knowledgeCatalog: [], modelUsage: [] };
  let activeSessionId = localStorage.getItem('ragActiveSessionId') || '';
  let pendingAttachments = [];
  let streaming = null;
  let currentApproval = null;
  let editingProviderId = '';
  let remoteModelSaveTimer = null;
  let streamRenderTimer = null;
  let messageRenderQueue = Promise.resolve();
  let initialized = false;

  async function refresh(sessionId = activeSessionId, { quiet = false } = {}) {
    try {
      state = await window.orchestrator.ragState(sessionId || '');
      if (state.loading) {
        renderAll();
        setTimeout(() => refresh(activeSessionId, { quiet: true }), 500);
        return;
      }
      activeSessionId = state.activeSession?.id || state.sessions[0]?.id || '';
      if (activeSessionId) localStorage.setItem('ragActiveSessionId', activeSessionId);
      renderAll();
      initialized = true;
    } catch (error) {
      if (!quiet) notify('RAG 知识库助手尚未就绪', error.message || String(error), 'error');
      if (!initialized) setTimeout(() => refresh(activeSessionId, { quiet: true }), 1200);
    }
  }

  function renderAll() {
    renderSessions();
    renderInspector();
    queueMessageRender();
    renderUsageSummary();
    if (!elements.providerModal.hidden) renderProviderManager();
  }

  function renderSessions() {
    const query = String(elements.sessionSearch.value || '').trim().toLowerCase();
    const sessions = state.sessions.filter((session) => !query || `${session.title} ${session.modelId}`.toLowerCase().includes(query));
    elements.sessionList.innerHTML = '';
    for (const session of sessions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `rag-session-item${session.id === activeSessionId ? ' active' : ''}`;
      button.innerHTML = `<strong>${escapeHtml(session.title || '新对话')}</strong><span><em>${escapeHtml(session.modelId || '未选择模型')}</em><time>${relativeTime(session.updatedAt)}</time></span>`;
      button.addEventListener('click', () => selectSession(session.id));
      button.addEventListener('contextmenu', (event) => openSessionContextMenu(event, session.id));
      elements.sessionList.appendChild(button);
    }
    if (!sessions.length) elements.sessionList.innerHTML = '<div class="rag-list-empty">暂无会话</div>';
  }

  function renderUsageSummary() {
    const total = state.modelUsage.reduce((sum, item) => sum + Number(item.totalTokens || 0), 0);
    const requests = state.modelUsage.reduce((sum, item) => sum + Number(item.requests || 0), 0);
    elements.usageSummary.innerHTML = `<span>全部模型累计</span><strong>${formatNumber(total)} tokens</strong><span>${formatNumber(requests)} 次请求 / ${state.modelUsage.length} 个模型</span>`;
  }

  async function selectSession(id) {
    closeKnowledgeMenus();
    activeSessionId = id;
    pendingAttachments = [];
    localStorage.setItem('ragActiveSessionId', id);
    await refresh(id, { quiet: true });
  }

  function renderInspector() {
    const session = state.activeSession;
    const enabled = Boolean(session);
    elements.input.disabled = !enabled || streaming;
    elements.attach.disabled = !enabled || streaming;
    elements.send.disabled = !enabled || streaming || (!elements.input.value.trim() && !pendingAttachments.length);
    elements.deleteSession.disabled = !enabled || streaming;
    elements.openSessionSettings.disabled = !enabled || streaming;
    elements.chooseSandbox.disabled = !enabled || streaming;
    elements.createSandbox.disabled = !enabled || streaming;
    elements.compact.disabled = !enabled || streaming || !session?.modelCapabilities?.supportsCompression || (session?.messages?.length || 0) < 4;
    elements.chatTitle.textContent = session?.title || '选择或创建会话';
    elements.chatMeta.textContent = session ? `${providerName(session.providerId)} / ${session.modelId || '未选择模型'}` : '尚未配置模型';
    elements.sessionTitleInput.value = session?.title || '';
    elements.sessionTitleInput.disabled = !enabled || streaming;
    const percent = Number(session?.contextPercent || 0);
    elements.contextPercent.textContent = `${percent}%`;
    elements.contextBar.style.width = `${Math.min(100, percent)}%`;
    elements.contextBar.className = percent >= 90 ? 'danger' : (percent >= 72 ? 'warning' : '');

    renderProviderAndModelSelects(session);
    renderCapabilities(session?.modelCapabilities);
    renderKnowledge(session);
    elements.sandboxPath.textContent = session?.sandboxDir || '尚未创建会话';
    elements.permissionBadge.textContent = session?.permissionMode === 'full' ? '完全访问' : '有限权限';
    elements.permissionBadge.style.color = session?.permissionMode === 'full' ? 'var(--red)' : '';
    for (const button of document.querySelectorAll('[data-rag-permission]')) button.classList.toggle('active', button.dataset.ragPermission === (session?.permissionMode || 'restricted'));

    const usage = session?.tokenUsage || {};
    elements.inputTokens.textContent = formatNumber(usage.input || 0);
    elements.outputTokens.textContent = formatNumber(usage.output || 0);
    elements.totalTokens.textContent = formatNumber(usage.total || 0);
    const stats = state.modelUsage.find((item) => item.providerId === session?.providerId && item.modelId === session?.modelId);
    elements.sessionRequests.textContent = `${formatNumber(stats?.requests || 0)} 次请求`;
    renderPendingAttachments();
  }

  function renderProviderAndModelSelects(session) {
    const provider = state.providers.find((item) => item.id === session?.providerId);
    const providerOptions = '<option value="">选择供应商</option>' + state.providers.map((item) => `<option value="${escapeAttr(item.id)}">${escapeHtml(item.name)}</option>`).join('');
    const modelOptions = '<option value="">选择模型</option>' + (provider?.enabledModels || []).map((model) => `<option value="${escapeAttr(model.id)}">${escapeHtml(model.name || model.id)}</option>`).join('');
    for (const select of [elements.providerSelect, elements.composerProviderSelect]) {
      select.innerHTML = providerOptions;
      select.value = session?.providerId || '';
      select.disabled = !session || streaming;
    }
    for (const select of [elements.modelSelect, elements.composerModelSelect]) {
      select.innerHTML = modelOptions;
      select.value = session?.modelId || '';
      select.disabled = !session || streaming || !provider?.enabledModels?.length;
    }
  }

  function openSessionSettingsModal() {
    if (!state.activeSession || streaming) return;
    hideSessionContextMenu();
    elements.sessionSettingsModal.hidden = false;
    requestAnimationFrame(() => elements.sessionTitleInput.focus());
  }

  function closeSessionSettingsModal() {
    elements.sessionSettingsModal.hidden = true;
    closeKnowledgeMenus();
  }

  async function openSessionContextMenu(event, sessionId) {
    event.preventDefault();
    const x = event.clientX;
    const y = event.clientY;
    if (sessionId !== activeSessionId) await selectSession(sessionId);
    elements.contextDelete.dataset.confirm = '';
    elements.contextDelete.querySelector('span').textContent = '删除会话';
    elements.sessionContextMenu.hidden = false;
    const width = elements.sessionContextMenu.offsetWidth;
    const height = elements.sessionContextMenu.offsetHeight;
    elements.sessionContextMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
    elements.sessionContextMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
  }

  function hideSessionContextMenu() {
    elements.sessionContextMenu.hidden = true;
    elements.contextDelete.dataset.confirm = '';
    elements.contextDelete.querySelector('span').textContent = '删除会话';
  }

  async function deleteActiveSession() {
    if (!activeSessionId || streaming) return;
    await window.orchestrator.ragDeleteSession(activeSessionId);
    activeSessionId = '';
    localStorage.removeItem('ragActiveSessionId');
    closeSessionSettingsModal();
    hideSessionContextMenu();
    await refresh('', { quiet: true });
  }

  function renderCapabilities(model) {
    if (!model?.id) {
      elements.capabilities.innerHTML = '<span>尚未选择模型</span>';
      return;
    }
    const capabilities = [
      ['工具', model.supportsTools], ['推理', model.supportsReasoning], ['视觉', model.supportsVision], ['音频', model.supportsAudio], ['图片返回', model.supportsImages], ['压缩', model.supportsCompression], ['子 Agent', model.supportsSubagents]
    ];
    elements.capabilities.innerHTML = capabilities.map(([name, on]) => `<span class="${on ? 'on' : ''}">${name}</span>`).join('');
  }

  function renderKnowledge(session) {
    const selected = new Set(session?.knowledgeCollectionIds || []);
    renderKnowledgeMenu(elements.knowledgeMenu, selected, session);
    renderKnowledgeMenu(elements.headKnowledgeMenu, selected, session);
    const selectedItems = state.knowledgeCatalog.filter((item) => selected.has(item.id));
    elements.knowledgeCount.textContent = `${selectedItems.length} 个`;
    elements.headKnowledgeCount.textContent = String(selectedItems.length);
    elements.headKnowledgeLabel.textContent = selectedItems.length
      ? (selectedItems.length === 1 ? selectedItems[0].name : `已选 ${selectedItems.length} 个知识库`)
      : '选择知识库';
    elements.headKnowledgeToggle.title = selectedItems.length
      ? selectedItems.map((item) => `${item.userName} / ${item.name}`).join('\n')
      : '选择当前会话使用的知识库';
    elements.headKnowledgeToggle.disabled = !session || Boolean(streaming);
    elements.knowledgeToggle.disabled = !session || Boolean(streaming);
    elements.selectedKnowledge.innerHTML = selectedItems.map((item) => `<div class="rag-knowledge-chip"><span title="${escapeAttr(`${item.userName} / ${item.name}`)}">${escapeHtml(item.name)}</span><button type="button" data-remove-knowledge="${escapeAttr(item.id)}" aria-label="移除" ${streaming ? 'disabled' : ''}>×</button></div>`).join('');
    for (const button of elements.selectedKnowledge.querySelectorAll('[data-remove-knowledge]')) button.addEventListener('click', () => removeKnowledge(button.dataset.removeKnowledge));
  }

  function renderKnowledgeMenu(menu, selected, session) {
    const groups = groupBy(state.knowledgeCatalog, (item) => item.userName);
    menu.innerHTML = '';
    if (state.knowledgeCatalog.length) {
      const search = document.createElement('label');
      search.className = 'rag-knowledge-search';
      search.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M16 16l5 5"/></svg><input type="search" placeholder="搜索用户或收藏夹" aria-label="搜索知识库" />';
      search.querySelector('input').addEventListener('input', (event) => filterKnowledgeMenu(menu, event.target.value));
      menu.appendChild(search);
    }
    for (const [user, collections] of groups) {
      const heading = document.createElement('div');
      heading.className = 'rag-knowledge-user';
      heading.textContent = user;
      heading.dataset.knowledgeUser = user;
      menu.appendChild(heading);
      for (const collection of collections) {
        const label = document.createElement('label');
        label.className = 'rag-knowledge-option';
        label.dataset.knowledgeUser = user;
        label.dataset.knowledgeSearch = `${user} ${collection.name}`.toLocaleLowerCase();
        label.innerHTML = `<input type="checkbox" value="${escapeAttr(collection.id)}" ${selected.has(collection.id) ? 'checked' : ''} ${!session || streaming ? 'disabled' : ''}><span>${escapeHtml(collection.name)}</span><small>${collection.documentCount} 篇</small>`;
        label.querySelector('input').addEventListener('change', () => updateKnowledgeSelection(menu));
        menu.appendChild(label);
      }
    }
    if (!state.knowledgeCatalog.length) menu.innerHTML = '<div class="rag-list-empty">暂无已完成 Markdown</div>';
  }

  function filterKnowledgeMenu(menu, value) {
    const query = String(value || '').trim().toLocaleLowerCase();
    for (const option of menu.querySelectorAll('.rag-knowledge-option')) option.hidden = Boolean(query) && !option.dataset.knowledgeSearch.includes(query);
    for (const heading of menu.querySelectorAll('.rag-knowledge-user')) {
      heading.hidden = ![...menu.querySelectorAll('.rag-knowledge-option')].some((option) => option.dataset.knowledgeUser === heading.dataset.knowledgeUser && !option.hidden);
    }
  }

  async function updateKnowledgeSelection(sourceMenu) {
    if (!activeSessionId) return;
    const ids = [...sourceMenu.querySelectorAll('input:checked')].map((input) => input.value);
    await updateSession({ knowledgeCollectionIds: ids });
  }

  function toggleKnowledgeMenu(menu, toggle) {
    const open = !menu.classList.contains('open');
    closeKnowledgeMenus();
    if (!open || toggle.disabled) return;
    menu.classList.add('open');
    toggle.setAttribute('aria-expanded', 'true');
  }

  function closeKnowledgeMenus() {
    for (const [menu, toggle] of [[elements.knowledgeMenu, elements.knowledgeToggle], [elements.headKnowledgeMenu, elements.headKnowledgeToggle]]) {
      menu.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  }

  async function removeKnowledge(id) {
    const ids = (state.activeSession?.knowledgeCollectionIds || []).filter((item) => item !== id);
    await updateSession({ knowledgeCollectionIds: ids });
  }

  async function updateSession(patch, { quiet = true } = {}) {
    if (!activeSessionId) return;
    try {
      await window.orchestrator.ragUpdateSession({ sessionId: activeSessionId, patch });
      await refresh(activeSessionId, { quiet: true });
    } catch (error) {
      if (!quiet) notify('会话设置保存失败', error.message || String(error), 'error');
      else notify('设置未保存', error.message || String(error), 'error');
    }
  }

  async function renderMessages() {
    const session = state.activeSession;
    const sessionId = session?.id || '';
    if (!session?.messages?.length && !streaming) {
      elements.messages.innerHTML = '<div class="rag-empty-state"><svg viewBox="0 0 24 24"><path d="M4 5h16v12H8l-4 4zM8 9h8M8 13h5"/></svg><strong>让知识库真正参与对话</strong><span>配置供应商、选择模型和收藏夹知识库后，可进行跨文档查阅、整理与分析。</span></div>';
      return;
    }
    const messages = [...(session?.messages || [])];
    if (streaming && !streaming.pending && streaming.sessionId === session?.id && !messages.some((item) => item.id === streaming.id)) messages.push(streaming);
    const fragment = document.createDocumentFragment();
    for (const message of messages) fragment.appendChild(await createMessageElement(message));
    if ((state.activeSession?.id || '') !== sessionId) return;
    elements.messages.replaceChildren(fragment);
    elements.messages.scrollTop = elements.messages.scrollHeight;
  }

  function queueMessageRender() {
    messageRenderQueue = messageRenderQueue
      .catch(() => {})
      .then(() => renderMessages())
      .catch((error) => console.error('RAG message render failed:', error));
    return messageRenderQueue;
  }

  async function createMessageElement(message) {
    const article = document.createElement('article');
    article.className = `rag-message ${message.role || 'assistant'} ${message.status || ''}`;
    article.dataset.messageId = message.id;
    const role = message.role === 'user' ? '你' : '助手';
    article.innerHTML = `<div class="rag-message-avatar">${message.role === 'user' ? 'U' : 'AI'}</div><div class="rag-message-body"><div class="rag-message-head"><strong>${role}</strong><span>${formatTime(message.createdAt)}</span></div><div class="rag-message-extras"></div><div class="rag-message-content"></div></div>`;
    await fillMessage(article, message);
    return article;
  }

  async function fillMessage(article, message) {
    const extras = article.querySelector('.rag-message-extras');
    const extrasSignature = JSON.stringify({ reasoning: message.reasoning || '', tools: message.toolEvents || [], attachments: message.attachments || [] });
    if (article.ragExtrasSignature !== extrasSignature) {
      article.ragExtrasSignature = extrasSignature;
      extras.innerHTML = '';
      if (message.reasoning) {
        const details = document.createElement('details');
        details.className = 'rag-reasoning';
        details.innerHTML = `<summary>模型推理流</summary><pre>${escapeHtml(message.reasoning)}</pre>`;
        extras.appendChild(details);
      }
      if (message.toolEvents?.length) extras.appendChild(await toolList(message.toolEvents, message.sessionId));
      if (message.attachments?.length) {
        const attachments = document.createElement('div');
        attachments.className = 'rag-message-attachments';
        attachments.innerHTML = message.attachments.map((item) => isImageAttachment(item)
          ? `<figure class="rag-message-image"><img src="${escapeAttr(item.previewUrl)}" alt="${escapeAttr(item.name)}" loading="lazy" /><figcaption>${escapeHtml(item.name)}</figcaption></figure>`
          : `<span class="rag-attachment-chip"><span>${escapeHtml(item.name)}</span></span>`).join('');
        extras.appendChild(attachments);
      }
    }
    const content = article.querySelector('.rag-message-content');
    if (message.error) content.textContent = message.error;
    else content.innerHTML = await window.orchestrator.ragRenderMarkdown(message.content || '', message.sessionId);
    enhanceCodeBlocks(content);
    if (message.status === 'streaming') content.insertAdjacentHTML('beforeend', '<span class="rag-stream-caret"></span>');
  }

  function enhanceCodeBlocks(content) {
    for (const code of content.querySelectorAll('pre > code')) {
      const pre = code.parentElement;
      if (pre.parentElement?.classList.contains('rag-code-block')) continue;
      const languageClass = [...code.classList].find((name) => name.startsWith('language-')) || '';
      const language = languageClass.slice('language-'.length) || '代码';
      const wrapper = document.createElement('div');
      wrapper.className = 'rag-code-block';
      pre.replaceWith(wrapper);
      wrapper.innerHTML = `<div class="rag-code-toolbar"><span>${escapeHtml(language)}</span><button type="button" data-rag-copy-code title="复制代码" aria-label="复制代码"><svg viewBox="0 0 24 24"><path d="M9 9h10v10H9zM5 15H4V4h11v1"/></svg><span>复制</span></button></div>`;
      wrapper.appendChild(pre);
    }
  }

  function conversationImage(target) {
    const image = target.closest?.('.rag-message-content img, .rag-message-image img, .rag-tool-images img');
    return image && elements.messages.contains(image) ? image : null;
  }

  function openImageLightbox(image) {
    const source = image.currentSrc || image.src;
    if (!source) return;
    elements.imageLightboxImage.src = source;
    elements.imageLightboxImage.alt = image.alt || '对话图片';
    elements.imageLightboxLabel.textContent = image.alt || '图片预览';
    elements.imageLightbox.dataset.source = source;
    elements.imageLightbox.hidden = false;
    elements.imageLightboxClose.focus();
  }

  function closeImageLightbox() {
    elements.imageLightbox.hidden = true;
    elements.imageLightboxImage.removeAttribute('src');
    delete elements.imageLightbox.dataset.source;
  }

  async function copyConversationImage(source) {
    if (!source) return;
    try {
      await window.orchestrator.copyImage(source);
      notify('图片已复制', '已将原图写入系统剪贴板。', 'success');
    } catch (error) {
      notify('图片复制失败', error.message || String(error), 'error');
    }
  }

  async function toolList(tools, sessionId) {
    const list = document.createElement('div');
    list.className = 'rag-tool-list';
    for (const item of tools) {
      const event = document.createElement('div');
      event.className = `rag-tool-event ${item.status || 'running'}`;
      event.innerHTML = `<div class="rag-tool-event-head"><i></i><span>${escapeHtml(toolLabel(item.name))}</span><time>${escapeHtml(toolStatus(item.status))}</time></div>`;
      if (item.images?.length) {
        const gallery = document.createElement('div');
        gallery.className = 'rag-tool-images';
        for (const image of item.images) {
          const figure = document.createElement('figure');
          figure.innerHTML = `${await window.orchestrator.ragRenderMarkdown(`![${image.alt || image.name || '知识库原图'}](${image.uri})`, sessionId)}<figcaption>${escapeHtml(image.alt || image.name || `图片 ${image.index}`)}</figcaption>`;
          gallery.appendChild(figure);
        }
        event.appendChild(gallery);
      }
      list.appendChild(event);
    }
    return list;
  }

  function scheduleStreamRender() {
    if (streamRenderTimer) return;
    streamRenderTimer = setTimeout(async () => {
      streamRenderTimer = null;
      await messageRenderQueue;
      if (!streaming) return;
      let article = elements.messages.querySelector(`[data-message-id="${cssEscape(streaming.id)}"]`);
      if (!article) {
        elements.messages.querySelector('.rag-empty-state')?.remove();
        article = await createMessageElement(streaming);
        elements.messages.appendChild(article);
      } else {
        await fillMessage(article, streaming);
      }
      elements.messages.scrollTop = elements.messages.scrollHeight;
    }, 45);
  }

  function renderPendingAttachments() {
    elements.pendingAttachments.innerHTML = pendingAttachments.map((item) => isImageAttachment(item)
      ? `<div class="rag-pending-image"><img src="${escapeAttr(item.previewUrl)}" alt="" /><div><span title="${escapeAttr(item.name)}">${escapeHtml(item.name)}</span><small>${formatBytes(item.size)}</small></div><button type="button" data-remove-attachment="${escapeAttr(item.id)}" aria-label="移除图片">×</button></div>`
      : `<div class="rag-attachment-chip"><span title="${escapeAttr(item.path || item.name)}">${escapeHtml(item.name)}</span><button type="button" data-remove-attachment="${escapeAttr(item.id)}" aria-label="移除">×</button></div>`).join('');
    for (const button of elements.pendingAttachments.querySelectorAll('[data-remove-attachment]')) button.addEventListener('click', async () => {
      const attachmentId = button.dataset.removeAttachment;
      button.disabled = true;
      try {
        await window.orchestrator.ragDiscardAttachment(activeSessionId, attachmentId);
        pendingAttachments = pendingAttachments.filter((item) => item.id !== attachmentId);
        renderInspector();
      } catch (error) {
        button.disabled = false;
        notify('附件移除失败', error.message || String(error), 'error');
      }
    });
  }

  async function createSession() {
    const provider = state.providers.find((item) => item.enabledModels?.length) || state.providers[0];
    if (!provider) {
      openAiModelCenter();
      notify('先配置模型供应商', '已为你打开 AI 模型配置，保存供应商并启用至少一个模型。', 'info');
      return;
    }
    const session = await window.orchestrator.ragCreateSession({ providerId: provider.id, modelId: provider.enabledModels?.[0]?.id || '' });
    activeSessionId = session.id;
    pendingAttachments = [];
    await refresh(session.id, { quiet: true });
    elements.input.focus();
  }

  function openAiModelCenter() {
    closeSessionSettingsModal();
    closeProviderModal();
    window.dispatchEvent(new CustomEvent('star:navigate', { detail: { page: 'ai-models' } }));
  }

  async function sendMessage(event) {
    event?.preventDefault();
    if (!activeSessionId || streaming) return;
    const content = elements.input.value.trim();
    if (!content && !pendingAttachments.length) return;
    const attachmentIds = pendingAttachments.map((item) => item.id);
    elements.input.value = '';
    autoGrowInput();
    pendingAttachments = [];
    streaming = { id: `pending-${Date.now()}`, sessionId: activeSessionId, role: 'assistant', content: '', reasoning: '', toolEvents: [], status: 'streaming', pending: true, createdAt: new Date().toISOString() };
    setGenerating(true, '正在连接模型');
    renderPendingAttachments();
    try {
      await window.orchestrator.ragSend({ sessionId: activeSessionId, content, attachmentIds });
    } catch (error) {
      notify('生成失败', error.message || String(error), 'error');
      streaming = null;
      setGenerating(false);
      await refresh(activeSessionId, { quiet: true });
    }
  }

  function setGenerating(active, status = '') {
    elements.stop.hidden = !active;
    elements.send.hidden = active;
    elements.input.disabled = active || !state.activeSession;
    elements.attach.disabled = active || !state.activeSession;
    elements.runStatus.classList.toggle('active', active);
    elements.runStatus.innerHTML = active ? `<span class="rag-thinking-dots"><i></i><i></i><i></i></span><span>${escapeHtml(status || '模型正在思考')}</span>` : '';
    elements.deleteSession.disabled = active || !state.activeSession;
    elements.openSessionSettings.disabled = active || !state.activeSession;
    elements.sessionTitleInput.disabled = active || !state.activeSession;
    elements.providerSelect.disabled = active || !state.activeSession;
    elements.modelSelect.disabled = active || !state.activeSession;
    elements.composerProviderSelect.disabled = active || !state.activeSession;
    elements.composerModelSelect.disabled = active || !state.activeSession;
    elements.headKnowledgeToggle.disabled = active || !state.activeSession;
    elements.knowledgeToggle.disabled = active || !state.activeSession;
    for (const input of document.querySelectorAll('.rag-knowledge-menu input')) input.disabled = active || !state.activeSession;
    if (active) closeKnowledgeMenus();
    elements.compact.disabled = active || !state.activeSession || !state.activeSession?.modelCapabilities?.supportsCompression || (state.activeSession?.messages?.length || 0) < 4;
  }

  function openProviderModal() {
    elements.providerModal.hidden = false;
    editingProviderId = editingProviderId || state.providers[0]?.id || '';
    renderProviderManager();
  }

  function closeProviderModal() { elements.providerModal.hidden = true; }

  function renderProviderManager() {
    elements.providerList.innerHTML = state.providers.map((provider) => `<button type="button" class="rag-provider-item ${provider.id === editingProviderId ? 'active' : ''}" data-provider-id="${escapeAttr(provider.id)}"><strong>${escapeHtml(provider.name)}</strong><span>${escapeHtml(provider.type)} / ${escapeHtml(provider.baseUrl)}</span></button>`).join('');
    if (!state.providers.length) elements.providerList.innerHTML = '<div class="rag-list-empty">暂无供应商</div>';
    for (const button of elements.providerList.querySelectorAll('[data-provider-id]')) button.addEventListener('click', () => {
      editingProviderId = button.dataset.providerId;
      renderProviderManager();
    });
    const provider = state.providers.find((item) => item.id === editingProviderId);
    elements.providerId.value = provider?.id || '';
    elements.providerName.value = provider?.name || '';
    elements.providerType.value = provider?.type || 'openai';
    elements.providerBaseUrl.value = provider?.baseUrl || '';
    elements.providerApiKey.value = '';
    elements.providerApiKey.placeholder = provider?.hasApiKey ? '已安全保存，留空则保持不变' : '输入 API Key；本地免密接口可留空';
    elements.providerTemperature.value = provider?.temperature ?? 0.2;
    elements.providerMaxTokens.value = provider?.maxOutputTokens || 128000;
    elements.providerHeaders.value = Object.keys(provider?.extraHeaders || {}).length ? JSON.stringify(provider.extraHeaders, null, 2) : '';
    elements.deleteProvider.disabled = !provider;
    renderRemoteModels(provider);
  }

  function renderRemoteModels(provider) {
    const source = mergeModels(provider?.remoteModels || [], provider?.enabledModels || []);
    const enabled = new Map((provider?.enabledModels || []).map((item) => [item.id, item]));
    elements.remoteModelCount.textContent = `${source.length} 个`;
    elements.remoteModels.innerHTML = '';
    for (const model of source) {
      const selected = enabled.get(model.id);
      const value = { ...model, ...selected };
      const row = document.createElement('div');
      row.className = 'rag-remote-model';
      row.dataset.modelId = model.id;
      row.innerHTML = `<input class="rag-model-enabled" type="checkbox" ${selected ? 'checked' : ''} aria-label="启用 ${escapeAttr(model.id)}"><strong title="${escapeAttr(model.id)}">${escapeHtml(model.name || model.id)}</strong><label class="rag-model-limit"><span>上下文</span><input class="rag-model-context" type="number" min="1024" max="4000000" step="1024" value="${Number(value.contextWindow || 1000000)}"></label><label class="rag-model-limit"><span>输出</span><input class="rag-model-output" type="number" min="256" max="1000000" step="1024" value="${Number(value.maxOutputTokens || 128000)}"></label><button type="button" class="rag-model-cap-toggle ${value.supportsTools ? 'active' : ''}" data-cap="supportsTools" title="工具调用">T</button><button type="button" class="rag-model-cap-toggle ${value.supportsReasoning ? 'active' : ''}" data-cap="supportsReasoning" title="推理流">R</button><button type="button" class="rag-model-cap-toggle ${value.supportsVision ? 'active' : ''}" data-cap="supportsVision" title="视觉">V</button><button type="button" class="rag-model-cap-toggle ${value.supportsAudio ? 'active' : ''}" data-cap="supportsAudio" title="音频">A</button><button type="button" class="rag-model-cap-toggle ${value.supportsImages ? 'active' : ''}" data-cap="supportsImages" title="图片返回">I</button><button type="button" class="rag-model-cap-toggle ${value.supportsCompression ? 'active' : ''}" data-cap="supportsCompression" title="上下文压缩">C</button><button type="button" class="rag-model-cap-toggle ${value.supportsSubagents ? 'active' : ''}" data-cap="supportsSubagents" title="子 Agent">S</button>`;
      row.querySelector('.rag-model-enabled').addEventListener('change', scheduleModelSave);
      row.querySelector('.rag-model-context').addEventListener('change', scheduleModelSave);
      row.querySelector('.rag-model-output').addEventListener('change', scheduleModelSave);
      for (const toggle of row.querySelectorAll('.rag-model-cap-toggle')) toggle.addEventListener('click', () => { toggle.classList.toggle('active'); scheduleModelSave(); });
      elements.remoteModels.appendChild(row);
    }
    if (!source.length) elements.remoteModels.innerHTML = '<div class="rag-list-empty">保存配置后点击“拉取远程模型”</div>';
  }

  async function saveProviderForm() {
    const provider = await window.orchestrator.ragSaveProvider({
      id: elements.providerId.value || undefined,
      name: elements.providerName.value.trim(),
      type: elements.providerType.value,
      baseUrl: elements.providerBaseUrl.value.trim(),
      apiKey: elements.providerApiKey.value,
      temperature: Number(elements.providerTemperature.value),
      maxOutputTokens: Number(elements.providerMaxTokens.value),
      extraHeaders: elements.providerHeaders.value.trim()
    });
    editingProviderId = provider.id;
    await refresh(activeSessionId, { quiet: true });
    renderProviderManager();
    return provider;
  }

  function scheduleModelSave() {
    if (remoteModelSaveTimer) clearTimeout(remoteModelSaveTimer);
    remoteModelSaveTimer = setTimeout(saveEnabledModels, 240);
  }

  async function saveEnabledModels() {
    const providerId = editingProviderId;
    if (!providerId) return;
    const provider = state.providers.find((item) => item.id === providerId);
    const remote = new Map((provider?.remoteModels || []).map((item) => [item.id, item]));
    const models = [...elements.remoteModels.querySelectorAll('.rag-remote-model')].filter((row) => row.querySelector('.rag-model-enabled').checked).map((row) => {
      const base = remote.get(row.dataset.modelId) || { id: row.dataset.modelId, name: row.dataset.modelId };
      const caps = {};
      for (const toggle of row.querySelectorAll('[data-cap]')) caps[toggle.dataset.cap] = toggle.classList.contains('active');
      return { ...base, ...caps, contextWindow: Number(row.querySelector('.rag-model-context').value) || 1000000, maxOutputTokens: Number(row.querySelector('.rag-model-output').value) || 128000 };
    });
    await window.orchestrator.ragUpdateModels({ providerId, models });
    await refresh(activeSessionId, { quiet: true });
    editingProviderId = providerId;
    renderProviderManager();
  }

  async function fetchRemoteModels() {
    try {
      const provider = await saveProviderForm();
      elements.fetchModels.disabled = true;
      elements.fetchModels.textContent = '正在拉取...';
      await window.orchestrator.ragFetchModels(provider.id);
      await refresh(activeSessionId, { quiet: true });
      editingProviderId = provider.id;
      renderProviderManager();
      notify('模型列表已更新', '请选择需要在会话中使用的模型。', 'success');
    } catch (error) {
      notify('模型拉取失败', error.message || String(error), 'error');
    } finally {
      elements.fetchModels.disabled = false;
      elements.fetchModels.textContent = '拉取远程模型';
    }
  }

  function newProviderForm() {
    editingProviderId = '';
    elements.providerId.value = '';
    renderProviderManager();
    elements.providerName.focus();
  }

  async function deleteProvider() {
    if (!editingProviderId) return;
    if (elements.deleteProvider.dataset.confirm !== '1') {
      elements.deleteProvider.dataset.confirm = '1';
      elements.deleteProvider.textContent = '再点一次确认';
      setTimeout(() => { elements.deleteProvider.dataset.confirm = ''; elements.deleteProvider.textContent = '删除'; }, 2600);
      return;
    }
    try {
      await window.orchestrator.ragDeleteProvider(editingProviderId);
      editingProviderId = '';
      await refresh(activeSessionId, { quiet: true });
      renderProviderManager();
    } catch (error) { notify('无法删除供应商', error.message || String(error), 'error'); }
  }

  function showApproval(approval) {
    currentApproval = approval;
    elements.approvalAction.textContent = approval.action || '受限操作';
    elements.approvalTarget.textContent = approval.target || '-';
    elements.approvalDetail.textContent = approval.detail || '';
    elements.approvalModal.hidden = false;
  }

  async function resolveApproval(approved, fullAccess = false) {
    if (!currentApproval) return;
    const id = currentApproval.id;
    currentApproval = null;
    elements.approvalModal.hidden = true;
    await window.orchestrator.ragResolveApproval({ id, approved, fullAccess });
  }

  function handleEvent(event) {
    if (!event) return;
    if (event.type === 'approval-request') return showApproval(event.approval);
    if (event.sessionId && event.sessionId !== activeSessionId) {
      if (event.type === 'assistant-complete' || event.type === 'assistant-error') refresh(activeSessionId, { quiet: true });
      return;
    }
    if (event.type === 'message') {
      if (state.activeSession && !state.activeSession.messages.some((item) => item.id === event.message.id)) state.activeSession.messages.push(event.message);
      queueMessageRender();
    } else if (event.type === 'assistant-start') {
      const previousId = streaming?.id;
      if (previousId && previousId !== event.messageId) elements.messages.querySelector(`[data-message-id="${cssEscape(previousId)}"]`)?.remove();
      streaming = { id: event.messageId, sessionId: event.sessionId, role: 'assistant', content: '', reasoning: '', toolEvents: [], status: 'streaming', pending: false, createdAt: new Date().toISOString() };
      setGenerating(true, '模型正在思考');
      scheduleStreamRender();
    } else if (event.type === 'assistant-delta' && streaming) {
      if (event.content) streaming.content += event.content;
      if (event.reasoning) streaming.reasoning += event.reasoning;
      setGenerating(true, event.reasoning && !streaming.content ? '正在接收模型推理' : '正在流式输出');
      scheduleStreamRender();
    } else if (event.type === 'tool' && streaming) {
      const index = streaming.toolEvents.findIndex((item) => item.id === event.tool.id);
      if (index >= 0) streaming.toolEvents[index] = event.tool;
      else streaming.toolEvents.push(event.tool);
      setGenerating(true, `正在调用 ${toolLabel(event.tool.name)}`);
      scheduleStreamRender();
    } else if (event.type === 'assistant-complete') {
      streaming = null;
      setGenerating(false);
      refresh(activeSessionId, { quiet: true });
    } else if (event.type === 'assistant-error') {
      streaming = null;
      setGenerating(false);
      notify('模型调用结束', event.error || '生成失败', event.message?.status === 'cancelled' ? 'info' : 'error');
      refresh(activeSessionId, { quiet: true });
    } else if (event.type === 'session-updated') {
      refresh(activeSessionId, { quiet: true });
    }
  }

  function autoGrowInput() {
    elements.input.style.height = 'auto';
    elements.input.style.height = `${Math.min(130, Math.max(34, elements.input.scrollHeight))}px`;
    elements.send.disabled = !state.activeSession || streaming || (!elements.input.value.trim() && !pendingAttachments.length);
  }

  function notify(title, message, type = 'info') {
    const viewport = $('#toastViewport');
    if (!viewport) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<div><strong>${escapeHtml(title)}</strong>${message ? `<span>${escapeHtml(message)}</span>` : ''}</div>`;
    viewport.appendChild(toast);
    setTimeout(() => { toast.classList.add('leaving'); setTimeout(() => toast.remove(), 220); }, type === 'error' ? 5200 : 3200);
  }

  elements.newSession.addEventListener('click', () => createSession().catch((error) => notify('新建会话失败', error.message, 'error')));
  elements.sessionSearch.addEventListener('input', renderSessions);
  elements.composer.addEventListener('submit', sendMessage);
  elements.input.addEventListener('input', autoGrowInput);
  elements.input.addEventListener('paste', async (event) => {
    const hasImage = [...(event.clipboardData?.items || [])].some((item) => String(item.type || '').startsWith('image/'))
      || [...(event.clipboardData?.files || [])].some((file) => String(file.type || '').startsWith('image/'));
    if (!hasImage) return;
    event.preventDefault();
    if (!activeSessionId || streaming) return;
    try {
      const result = await window.orchestrator.ragImportClipboardImage(activeSessionId);
      if (result.attachment) pendingAttachments.push(result.attachment);
      renderInspector();
      notify('剪贴板图片已加入', '发送前可以预览或移除这张图片。', 'success');
    } catch (error) { notify('无法粘贴图片', error.message || String(error), 'error'); }
  });
  elements.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage(); }
  });
  elements.stop.addEventListener('click', () => window.orchestrator.ragStop(activeSessionId));
  elements.attach.addEventListener('click', async () => {
    try {
      const result = await window.orchestrator.ragImportAttachments(activeSessionId);
      if (!result.canceled) pendingAttachments.push(...result.attachments);
      renderInspector();
    } catch (error) { notify('附件导入失败', error.message || String(error), 'error'); }
  });
  async function changeSessionProvider(providerId) {
    const provider = state.providers.find((item) => item.id === providerId);
    if (!provider) return refresh(activeSessionId, { quiet: true });
    await updateSession({ providerId: provider?.id || '', modelId: provider?.enabledModels?.[0]?.id || '' });
  }
  elements.providerSelect.addEventListener('change', () => changeSessionProvider(elements.providerSelect.value));
  elements.composerProviderSelect.addEventListener('change', () => changeSessionProvider(elements.composerProviderSelect.value));
  elements.modelSelect.addEventListener('change', () => updateSession({ modelId: elements.modelSelect.value }));
  elements.composerModelSelect.addEventListener('change', () => updateSession({ modelId: elements.composerModelSelect.value }));
  const saveSessionTitle = async () => {
    const title = elements.sessionTitleInput.value.trim() || '新对话';
    if (title !== state.activeSession?.title) await updateSession({ title }, { quiet: false });
  };
  elements.sessionTitleInput.addEventListener('change', saveSessionTitle);
  elements.sessionTitleInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); elements.sessionTitleInput.blur(); }
  });
  elements.openSessionSettings.addEventListener('click', openSessionSettingsModal);
  elements.closeSessionSettings.addEventListener('click', closeSessionSettingsModal);
  elements.sessionSettingsModal.addEventListener('click', (event) => { if (event.target === elements.sessionSettingsModal) closeSessionSettingsModal(); });
  elements.contextEdit.addEventListener('click', () => { hideSessionContextMenu(); openSessionSettingsModal(); });
  elements.contextDelete.addEventListener('click', async () => {
    if (elements.contextDelete.dataset.confirm !== '1') {
      elements.contextDelete.dataset.confirm = '1';
      elements.contextDelete.querySelector('span').textContent = '再次点击确认删除';
      setTimeout(() => {
        if (!elements.sessionContextMenu.hidden) {
          elements.contextDelete.dataset.confirm = '';
          elements.contextDelete.querySelector('span').textContent = '删除会话';
        }
      }, 2600);
      return;
    }
    await deleteActiveSession();
  });
  elements.refreshState.addEventListener('click', () => refresh(activeSessionId));
  elements.knowledgeToggle.addEventListener('click', () => toggleKnowledgeMenu(elements.knowledgeMenu, elements.knowledgeToggle));
  elements.headKnowledgeToggle.addEventListener('click', () => toggleKnowledgeMenu(elements.headKnowledgeMenu, elements.headKnowledgeToggle));
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.rag-knowledge-picker')) closeKnowledgeMenus();
    if (!event.target.closest('.rag-context-menu')) hideSessionContextMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!elements.imageLightbox.hidden) closeImageLightbox();
    else if (!elements.providerModal.hidden) closeProviderModal();
    else if (!elements.sessionSettingsModal.hidden) closeSessionSettingsModal();
    else { closeKnowledgeMenus(); hideSessionContextMenu(); }
  });
  window.addEventListener('resize', hideSessionContextMenu);
  document.addEventListener('click', (event) => {
    if (!event.target.closest('[data-page]')) return;
    hideSessionContextMenu();
    closeSessionSettingsModal();
  });
  elements.chooseSandbox.addEventListener('click', async () => {
    const result = await window.orchestrator.ragChooseSandbox();
    if (!result.canceled) await updateSession({ sandboxDir: result.path }, { quiet: false });
  });
  elements.createSandbox.addEventListener('click', async () => {
    const result = await window.orchestrator.ragCreateSandbox();
    await updateSession({ sandboxDir: result.path }, { quiet: false });
  });
  for (const button of document.querySelectorAll('[data-rag-permission]')) button.addEventListener('click', () => updateSession({ permissionMode: button.dataset.ragPermission }, { quiet: false }));
  elements.compact.addEventListener('click', async () => {
    elements.compact.disabled = true;
    elements.compact.textContent = '正在压缩...';
    try { await window.orchestrator.ragCompactSession(activeSessionId); await refresh(activeSessionId, { quiet: true }); notify('上下文已压缩', '后续请求会携带压缩后的工作记忆。', 'success'); }
    catch (error) { notify('压缩失败', error.message || String(error), 'error'); }
    finally { elements.compact.textContent = '压缩上下文'; renderInspector(); }
  });
  elements.deleteSession.addEventListener('click', async () => {
    if (elements.deleteSession.dataset.confirm !== '1') {
      elements.deleteSession.dataset.confirm = '1';
      elements.deleteSession.title = '再次点击确认删除';
      setTimeout(() => { elements.deleteSession.dataset.confirm = ''; elements.deleteSession.title = '删除会话'; }, 2600);
      return;
    }
    await deleteActiveSession();
  });
  elements.openProviders.addEventListener('click', openAiModelCenter);
  elements.openModelCenter.addEventListener('click', openAiModelCenter);
  elements.closeProviders.addEventListener('click', closeProviderModal);
  elements.providerModal.addEventListener('click', (event) => { if (event.target === elements.providerModal) closeProviderModal(); });
  elements.newProvider.addEventListener('click', newProviderForm);
  elements.saveProvider.addEventListener('click', async () => {
    try { await saveProviderForm(); notify('供应商已保存', 'API Key 已通过系统安全存储加密。', 'success'); }
    catch (error) { notify('保存失败', error.message || String(error), 'error'); }
  });
  elements.fetchModels.addEventListener('click', fetchRemoteModels);
  elements.deleteProvider.addEventListener('click', deleteProvider);
  elements.denyApproval.addEventListener('click', () => resolveApproval(false));
  elements.approveOnce.addEventListener('click', () => resolveApproval(true, false));
  elements.approveFull.addEventListener('click', () => resolveApproval(true, true));
  elements.messages.addEventListener('click', (event) => {
    const copyButton = event.target.closest('[data-rag-copy-code]');
    if (copyButton) {
      const code = copyButton.closest('.rag-code-block')?.querySelector('pre > code')?.textContent || '';
      window.orchestrator.copyText(code).then(() => notify('代码已复制', '代码块内容已写入剪贴板。', 'success')).catch((error) => notify('复制失败', error.message, 'error'));
      return;
    }
    const image = conversationImage(event.target);
    if (image) { event.preventDefault(); openImageLightbox(image); return; }
    const link = event.target.closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href');
    if (!/^https?:\/\//i.test(href)) return;
    event.preventDefault();
    window.orchestrator.openExternal(href).catch((error) => notify('无法打开链接', error.message, 'error'));
  });
  elements.messages.addEventListener('contextmenu', (event) => {
    const image = conversationImage(event.target);
    if (!image) return;
    event.preventDefault();
    copyConversationImage(image.currentSrc || image.src);
  });
  elements.imageLightboxClose.addEventListener('click', closeImageLightbox);
  elements.imageLightboxCopy.addEventListener('click', () => copyConversationImage(elements.imageLightbox.dataset.source));
  elements.imageLightbox.addEventListener('click', (event) => { if (event.target === elements.imageLightbox || event.target.closest('.rag-image-lightbox-stage') && event.target !== elements.imageLightboxImage) closeImageLightbox(); });
  elements.imageLightboxImage.addEventListener('contextmenu', (event) => { event.preventDefault(); copyConversationImage(elements.imageLightbox.dataset.source); });
  document.querySelector('[data-page="rag"]')?.addEventListener('click', () => refresh(activeSessionId, { quiet: initialized }));
  window.orchestrator.onRagEvent(handleEvent);

  function providerName(id) { return state.providers.find((item) => item.id === id)?.name || '未配置供应商'; }
  function groupBy(items, key) { const map = new Map(); for (const item of items || []) { const value = key(item); if (!map.has(value)) map.set(value, []); map.get(value).push(item); } return map; }
  function mergeModels(...lists) { const map = new Map(); for (const item of lists.flat()) map.set(item.id, { ...(map.get(item.id) || {}), ...item }); return [...map.values()].sort((a, b) => String(a.id).localeCompare(String(b.id))); }
  function toolLabel(name) { return ({ knowledge_search: '检索知识库', knowledge_list_documents: '列出知识库原文', knowledge_read_document: '读取原始 Markdown', knowledge_view_images: '查看知识库原图', list_files: '列出文件', read_file: '读取文件', write_file: '写入文件', run_command: '执行 CMD', web_search: '联网搜索', browse_url: '读取网页', open_browser: '打开浏览器', spawn_subagent: '调用子 Agent' })[name] || name || '工具'; }
  function toolStatus(status) { return ({ running: '进行中', succeeded: '已完成', failed: '失败' })[status] || status || '进行中'; }
  function formatNumber(value) { return new Intl.NumberFormat('zh-CN', { notation: Number(value) > 999999 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(Number(value || 0)); }
  function formatBytes(value) { const bytes = Number(value || 0); return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`; }
  function isImageAttachment(item) { return String(item?.mimeType || '').startsWith('image/') && Boolean(item?.previewUrl); }
  function formatTime(value) { const date = new Date(value || Date.now()); return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date); }
  function relativeTime(value) { const delta = Date.now() - new Date(value || 0).getTime(); if (!Number.isFinite(delta)) return ''; if (delta < 60000) return '刚刚'; if (delta < 3600000) return `${Math.floor(delta / 60000)} 分钟`; if (delta < 86400000) return `${Math.floor(delta / 3600000)} 小时`; return `${Math.floor(delta / 86400000)} 天`; }
  function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
  function escapeAttr(value) { return escapeHtml(value); }
  function cssEscape(value) { return globalThis.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }

  refresh(activeSessionId, { quiet: true });
})();
