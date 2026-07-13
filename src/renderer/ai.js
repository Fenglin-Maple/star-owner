(() => {
  const $ = (selector) => document.querySelector(selector);
  const elements = {
    agentPage: $('#page-internal-agents'), singlePage: $('#page-single-agent'), modelPage: $('#page-ai-models'),
    newAgent: $('#aiNewAgent'), refreshAgents: $('#aiRefreshAgents'), agentList: $('#aiAgentSessionList'), agentDetail: $('#aiAgentDetail'),
    metricSessions: $('#aiMetricSessions'), metricRunning: $('#aiMetricRunning'), metricCompleted: $('#aiMetricCompleted'), metricFailed: $('#aiMetricFailed'),
    createModal: $('#aiAgentCreateModal'), closeCreate: $('#aiCloseAgentCreate'), cancelCreate: $('#aiCancelAgentCreate'), createOnly: $('#aiCreateAgentOnly'), createStart: $('#aiCreateAgentStart'),
    agentTitle: $('#aiAgentTitle'), agentProvider: $('#aiAgentProvider'), agentModel: $('#aiAgentModel'), agentCollection: $('#aiAgentCollection'), agentRequirements: $('#aiAgentRequirements'),
    collectionModal: $('#aiCollectionModal'), collectionName: $('#aiCollectionName'), closeCollection: $('#aiCloseCollection'), cancelCollection: $('#aiCancelCollection'), saveCollection: $('#aiSaveCollection'),
    singleVideo: $('#singleVideoInput'), singleCollection: $('#singleCollectionSelect'), singleCreateCollection: $('#singleCreateCollection'), singleOpenCollection: $('#singleOpenCollection'), singleProvider: $('#singleProviderSelect'), singleModel: $('#singleModelSelect'), singleFrames: $('#singleFrames'), singleComments: $('#singleComments'), singleRequirements: $('#singleRequirements'), singleKeepVideoCache: $('#singleKeepVideoCache'), singleStart: $('#singleStart'), singleSession: $('#singleSessionSelect'), singleDetail: $('#singleAgentDetail'),
    modelNew: $('#aiModelNewProvider'), modelProviderList: $('#aiModelProviderList'), modelProviderId: $('#aiModelProviderId'), modelProviderName: $('#aiModelProviderName'), modelProviderType: $('#aiModelProviderType'), modelProviderBaseUrl: $('#aiModelProviderBaseUrl'), modelProviderApiKey: $('#aiModelProviderApiKey'), modelProviderTemperature: $('#aiModelProviderTemperature'), modelProviderMaxTokens: $('#aiModelProviderMaxTokens'), modelProviderHeaders: $('#aiModelProviderHeaders'), modelDelete: $('#aiModelDeleteProvider'), modelSave: $('#aiModelSaveProvider'), modelFetch: $('#aiModelFetchModels'), modelCount: $('#aiModelRemoteCount'), modelRemote: $('#aiModelRemoteModels'),
    dependencyList: $('#dependencyList'), dependencyRefresh: $('#dependencyRefresh'), dependencyModal: $('#dependencyPromptModal'), dependencyMissing: $('#dependencyPromptMissing'), dependencyLater: $('#dependencyPromptLater'), dependencyDownload: $('#dependencyPromptDownload'),
    loginRequiredModal: $('#singleLoginRequiredModal'), loginRequiredVideo: $('#singleLoginRequiredVideo'), loginRequiredReason: $('#singleLoginRequiredReason'), loginLater: $('#singleLoginLater'), goLogin: $('#singleGoLogin')
  };

  let state = { providers: [], sessions: [], collections: [], internalCollections: [] };
  let modelState = { providers: [] };
  let dependencyState = null;
  let activeAgentId = localStorage.getItem('internalAgentActiveId') || '';
  let activeSingleId = localStorage.getItem('singleAgentActiveId') || '';
  let editingProviderId = '';
  let collectionModalSource = 'single';
  let refreshTimer = null;
  let streamRenderTimer = null;
  let streamStructuralRender = false;
  let initialized = false;
  let modelSaveTimer = null;
  const pendingSessionActions = new Set();
  let agentContextMenu = null;

  async function refreshAll({ quiet = false } = {}) {
    try {
      state = await window.orchestrator.internalAgentState();
      modelState = await window.orchestrator.ragState('');
      dependencyState = await window.orchestrator.dependencyState();
      if (!activeAgentId || !state.sessions.some((item) => item.id === activeAgentId && item.mode === 'queue')) activeAgentId = state.sessions.find((item) => item.mode === 'queue')?.id || '';
      if (!activeSingleId || !state.sessions.some((item) => item.id === activeSingleId && item.mode === 'single')) activeSingleId = state.sessions.find((item) => item.mode === 'single')?.id || '';
      persistActiveIds();
      renderAll();
      initialized = true;
      maybeShowDependencyPrompt();
    } catch (error) {
      if (!quiet) notify('AI 工作台尚未就绪', error.message || String(error), 'error');
    }
  }

  function renderAll() {
    state.providers = modelState.providers || state.providers || [];
    renderAgentPage();
    renderSinglePage();
    renderModelPage();
    renderDependencies();
    maybeShowDependencyPrompt();
  }

  function renderAgentPage() {
    const sessions = state.sessions
      .filter((item) => item.mode === 'queue')
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(b.id || '').localeCompare(String(a.id || '')));
    elements.metricSessions.textContent = String(sessions.length);
    elements.metricRunning.textContent = String(sessions.filter((item) => ['running', 'draining'].includes(item.status)).length);
    elements.metricCompleted.textContent = String(sessions.reduce((sum, item) => sum + Number(item.completed || 0), 0));
    elements.metricFailed.textContent = String(sessions.reduce((sum, item) => sum + Number(item.failed || 0), 0));
    elements.agentList.innerHTML = sessions.map((session) => sessionButton(session, session.id === activeAgentId)).join('');
    if (!sessions.length) elements.agentList.innerHTML = '<div class="rag-list-empty">暂无应用内 Agent<br>点击右上角新建</div>';
    for (const button of elements.agentList.querySelectorAll('[data-agent-session]')) {
      button.addEventListener('click', () => {
        activeAgentId = button.dataset.agentSession;
        persistActiveIds();
        renderAgentPage();
      });
      button.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        const session = sessions.find((item) => item.id === button.dataset.agentSession);
        if (session) openAgentContextMenu(session, event.clientX, event.clientY);
      });
    }
    renderSessionDetail(elements.agentDetail, sessions.find((item) => item.id === activeAgentId));
  }

  function renderSinglePage() {
    populateProviderSelect(elements.singleProvider, elements.singleModel, elements.singleProvider.value || state.providers[0]?.id || '', elements.singleModel.value);
    const previousCollection = elements.singleCollection.value;
    elements.singleCollection.innerHTML = '<option value="">选择内置收藏夹</option>' + state.internalCollections.map((item) => `<option value="${esc(item.id)}">${html(item.name)}</option>`).join('');
    elements.singleCollection.value = state.internalCollections.some((item) => item.id === previousCollection) ? previousCollection : (state.internalCollections[0]?.id || '');
    elements.singleOpenCollection.disabled = !elements.singleCollection.value;
    const singles = state.sessions.filter((item) => item.mode === 'single');
    elements.singleSession.innerHTML = '<option value="">选择单任务会话</option>' + singles.map((item) => `<option value="${esc(item.id)}">${html(item.title)} · ${statusLabel(item.status)}</option>`).join('');
    elements.singleSession.value = activeSingleId;
    renderSessionDetail(elements.singleDetail, singles.find((item) => item.id === activeSingleId), { compact: true });
    updateSingleStartState();
  }

  function updateSingleStartState() {
    const hasModel = Boolean(elements.singleProvider.value && elements.singleModel.value && state.providers.some((provider) => provider.id === elements.singleProvider.value && provider.enabledModels?.some((model) => model.id === elements.singleModel.value)));
    elements.singleStart.disabled = !hasModel;
    elements.singleStart.title = hasModel ? '' : '请先在 AI 模型配置中启用至少一个模型';
  }

  function renderSessionDetail(container, session, { compact = false } = {}) {
    if (!session) {
      container.innerHTML = `<div class="ai-empty ${compact ? 'compact' : ''}"><strong>${compact ? '尚未开始单任务' : '选择或创建一个 Agent'}</strong><span>${compact ? '任务开始后可离开本页面，处理会在后台继续。' : '每个会话都有独立 Worker ID、模型、收藏夹目标和工作记录。'}</span></div>`;
      return;
    }
    const collection = state.collections.find((item) => item.id === session.collectionId);
    const collectionProgress = session.collectionProgress || collection || {};
    const collectionPercent = Math.round(Number(collectionProgress.progress || 0) * 100);
    const active = ['running', 'draining', 'stopping'].includes(session.status);
    const modelUnavailable = session.modelAvailable === false;
    const canStart = !active && session.status !== 'completed' && !modelUnavailable;
    const logs = (session.logs || []).slice().reverse().map((entry) => `<div class="ai-log-entry"><time>${time(entry.at)}</time><span>${html(entry.message)}</span></div>`).join('') || '<div class="rag-list-empty">暂无工作记录</div>';
    const output = session.lastOutput || '';
    const pending = [...pendingSessionActions].some((key) => key.startsWith(`${session.id}:`));
    container.innerHTML = `<div class="ai-session-view" data-agent-session-view="${esc(session.id)}">
      <header class="ai-session-head">
        <div class="ai-session-identity"><strong>${html(session.title)}</strong><span>${html(collection ? `${collection.userName} / ${collection.name}` : session.collectionId)} · ${html(providerName(session.providerId))} / ${html(session.modelId)} · ${html(session.workerId)}</span></div>
        <div class="ai-session-actions">
          ${session.mode === 'single' && output ? `<button class="secondary-button compact-button" data-agent-action="open-output"><svg viewBox="0 0 24 24"><path d="M4 6h6l2 2h8v10H4z"/></svg><span>打开产物</span></button>` : ''}
          ${modelUnavailable ? `<button class="primary-button compact-button" type="button" disabled title="${esc(session.modelUnavailableReason || 'AI 模型配置不可用')}">模型不可用</button>` : (canStart ? `<button class="primary-button compact-button" data-agent-action="start" ${pending ? 'disabled' : ''}>${startActionLabel(session)}</button>` : '')}
          ${active && session.acceptNewTasks ? `<button class="secondary-button compact-button" data-agent-action="pause" ${pending ? 'disabled' : ''}>完成本单后暂停</button>` : ''}
          ${active ? `<button class="secondary-button compact-button danger-button" data-agent-action="stop" ${pending ? 'disabled' : ''}>${pendingSessionActions.has(`${session.id}:stop`) ? '正在停止…' : '立即停止'}</button>` : ''}
          <button class="icon-action danger-icon" data-agent-action="delete" title="删除会话" ${active || pending ? 'disabled' : ''}><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14"/></svg></button>
        </div>
      </header>
      <div class="ai-session-progress">
        ${modelUnavailable ? `<div class="ai-model-unavailable"><strong>AI 模型配置不可用</strong><span>${html(session.modelUnavailableReason || '')}</span></div>` : ''}
        <div class="ai-collection-overview">
          <div><span>收藏夹总进度</span><strong data-agent-role="collection-summary">${Number(collectionProgress.done || 0)} / ${Number(collectionProgress.enabled || 0)} · ${collectionPercent}%</strong></div>
          <div class="ai-collection-progress-track"><span data-agent-role="collection-progress" style="width:${collectionPercent}%"></span></div>
          <small data-agent-role="collection-detail">处理中 ${Number(collectionProgress.claimed || 0)} · 剩余 ${Number(collectionProgress.remaining || 0)} · 失败/打回 ${Number(collectionProgress.failed || 0)} · 已关闭 ${Number(collectionProgress.disabled || 0)}</small>
        </div>
        <div class="ai-task-progress-head"><span data-agent-role="phase">${html(session.phase || statusLabel(session.status))}</span><strong data-agent-role="percent">${Math.round(Number(session.progress || 0) * 100)}%</strong></div>
        <div class="ai-progress-track"><span data-agent-role="progress" style="width:${Math.round(Number(session.progress || 0) * 100)}%"></span></div>
        <div class="ai-context-state"><span>独立上下文 <strong data-agent-role="context-cycle">${Number(session.contextCycle || 0)}</strong></span><span>预计占用 <strong data-agent-role="context-percent">${Number(session.contextPercent || 0)}%</strong></span><span>语义整理 <strong data-agent-role="context-compactions">${Number(session.contextCompactions || 0)}</strong> 次</span></div>
        <div class="ai-session-path" data-agent-role="output" title="${esc(output)}" ${output ? '' : 'hidden'}>${html(output)}</div>
      </div>
      <div class="ai-session-body"><section class="ai-stream-pane"><div class="ai-subpanel-title"><strong>模型输出</strong><span data-agent-role="tokens">${formatTokens(session.tokenUsage?.total || 0)} 累计 tokens</span></div><div class="ai-stream-scroll"><div data-agent-role="reasoning">${session.reasoning ? `<details class="ai-reasoning" open><summary>模型思考</summary><pre>${html(session.reasoning)}</pre></details>` : ''}</div><pre class="ai-content-stream" data-agent-role="content">${html(session.content || (active ? '正在等待模型输出…' : '该会话尚无模型输出。'))}</pre></div></section><aside class="ai-log-pane"><div class="ai-subpanel-title"><strong>工作记录</strong><span data-agent-role="stats">${session.completed || 0} 完成 / ${session.failed || 0} 失败 / ${session.skipped || 0} 跳过</span></div><div class="ai-log-scroll" data-agent-role="logs">${logs}</div></aside></div>
    </div>`;
    for (const button of container.querySelectorAll('[data-agent-action]')) button.addEventListener('click', () => handleSessionAction(session, button));
  }

  async function handleSessionAction(session, button) {
    const action = button.dataset.agentAction;
    const pendingKey = `${session.id}:${action}`;
    if (pendingSessionActions.has(pendingKey)) return;
    if (action === 'delete' && button.dataset.confirm !== '1') {
      button.dataset.confirm = '1';
      button.title = '再次点击确认删除';
      notify('再次点击删除按钮确认', '只删除会话记录，不删除已经归档的视频知识文档。', 'info');
      setTimeout(() => { button.dataset.confirm = ''; button.title = '删除会话'; }, 2600);
      return;
    }
    pendingSessionActions.add(pendingKey);
    button.disabled = true;
    if (action === 'stop') button.textContent = '正在停止…';
    try {
      if (action === 'open-output') await window.orchestrator.internalAgentOpenOutput(session.id);
      if (action === 'start') await window.orchestrator.internalAgentStart(session.id);
      if (action === 'pause') await window.orchestrator.internalAgentPause(session.id);
      if (action === 'stop') await window.orchestrator.internalAgentStop(session.id);
      if (action === 'delete') {
        await window.orchestrator.internalAgentDelete(session.id);
        if (activeAgentId === session.id) activeAgentId = '';
        if (activeSingleId === session.id) activeSingleId = '';
      }
      await refreshAll({ quiet: true });
    } catch (error) { notify('Agent 操作失败', error.message || String(error), 'error'); }
    finally {
      pendingSessionActions.delete(pendingKey);
      const latest = state.sessions.find((item) => item.id === session.id);
      const isSelected = latest && (latest.mode === 'single' ? latest.id === activeSingleId : latest.id === activeAgentId);
      if (isSelected) renderSessionDetail(containerForSession(latest), latest, { compact: latest.mode === 'single' });
    }
  }

  function sessionButton(session, active) {
    const collection = state.collections.find((item) => item.id === session.collectionId);
    const status = session.modelAvailable === false ? 'model-unavailable' : session.status;
    const summary = session.modelAvailable === false ? session.modelUnavailableReason : (session.currentTask ? `${session.currentTask.bvid} · ${session.phase}` : `${session.completed || 0} 完成 / ${session.failed || 0} 失败 / ${session.skipped || 0} 跳过`);
    return `<button class="ai-agent-session ${active ? 'active' : ''}" type="button" data-agent-session="${esc(session.id)}"><div><strong>${html(session.title)}</strong><em class="ai-status ${esc(status)}" data-agent-role="list-status">${statusLabel(status)}</em></div><span>${html(collection ? `${collection.userName} / ${collection.name}` : session.collectionId)}</span><small data-agent-role="list-summary">${html(summary)}</small></button>`;
  }

  function openAgentContextMenu(session, x, y) {
    closeAgentContextMenu();
    const active = ['running', 'draining', 'stopping'].includes(session.status);
    agentContextMenu = document.createElement('div');
    agentContextMenu.className = 'ai-agent-context-menu';
    agentContextMenu.innerHTML = `<button type="button" ${active ? 'disabled' : ''}><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14"/></svg><span>${active ? '请先停止此工作流' : '删除这个工作流'}</span></button>`;
    document.body.appendChild(agentContextMenu);
    const bounds = agentContextMenu.getBoundingClientRect();
    agentContextMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
    agentContextMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
    agentContextMenu.querySelector('button').addEventListener('click', async () => {
      closeAgentContextMenu();
      if (!window.confirm(`删除工作流“${session.title}”？\n\n只删除会话记录，不删除已经归档的视频知识文档。`)) return;
      const pendingKey = `${session.id}:delete`;
      if (pendingSessionActions.has(pendingKey)) return;
      pendingSessionActions.add(pendingKey);
      try {
        await window.orchestrator.internalAgentDelete(session.id);
        if (activeAgentId === session.id) activeAgentId = '';
        persistActiveIds();
        await refreshAll({ quiet: true });
        notify('工作流已删除', '已保留归档的视频知识文档。', 'success');
      } catch (error) {
        notify('删除工作流失败', error.message || String(error), 'error');
      } finally {
        pendingSessionActions.delete(pendingKey);
      }
    });
  }

  function closeAgentContextMenu() {
    agentContextMenu?.remove();
    agentContextMenu = null;
  }

  function openCreateModal() {
    if (!state.providers.some((item) => item.enabledModels?.length)) {
      notify('请先配置可用模型', '在 AI 模型配置中保存供应商并启用至少一个模型。', 'info');
      document.querySelector('[data-page="ai-models"]')?.click();
      return;
    }
    elements.createModal.hidden = false;
    elements.agentTitle.value = '';
    elements.agentRequirements.value = '';
    populateProviderSelect(elements.agentProvider, elements.agentModel, state.providers.find((item) => item.enabledModels?.length)?.id || '', '');
    elements.agentCollection.innerHTML = '<option value="">选择任务收藏夹</option>' + state.collections.map((item) => `<option value="${esc(item.id)}">${html(item.userName)} / ${html(item.name)} · 待处理 ${item.pending}</option>`).join('');
  }

  function closeCreateModal() { elements.createModal.hidden = true; }

  async function createAgent(start) {
    try {
      const session = await window.orchestrator.internalAgentCreateSession({ title: elements.agentTitle.value, providerId: elements.agentProvider.value, modelId: elements.agentModel.value, collectionId: elements.agentCollection.value, taskRequirements: elements.agentRequirements.value });
      activeAgentId = session.id;
      persistActiveIds();
      closeCreateModal();
      if (start) await window.orchestrator.internalAgentStart(session.id);
      await refreshAll({ quiet: true });
      notify('Agent 会话已创建', start ? '已开始从指定收藏夹持续领取任务。' : '可在会话详情中手动启动。', 'success');
    } catch (error) { notify('无法创建 Agent', error.message || String(error), 'error'); }
  }

  function populateProviderSelect(providerSelect, modelSelect, providerId, modelId) {
    const providers = state.providers || [];
    providerSelect.innerHTML = '<option value="">选择供应商</option>' + providers.map((provider) => `<option value="${esc(provider.id)}">${html(provider.name)}</option>`).join('');
    const selectedProvider = providers.find((item) => item.id === providerId) || providers.find((item) => item.enabledModels?.length) || providers[0];
    providerSelect.value = selectedProvider?.id || '';
    modelSelect.innerHTML = '<option value="">选择模型</option>' + (selectedProvider?.enabledModels || []).map((model) => `<option value="${esc(model.id)}">${html(model.name || model.id)}</option>`).join('');
    modelSelect.value = (selectedProvider?.enabledModels || []).some((item) => item.id === modelId) ? modelId : (selectedProvider?.enabledModels?.[0]?.id || '');
  }

  function syncModelForProvider(providerSelect, modelSelect) { populateProviderSelect(providerSelect, modelSelect, providerSelect.value, ''); }

  function openCollectionModal(source = 'single') {
    collectionModalSource = source;
    elements.collectionName.value = '';
    elements.collectionModal.hidden = false;
    requestAnimationFrame(() => elements.collectionName.focus());
  }

  function closeCollectionModal() { elements.collectionModal.hidden = true; }

  async function saveCollection() {
    try {
      const collection = await window.orchestrator.internalAgentCreateCollection(elements.collectionName.value);
      closeCollectionModal();
      await refreshAll({ quiet: true });
      if (collectionModalSource === 'single') elements.singleCollection.value = collection.id;
      notify('内置收藏夹已创建', `${collection.name} 可用于单任务、RAG、文档库和导出。`, 'success');
    } catch (error) { notify('创建失败', error.message || String(error), 'error'); }
  }

  async function startSingleTask() {
    elements.singleStart.disabled = true;
    try {
      const session = await window.orchestrator.internalAgentCreateSingle({
        video: elements.singleVideo.value,
        collectionId: elements.singleCollection.value,
        providerId: elements.singleProvider.value,
        modelId: elements.singleModel.value,
        title: `单视频总结 · ${elements.singleVideo.value.trim().slice(0, 24)}`,
        taskRequirements: elements.singleRequirements.value,
        taskOptions: { frames: Number(elements.singleFrames.value), commentLimit: Number(elements.singleComments.value) },
        keepVideoCache: Boolean(elements.singleKeepVideoCache.checked)
      });
      activeSingleId = session.id;
      persistActiveIds();
      await window.orchestrator.internalAgentStart(session.id);
      await refreshAll({ quiet: true });
      notify('单任务已开始', '可以切换到其它页面，后台会继续处理。', 'success');
    } catch (error) { notify('无法开始单任务', error.message || String(error), 'error'); }
    finally { updateSingleStartState(); }
  }

  function renderModelPage() {
    const providers = modelState.providers || [];
    if (!editingProviderId && providers.length) editingProviderId = providers[0].id;
    elements.modelProviderList.innerHTML = providers.map((provider) => `<button type="button" class="rag-provider-item ${provider.id === editingProviderId ? 'active' : ''}" data-ai-provider="${esc(provider.id)}"><strong>${html(provider.name)}</strong><span>${html(provider.type)} / ${html(provider.baseUrl)}</span></button>`).join('') || '<div class="rag-list-empty">暂无供应商</div>';
    for (const button of elements.modelProviderList.querySelectorAll('[data-ai-provider]')) button.addEventListener('click', () => { editingProviderId = button.dataset.aiProvider; renderModelPage(); });
    const provider = providers.find((item) => item.id === editingProviderId);
    if (editingProviderId === '__new__') fillProviderForm(null);
    else fillProviderForm(provider);
    renderRemoteModels(provider);
  }

  function fillProviderForm(provider) {
    elements.modelProviderId.value = provider?.id || '';
    elements.modelProviderName.value = provider?.name || '';
    elements.modelProviderType.value = provider?.type || 'openai';
    elements.modelProviderBaseUrl.value = provider?.baseUrl || '';
    elements.modelProviderApiKey.value = '';
    elements.modelProviderApiKey.placeholder = provider?.hasApiKey ? '已安全保存，留空保持不变' : '本地免密接口可留空';
    elements.modelProviderTemperature.value = provider?.temperature ?? 0.2;
    elements.modelProviderMaxTokens.value = provider?.maxOutputTokens || 128000;
    elements.modelProviderHeaders.value = Object.keys(provider?.extraHeaders || {}).length ? JSON.stringify(provider.extraHeaders, null, 2) : '';
    elements.modelDelete.disabled = !provider;
  }

  function renderRemoteModels(provider) {
    const map = new Map();
    for (const item of [...(provider?.remoteModels || []), ...(provider?.enabledModels || [])]) map.set(item.id, { ...(map.get(item.id) || {}), ...item });
    const source = [...map.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const enabled = new Map((provider?.enabledModels || []).map((item) => [item.id, item]));
    elements.modelCount.textContent = `${source.length} 个`;
    elements.modelRemote.innerHTML = '';
    for (const model of source) {
      const value = { ...model, ...(enabled.get(model.id) || {}) };
      const row = document.createElement('div');
      row.className = 'rag-remote-model';
      row.dataset.modelId = model.id;
      row.innerHTML = `<input class="rag-model-enabled app-checkbox" type="checkbox" ${enabled.has(model.id) ? 'checked' : ''} aria-label="启用 ${esc(model.id)}"><strong title="${esc(model.id)}">${html(model.name || model.id)}</strong><label class="rag-model-limit"><span>上下文</span><input class="rag-model-context" type="number" min="1024" max="4000000" step="1024" value="${Number(value.contextWindow || 1000000)}"></label><label class="rag-model-limit"><span>输出</span><input class="rag-model-output" type="number" min="256" max="1000000" step="1024" value="${Number(value.maxOutputTokens || 128000)}"></label><button type="button" class="rag-model-cap-toggle ${value.supportsTools ? 'active' : ''}" data-cap="supportsTools" title="工具调用">T</button><button type="button" class="rag-model-cap-toggle ${value.supportsReasoning ? 'active' : ''}" data-cap="supportsReasoning" title="推理流">R</button><button type="button" class="rag-model-cap-toggle ${value.supportsVision ? 'active' : ''}" data-cap="supportsVision" title="视觉">V</button><button type="button" class="rag-model-cap-toggle ${value.supportsAudio ? 'active' : ''}" data-cap="supportsAudio" title="音频">A</button><button type="button" class="rag-model-cap-toggle ${value.supportsImages ? 'active' : ''}" data-cap="supportsImages" title="图片返回">I</button><button type="button" class="rag-model-cap-toggle ${value.supportsCompression ? 'active' : ''}" data-cap="supportsCompression" title="压缩">C</button><button type="button" class="rag-model-cap-toggle ${value.supportsSubagents ? 'active' : ''}" data-cap="supportsSubagents" title="子 Agent">S</button>`;
      row.querySelector('.rag-model-enabled').addEventListener('change', scheduleModelSave);
      row.querySelector('.rag-model-context').addEventListener('change', scheduleModelSave);
      row.querySelector('.rag-model-output').addEventListener('change', scheduleModelSave);
      for (const toggle of row.querySelectorAll('[data-cap]')) toggle.addEventListener('click', () => { toggle.classList.toggle('active'); scheduleModelSave(); });
      elements.modelRemote.appendChild(row);
    }
    if (!source.length) elements.modelRemote.innerHTML = '<div class="rag-list-empty">保存配置后拉取远程模型</div>';
  }

  async function saveProviderForm() {
    const provider = await window.orchestrator.ragSaveProvider({ id: elements.modelProviderId.value || undefined, name: elements.modelProviderName.value, type: elements.modelProviderType.value, baseUrl: elements.modelProviderBaseUrl.value, apiKey: elements.modelProviderApiKey.value, temperature: Number(elements.modelProviderTemperature.value), maxOutputTokens: Number(elements.modelProviderMaxTokens.value), extraHeaders: elements.modelProviderHeaders.value });
    editingProviderId = provider.id;
    await refreshAll({ quiet: true });
    return provider;
  }

  function scheduleModelSave() {
    clearTimeout(modelSaveTimer);
    modelSaveTimer = setTimeout(saveEnabledModels, 260);
  }

  async function saveEnabledModels() {
    if (!editingProviderId || editingProviderId === '__new__') return;
    const provider = (modelState.providers || []).find((item) => item.id === editingProviderId);
    const source = new Map([...(provider?.remoteModels || []), ...(provider?.enabledModels || [])].map((item) => [item.id, item]));
    const models = [...elements.modelRemote.querySelectorAll('.rag-remote-model')].filter((row) => row.querySelector('.rag-model-enabled').checked).map((row) => {
      const caps = {};
      for (const toggle of row.querySelectorAll('[data-cap]')) caps[toggle.dataset.cap] = toggle.classList.contains('active');
      return { ...(source.get(row.dataset.modelId) || { id: row.dataset.modelId, name: row.dataset.modelId }), ...caps, contextWindow: Number(row.querySelector('.rag-model-context').value) || 1000000, maxOutputTokens: Number(row.querySelector('.rag-model-output').value) || 128000 };
    });
    await window.orchestrator.ragUpdateModels({ providerId: editingProviderId, models });
    await refreshAll({ quiet: true });
  }

  async function fetchModels() {
    elements.modelFetch.disabled = true;
    try {
      const provider = await saveProviderForm();
      await window.orchestrator.ragFetchModels(provider.id);
      await refreshAll({ quiet: true });
      notify('模型列表已更新', '请选择允许 RAG 知识库助手和视频总结 Agent 使用的模型。', 'success');
    } catch (error) { notify('模型拉取失败', error.message || String(error), 'error'); }
    finally { elements.modelFetch.disabled = false; }
  }

  async function deleteProvider(button) {
    if (!editingProviderId || editingProviderId === '__new__') return;
    if (button.dataset.confirm !== '1') {
      button.dataset.confirm = '1'; button.textContent = '再次点击确认';
      setTimeout(() => { button.dataset.confirm = ''; button.textContent = '删除'; }, 2600);
      return;
    }
    try { await window.orchestrator.ragDeleteProvider(editingProviderId); editingProviderId = ''; await refreshAll({ quiet: true }); }
    catch (error) { notify('无法删除供应商', error.message || String(error), 'error'); }
  }

  function renderDependencies() {
    if (!dependencyState) return;
    elements.dependencyList.innerHTML = dependencyState.packages.map((item) => `<div class="dependency-item"><div class="dependency-main"><div><strong>${html(item.name)}</strong><span class="dependency-state ${esc(item.status)}">${dependencyStatus(item)}</span></div><p>${html(item.message || item.description)}</p><div class="dependency-progress"><span style="width:${Math.round(Number(item.progress || 0) * 100)}%"></span></div></div><button class="secondary-button compact-button" type="button" data-download-dependency="${esc(item.id)}" ${['downloading', 'installing', 'verifying', 'resolving'].includes(item.status) ? 'disabled' : ''}>${item.available ? '重新下载' : '下载'}</button></div>`).join('');
    for (const button of elements.dependencyList.querySelectorAll('[data-download-dependency]')) button.addEventListener('click', () => downloadDependency(button.dataset.downloadDependency, button));
  }

  function maybeShowDependencyPrompt() {
    if (!dependencyState?.needsPrompt || !initialized) return;
    elements.dependencyMissing.innerHTML = dependencyState.packages.filter((item) => dependencyState.missingRequired.includes(item.id)).map((item) => `<span>${html(item.name)}</span>`).join('');
    elements.dependencyModal.hidden = false;
  }

  async function downloadDependency(id, button) {
    button.disabled = true;
    try { await window.orchestrator.dependencyDownload(id); dependencyState = await window.orchestrator.dependencyState(); renderDependencies(); notify('依赖安装完成', '运行时状态已经重新检查。', 'success'); }
    catch (error) { notify('依赖下载失败', error.message || String(error), 'error'); dependencyState = await window.orchestrator.dependencyState(); renderDependencies(); }
    finally { button.disabled = false; }
  }

  function handleInternalEvent(event) {
    if (!event) return;
    let structural = false;
    if (event.type === 'session-updated' && event.session) {
      const previous = state.sessions.find((item) => item.id === event.session.id);
      structural = !previous || sessionStructureKey(previous) !== sessionStructureKey(event.session);
      replaceSession(event.session);
    }
    if (event.type === 'stream') {
      const session = state.sessions.find((item) => item.id === event.sessionId);
      if (session) {
        if (event.delta?.content) session.content = `${session.content || ''}${event.delta.content}`;
        if (event.delta?.reasoning) session.reasoning = `${session.reasoning || ''}${event.delta.reasoning}`;
        session.phase = event.phase || session.phase;
        session.progress = event.progress ?? session.progress;
      }
    }
    if (event.type === 'log') {
      const session = state.sessions.find((item) => item.id === event.sessionId);
      if (session) session.logs = [...(session.logs || []), event.entry].slice(-200);
    }
    if (event.type === 'login-required') {
      elements.loginRequiredVideo.textContent = [event.bvid, event.title].filter(Boolean).join(' · ') || '当前单视频任务';
      elements.loginRequiredReason.textContent = event.reason || '登录完成后回到“视频总结（单个）”，点击“登录后重试”即可重新处理。';
      elements.loginRequiredModal.hidden = false;
    }
    scheduleStreamRender(structural);
  }

  function replaceSession(session) {
    const index = state.sessions.findIndex((item) => item.id === session.id);
    if (index >= 0) state.sessions[index] = session;
    else state.sessions.unshift(session);
  }

  function scheduleStreamRender(structural = false) {
    streamStructuralRender = streamStructuralRender || structural;
    if (streamRenderTimer) return;
    streamRenderTimer = setTimeout(() => {
      streamRenderTimer = null;
      if (streamStructuralRender) {
        streamStructuralRender = false;
        renderAgentPage();
        renderSinglePage();
      } else {
        patchAgentPage();
        patchSinglePage();
      }
    }, 90);
  }

  function patchAgentPage() {
    const sessions = state.sessions
      .filter((item) => item.mode === 'queue')
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(b.id || '').localeCompare(String(a.id || '')));
    elements.metricSessions.textContent = String(sessions.length);
    elements.metricRunning.textContent = String(sessions.filter((item) => ['running', 'draining'].includes(item.status)).length);
    elements.metricCompleted.textContent = String(sessions.reduce((sum, item) => sum + Number(item.completed || 0), 0));
    elements.metricFailed.textContent = String(sessions.reduce((sum, item) => sum + Number(item.failed || 0), 0));
    for (const session of sessions) patchSessionButton(elements.agentList, session, session.id === activeAgentId);
    patchSessionDetail(elements.agentDetail, sessions.find((item) => item.id === activeAgentId));
  }

  function patchSinglePage() {
    const session = state.sessions.find((item) => item.id === activeSingleId && item.mode === 'single');
    const option = [...elements.singleSession.options].find((item) => item.value === activeSingleId);
    if (option && session) option.textContent = `${session.title} · ${statusLabel(session.status)}`;
    patchSessionDetail(elements.singleDetail, session);
  }

  function patchSessionButton(list, session, active) {
    const button = list.querySelector(`[data-agent-session="${CSS.escape(session.id)}"]`);
    if (!button) return;
    button.classList.toggle('active', active);
    const status = button.querySelector('[data-agent-role="list-status"]');
    if (status) {
      const displayedStatus = session.modelAvailable === false ? 'model-unavailable' : session.status;
      status.className = `ai-status ${displayedStatus}`;
      status.textContent = statusLabel(displayedStatus);
    }
    const summary = button.querySelector('[data-agent-role="list-summary"]');
    if (summary) summary.textContent = session.modelAvailable === false
      ? session.modelUnavailableReason
      : (session.currentTask ? `${session.currentTask.bvid} · ${session.phase}` : `${session.completed || 0} 完成 / ${session.failed || 0} 失败 / ${session.skipped || 0} 跳过`);
  }

  function patchSessionDetail(container, session) {
    if (!session || container.querySelector('[data-agent-session-view]')?.dataset.agentSessionView !== session.id) return;
    const percent = Math.round(Number(session.progress || 0) * 100);
    setText(container, 'phase', session.phase || statusLabel(session.status));
    setText(container, 'percent', `${percent}%`);
    const bar = container.querySelector('[data-agent-role="progress"]');
    if (bar) bar.style.width = `${percent}%`;
    setText(container, 'tokens', `${formatTokens(session.tokenUsage?.total || 0)} 累计 tokens`);
    setText(container, 'context-cycle', Number(session.contextCycle || 0));
    setText(container, 'context-percent', `${Number(session.contextPercent || 0)}%`);
    setText(container, 'context-compactions', Number(session.contextCompactions || 0));
    const collectionProgress = session.collectionProgress || {};
    const collectionPercent = Math.round(Number(collectionProgress.progress || 0) * 100);
    setText(container, 'collection-summary', `${Number(collectionProgress.done || 0)} / ${Number(collectionProgress.enabled || 0)} · ${collectionPercent}%`);
    setText(container, 'collection-detail', `处理中 ${Number(collectionProgress.claimed || 0)} · 剩余 ${Number(collectionProgress.remaining || 0)} · 失败/打回 ${Number(collectionProgress.failed || 0)} · 已关闭 ${Number(collectionProgress.disabled || 0)}`);
    const collectionBar = container.querySelector('[data-agent-role="collection-progress"]');
    if (collectionBar) collectionBar.style.width = `${collectionPercent}%`;
    setText(container, 'stats', `${session.completed || 0} 完成 / ${session.failed || 0} 失败 / ${session.skipped || 0} 跳过`);
    setText(container, 'content', session.content || (['running', 'draining', 'stopping'].includes(session.status) ? '正在等待模型输出…' : '该会话尚无模型输出。'));
    const output = session.lastOutput || '';
    const outputNode = container.querySelector('[data-agent-role="output"]');
    if (outputNode) {
      outputNode.hidden = !output;
      outputNode.textContent = output;
      outputNode.title = output;
    }
    const reasoningHost = container.querySelector('[data-agent-role="reasoning"]');
    if (reasoningHost) {
      const details = reasoningHost.querySelector('details');
      if (session.reasoning && !details) reasoningHost.innerHTML = `<details class="ai-reasoning" open><summary>模型思考</summary><pre>${html(session.reasoning)}</pre></details>`;
      else if (details) {
        const wasOpen = details.open;
        details.querySelector('pre').textContent = session.reasoning || '';
        details.open = wasOpen;
      }
    }
    const logNode = container.querySelector('[data-agent-role="logs"]');
    if (logNode) {
      const previousScroll = logNode.scrollTop;
      const logs = (session.logs || []).slice().reverse().map((entry) => `<div class="ai-log-entry"><time>${time(entry.at)}</time><span>${html(entry.message)}</span></div>`).join('') || '<div class="rag-list-empty">暂无工作记录</div>';
      if (logNode.innerHTML !== logs) {
        logNode.innerHTML = logs;
        logNode.scrollTop = previousScroll;
      }
    }
  }

  function setText(container, role, value) {
    const node = container.querySelector(`[data-agent-role="${role}"]`);
    if (node && node.textContent !== String(value)) node.textContent = String(value);
  }

  function sessionStructureKey(session) {
    return [session.mode, session.status, Boolean(session.acceptNewTasks), session.title, session.collectionId, session.providerId, session.modelId, session.modelAvailable !== false, session.modelUnavailableReason || ''].join('|');
  }

  function containerForSession(session) {
    return session.mode === 'single' ? elements.singleDetail : elements.agentDetail;
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refreshAll({ quiet: true }), 280);
  }

  elements.newAgent.addEventListener('click', openCreateModal);
  document.addEventListener('pointerdown', (event) => { if (agentContextMenu && !agentContextMenu.contains(event.target)) closeAgentContextMenu(); });
  window.addEventListener('blur', closeAgentContextMenu);
  elements.refreshAgents.addEventListener('click', () => refreshAll());
  elements.closeCreate.addEventListener('click', closeCreateModal);
  elements.cancelCreate.addEventListener('click', closeCreateModal);
  elements.createModal.addEventListener('click', (event) => { if (event.target === elements.createModal) closeCreateModal(); });
  elements.createOnly.addEventListener('click', () => createAgent(false));
  elements.createStart.addEventListener('click', () => createAgent(true));
  elements.agentProvider.addEventListener('change', () => syncModelForProvider(elements.agentProvider, elements.agentModel));
  elements.singleProvider.addEventListener('change', () => { syncModelForProvider(elements.singleProvider, elements.singleModel); updateSingleStartState(); });
  elements.singleModel.addEventListener('change', updateSingleStartState);
  elements.singleCreateCollection.addEventListener('click', () => openCollectionModal('single'));
  elements.singleCollection.addEventListener('change', () => { elements.singleOpenCollection.disabled = !elements.singleCollection.value; });
  elements.singleOpenCollection.addEventListener('click', async () => {
    try { await window.orchestrator.internalAgentOpenCollection(elements.singleCollection.value); }
    catch (error) { notify('无法打开输出目录', error.message || String(error), 'error'); }
  });
  elements.closeCollection.addEventListener('click', closeCollectionModal);
  elements.cancelCollection.addEventListener('click', closeCollectionModal);
  elements.collectionModal.addEventListener('click', (event) => { if (event.target === elements.collectionModal) closeCollectionModal(); });
  elements.saveCollection.addEventListener('click', saveCollection);
  elements.singleStart.addEventListener('click', startSingleTask);
  elements.loginLater.addEventListener('click', () => { elements.loginRequiredModal.hidden = true; });
  elements.goLogin.addEventListener('click', () => { elements.loginRequiredModal.hidden = true; window.dispatchEvent(new CustomEvent('star:navigate', { detail: { page: 'login' } })); });
  elements.singleSession.addEventListener('change', () => { activeSingleId = elements.singleSession.value; persistActiveIds(); renderSinglePage(); });
  elements.modelNew.addEventListener('click', () => { editingProviderId = '__new__'; renderModelPage(); elements.modelProviderName.focus(); });
  elements.modelSave.addEventListener('click', async () => { try { await saveProviderForm(); notify('供应商已保存', '配置已供 RAG 和应用内 Agent 共用。', 'success'); } catch (error) { notify('保存失败', error.message || String(error), 'error'); } });
  elements.modelFetch.addEventListener('click', fetchModels);
  elements.modelDelete.addEventListener('click', () => deleteProvider(elements.modelDelete));
  elements.dependencyRefresh.addEventListener('click', async () => { dependencyState = await window.orchestrator.dependencyState(); renderDependencies(); });
  elements.dependencyLater.addEventListener('click', async () => { await window.orchestrator.dependencyAcknowledge({ download: false }); elements.dependencyModal.hidden = true; });
  elements.dependencyDownload.addEventListener('click', async () => { await window.orchestrator.dependencyAcknowledge({ download: true }); elements.dependencyModal.hidden = true; notify('依赖下载已加入后台队列', '可在设置的项目依赖包区域查看实时进度。', 'info'); });
  document.querySelector('[data-page="internal-agents"]')?.addEventListener('click', () => refreshAll({ quiet: initialized }));
  document.querySelector('[data-page="single-agent"]')?.addEventListener('click', () => refreshAll({ quiet: initialized }));
  document.querySelector('[data-page="ai-models"]')?.addEventListener('click', () => refreshAll({ quiet: initialized }));
  window.orchestrator.onInternalAgentEvent(handleInternalEvent);
  window.orchestrator.onDependencyEvent((event) => {
    if (event.state) dependencyState = event.state;
    if (event.type === 'dependency-error') notify('依赖下载失败', event.error || '未知错误', 'error');
    renderDependencies();
  });
  window.orchestrator.onRuntime((runtime) => {
    if (runtime?.dependencies) { dependencyState = runtime.dependencies; renderDependencies(); maybeShowDependencyPrompt(); }
  });

  function providerName(id) { return state.providers.find((item) => item.id === id)?.name || '未配置供应商'; }
  function statusLabel(status) { return ({ idle: '等待任务', running: '工作中', draining: '即将暂停', paused: '已暂停', blocked: '故障停止', 'waiting-login': '等待登录', stopping: '停止中', stopped: '已停止', completed: '已完成', error: '失败', unavailable: '视频不可用', 'model-unavailable': '模型不可用' })[status] || status || '未知'; }
  function startActionLabel(session) {
    if (session.mode === 'single') {
      if (session.status === 'waiting-login') return '登录后重试';
      return session.status === 'idle' ? '开始处理' : '重新开始处理';
    }
    return session.status === 'idle' ? '开始接单' : '重新开始接单';
  }
  function dependencyStatus(item) { return item.available ? '可用' : ({ resolving: '查询中', downloading: `${Math.round(item.progress * 100)}%`, verifying: '校验中', installing: '安装中', failed: '失败', missing: item.required ? '必需缺失' : '可选未装' })[item.status] || item.status; }
  function formatTokens(value) { return new Intl.NumberFormat('zh-CN', { notation: Number(value) > 999999 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(Number(value || 0)); }
  function time(value) { try { return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)); } catch { return ''; } }
  function persistActiveIds() { if (activeAgentId) localStorage.setItem('internalAgentActiveId', activeAgentId); else localStorage.removeItem('internalAgentActiveId'); if (activeSingleId) localStorage.setItem('singleAgentActiveId', activeSingleId); else localStorage.removeItem('singleAgentActiveId'); }
  function html(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
  function esc(value) { return html(value); }
  function notify(title, message, type = 'info') {
    const viewport = $('#toastViewport');
    if (!viewport) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<div><strong>${html(title)}</strong>${message ? `<span>${html(message)}</span>` : ''}</div>`;
    viewport.appendChild(toast);
    setTimeout(() => { toast.classList.add('leaving'); setTimeout(() => toast.remove(), 220); }, type === 'error' ? 5200 : 3400);
  }

  refreshAll({ quiet: true });
})();
