(() => {
  const $ = (selector) => document.querySelector(selector);
  const elements = {
    page: $('#page-outside-bilibili'),
    homeHead: $('#outsideToolHomeHead'),
    toolStack: $('#outsideToolStack'),
    toolDetail: $('#outsideToolDetail'),
    toolDetailBody: $('#outsideToolDetailBody'),
    toolDetailKicker: $('#outsideToolDetailKicker'),
    toolDetailTitle: $('#outsideToolDetailTitle'),
    toolDetailDescription: $('#outsideToolDetailDescription'),
    toolBack: $('#outsideToolBack'),
    subtitleChoose: $('#localSubtitleChoose'),
    subtitleStart: $('#localSubtitleStart'),
    subtitleSelection: $('#localSubtitleSelection'),
    subtitleJob: $('#localSubtitleJob'),
    videoChooseFiles: $('#localVideoChooseFiles'),
    videoChooseFolder: $('#localVideoChooseFolder'),
    videoJob: $('#localVideoJob'),
    videoModal: $('#localVideoImportModal'),
    videoSummary: $('#localVideoImportSummary'),
    videoCollection: $('#localVideoCollectionSelect'),
    videoCollectionName: $('#localVideoCollectionName'),
    videoCollectionNameRow: $('#localVideoCollectionNameRow'),
    videoCollectionKind: $('#localVideoCollectionKind'),
    videoList: $('#localVideoImportList'),
    videoStart: $('#localVideoImportStart'),
    documentChoose: $('#localDocumentChoose'),
    documentJob: $('#localDocumentJob'),
    documentModal: $('#localDocumentImportModal'),
    documentSummary: $('#localDocumentImportSummary'),
    documentCollection: $('#localDocumentCollectionSelect'),
    documentCollectionName: $('#localDocumentCollectionName'),
    documentCollectionNameRow: $('#localDocumentCollectionNameRow'),
    documentList: $('#localDocumentImportList'),
    documentStart: $('#localDocumentImportStart'),
    multipartBvid: $('#multipartBvid'),
    multipartInspect: $('#multipartInspect'),
    multipartInspectResult: $('#multipartInspectResult'),
    multipartSettings: $('#multipartSettings'),
    multipartProvider: $('#multipartProvider'),
    multipartModel: $('#multipartModel'),
    multipartConcurrency: $('#multipartConcurrency'),
    multipartMinimumFrames: $('#multipartMinimumFrames'),
    multipartFrameInterval: $('#multipartFrameInterval'),
    multipartRetainCache: $('#multipartRetainCache'),
    multipartRequirements: $('#multipartRequirements'),
    multipartCollection: $('#multipartCollection'),
    multipartCollectionName: $('#multipartCollectionName'),
    multipartCreate: $('#multipartCreate'),
    multipartCreateStart: $('#multipartCreateStart'),
    multipartRefreshState: $('#multipartRefreshState'),
    multipartViewerCollection: $('#multipartViewerCollection'),
    multipartParentList: $('#multipartParentList'),
    sharedLogin: $('#sharedLogin'),
    sharedToken: $('#sharedToken'),
    sharedSetToken: $('#sharedSetToken'),
    sharedLogout: $('#sharedLogout'),
    sharedAuthStatus: $('#sharedAuthStatus'),
    sharedRepositoryStatus: $('#sharedRepositoryStatus'),
    sharedRepositorySelect: $('#sharedRepositorySelect'),
    sharedRepositoryInput: $('#sharedRepositoryInput'),
    sharedRepositorySave: $('#sharedRepositorySave'),
    sharedRepositoryOpen: $('#sharedRepositoryOpen'),
    sharedRepositoryCreateName: $('#sharedRepositoryCreateName'),
    sharedRepositoryCreate: $('#sharedRepositoryCreate'),
    sharedOperationProgress: $('#sharedOperationProgress'),
    sharedOperationMessage: $('#sharedOperationMessage'),
    sharedOperationCount: $('#sharedOperationCount'),
    sharedOperationBar: $('#sharedOperationBar'),
    sharedOperationPercent: $('#sharedOperationPercent'),
    sharedCatalog: $('#sharedCatalog'),
    sharedGithubFilter: $('#sharedGithubFilter'),
    sharedGithubOptions: $('#sharedGithubOptions'),
    sharedBilibiliFilter: $('#sharedBilibiliFilter'),
    sharedBilibiliOptions: $('#sharedBilibiliOptions'),
    sharedVideoFilter: $('#sharedVideoFilter'),
    sharedVideoOptions: $('#sharedVideoOptions'),
    sharedCatalogResultCount: $('#sharedCatalogResultCount'),
    sharedMountFiltered: $('#sharedMountFiltered'),
    sharedCatalogList: $('#sharedCatalogList'),
    sharedCollection: $('#sharedCollection'),
    sharedCollectionName: $('#sharedCollectionName'),
    sharedMount: $('#sharedMount'),
    sharedMountSelectAll: $('#sharedMountSelectAll'),
    sharedSyncSelected: $('#sharedSyncSelected'),
    sharedMountList: $('#sharedMountList'),
    sharedUpload: $('#sharedUpload'),
    sharedUploadSelectAll: $('#sharedUploadSelectAll'),
    sharedUploadFilter: $('#sharedUploadFilter'),
    sharedUploadUserFilter: $('#sharedUploadUserFilter'),
    sharedUploadUserOptions: $('#sharedUploadUserOptions'),
    sharedUploadCollectionFilter: $('#sharedUploadCollectionFilter'),
    sharedUploadCollectionOptions: $('#sharedUploadCollectionOptions'),
    sharedUploadSort: $('#sharedUploadSort'),
    sharedUploadDurationMin: $('#sharedUploadDurationMin'),
    sharedUploadDurationMax: $('#sharedUploadDurationMax'),
    sharedUploadDurationLabel: $('#sharedUploadDurationLabel'),
    sharedUploadResultCount: $('#sharedUploadResultCount'),
    sharedUploadSelectedCount: $('#sharedUploadSelectedCount'),
    sharedUploadList: $('#sharedUploadList'),
    sharedUploadPrepareCollectionFilter: $('#sharedUploadPrepareCollectionFilter'),
    sharedUploadPrepareCollectionOptions: $('#sharedUploadPrepareCollectionOptions'),
    sharedUploadPrepareFilter: $('#sharedUploadPrepareFilter'),
    sharedUploadPrepareSelectAll: $('#sharedUploadPrepareSelectAll'),
    sharedUploadPrepareRemove: $('#sharedUploadPrepareRemove'),
    sharedUploadPrepareResultCount: $('#sharedUploadPrepareResultCount'),
    sharedUploadPrepareList: $('#sharedUploadPrepareList'),
    sharedUploadProgressModal: $('#sharedUploadProgressModal'),
    sharedUploadProgressMessage: $('#sharedUploadProgressMessage'),
    sharedUploadProgressCount: $('#sharedUploadProgressCount'),
    sharedUploadProgressBar: $('#sharedUploadProgressBar'),
    sharedUploadProgressPercent: $('#sharedUploadProgressPercent'),
    sharedUploadCancel: $('#sharedUploadCancel'),
    appShell: $('#appShell')
  };
  if (!elements.page) return;

  const { RequestGate } = window.StarOwnerRendererGuards;

  let state = { jobs: [], videoCollections: [], documentCollections: [] };
  let multipartState = { collections: [], parents: [] };
  let multipartInspection = null;
  let sharedData = { repository: null, authenticated: false, collections: [], mounts: [], documents: [] };
  let sharedCatalogData = { documents: [] };
  let snapshot = { tasks: [], collections: [] };
  let subtitleSelection = null;
  let videoSelection = null;
  let videoPreview = null;
  let documentSelection = null;
  let documentPreview = null;
  let videoPreviewTimer = null;
  let documentPreviewTimer = null;
  let activeToolId = '';
  let uploadDurationMaximum = 1;
  let outsideBackendReady = false;
  let readyRefreshStarted = false;
  let sharedUploadInvocationActive = false;
  let sharedOperationView = null;
  let sharedOperationHideTimer = null;
  let sharedOperationPollTimer = null;
  let sharedOperationPollGeneration = 0;
  let sharedOperationPollInFlight = false;
  let sharedRepositoryCheckPromise = null;
  let sharedRepositoryCheckedForEntry = false;
  let sharedCatalogLoadedKey = '';
  const selectedUploadTaskIds = new Set();
  const selectedPreparedTaskIds = new Set();
  const selectedRemotePaths = new Set();
  const selectedMountIds = new Set();
  const toolCards = new Map();
  const toolBodies = new Map();
  const localRefreshGate = new RequestGate();
  const multipartRefreshGate = new RequestGate();
  const sharedRefreshGate = new RequestGate();
  const snapshotRefreshGate = new RequestGate();
  const multipartProviderGate = new RequestGate();
  const sharedCatalogGate = new RequestGate();
  const videoSelectionGate = new RequestGate();
  const videoPreviewGate = new RequestGate();
  const documentSelectionGate = new RequestGate();
  const documentPreviewGate = new RequestGate();

  function setupToolNavigation() {
    for (const card of elements.toolStack.querySelectorAll('[data-outside-open]')) {
      const id = card.dataset.outsideOpen;
      const body = card.querySelector('.outside-tool-body');
      if (!id || !body) continue;
      toolCards.set(id, card);
      toolBodies.set(id, body);
      body.remove();
    }
  }

  function openOutsideTool(id) {
    const card = toolCards.get(String(id || ''));
    const body = toolBodies.get(String(id || ''));
    if (!card || !body) return;
    if (activeToolId && activeToolId !== id) closeOutsideTool({ focus: false });
    activeToolId = String(id);
    body.hidden = false;
    elements.toolDetailBody.replaceChildren(body);
    elements.toolDetailKicker.textContent = card.querySelector('.outside-tool-kicker')?.textContent || '';
    elements.toolDetailTitle.textContent = card.querySelector('h2')?.textContent || '工具';
    elements.toolDetailDescription.textContent = card.querySelector('.outside-tool-description')?.textContent || '';
    elements.homeHead.hidden = true;
    elements.toolStack.hidden = true;
    elements.toolDetail.hidden = false;
    elements.page.scrollTop = 0;
    elements.toolBack.focus();
    if (activeToolId === 'shared') {
      sharedRepositoryCheckedForEntry = false;
      if (outsideBackendReady) ensureSharedRepositoryReady().catch(() => {});
    }
  }

  function closeOutsideTool({ focus = true } = {}) {
    if (!activeToolId) return;
    const id = activeToolId;
    const card = toolCards.get(id);
    const body = toolBodies.get(id);
    activeToolId = '';
    if (id === 'shared') sharedRepositoryCheckedForEntry = false;
    if (body) {
      body.hidden = true;
      card?.appendChild(body);
    }
    elements.toolDetailBody.replaceChildren();
    elements.toolDetail.hidden = true;
    elements.homeHead.hidden = false;
    elements.toolStack.hidden = false;
    elements.page.scrollTop = 0;
    if (focus) card?.focus();
  }

  function renderOutsideCards() {
    const jobs = state.jobs || [];
    const activeJobs = (type) => jobs.filter((job) => job.type === type && ['queued', 'running'].includes(job.status)).length;
    const latestJob = (type) => jobs.filter((job) => job.type === type).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
    const parents = multipartState.parents || [];
    const runningParents = parents.filter((parent) => parent.activeSessions?.length || parent.status === 'running').length;
    const cards = {
      multipart: [`${parents.length} 个父任务`, `${runningParents} 个处理中`, `${(multipartState.collections || []).length} 个多P收藏夹`],
      shared: [`${(sharedData.mounts || []).length} 个远程挂载`, `${(sharedData.documents || []).length} 篇本地共享文档`, sharedData.authenticated ? `已授权 ${sharedData.login || 'GitHub'}` : '未授权上传'],
      subtitles: [`${activeJobs('subtitles')} 个处理中`, latestJob('subtitles') ? `最近：${statusLabel(latestJob('subtitles').status)}` : '尚无执行记录'],
      'video-import': [`${(state.videoCollections || []).length} 个缓存收藏夹`, `${activeJobs('video-import')} 个处理中`, latestJob('video-import') ? `最近：${statusLabel(latestJob('video-import').status)}` : '尚无执行记录'],
      'document-import': [`${(state.documentCollections || []).length} 个文档收藏夹`, `${activeJobs('document-import')} 个处理中`, latestJob('document-import') ? `最近：${statusLabel(latestJob('document-import').status)}` : '尚无执行记录']
    };
    for (const [id, values] of Object.entries(cards)) {
      const target = elements.toolStack.querySelector(`[data-outside-tool-stats="${id}"]`);
      if (target) target.innerHTML = values.map((value) => `<span>${esc(value)}</span>`).join('');
    }
  }

  async function refresh() {
    const generations = {
      local: localRefreshGate.next(),
      multipart: multipartRefreshGate.next(),
      shared: sharedRefreshGate.next(),
      snapshot: snapshotRefreshGate.next()
    };
    const [local, multipart, shared, currentSnapshot] = await Promise.all([
      window.orchestrator.localToolboxState(),
      window.orchestrator.multiPartState(),
      window.orchestrator.sharedState(),
      window.orchestrator.snapshot()
    ]);
    const accepted = {
      local: localRefreshGate.isCurrent(generations.local),
      multipart: multipartRefreshGate.isCurrent(generations.multipart),
      shared: sharedRefreshGate.isCurrent(generations.shared),
      snapshot: snapshotRefreshGate.isCurrent(generations.snapshot)
    };
    if (!Object.values(accepted).some(Boolean)) return state;
    if (accepted.local) state = local;
    if (accepted.multipart) multipartState = multipart;
    if (accepted.shared) applySharedState(shared);
    if (accepted.snapshot) snapshot = currentSnapshot;
    renderOutsideCards();
    renderJobs();
    renderMultipart();
    renderShared();
    return state;
  }

  function applySharedState(nextState) {
    const previousRepository = sharedRepositoryFullName(sharedData.repository || {});
    const nextRepository = sharedRepositoryFullName(nextState?.repository || {});
    if (previousRepository !== nextRepository) {
      sharedCatalogGate.next();
      setBusy(elements.sharedCatalog, false, '读取远程目录');
      sharedCatalogData = { repository: nextState?.repository || null, documents: [] };
      sharedCatalogLoadedKey = '';
      selectedRemotePaths.clear();
    }
    sharedData = nextState;
  }

  function scheduleInitialReadyRefresh() {
    if (!outsideBackendReady || readyRefreshStarted) return;
    readyRefreshStarted = true;
    refresh().catch((error) => notify('加载本地工具失败', error));
  }

  async function loadMultipartProviders() {
    await refreshMultipartProvidersForUi();
  }

  async function inspectMultipart() {
    const value = elements.multipartBvid.value.trim();
    if (!value) return notify('无法读取多P视频', '请先输入 BV 号或视频链接。');
    setBusy(elements.multipartInspect, true, '读取中');
    try {
      multipartInspection = await window.orchestrator.multiPartInspect({ bvid: value });
      renderMultipartInspection();
      await loadMultipartProviders();
      elements.multipartSettings.hidden = false;
    } catch (error) {
      multipartInspection = null;
      elements.multipartInspectResult.hidden = true;
      elements.multipartSettings.hidden = true;
      notify('读取多P列表失败', error);
    } finally { setBusy(elements.multipartInspect, false, '读取 P 列表'); }
  }

  function renderMultipartInspection() {
    if (!multipartInspection) return;
    const pages = multipartInspection.pages || [];
    elements.multipartInspectResult.hidden = false;
    elements.multipartInspectResult.innerHTML = `<div class="outside-subpanel-title"><strong>${esc(multipartInspection.title || multipartInspection.bvid)}</strong><span>${esc(multipartInspection.owner || '')} · ${pages.length} P</span></div><div class="multipart-page-list">${pages.map((page) => `<label class="multipart-page-row"><input class="app-checkbox" type="checkbox" data-multipart-page="${escAttr(page.cid)}" checked /><span class="multipart-page-number">P${Number(page.page || 1)}</span><span class="multipart-page-name">${esc(page.part || `P${page.page || 1}`)}</span><small>${formatDuration(page.duration)} · CID ${esc(page.cid)}</small></label>`).join('')}</div>`;
    renderMultipartCollections();
  }

  function renderMultipartCollections() {
    const collections = multipartState.collections || [];
    const currentCollection = elements.multipartCollection.value;
    elements.multipartCollection.innerHTML = `<option value="__new__">创建新收藏夹</option>${collections.map((item) => `<option value="${escAttr(item.id)}">${esc(item.name)}</option>`).join('')}`;
    if (collections.some((item) => item.id === currentCollection)) elements.multipartCollection.value = currentCollection;
    const defaultName = multipartInspection ? `${multipartInspection.title || multipartInspection.bvid} 多P` : '';
    const sameName = collections.find((item) => item.name === defaultName);
    if (!currentCollection || currentCollection === '__new__') elements.multipartCollection.value = sameName?.id || '__new__';
    if (!elements.multipartCollectionName.value) elements.multipartCollectionName.value = defaultName;
    const currentViewer = elements.multipartViewerCollection.value;
    elements.multipartViewerCollection.innerHTML = `<option value="">选择多P视频收藏夹</option>${collections.map((item) => `<option value="${escAttr(item.id)}">${esc(item.name)}</option>`).join('')}`;
    elements.multipartViewerCollection.value = collections.some((item) => item.id === currentViewer) ? currentViewer : (collections[0]?.id || '');
  }

  function renderMultipartModels() {
    const providers = [...(window.__starOwnerAgentProviders || [])];
    const selected = elements.multipartProvider.value;
    const provider = providers.find((item) => item.id === selected) || providers[0];
    elements.multipartModel.innerHTML = provider?.enabledModels?.length
      ? provider.enabledModels.map((model) => `<option value="${escAttr(model.id)}">${esc(model.name || model.id)}</option>`).join('')
      : '<option value="">请先启用模型</option>';
  }

  async function refreshMultipartProvidersForUi() {
    const generation = multipartProviderGate.next();
    const agentState = await window.orchestrator.internalAgentState();
    if (!multipartProviderGate.isCurrent(generation)) return;
    window.__starOwnerAgentProviders = agentState.providers || [];
    const current = elements.multipartProvider.value;
    const providers = (agentState.providers || []).filter((provider) => provider.enabled !== false && (provider.enabledModels || []).length);
    elements.multipartProvider.innerHTML = providers.length
      ? providers.map((provider) => `<option value="${escAttr(provider.id)}">${esc(provider.name || provider.id)}</option>`).join('')
      : '<option value="">请先在 AI 模型配置中启用模型</option>';
    elements.multipartProvider.value = providers.some((provider) => provider.id === current) ? current : (providers[0]?.id || '');
    renderMultipartModels();
  }

  function multipartSelectedCids() {
    return [...elements.multipartInspectResult.querySelectorAll('[data-multipart-page]:checked')].map((input) => input.dataset.multipartPage);
  }

  function multipartPayload() {
    const collectionId = elements.multipartCollection.value === '__new__' ? '' : elements.multipartCollection.value;
    return {
      bvid: elements.multipartBvid.value.trim(),
      providerId: elements.multipartProvider.value,
      modelId: elements.multipartModel.value,
      selectedPages: multipartSelectedCids(),
      collectionId,
      collectionName: collectionId ? '' : elements.multipartCollectionName.value.trim(),
      concurrency: Number(elements.multipartConcurrency.value || 2),
      minimumFrames: Number(elements.multipartMinimumFrames.value || 8),
      frameIntervalSeconds: Number(elements.multipartFrameInterval.value || 25),
      retainProcessCache: elements.multipartRetainCache.checked,
      taskRequirements: elements.multipartRequirements.value.trim()
    };
  }

  async function createMultipart(startAfter) {
    if (!multipartInspection) return notify('无法创建多P任务', '请先读取 BV 的 P 列表。');
    const payload = multipartPayload();
    if (!payload.selectedPages.length) return notify('无法创建多P任务', '请至少选择一个 P。');
    setBusy(startAfter ? elements.multipartCreateStart : elements.multipartCreate, true, startAfter ? '创建中' : '创建中');
    try {
      const parent = await window.orchestrator.multiPartCreate(payload);
      if (parent.existing) {
        const completed = (parent.existingCompletedCids || []).join(', ') || '无';
        const pending = (parent.existingPendingCids || []).join(', ') || '无';
        const message = `目标收藏夹已存在这个多P视频的产物。已完成 CID：${completed}；待处理 CID：${pending}。继续操作只会处理未完成 P，不会覆盖已完成 P。`;
        if (startAfter && !window.confirm(`${message}\n\n是否继续启动未完成范围？`)) {
          await refresh();
          return;
        }
        notify('检测到已有多P产物', message);
      }
      if (startAfter) await window.orchestrator.multiPartStart({ parentId: parent.id, ...payload });
      await refresh();
      notify(startAfter ? '多P任务已启动' : '多P父任务已创建', startAfter ? '已进入应用内 Agent 队列。' : '可在父任务查看器中选择范围后继续。');
    } catch (error) { notify('多P任务操作失败', error); }
    finally { setBusy(startAfter ? elements.multipartCreateStart : elements.multipartCreate, false, startAfter ? '创建并开始' : '创建父任务'); }
  }

  function renderMultipart() {
    renderMultipartCollections();
    const selectedCollectionId = elements.multipartViewerCollection.value;
    const parents = (multipartState.parents || []).filter((parent) => !selectedCollectionId || String(parent.collectionId) === String(selectedCollectionId));
    elements.multipartParentList.innerHTML = !selectedCollectionId
      ? '<div class="empty-state">请选择一个 B站多P类型收藏夹。</div>'
      : parents.length ? parents.map((parent) => {
      const status = parentStatusLabel(parent.status);
      const pages = (parent.pages || []).map((page) => {
        const task = page.task || {};
        const checked = (parent.selectedCids || []).map(String).includes(String(page.cid));
        const stateClass = task.pageState === 'removed' ? 'is-removed' : task.status === 'done' ? 'is-done' : 'is-pending';
        return `<label class="multipart-parent-page ${stateClass}"><input class="app-checkbox" type="checkbox" data-parent-id="${escAttr(parent.id)}" data-parent-page="${escAttr(page.cid)}" ${checked ? 'checked' : ''} ${task.pageState === 'removed' || task.status === 'done' ? 'disabled' : ''}/><span>P${Number(page.page || 1)} ${esc(page.part || '')}</span><small>${task.status === 'done' ? '已完成' : task.pageState === 'removed' ? '远程已移除' : '待处理'}</small></label>`;
      }).join('');
      return `<article class="multipart-parent-record" data-parent-record="${escAttr(parent.id)}"><div class="multipart-parent-head"><div><strong>${esc(parent.title)}</strong><small>${esc(parent.bvid)} · ${esc(parent.collectionName || '')} · ${status}</small></div><div class="multipart-parent-actions"><button class="secondary-button compact-button" type="button" data-multipart-action="refresh" data-parent-id="${escAttr(parent.id)}">刷新 P</button>${parent.activeSessions?.length ? `<button class="secondary-button compact-button" type="button" data-multipart-action="stop" data-parent-id="${escAttr(parent.id)}">停止</button>` : `<button class="primary-button compact-button" type="button" data-multipart-action="start" data-parent-id="${escAttr(parent.id)}">继续</button>`}<button class="secondary-button compact-button danger-button" type="button" data-multipart-action="delete" data-parent-id="${escAttr(parent.id)}">删除</button></div></div><div class="local-progress"><span style="width:${Math.round(Number(parent.progress || 0) * 100)}%"></span></div><div class="multipart-parent-summary">${parent.completed}/${parent.total} P · ${Math.round(Number(parent.progress || 0) * 100)}% · ${esc(status)}</div><div class="multipart-parent-pages">${pages}</div></article>`;
    }).join('') : '<div class="empty-state">这个收藏夹还没有多P父任务。</div>';
  }

  function parentStatusLabel(status) { return ({ pending: '待开始', running: '处理中', partial: '部分完成', stopped: '已停止', completed: '已完成' })[status] || status || '未知'; }

  async function startExistingMultipart(parentId) {
    const parent = (multipartState.parents || []).find((item) => item.id === parentId);
    if (!parent) return;
    const selectedPages = [...document.querySelectorAll(`[data-parent-id="${cssEscape(parentId)}"][data-parent-page]:checked`)].map((input) => input.dataset.parentPage);
    if (!selectedPages.length) return notify('无法继续多P任务', '请至少选择一个尚未完成的 P。');
    try {
      await window.orchestrator.multiPartStart({
        parentId,
        selectedPages,
        providerId: parent.settings?.providerId,
        modelId: parent.settings?.modelId,
        ...parent.settings?.taskOptions,
        taskRequirements: parent.settings?.taskRequirements || ''
      });
      await refresh();
    } catch (error) { notify('启动多P任务失败', error); }
  }

  async function handleMultipartAction(event) {
    const button = event.target.closest('[data-multipart-action]');
    if (!button) return;
    const parentId = button.dataset.parentId;
    const action = button.dataset.multipartAction;
    try {
      if (action === 'refresh') await window.orchestrator.multiPartRefresh(parentId);
      else if (action === 'start') await startExistingMultipart(parentId);
      else if (action === 'stop') await window.orchestrator.multiPartStop(parentId);
      else if (action === 'delete') {
        if (!window.confirm('确定删除这个多P父任务及其所有已完成 P 产物吗？')) return;
        await window.orchestrator.multiPartDelete(parentId);
      }
      await refresh();
    } catch (error) { notify('多P父任务操作失败', error); }
  }

  function sharedCollectionPayload() {
    const collectionId = elements.sharedCollection.value === '__new__' ? '' : elements.sharedCollection.value;
    return { collectionId, collectionName: collectionId ? '' : elements.sharedCollectionName.value.trim() };
  }

  function sharedDocumentRoot(document) {
    return String(document?.path || '').replace(/\/_star-owner-document\.json$/i, '');
  }

  function sharedCollectionPrefix(document) {
    const root = sharedDocumentRoot(document);
    const parts = root.split('/').filter(Boolean);
    return parts.slice(0, 3).join('/') || root;
  }

  function renderSharedCollections() {
    const collections = sharedData.collections || [];
    const current = elements.sharedCollection.value;
    elements.sharedCollection.innerHTML = `<option value="__new__">创建新共享收藏夹</option>${collections.map((item) => `<option value="${escAttr(item.id)}">${esc(item.name)}</option>`).join('')}`;
    if (collections.some((item) => item.id === current)) elements.sharedCollection.value = current;
    else if (collections.length && !elements.sharedCollectionName.value) elements.sharedCollection.value = collections[0].id;
  }

  function sharedRepositoryFullName(repository = sharedData.repository || {}) {
    return repository.owner && repository.name ? `${repository.owner}/${repository.name}` : '';
  }

  function sharedRepositoryOwnerMode(repository = sharedData.repository || {}) {
    const sameId = repository.ownerId && sharedData.userId && String(repository.ownerId) === String(sharedData.userId);
    const sameLogin = repository.owner && sharedData.login && String(repository.owner).toLowerCase() === String(sharedData.login).toLowerCase();
    return Boolean(sameId || (!repository.ownerId && sameLogin));
  }

  function sameSharedRepository(left = {}, right = {}) {
    return String(left.owner || '').toLowerCase() === String(right.owner || '').toLowerCase()
      && String(left.name || '').toLowerCase() === String(right.name || '').toLowerCase()
      && String(left.branch || 'main').toLowerCase() === String(right.branch || 'main').toLowerCase();
  }

  function renderSharedRepository() {
    const repository = sharedData.repository || {};
    const fullName = sharedRepositoryFullName(repository);
    const health = sharedData.repositoryHealth || {};
    const healthLabel = health.status === 'available' ? '连接正常' : health.status === 'unavailable' ? '连接异常' : '待检查';
    const role = !sharedData.authenticated ? '未授权时可读取公开目录' : sharedRepositoryOwnerMode(repository) ? '当前账户是仓库主人，将直接创建分支 / PR' : '当前账户不是仓库主人，将使用 Fork / PR';
    elements.sharedRepositoryStatus.textContent = fullName ? `${fullName} · ${repository.branch || 'main'} · ${healthLabel} · ${role}` : '尚未配置共享仓库。';
    const repositories = (sharedData.repositories || []).filter((item) => item.verified === true);
    const current = elements.sharedRepositorySelect.value;
    elements.sharedRepositorySelect.innerHTML = repositories.length
      ? repositories.map((item) => {
        const value = sharedRepositoryFullName(item);
        const suffix = item.health === 'unavailable' ? ' · 连接异常' : item.builtIn ? ' · 内置默认' : '';
        return `<option value="${escAttr(value)}">${esc(value)}${esc(suffix)}</option>`;
      }).join('')
      : '<option value="">尚无已验证仓库</option>';
    elements.sharedRepositorySelect.value = repositories.some((item) => sharedRepositoryFullName(item) === fullName)
      ? fullName
      : (repositories.some((item) => sharedRepositoryFullName(item) === current) ? current : (repositories[0] ? sharedRepositoryFullName(repositories[0]) : ''));
    elements.sharedRepositorySelect.disabled = !repositories.length;
    elements.sharedRepositoryOpen.disabled = !repository.htmlUrl && !fullName;
  }

  async function saveSharedRepository() {
    const repository = elements.sharedRepositoryInput.value.trim();
    if (!repository) return notify('连接共享仓库失败', '请填写 owner/repository 或完整 GitHub 仓库链接。');
    setBusy(elements.sharedRepositorySave, true, '验证中');
    try {
      const result = await runSharedUiOperation({ type: 'repository-link', message: '正在检测并连接共享仓库...' }, () => (
        window.orchestrator.sharedSetRepository({ repository })
      ));
      sharedCatalogData = { repository: result.repository, documents: [] };
      sharedCatalogLoadedKey = '';
      selectedRemotePaths.clear();
      selectedUploadTaskIds.clear();
      selectedPreparedTaskIds.clear();
      elements.sharedRepositoryInput.value = '';
      await refresh();
      await loadSharedCatalog({ force: true, quiet: true });
      notify('共享仓库已验证并连接', `${result.repository.owner}/${result.repository.name} · ${result.repository.branch}`, 'success');
    } catch (error) { notify('连接共享仓库失败', error); }
    finally { setBusy(elements.sharedRepositorySave, false, '检测并连接'); }
  }

  async function selectSharedRepository() {
    const repository = elements.sharedRepositorySelect.value;
    if (!repository || repository === sharedRepositoryFullName()) return;
    elements.sharedRepositorySelect.disabled = true;
    try {
      const result = await runSharedUiOperation({ type: 'repository-link', message: '正在检查并切换共享仓库...' }, () => (
        window.orchestrator.sharedSetRepository({ repository })
      ));
      sharedCatalogData = { repository: result.repository, documents: [] };
      sharedCatalogLoadedKey = '';
      selectedRemotePaths.clear();
      selectedMountIds.clear();
      await refresh();
      await loadSharedCatalog({ force: true, quiet: true });
    } catch (error) {
      notify('切换共享仓库失败', error);
      await refresh();
    } finally { elements.sharedRepositorySelect.disabled = false; }
  }

  async function createSharedRepository() {
    const name = elements.sharedRepositoryCreateName.value.trim();
    if (!name) return notify('创建共享仓库失败', '请填写公开仓库名称。');
    if (!window.confirm(`将在当前授权的 GitHub 账户下创建公开仓库“${name}”，并写入 README、配置文件和 GitHub Actions。是否继续？`)) return;
    setBusy(elements.sharedRepositoryCreate, true, '创建中');
    try {
      const result = await runSharedUiOperation({ type: 'repository-create', message: '正在创建并初始化共享仓库...' }, () => (
        window.orchestrator.sharedCreateRepository({ name })
      ));
      sharedCatalogData = { repository: result.repository, documents: [] };
      sharedCatalogLoadedKey = '';
      selectedRemotePaths.clear();
      selectedUploadTaskIds.clear();
      selectedPreparedTaskIds.clear();
      await refresh();
      await loadSharedCatalog({ force: true, quiet: true });
      notify('个人共享仓库已创建', `已初始化 ${result.initializedFiles} 个配置文件，并切换到 ${result.repository.owner}/${result.repository.name}。`, 'success');
    } catch (error) { notify('创建共享仓库失败', error); }
    finally { setBusy(elements.sharedRepositoryCreate, false, '一键创建并初始化'); }
  }

  async function openSharedRepository() {
    const repository = sharedData.repository || {};
    const url = repository.htmlUrl || (sharedRepositoryFullName(repository) ? `https://github.com/${sharedRepositoryFullName(repository)}` : '');
    if (url) await window.orchestrator.openExternal(url);
  }

  function updateSharedOperation(operation) {
    if (sharedOperationHideTimer) clearTimeout(sharedOperationHideTimer);
    sharedOperationView = operation || null;
    renderSharedOperation();
    if (operation && ['completed', 'failed'].includes(operation.status)) {
      sharedOperationHideTimer = setTimeout(() => {
        sharedOperationView = null;
        renderSharedOperation();
      }, operation.status === 'failed' ? 3200 : 1200);
    }
  }

  function stopSharedOperationPolling() {
    sharedOperationPollGeneration += 1;
    sharedOperationPollInFlight = false;
    if (sharedOperationPollTimer) clearInterval(sharedOperationPollTimer);
    sharedOperationPollTimer = null;
  }

  function beginSharedOperationPolling(seed = {}) {
    stopSharedOperationPolling();
    const generation = sharedOperationPollGeneration;
    sharedData.operation = null;
    updateSharedOperation({
      id: `renderer:${Date.now()}`,
      type: String(seed.type || 'operation'),
      status: 'running',
      stage: 'starting',
      progress: 0.01,
      current: 0,
      total: 0,
      message: String(seed.message || '正在执行共享工具操作...')
    });
    sharedOperationPollTimer = setInterval(async () => {
      if (sharedOperationPollInFlight || generation !== sharedOperationPollGeneration) return;
      sharedOperationPollInFlight = true;
      try {
        const operation = await window.orchestrator.sharedOperationState();
        if (generation !== sharedOperationPollGeneration || !operation) return;
        updateSharedOperation(operation);
      } catch {}
      finally { if (generation === sharedOperationPollGeneration) sharedOperationPollInFlight = false; }
    }, 240);
  }

  async function runSharedUiOperation(seed, callback) {
    beginSharedOperationPolling(seed);
    try {
      const result = await callback();
      const current = sharedOperationView || sharedData.operation || {};
      sharedData.operation = null;
      updateSharedOperation({ ...current, type: seed.type, status: 'completed', stage: 'completed', progress: 1, message: sharedOperationCompletedMessage(seed.type) });
      return result;
    } catch (error) {
      const current = sharedOperationView || sharedData.operation || {};
      sharedData.operation = null;
      updateSharedOperation({ ...current, type: seed.type, status: 'failed', stage: 'failed', message: error?.message || String(error) });
      throw error;
    } finally {
      stopSharedOperationPolling();
    }
  }

  function sharedOperationCompletedMessage(type) {
    return ({
      'repository-link': '共享仓库已验证并连接。',
      'repository-check': '共享仓库检查完成。',
      'repository-create': '共享仓库创建和初始化完成。',
      'catalog-read': '远程目录读取完成。',
      mount: '远程文档挂载完成。',
      'mount-sync': '共享挂载同步完成。',
      'mount-sync-batch': '选中的共享挂载已同步。'
    })[type] || '共享工具操作已完成。';
  }

  function renderSharedOperation() {
    const operation = sharedOperationView || sharedData.operation;
    const visible = Boolean(operation);
    elements.sharedOperationProgress.hidden = !visible;
    if (!visible) return;
    const progress = Math.max(0, Math.min(1, Number(operation.progress || 0)));
    elements.sharedOperationProgress.classList.toggle('is-failed', operation.status === 'failed');
    elements.sharedOperationProgress.classList.toggle('is-complete', operation.status === 'completed');
    elements.sharedOperationMessage.textContent = operation.message || '正在执行共享工具操作...';
    elements.sharedOperationCount.textContent = Number(operation.total || 0) > 0 ? `${Number(operation.current || 0)} / ${Number(operation.total)} 项` : '';
    elements.sharedOperationBar.style.width = `${Math.round(progress * 100)}%`;
    elements.sharedOperationPercent.textContent = `${Math.round(progress * 100)}%`;
  }

  async function ensureSharedRepositoryReady() {
    if (!outsideBackendReady || sharedRepositoryCheckedForEntry || sharedRepositoryCheckPromise) return sharedRepositoryCheckPromise;
    sharedRepositoryCheckedForEntry = true;
    sharedRepositoryCheckPromise = (async () => {
      try {
        const result = await runSharedUiOperation({ type: 'repository-check', message: '正在检查已连接的共享仓库...' }, () => (
          window.orchestrator.sharedCheckRepository()
        ));
        await refresh();
        const key = sharedRepositoryFullName(result.repository);
        if (sharedCatalogLoadedKey !== key) await loadSharedCatalog({ force: true, quiet: true });
      } catch (error) {
        await refresh().catch(() => {});
        notify('共享仓库连接检查失败', error);
      } finally { sharedRepositoryCheckPromise = null; }
    })();
    return sharedRepositoryCheckPromise;
  }

  function renderSharedUploadProgress(upload = sharedData.upload) {
    const active = Boolean(upload && ['running', 'cancelling'].includes(upload.status)) || sharedUploadInvocationActive;
    elements.sharedUploadProgressModal.hidden = !active;
    elements.appShell.inert = active;
    document.body.classList.toggle('shared-upload-locked', active);
    if (!active) return;
    const progress = Math.max(0, Math.min(1, Number(upload?.progress || 0)));
    elements.sharedUploadProgressMessage.textContent = upload?.message || '正在准备共享文档...';
    elements.sharedUploadProgressCount.textContent = `${Number(upload?.current || 0)} / ${Number(upload?.total || selectedUploadTaskIds.size || 0)} 篇`;
    elements.sharedUploadProgressBar.style.width = `${Math.round(progress * 100)}%`;
    elements.sharedUploadProgressPercent.textContent = `${Math.round(progress * 100)}%`;
    elements.sharedUploadCancel.disabled = upload?.status === 'cancelling';
    elements.sharedUploadCancel.textContent = upload?.status === 'cancelling' ? '正在中止' : '中止上传';
    requestAnimationFrame(() => elements.sharedUploadCancel.focus());
  }

  function renderShared() {
    const method = sharedData.authMethod === 'browser' ? '浏览器授权' : sharedData.authMethod === 'token' ? 'Token 授权' : '';
    const login = sharedData.authenticated ? `已授权：${sharedData.login || 'GitHub 用户'}（${sharedData.userId || 'ID 已隐藏'}${method ? ` · ${method}` : ''}）` : '公共仓库目录可以直接浏览；上传和创建 Pull Request 需要 GitHub 授权。';
    elements.sharedAuthStatus.textContent = login;
    elements.sharedLogout.hidden = !sharedData.authenticated;
    renderSharedRepository();
    renderSharedCollections();
    renderSharedCatalog();
    renderSharedMounts();
    renderSharedUploads();
    renderSharedOperation();
    renderSharedUploadProgress();
  }

  function filteredSharedDocuments() {
    const githubQuery = elements.sharedGithubFilter.value.trim().toLocaleLowerCase();
    const bilibiliQuery = elements.sharedBilibiliFilter.value.trim().toLocaleLowerCase();
    const videoQuery = elements.sharedVideoFilter.value.trim().toLocaleLowerCase();
    return (sharedCatalogData.documents || []).filter((document) => {
      const githubName = sharedGithubName(document).toLocaleLowerCase();
      const bilibiliName = sharedBilibiliName(document).toLocaleLowerCase();
      const videoText = [document.title, document.owner, document.bvid].map((value) => String(value || '').toLocaleLowerCase()).join(' ');
      return (!githubQuery || githubName.includes(githubQuery))
        && (!bilibiliQuery || bilibiliName.includes(bilibiliQuery))
        && (!videoQuery || videoText.includes(videoQuery));
    });
  }

  function sharedGithubName(document) {
    return String(document?.contributorGithubLogin || '').trim() || (document?.contributorGithubId ? '未公开名称的 GitHub 贡献者' : '未知 GitHub 贡献者');
  }

  function sharedBilibiliName(document) {
    const value = String(document?.userName || '').trim();
    if (value && value !== '内置用户') return value;
    if (document?.documentType === 'multipart-parent' || document?.sourceCollectionKind === 'bilibili-multipart') return '内置来源 · B站多P视频';
    if (String(document?.sourceCollectionKind || '').startsWith('single') || String(document?.remoteCollectionId || '').startsWith('single:')) return '内置来源 · B站单视频';
    return value || '未知哔哩哔哩用户';
  }

  function sharedCollectionName(document) {
    return String(document?.collectionName || '').trim() || (document?.documentType === 'multipart-parent' ? 'B站多P视频总结' : '未命名收藏夹');
  }

  function sharedCollectionKey(document) {
    return String(document?.remoteCollectionId || sharedCollectionPrefix(document) || document?.collectionName || '').trim();
  }

  function sharedDocumentLocalStatus(document) {
    const targetCollectionId = elements.sharedCollection.value === '__new__' ? '' : elements.sharedCollection.value;
    const repository = sharedCatalogData.repository || sharedData.repository || {};
    const matches = (sharedData.documents || []).filter((item) => sameSharedRepository(item.sharedRepository || {}, repository)
      && (String(item.sharedRemotePath || '') === String(document.path || '') || String(item.sharedDocumentId || '') === String(document.documentId || '')));
    const target = targetCollectionId ? matches.filter((item) => item.collectionId === targetCollectionId) : [];
    const local = target[0] || matches[0];
    if (document.invalid) return { label: '远程元数据无效', code: 'invalid' };
    if (!local) return { label: '未下载', code: 'new' };
    if (local.remoteState === 'remote-deleted') return { label: '远程已失效（本地保留）', code: 'stale' };
    if (local.remoteState === 'sync-conflict') return { label: '同步冲突（本地保留）', code: 'conflict' };
    if (local.remoteState === 'local-modified') return { label: '本地已修改', code: 'modified' };
    const remoteTime = Date.parse(document.updatedAt || document.uploadedAt || '') || 0;
    const localTime = Date.parse(local.remoteUpdatedAt || '') || 0;
    const needsUpdate = Boolean(document.remoteSha && local.sharedRemoteSha && document.remoteSha !== local.sharedRemoteSha) || (remoteTime > localTime && localTime > 0);
    if (needsUpdate) return { label: targetCollectionId ? '需要更新' : '已下载但有远程更新', code: 'update' };
    if (targetCollectionId && target.length) return { label: '已下载且为最新', code: 'latest' };
    return { label: '已下载到其它共享收藏夹', code: 'other' };
  }

  function renderSharedCatalog() {
    const documents = filteredSharedDocuments();
    const validDocuments = documents.filter((document) => !document.invalid);
    const allDocuments = sharedCatalogData.documents || [];
    const knownPaths = new Set(allDocuments.filter((document) => !document.invalid).map((document) => String(document.path)));
    for (const pathName of [...selectedRemotePaths]) if (!knownPaths.has(pathName)) selectedRemotePaths.delete(pathName);
    const githubNames = [...new Set(allDocuments.filter((item) => !item.invalid).map(sharedGithubName))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const bilibiliNames = [...new Set(allDocuments.filter((item) => !item.invalid).map(sharedBilibiliName))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const videoNames = [...new Set(allDocuments.filter((item) => !item.invalid).map((item) => String(item.title || item.bvid || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    elements.sharedGithubOptions.innerHTML = githubNames.map((value) => `<option value="${escAttr(value)}"></option>`).join('');
    elements.sharedBilibiliOptions.innerHTML = bilibiliNames.map((value) => `<option value="${escAttr(value)}"></option>`).join('');
    elements.sharedVideoOptions.innerHTML = videoNames.map((value) => `<option value="${escAttr(value)}"></option>`).join('');
    elements.sharedCatalogResultCount.textContent = sharedCatalogLoadedKey ? `显示 ${validDocuments.length} / ${allDocuments.length} 篇 · 已勾选 ${selectedRemotePaths.size} 篇` : '尚未读取目录';
    elements.sharedMountFiltered.disabled = !validDocuments.length;
    elements.sharedMount.disabled = !selectedRemotePaths.size;
    if (!documents.length) {
      elements.sharedCatalogList.innerHTML = `<div class="empty-state">${sharedCatalogLoadedKey ? '当前筛选条件下没有远程共享文档。' : '尚未读取远程目录。'}</div>`;
      return;
    }
    const githubGroups = new Map();
    for (const document of validDocuments) {
      const githubName = sharedGithubName(document);
      const githubKey = `${githubName}|${document.contributorGithubId || ''}`;
      if (!githubGroups.has(githubKey)) githubGroups.set(githubKey, { name: githubName, items: new Map() });
      const github = githubGroups.get(githubKey);
      const bilibiliName = sharedBilibiliName(document);
      const bilibiliKey = `${bilibiliName}|${document.bilibiliUid || document.userId || document.sourceCollectionKind || ''}`;
      if (!github.items.has(bilibiliKey)) github.items.set(bilibiliKey, { name: bilibiliName, collections: new Map() });
      const bilibili = github.items.get(bilibiliKey).collections;
      const collectionKey = sharedCollectionKey(document);
      if (!bilibili.has(collectionKey)) bilibili.set(collectionKey, { name: sharedCollectionName(document), prefix: sharedCollectionPrefix(document), documents: [] });
      bilibili.get(collectionKey).documents.push(document);
    }
    const tree = [...githubGroups.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).map((github, githubIndex) => {
      const githubCount = [...github.items.values()].flatMap((group) => [...group.collections.values()].flatMap((collection) => collection.documents)).length;
      const bilibiliHtml = [...github.items.values()].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')).map(({ name: bilibiliName, collections }) => {
        const bilibiliCount = [...collections.values()].reduce((sum, collection) => sum + collection.documents.length, 0);
        const collectionsHtml = [...collections.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).map((collection) => {
          const rows = [...collection.documents].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).map((document) => {
            const status = sharedDocumentLocalStatus(document);
            const updated = document.updatedAt || document.uploadedAt || '时间未知';
            return `<div class="shared-catalog-row shared-state-${escAttr(status.code)}"><input class="app-checkbox" type="checkbox" data-shared-path="${escAttr(document.path)}" ${selectedRemotePaths.has(String(document.path)) ? 'checked' : ''}/><span class="shared-catalog-main"><strong title="${escAttr(document.title || document.bvid || '')}">${esc(document.title || document.bvid || '未命名视频')}</strong><small>${esc(document.bvid || '无 BV')} · ${esc(document.owner || '未知UP主')} · ${esc(updated)}</small></span><span class="shared-catalog-status"><strong>${esc(status.label)}</strong><small>${esc(sharedGithubName(document))}</small></span><button class="secondary-button compact-button" type="button" data-shared-mount-path="${escAttr(document.path)}">挂载此文档</button></div>`;
          }).join('');
          return `<details class="shared-tree-node shared-tree-collection"><summary><span class="shared-tree-marker">COL</span><span><strong title="${escAttr(collection.name)}">${esc(collection.name)}</strong><small>${collection.documents.length} 篇视频总结</small></span><em>${collection.documents.length}</em><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary><div class="shared-tree-collection-body"><div class="shared-tree-collection-tools"><span>可挂载整个远程收藏夹，后续同步会自动带入新增文档。</span><button class="secondary-button compact-button" type="button" data-shared-mount-prefix="${escAttr(collection.prefix)}">挂载此收藏夹</button></div>${rows}</div></details>`;
        }).join('');
        return `<details class="shared-tree-node shared-tree-bilibili" ${github.items.size === 1 ? 'open' : ''}><summary><span class="shared-tree-marker">BILI</span><span><strong title="${escAttr(bilibiliName)}">${esc(bilibiliName)}</strong><small>${collections.size} 个收藏夹 · ${bilibiliCount} 篇</small></span><em>${bilibiliCount}</em><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary><div class="shared-tree-children">${collectionsHtml}</div></details>`;
      }).join('');
      return `<details class="shared-tree-node shared-tree-github" ${githubGroups.size === 1 || githubIndex === 0 ? 'open' : ''}><summary><span class="shared-tree-marker">GH</span><span><strong title="${escAttr(github.name)}">${esc(github.name)}</strong><small>${github.items.size} 个哔哩哔哩用户 · ${githubCount} 篇</small></span><em>${githubCount}</em><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary><div class="shared-tree-children">${bilibiliHtml}</div></details>`;
    }).join('');
    const invalid = documents.filter((document) => document.invalid);
    const invalidHtml = invalid.length ? `<details class="shared-tree-node shared-tree-invalid"><summary><span class="shared-tree-marker">ERR</span><span><strong>无法识别的远程条目</strong><small>元数据不符合共享规范，无法挂载</small></span><em>${invalid.length}</em><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary><div class="shared-tree-invalid-list">${invalid.map((document) => `<div><strong>${esc(document.error || '远程元数据无效')}</strong></div>`).join('')}</div></details>` : '';
    elements.sharedCatalogList.innerHTML = tree + invalidHtml;
  }

  async function loadSharedCatalog({ force = true, quiet = false } = {}) {
    const generation = sharedCatalogGate.next();
    setBusy(elements.sharedCatalog, true, '读取中');
    try {
      const nextCatalog = await runSharedUiOperation({ type: 'catalog-read', message: '正在读取远程共享目录...' }, () => (
        window.orchestrator.sharedCatalog({ force })
      ));
      if (!sharedCatalogGate.isCurrent(generation)) return false;
      sharedCatalogData = nextCatalog;
      sharedCatalogLoadedKey = sharedRepositoryFullName(sharedCatalogData.repository || sharedData.repository || {});
      selectedRemotePaths.clear();
      renderSharedCatalog();
      if (!quiet) notify('远程共享目录已读取', `共读取 ${Number(sharedCatalogData.total || 0)} 篇文档。`, 'success');
      return true;
    }
    catch (error) {
      if (sharedCatalogGate.isCurrent(generation)) notify('读取 GitHub 共享目录失败', error);
      return false;
    }
    finally {
      if (sharedCatalogGate.isCurrent(generation)) setBusy(elements.sharedCatalog, false, '读取远程目录');
    }
  }

  async function setSharedToken() {
    const token = elements.sharedToken.value.trim();
    if (!token) return notify('保存授权失败', '请先粘贴 GitHub Fine-grained Token。');
    setBusy(elements.sharedSetToken, true, '验证中');
    try { await window.orchestrator.sharedSetToken(token); elements.sharedToken.value = ''; await refresh(); }
    catch (error) { notify('GitHub 授权失败', error); }
    finally { setBusy(elements.sharedSetToken, false, '保存 Token'); }
  }

  async function browserSharedLogin() {
    setBusy(elements.sharedLogin, true, '等待浏览器授权');
    try { await window.orchestrator.sharedBrowserLogin(); await refresh(); notify('GitHub 授权成功', '已从项目内置 Git 凭据环境读取授权，可创建 Fork / Pull Request。', 'success'); }
    catch (error) { notify('GitHub 浏览器授权失败', error); }
    finally { setBusy(elements.sharedLogin, false, '浏览器登录 GitHub'); }
  }

  async function clearSharedAuthorization() {
    if (!window.confirm('将清除星藏家应用数据库和内置 Git 私有存储中的 GitHub 授权，用于切换提交账户。\n\n绝不会清除系统 Git、系统凭据库或用户全局 Git 配置。是否继续？')) return;
    try {
      const result = await window.orchestrator.sharedLogout();
      selectedUploadTaskIds.clear();
      document.querySelector('#sharedAuthMore').open = false;
      await refresh();
      notify('GitHub 授权已清除', result?.message || '已清除星藏家保存的 GitHub 授权。', 'success');
    } catch (error) { notify('清除 GitHub 授权失败', error); }
  }

  async function mountShared({ paths = null, remotePrefix = '', button = null } = {}) {
    const selectedPaths = paths || [...selectedRemotePaths];
    if (!selectedPaths.length && !remotePrefix) return notify('无法挂载共享文档', '请勾选文档、使用“挂载筛选结果”，或点击收藏夹/文档旁的挂载按钮。');
    if (button) setBusy(button, true, '挂载中');
    try {
      const result = await runSharedUiOperation({ type: 'mount', message: '正在挂载远程共享文档...' }, () => (
        window.orchestrator.sharedMount({ paths: selectedPaths, remotePrefix, ...sharedCollectionPayload() })
      ));
      for (const pathName of selectedPaths) selectedRemotePaths.delete(String(pathName));
      await refresh();
      renderSharedCatalog();
      notify(result?.unchanged ? '远程内容没有变化' : '共享文档挂载完成', result?.unchanged
        ? '本地文档完整且远程收藏夹版本未变化，本次无需重复下载。'
        : remotePrefix ? '远程收藏夹已挂载，后续同步会自动加入新增文档。' : `已挂载 ${selectedPaths.length} 篇远程文档。`, 'success');
    }
    catch (error) { notify('挂载共享文档失败', error); }
    finally { if (button) setBusy(button, false, button === elements.sharedMountFiltered ? '挂载筛选结果' : button === elements.sharedMount ? '挂载勾选文档' : button.dataset.sharedMountPrefix ? '挂载此收藏夹' : '挂载此文档'); }
  }

  function renderSharedMounts() {
    const mounts = sharedData.mounts || [];
    const collections = sharedData.collections || [];
    const documents = (sharedData.documents || []).filter((item) => item.multiPartRole !== 'part');
    const openCollectionIds = new Set([...elements.sharedMountList.querySelectorAll('details[data-shared-local-collection][open]')].map((item) => String(item.dataset.sharedLocalCollection)));
    const openMountIds = new Set([...elements.sharedMountList.querySelectorAll('details[data-shared-local-mount][open]')].map((item) => String(item.dataset.sharedLocalMount)));
    const validIds = new Set(mounts.map((mount) => String(mount.id)));
    for (const id of [...selectedMountIds]) if (!validIds.has(id)) selectedMountIds.delete(id);
    elements.sharedMountSelectAll.disabled = !mounts.length;
    elements.sharedMountSelectAll.textContent = mounts.length && selectedMountIds.size === mounts.length ? '取消全选' : '全选挂载';
    elements.sharedSyncSelected.disabled = !selectedMountIds.size;
    elements.sharedSyncSelected.textContent = selectedMountIds.size ? `同步选中（${selectedMountIds.size}）` : '同步选中';
    if (!collections.length) {
      elements.sharedMountList.innerHTML = '<div class="empty-state">还没有本地“共享”收藏夹。</div>';
      return;
    }
    const documentState = (document) => {
      if (document.remoteState === 'remote-deleted') return { code: 'stale', label: '远程已失效，本地保留' };
      if (document.remoteState === 'sync-conflict') return { code: 'conflict', label: '同步冲突，本地保留' };
      if (document.remoteState === 'local-modified') return { code: 'modified', label: '本地已修改' };
      if (document.remoteState === 'local-deleted') return { code: 'stale', label: '已从本地移除' };
      return { code: 'latest', label: '已挂载' };
    };
    elements.sharedMountList.innerHTML = [...collections].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN')).map((collection, collectionIndex) => {
      const collectionMounts = mounts.filter((mount) => String(mount.collectionId) === String(collection.id));
      const collectionMountIds = new Set(collectionMounts.map((mount) => String(mount.id)));
      const collectionDocuments = documents.filter((document) => (document.sharedMountIds || []).some((id) => collectionMountIds.has(String(id))));
      const mountHtml = [...collectionMounts].sort((a, b) => String(a.remoteCollectionName || a.remotePrefix || '').localeCompare(String(b.remoteCollectionName || b.remotePrefix || ''), 'zh-CN')).map((mount) => {
        const mountDocuments = documents.filter((document) => (document.sharedMountIds || []).map(String).includes(String(mount.id)));
        const remoteName = mount.remoteCollectionName || String(mount.remotePrefix || '').split('/').filter(Boolean).at(-1) || '远程收藏夹';
        const repositoryName = sharedRepositoryFullName(mount.repository || {}) || '未知共享仓库';
        const identity = [mount.remoteContributorGithubLogin ? `GitHub ${mount.remoteContributorGithubLogin}` : '', mount.remoteBilibiliName ? `B站 ${mount.remoteBilibiliName}` : ''].filter(Boolean).join(' · ');
        const scope = mount.scope === 'collection' ? '完整收藏夹挂载，后续同步会自动加入远程新增文档' : `当前挂载 ${Number(mount.remoteDocumentCount || mountDocuments.length)} 篇文档`;
        const rows = [...mountDocuments].sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN')).map((document) => {
          const status = documentState(document);
          return `<div class="shared-local-document-row shared-state-${escAttr(status.code)}"><span class="shared-tree-marker">MD</span><span class="shared-local-document-main"><strong title="${escAttr(document.title || document.bvid || '')}">${esc(document.title || document.bvid || '未命名视频')}</strong><small>${esc(document.bvid || '无 BV')} · ${esc(document.owner || '未知UP主')} · ${document.remoteUpdatedAt ? `远程更新 ${esc(formatUploadDate(document.remoteUpdatedAt))}` : '远程时间未知'}</small></span><span class="shared-local-document-status">${esc(status.label)}</span></div>`;
        }).join('');
        const mountOpen = openMountIds.has(String(mount.id)) || collectionMounts.length === 1;
        return `<details class="shared-tree-node shared-local-remote" data-shared-local-mount="${escAttr(mount.id)}" ${mountOpen ? 'open' : ''}><summary><input class="app-checkbox" type="checkbox" data-shared-mount-select="${escAttr(mount.id)}" aria-label="选择远程收藏夹挂载 ${escAttr(remoteName)}" ${selectedMountIds.has(String(mount.id)) ? 'checked' : ''}/><span class="shared-tree-marker">REMOTE</span><span><strong title="${escAttr(remoteName)}">${esc(remoteName)}</strong><small>${esc(repositoryName)}${identity ? ` · ${esc(identity)}` : ''}</small></span><em>${mountDocuments.length}</em><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary><div class="shared-local-source-body"><div class="shared-local-source-tools"><span>${esc(scope)} · ${mount.lastSyncedAt ? `上次同步 ${esc(formatUploadDate(mount.lastSyncedAt))}` : '尚未同步'}</span><div class="shared-mount-actions"><button class="secondary-button compact-button" type="button" data-shared-action="sync" data-mount-id="${escAttr(mount.id)}">同步</button><button class="secondary-button compact-button danger-button" type="button" data-shared-action="unmount" data-mount-id="${escAttr(mount.id)}">解除挂载</button></div></div>${rows || '<div class="empty-state shared-local-empty">该远程收藏夹当前没有可显示的本地文档。</div>'}</div></details>`;
      }).join('');
      const collectionOpen = openCollectionIds.has(String(collection.id)) || collections.length === 1 || collectionIndex === 0;
      return `<details class="shared-tree-node shared-local-collection" data-shared-local-collection="${escAttr(collection.id)}" ${collectionOpen ? 'open' : ''}><summary><span class="shared-tree-marker">LOCAL</span><span><strong title="${escAttr(collection.name || collection.id)}">${esc(collection.name || collection.id)}</strong><small>${collectionMounts.length} 个远程收藏夹挂载源 · ${collectionDocuments.length} 篇文档</small></span><em>${collectionMounts.length}</em><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary><div class="shared-tree-children shared-local-collection-body">${mountHtml || '<div class="empty-state shared-local-empty">该共享收藏夹尚未挂载远程收藏夹。</div>'}</div></details>`;
    }).join('');
  }

  function shareableUploadItems() {
    const collections = new Map((snapshot.collections || []).map((collection) => [String(collection.id), collection]));
    const users = new Map((snapshot.users || []).map((user) => [String(user.id), user]));
    return (snapshot.tasks || []).filter((task) => {
      const collection = collections.get(String(task.collectionId)) || {};
      return isShareableSnapshotTask(task, collection);
    }).map((task) => {
      const collection = collections.get(String(task.collectionId)) || {};
      const user = users.get(String(collection.userId)) || {};
      return {
        task,
        collection,
        userName: String(collection.userName || user.name || '未知用户'),
        userId: String(collection.userId || user.id || ''),
        collectionName: String(collection.name || task.collectionName || task.collectionId || '未知收藏夹'),
        completedAt: String(task.completedAt || task.updatedAt || task.createdAt || ''),
        duration: Math.max(0, Number(task.duration || 0))
      };
    });
  }

  function isShareableSnapshotTask(task, collection) {
    const sourceType = String(task.sourceType || '');
    if (task.status !== 'done' || !task.outputMarkdown || task.documentExists === false || !task.bvid || sourceType.startsWith('local-') || sourceType.startsWith('shared-') || task.multiPartRole === 'part') return false;
    if (task.multiPartRole === 'parent') return collection.collectionKind === 'bilibili-multipart' && collection.internal === true;
    if (task.singleTask === true) return collection.internal === true && !collection.mediaId && !['video-cache', 'multimodal-document', 'document-archive', 'bilibili-multipart', 'shared'].includes(collection.collectionKind);
    return Boolean(collection.mediaId) && collection.internal !== true && !['video-cache', 'multimodal-document', 'document-archive', 'bilibili-multipart', 'shared'].includes(collection.collectionKind);
  }

  function updateSharedUploadDuration(items) {
    const nextMaximum = Math.max(1, ...items.map((item) => Math.ceil(item.duration || 0)));
    if (nextMaximum !== uploadDurationMaximum) {
      const previousMaximum = uploadDurationMaximum;
      const previousUpper = Number(elements.sharedUploadDurationMax.value || previousMaximum);
      elements.sharedUploadDurationMin.max = String(nextMaximum);
      elements.sharedUploadDurationMax.max = String(nextMaximum);
      elements.sharedUploadDurationMin.value = String(Math.min(Number(elements.sharedUploadDurationMin.value || 0), nextMaximum));
      elements.sharedUploadDurationMax.value = String(previousMaximum <= 1 || previousUpper >= previousMaximum ? nextMaximum : Math.min(previousUpper, nextMaximum));
      uploadDurationMaximum = nextMaximum;
    }
    normalizeSharedUploadDuration();
  }

  function normalizeSharedUploadDuration(changed = '') {
    let minimum = Number(elements.sharedUploadDurationMin.value || 0);
    let maximum = Number(elements.sharedUploadDurationMax.value || uploadDurationMaximum);
    if (minimum > maximum) {
      if (changed === 'minimum') maximum = minimum;
      else minimum = maximum;
    }
    elements.sharedUploadDurationMin.value = String(minimum);
    elements.sharedUploadDurationMax.value = String(maximum);
    elements.sharedUploadDurationLabel.textContent = minimum <= 0 && maximum >= uploadDurationMaximum
      ? '全部时长'
      : `${formatUploadDuration(minimum)} - ${maximum >= uploadDurationMaximum ? '不限' : formatUploadDuration(maximum)}`;
  }

  function filteredSharedUploadItems(allItems = shareableUploadItems()) {
    const query = elements.sharedUploadFilter.value.trim().toLocaleLowerCase();
    const userQuery = elements.sharedUploadUserFilter.value.trim().toLocaleLowerCase();
    const collectionQuery = elements.sharedUploadCollectionFilter.value.trim().toLocaleLowerCase();
    const minimum = Number(elements.sharedUploadDurationMin.value || 0);
    const maximum = Number(elements.sharedUploadDurationMax.value || uploadDurationMaximum);
    const direction = elements.sharedUploadSort.value === 'completed-asc' ? 1 : -1;
    return allItems.filter((item) => {
      const task = item.task;
      const haystack = [task.title, task.bvid, task.owner].map((value) => String(value || '').toLocaleLowerCase()).join('\n');
      return (!query || haystack.includes(query))
        && (!userQuery || `${item.userName}\n${item.userId}`.toLocaleLowerCase().includes(userQuery))
        && (!collectionQuery || `${item.collectionName}\n${item.collection.id || ''}`.toLocaleLowerCase().includes(collectionQuery))
        && item.duration >= minimum && item.duration <= maximum;
    }).sort((left, right) => direction * (String(left.completedAt).localeCompare(String(right.completedAt)) || String(left.task.title || '').localeCompare(String(right.task.title || ''), 'zh-CN')));
  }

  function renderSharedUploadFilterOptions(items) {
    const users = [...new Map(items.map((item) => [`${item.userId}\n${item.userName}`, { id: item.userId, name: item.userName }])).values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    elements.sharedUploadUserOptions.innerHTML = users.map((user) => `<option value="${escAttr(user.name)}">${esc(user.id)}</option>`).join('');
    const userQuery = elements.sharedUploadUserFilter.value.trim().toLocaleLowerCase();
    const collections = [...new Map(items.filter((item) => !userQuery || `${item.userName}\n${item.userId}`.toLocaleLowerCase().includes(userQuery)).map((item) => [String(item.collection.id || item.collectionName), { id: item.collection.id || '', name: item.collectionName, userName: item.userName }])).values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    elements.sharedUploadCollectionOptions.innerHTML = collections.map((collection) => `<option value="${escAttr(collection.name)}">${esc(collection.userName)}</option>`).join('');
  }

  function filteredPreparedUploadItems(items) {
    const collectionQuery = elements.sharedUploadPrepareCollectionFilter.value.trim().toLocaleLowerCase();
    const query = elements.sharedUploadPrepareFilter.value.trim().toLocaleLowerCase();
    return items.filter((item) => {
      const task = item.task;
      const collectionText = `${item.collectionName}\n${item.userName}`.toLocaleLowerCase();
      const itemText = `${task.title || ''}\n${task.bvid || ''}\n${task.owner || ''}`.toLocaleLowerCase();
      return (!collectionQuery || collectionText.includes(collectionQuery)) && (!query || itemText.includes(query));
    });
  }

  function renderSharedUploadPreparation(items) {
    const selectedItems = items.filter((item) => selectedUploadTaskIds.has(String(item.task.id)));
    const maximum = Number(sharedData.limits?.maxUploadDocuments || 1000);
    const visibleItems = filteredPreparedUploadItems(selectedItems);
    const visibleIds = new Set(visibleItems.map((item) => String(item.task.id)));
    for (const id of [...selectedPreparedTaskIds]) if (!selectedUploadTaskIds.has(id) || !visibleIds.has(id)) selectedPreparedTaskIds.delete(id);
    elements.sharedUploadSelectedCount.textContent = `已选 ${selectedItems.length} / ${maximum} 篇`;
    elements.sharedUploadPrepareResultCount.textContent = `显示 ${visibleItems.length} / ${selectedItems.length} 篇 · 已勾选 ${selectedPreparedTaskIds.size} 篇`;
    const collectionNames = [...new Set(selectedItems.map((item) => item.collectionName))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    elements.sharedUploadPrepareCollectionOptions.innerHTML = collectionNames.map((name) => `<option value="${escAttr(name)}"></option>`).join('');
    elements.sharedUploadPrepareSelectAll.disabled = !visibleItems.length;
    elements.sharedUploadPrepareRemove.disabled = !selectedPreparedTaskIds.size;
    const ownerMode = sharedRepositoryOwnerMode();
    elements.sharedUpload.textContent = ownerMode ? '创建分支 / PR' : '创建 Fork / PR';
    elements.sharedUpload.disabled = !selectedItems.length || selectedItems.length > maximum || Boolean(sharedData.upload);
    if (!selectedItems.length) {
      elements.sharedUploadPrepareList.innerHTML = '<div class="empty-state">从上方筛选结果中选择要共享的总结文档。</div>';
      return;
    }
    if (!visibleItems.length) {
      elements.sharedUploadPrepareList.innerHTML = '<div class="empty-state">准备上传列表中没有符合筛选条件的文档。</div>';
      return;
    }
    const groups = new Map();
    for (const item of visibleItems) {
      const key = String(item.collection.id || `${item.userId}:${item.collectionName}`);
      if (!groups.has(key)) groups.set(key, { collectionName: item.collectionName, userName: item.userName, items: [] });
      groups.get(key).items.push(item);
    }
    const forceOpen = Boolean(elements.sharedUploadPrepareCollectionFilter.value.trim() || elements.sharedUploadPrepareFilter.value.trim());
    elements.sharedUploadPrepareList.innerHTML = [...groups.values()].sort((a, b) => a.collectionName.localeCompare(b.collectionName, 'zh-CN')).map((group) => `<details class="shared-upload-prep-group" ${forceOpen ? 'open' : ''}><summary><span><strong>${esc(group.collectionName)}</strong><small>${esc(group.userName)}</small></span><em>${group.items.length} 篇</em><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary><div>${group.items.map((item) => `<div class="shared-upload-prep-item"><input class="app-checkbox" type="checkbox" data-shared-upload-prep-select="${escAttr(item.task.id)}" ${selectedPreparedTaskIds.has(String(item.task.id)) ? 'checked' : ''}/><span><strong>${esc(item.task.title || item.task.bvid)}</strong><small>${esc(item.task.bvid)} · ${esc(item.task.owner || '未知UP主')} · ${formatUploadDuration(item.duration)} · ${esc(formatUploadDate(item.completedAt))}</small></span><button class="secondary-button compact-button" type="button" data-shared-upload-remove="${escAttr(item.task.id)}">移除</button></div>`).join('')}</div></details>`).join('');
  }

  function renderSharedUploads() {
    const allItems = shareableUploadItems();
    const availableIds = new Set(allItems.map((item) => String(item.task.id)));
    for (const id of [...selectedUploadTaskIds]) if (!availableIds.has(id)) selectedUploadTaskIds.delete(id);
    updateSharedUploadDuration(allItems);
    renderSharedUploadFilterOptions(allItems);
    const items = filteredSharedUploadItems(allItems);
    elements.sharedUploadResultCount.textContent = `筛选结果 ${items.length} / ${allItems.length}`;
    const maximum = Number(sharedData.limits?.maxUploadDocuments || 1000);
    elements.sharedUploadSelectAll.disabled = !items.length || selectedUploadTaskIds.size >= maximum;
    elements.sharedUploadList.innerHTML = items.length ? items.map((item) => {
      const task = item.task;
      const selected = selectedUploadTaskIds.has(String(task.id));
      return `<label class="shared-upload-row"><input class="app-checkbox" type="checkbox" data-shared-upload-task="${escAttr(task.id)}" ${selected ? 'checked' : ''} ${!selected && selectedUploadTaskIds.size >= maximum ? 'disabled' : ''}/><span><strong>${esc(task.title || task.bvid)}</strong><small>${esc(task.bvid || '')} · ${esc(task.owner || '未知UP主')} · ${esc(item.userName)} / ${esc(item.collectionName)}</small></span><span class="shared-upload-candidate-meta"><strong>${task.sharedUploadPr ? '已创建过 PR' : '未上传'}</strong><small>${formatUploadDuration(item.duration)} · ${esc(formatUploadDate(item.completedAt))}</small></span></label>`;
    }).join('') : '<div class="empty-state">当前筛选条件下没有可共享的 B站视频总结产物。</div>';
    renderSharedUploadPreparation(allItems);
  }

  async function uploadShared() {
    const taskIds = [...selectedUploadTaskIds];
    if (!taskIds.length) return notify('无法创建共享 PR', '请先把至少一篇总结文档加入准备上传列表。');
    const maximum = Number(sharedData.limits?.maxUploadDocuments || 1000);
    if (taskIds.length > maximum) return notify('无法创建共享 PR', `一次最多上传 ${maximum} 篇文档，请从准备上传列表移除一部分。`);
    const ownerMode = sharedRepositoryOwnerMode();
    let result = null;
    sharedUploadInvocationActive = true;
    renderSharedUploadProgress({ status: 'running', progress: 0, current: 0, total: taskIds.length, message: '正在启动共享上传事务...' });
    setBusy(elements.sharedUpload, true, '创建中');
    try {
      result = await window.orchestrator.sharedUpload({ taskIds });
      selectedUploadTaskIds.clear();
      selectedPreparedTaskIds.clear();
      await refresh();
    } catch (error) {
      if (/已由用户中止|已中止/.test(String(error?.message || error))) notify('共享上传已中止', '应用已恢复操作；已完成的远程 PR 不会被误删。', 'success');
      else notify(ownerMode ? '创建 GitHub 分支 / PR 失败' : '创建 GitHub Fork / PR 失败', error);
    } finally {
      sharedUploadInvocationActive = false;
      sharedData.upload = null;
      renderSharedUploadProgress();
      setBusy(elements.sharedUpload, false, ownerMode ? '创建分支 / PR' : '创建 Fork / PR');
      renderSharedUploads();
    }
    if (result?.prUrl) await window.orchestrator.openExternal(result.prUrl);
  }

  async function cancelSharedUpload() {
    elements.sharedUploadCancel.disabled = true;
    elements.sharedUploadCancel.textContent = '正在中止';
    try { await window.orchestrator.sharedCancelUpload(); }
    catch (error) { notify('中止共享上传失败', error); }
  }

  async function handleSharedAction(event) {
    const button = event.target.closest('[data-shared-action]');
    if (!button) return;
    const original = button.dataset.sharedAction === 'sync' ? '同步' : '解除挂载';
    setBusy(button, true, button.dataset.sharedAction === 'sync' ? '同步中' : '处理中');
    try {
      if (button.dataset.sharedAction === 'sync') {
        const result = await runSharedUiOperation({ type: 'mount-sync', message: '正在同步共享挂载...' }, () => (
          window.orchestrator.sharedSyncMount(button.dataset.mountId)
        ));
        notify(result?.unchanged ? '远程内容没有变化' : '共享挂载同步完成', result?.unchanged
          ? '本地文档完整且远程版本未变化，无需重复下载。'
          : `已下载或更新 ${Number(result?.downloaded || 0)} 篇文档。`, 'success');
      }
      else if (button.dataset.sharedAction === 'unmount') await window.orchestrator.sharedUnmount(button.dataset.mountId);
      await refresh();
    } catch (error) { notify('共享挂载操作失败', error); }
    finally { setBusy(button, false, original); }
  }

  async function syncSelectedSharedMounts() {
    const mountIds = [...selectedMountIds];
    if (!mountIds.length) return notify('无法同步共享挂载', '请先勾选至少一个本地共享挂载。');
    setBusy(elements.sharedSyncSelected, true, '同步中');
    try {
      const result = await runSharedUiOperation({ type: 'mount-sync-batch', message: `正在同步 ${mountIds.length} 个共享挂载...` }, () => (
        window.orchestrator.sharedSyncMounts(mountIds)
      ));
      await refresh();
      const unchanged = Number(result.unchanged || 0);
      notify(unchanged === Number(result.synced || mountIds.length) ? '远程内容没有变化' : '共享挂载同步完成', `检查 ${Number(result.synced || mountIds.length)} 个挂载；${unchanged} 个无需更新，下载或更新 ${Number(result.downloaded || 0)} 篇文档。`, 'success');
    } catch (error) { notify('同步选中的共享挂载失败', error); }
    finally { setBusy(elements.sharedSyncSelected, false, `同步选中（${selectedMountIds.size}）`); }
  }

  function cssEscape(value) { return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }

  async function chooseSubtitles() {
    setBusy(elements.subtitleChoose, true, '正在读取');
    try {
      const result = await window.orchestrator.localSubtitleSelectFile();
      if (result.canceled) return;
      subtitleSelection = result.selection;
      elements.subtitleSelection.textContent = `${subtitleSelection.outputDirectory} · 可处理 ${subtitleSelection.files.length} 个文件${subtitleSelection.rejected.length ? ` · 忽略 ${subtitleSelection.rejected.length} 个不可读文件` : ''}`;
      elements.subtitleStart.disabled = false;
    } catch (error) { notify('读取媒体文件失败', error); }
    finally { setBusy(elements.subtitleChoose, false, '选择视频或音频'); }
  }

  async function startSubtitles() {
    if (!subtitleSelection) return;
    const formats = [...document.querySelectorAll('input[name="localSubtitleFormat"]:checked')].map((input) => input.value);
    if (!formats.length) return notify('请选择字幕格式', '至少勾选一种输出格式。');
    elements.subtitleStart.disabled = true;
    try {
      const job = await window.orchestrator.localSubtitleStart({ selectionId: subtitleSelection.id, formats });
      mergeJob(job);
      renderJobs();
    } catch (error) { notify('字幕任务创建失败', error); elements.subtitleStart.disabled = false; }
  }

  async function chooseVideos(mode) {
    const button = mode === 'folder' ? elements.videoChooseFolder : elements.videoChooseFiles;
    const generation = videoSelectionGate.next();
    setBusy(button, true, '正在检查');
    try {
      const result = await (mode === 'folder' ? window.orchestrator.localVideoSelectFolder() : window.orchestrator.localVideoSelectFiles());
      if (!videoSelectionGate.isCurrent(generation) || result.canceled) return;
      invalidateImportPreview('video');
      videoSelection = result.selection;
      openImportModal('video');
      await loadVideoPreview();
    } catch (error) {
      if (videoSelectionGate.isCurrent(generation)) notify('视频读取失败', error);
    }
    finally { setBusy(button, false, mode === 'folder' ? '选择视频/音频文件夹' : '选择视频/音频'); }
  }

  async function chooseDocuments() {
    const generation = documentSelectionGate.next();
    setBusy(elements.documentChoose, true, '正在检查');
    try {
      const result = await window.orchestrator.localDocumentSelectFiles();
      if (!documentSelectionGate.isCurrent(generation) || result.canceled) return;
      invalidateImportPreview('document');
      documentSelection = result.selection;
      openImportModal('document');
      await loadDocumentPreview();
    } catch (error) {
      if (documentSelectionGate.isCurrent(generation)) notify('文档读取失败', error);
    }
    finally { setBusy(elements.documentChoose, false, '选择文档'); }
  }

  function openImportModal(type) {
    const video = type === 'video';
    const selection = video ? videoSelection : documentSelection;
    const collections = video ? state.videoCollections : state.documentCollections;
    const select = video ? elements.videoCollection : elements.documentCollection;
    const nameInput = video ? elements.videoCollectionName : elements.documentCollectionName;
    select.innerHTML = `<option value="__new__">创建新收藏夹</option>${collections.map((item) => `<option value="${escAttr(item.id)}">${esc(item.name)}</option>`).join('')}`;
    const sameName = collections.find((item) => item.name === selection.defaultCollectionName);
    select.value = sameName?.id || '__new__';
    nameInput.value = selection.defaultCollectionName || '';
    (video ? elements.videoModal : elements.documentModal).hidden = false;
    (video ? elements.videoStart : elements.documentStart).disabled = true;
    updateCollectionInput(type);
  }

  function closeImportModal(type) {
    (type === 'video' ? elements.videoModal : elements.documentModal).hidden = true;
    invalidateImportPreview(type);
    if (type === 'video') { videoSelectionGate.next(); videoSelection = null; }
    else { documentSelectionGate.next(); documentSelection = null; }
  }

  function collectionPayload(type) {
    const select = type === 'video' ? elements.videoCollection : elements.documentCollection;
    const input = type === 'video' ? elements.videoCollectionName : elements.documentCollectionName;
    return select.value === '__new__' ? { collectionId: '', collectionName: input.value.trim() } : { collectionId: select.value, collectionName: '' };
  }

  function updateCollectionInput(type) {
    const select = type === 'video' ? elements.videoCollection : elements.documentCollection;
    const row = type === 'video' ? elements.videoCollectionNameRow : elements.documentCollectionNameRow;
    row.hidden = select.value !== '__new__';
    if (type === 'video') {
      const collection = state.videoCollections.find((item) => item.id === select.value);
      elements.videoCollectionKind.innerHTML = `<span class="collection-kind-badge" data-kind="video-cache">内置缓存视频</span>${collection?.protected ? '<small>默认收藏夹</small>' : ''}`;
    }
  }

  function schedulePreview(type) {
    invalidateImportPreview(type);
    const timer = setTimeout(() => (type === 'video' ? loadVideoPreview() : loadDocumentPreview()).catch((error) => notify('检查同名文件失败', error)), 180);
    if (type === 'video') videoPreviewTimer = timer;
    else documentPreviewTimer = timer;
  }

  function invalidateImportPreview(type) {
    if (type === 'video') {
      videoPreviewGate.next();
      if (videoPreviewTimer) clearTimeout(videoPreviewTimer);
      videoPreviewTimer = null;
      videoPreview = null;
      elements.videoStart.disabled = true;
      return;
    }
    documentPreviewGate.next();
    if (documentPreviewTimer) clearTimeout(documentPreviewTimer);
    documentPreviewTimer = null;
    documentPreview = null;
    elements.documentStart.disabled = true;
  }

  async function loadVideoPreview() {
    const selection = videoSelection;
    if (!selection) return null;
    const generation = videoPreviewGate.next();
    elements.videoStart.disabled = true;
    const payload = collectionPayload('video');
    if (!payload.collectionId && !payload.collectionName) {
      if (videoPreviewGate.isCurrent(generation) && videoSelection?.id === selection.id) {
        elements.videoList.innerHTML = '<div class="local-selection-summary">请输入收藏夹名称。</div>';
      }
      return null;
    }
    try {
      const preview = await window.orchestrator.localVideoPreview({ selectionId: selection.id, ...payload });
      if (!videoPreviewGate.isCurrent(generation) || videoSelection?.id !== selection.id) return null;
      videoPreview = preview;
      elements.videoSummary.textContent = `读取到 ${videoPreview.files.length} 个视频或音频${videoPreview.rejected.length ? `，另有 ${videoPreview.rejected.length} 个文件不可读` : ''}`;
      renderImportList('video', videoPreview.files);
      elements.videoStart.disabled = false;
      return preview;
    } catch (error) {
      if (!videoPreviewGate.isCurrent(generation) || videoSelection?.id !== selection.id) return null;
      throw error;
    }
  }

  async function loadDocumentPreview() {
    const selection = documentSelection;
    if (!selection) return null;
    const generation = documentPreviewGate.next();
    elements.documentStart.disabled = true;
    const payload = collectionPayload('document');
    if (!payload.collectionId && !payload.collectionName) {
      if (documentPreviewGate.isCurrent(generation) && documentSelection?.id === selection.id) {
        elements.documentList.innerHTML = '<div class="local-selection-summary">请输入收藏夹名称。</div>';
      }
      return null;
    }
    try {
      const preview = await window.orchestrator.localDocumentPreview({ selectionId: selection.id, ...payload });
      if (!documentPreviewGate.isCurrent(generation) || documentSelection?.id !== selection.id) return null;
      documentPreview = preview;
      elements.documentSummary.textContent = `读取到 ${documentPreview.files.length} 个文档${documentPreview.rejected.length ? `，另有 ${documentPreview.rejected.length} 个文件不支持` : ''}`;
      renderImportList('document', documentPreview.files);
      elements.documentStart.disabled = false;
      return preview;
    } catch (error) {
      if (!documentPreviewGate.isCurrent(generation) || documentSelection?.id !== selection.id) return null;
      throw error;
    }
  }

  function renderImportList(type, files) {
    const list = type === 'video' ? elements.videoList : elements.documentList;
    list.innerHTML = files.map((file) => {
      const detail = type === 'video'
        ? `${file.kind === 'audio' ? '音频' : '视频'} · ${formatDuration(file.duration)} · ${formatBytes(file.size)}${file.kind === 'audio' ? '' : ` · ${file.width || '-'}×${file.height || '-'}`}`
        : `${String(file.extension || '').slice(1).toUpperCase()} · ${formatBytes(file.size)}`;
      return `<div class="local-import-row ${file.existing ? 'is-existing' : 'is-new'}" data-local-source="${escAttr(file.id)}"><div><strong title="${escAttr(file.path)}">${esc(file.name)}</strong><small>${file.existing ? '收藏夹内已存在同名记录' : '收藏夹内不存在同名记录'} · ${detail}</small></div>${file.existing ? '<select class="local-conflict-choice" aria-label="同名文件处理方式"><option value="skip">跳过</option><option value="overwrite">覆盖</option></select>' : '<span class="collection-kind-badge">准备导入</span>'}</div>`;
    }).join('');
  }

  function importChoices(type) {
    const list = type === 'video' ? elements.videoList : elements.documentList;
    return Object.fromEntries([...list.querySelectorAll('[data-local-source]')].map((row) => [row.dataset.localSource, row.querySelector('select')?.value || 'import']));
  }

  async function startVideoImport() {
    if (!videoSelection || !videoPreview) return;
    elements.videoStart.disabled = true;
    try {
      const job = await window.orchestrator.localVideoStart({ selectionId: videoSelection.id, ...collectionPayload('video'), choices: importChoices('video') });
      mergeJob(job);
      closeImportModal('video');
      renderJobs();
    } catch (error) { notify('视频/音频导入任务创建失败', error); elements.videoStart.disabled = false; }
  }

  async function startDocumentImport() {
    if (!documentSelection || !documentPreview) return;
    elements.documentStart.disabled = true;
    try {
      const job = await window.orchestrator.localDocumentStart({ selectionId: documentSelection.id, ...collectionPayload('document'), choices: importChoices('document') });
      mergeJob(job);
      closeImportModal('document');
      renderJobs();
    } catch (error) { notify('文档导入任务创建失败', error); elements.documentStart.disabled = false; }
  }

  function mergeJob(job) {
    state.jobs = [job, ...state.jobs.filter((item) => item.id !== job.id)];
  }

  function renderJobs() {
    renderJobSlot(elements.subtitleJob, latestJob('subtitles'));
    renderJobSlot(elements.videoJob, latestJob('video-import'));
    renderJobSlot(elements.documentJob, latestJob('document-import'));
    const subtitleActive = state.jobs.some((item) => item.type === 'subtitles' && ['queued', 'running'].includes(item.status));
    elements.subtitleStart.disabled = !subtitleSelection || subtitleActive;
  }

  function latestJob(type) {
    return state.jobs.filter((item) => item.type === type).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
  }

  function renderJobSlotLegacy(root, job) {
    if (!job) { root.innerHTML = ''; return; }
    const active = ['queued', 'running'].includes(job.status);
    const completed = Number(job.itemCounts?.completed ?? job.items.filter((item) => item.status === 'completed').length);
    const skipped = Number(job.itemCounts?.skipped ?? job.items.filter((item) => item.status === 'skipped').length);
    const failed = Number(job.itemCounts?.failed ?? job.items.filter((item) => item.status === 'failed').length);
    const failedItems = job.items.filter((item) => item.status === 'failed');
    const progress = Math.max(0, Math.min(100, Math.round(Number(job.progress || 0) * 100)));
    root.innerHTML = `<div class="local-job"><div class="local-job-head"><div><strong>${esc(job.title)}</strong><span>${esc(job.phase || statusLabel(job.status))}</span></div><div class="local-job-actions">${active ? `<button class="secondary-button compact-button" type="button" data-local-cancel="${escAttr(job.id)}">停止</button>` : ''}${job.outputDirectories?.length ? `<button class="secondary-button compact-button" type="button" data-local-open="${escAttr(job.id)}">打开目录</button>` : ''}</div></div><div class="local-progress"><span style="width:${progress}%"></span></div><div class="local-job-summary"><span>${progress}% · 完成 ${completed}${skipped ? ` · 跳过 ${skipped}` : ''}${failed ? ` · 失败 ${failed}` : ''}</span><span>${statusLabel(job.status)}</span></div>${job.error || failed ? `<div class="local-job-errors">${job.error ? `<div>${esc(job.error)}</div>` : ''}${failedItems.slice(0, 5).map((item) => `<div>${esc(item.name)}：${esc(item.error || '处理失败')}</div>`).join('')}</div>` : ''}</div>`;
  }

  function renderJobSlot(root, job) {
    if (!job) { root.innerHTML = ''; return; }
    const active = ['queued', 'running'].includes(job.status);
    const items = Array.isArray(job.items) ? job.items : [];
    const completed = Number(job.itemCounts?.completed ?? items.filter((item) => item.status === 'completed').length);
    const skipped = Number(job.itemCounts?.skipped ?? items.filter((item) => item.status === 'skipped').length);
    const failed = Number(job.itemCounts?.failed ?? items.filter((item) => item.status === 'failed').length);
    const failedItems = items.filter((item) => item.status === 'failed');
    const progress = Math.max(0, Math.min(100, Math.round(Number(job.progress || 0) * 100)));
    const previousList = root.querySelector('[data-local-item-list]');
    const previousScrollTop = previousList?.scrollTop || 0;
    const itemRows = items.map((item) => {
      const itemProgress = Math.max(0, Math.min(100, Math.round(Number(item.progress || 0) * 100)));
      const statusClass = String(item.status || 'queued').replace(/[^a-z-]/gi, '');
      return `<div class="local-job-item is-${statusClass}" title="${escAttr(item.phase || statusLabel(item.status))}"><div class="local-job-item-head"><strong>${esc(item.name || '-')}</strong><span>${itemProgress}% · ${esc(statusLabel(item.status))}</span></div><div class="local-item-progress"><span style="width:${itemProgress}%"></span></div>${item.error ? `<small>${esc(item.error)}</small>` : ''}</div>`;
    }).join('');
    root.innerHTML = `<div class="local-job"><div class="local-job-head"><div><strong>${esc(job.title)}</strong><span>${esc(job.phase || statusLabel(job.status))}</span></div><div class="local-job-actions">${active ? `<button class="secondary-button compact-button" type="button" data-local-cancel="${escAttr(job.id)}">停止</button>` : ''}${job.outputDirectories?.length ? `<button class="secondary-button compact-button" type="button" data-local-open="${escAttr(job.id)}">打开目录</button>` : ''}</div></div><div class="local-progress" aria-label="总进度"><span style="width:${progress}%"></span></div><div class="local-job-summary"><span>${progress}% · 完成 ${completed}${skipped ? ` · 跳过 ${skipped}` : ''}${failed ? ` · 失败 ${failed}` : ''}</span><span>${statusLabel(job.status)}</span></div><div class="local-job-items" data-local-item-list aria-label="每个视频进度">${itemRows}</div>${job.error || failed ? `<div class="local-job-errors">${job.error ? `<div>${esc(job.error)}</div>` : ''}${failedItems.slice(0, 5).map((item) => `<div>${esc(item.name)}：${esc(item.error || '处理失败')}</div>`).join('')}</div>` : ''}</div>`;
    const nextList = root.querySelector('[data-local-item-list]');
    if (nextList) nextList.scrollTop = previousScrollTop;
  }

  async function handleJobAction(event) {
    const cancel = event.target.closest('[data-local-cancel]');
    if (cancel) {
      cancel.disabled = true;
      try { await window.orchestrator.localToolCancel(cancel.dataset.localCancel); await refresh(); }
      catch (error) { notify('停止任务失败', error); cancel.disabled = false; }
      return;
    }
    const open = event.target.closest('[data-local-open]');
    if (open) {
      try { await window.orchestrator.localToolOpenOutput(open.dataset.localOpen); }
      catch (error) { notify('无法打开输出目录', error); }
    }
  }

  function setBusy(button, busy, label) {
    button.disabled = busy;
    button.textContent = label;
  }

  function notify(title, detail, type = 'error') {
    const message = detail?.message || String(detail || '');
    if (typeof window.notify === 'function') window.notify(title, message, type);
    else console.error(title, message);
  }

  function statusLabel(status) {
    return ({ queued: '排队中', running: '处理中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' })[status] || status || '-';
  }

  function formatBytes(value) {
    const bytes = Number(value || 0);
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function formatDuration(value) {
    const total = Math.max(0, Math.round(Number(value || 0)));
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }

  function formatUploadDuration(value) {
    const total = Math.max(0, Math.round(Number(value || 0)));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function formatUploadDate(value) {
    const time = Date.parse(value || '');
    return Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN', { hour12: false }) : '生成时间未知';
  }

  function esc(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
  function escAttr(value) { return esc(value); }

  setupToolNavigation();
  elements.subtitleChoose.addEventListener('click', chooseSubtitles);
  elements.subtitleStart.addEventListener('click', startSubtitles);
  elements.videoChooseFiles.addEventListener('click', () => chooseVideos('files'));
  elements.videoChooseFolder.addEventListener('click', () => chooseVideos('folder'));
  elements.documentChoose.addEventListener('click', chooseDocuments);
  elements.videoCollection.addEventListener('change', () => { updateCollectionInput('video'); schedulePreview('video'); });
  elements.videoCollectionName.addEventListener('input', () => schedulePreview('video'));
  elements.documentCollection.addEventListener('change', () => { updateCollectionInput('document'); schedulePreview('document'); });
  elements.documentCollectionName.addEventListener('input', () => schedulePreview('document'));
  elements.videoStart.addEventListener('click', startVideoImport);
  elements.documentStart.addEventListener('click', startDocumentImport);
  elements.multipartInspect.addEventListener('click', inspectMultipart);
  elements.multipartProvider.addEventListener('change', () => { refreshMultipartProvidersForUi().catch((error) => notify('刷新模型列表失败', error)); });
  elements.multipartCreate.addEventListener('click', () => createMultipart(false));
  elements.multipartCreateStart.addEventListener('click', () => createMultipart(true));
  elements.multipartRefreshState.addEventListener('click', () => refresh().catch((error) => notify('刷新多P父任务失败', error)));
  elements.multipartParentList.addEventListener('click', handleMultipartAction);
  elements.sharedLogin.addEventListener('click', browserSharedLogin);
  elements.sharedSetToken.addEventListener('click', setSharedToken);
  elements.sharedLogout.addEventListener('click', clearSharedAuthorization);
  elements.sharedRepositorySave.addEventListener('click', saveSharedRepository);
  elements.sharedRepositorySelect.addEventListener('change', selectSharedRepository);
  elements.sharedRepositoryOpen.addEventListener('click', () => openSharedRepository().catch((error) => notify('打开共享仓库失败', error)));
  elements.sharedRepositoryCreate.addEventListener('click', createSharedRepository);
  elements.sharedCatalog.addEventListener('click', () => loadSharedCatalog({ force: true }));
  for (const control of [elements.sharedGithubFilter, elements.sharedBilibiliFilter, elements.sharedVideoFilter]) control.addEventListener('input', renderSharedCatalog);
  elements.sharedCollection.addEventListener('change', renderSharedCatalog);
  elements.sharedMount.addEventListener('click', () => mountShared({ button: elements.sharedMount }));
  elements.sharedMountFiltered.addEventListener('click', () => mountShared({ paths: filteredSharedDocuments().filter((item) => !item.invalid).map((item) => item.path), button: elements.sharedMountFiltered }));
  elements.sharedCatalogList.addEventListener('change', (event) => {
    const input = event.target.closest('[data-shared-path]');
    if (!input) return;
    if (input.checked) selectedRemotePaths.add(String(input.dataset.sharedPath));
    else selectedRemotePaths.delete(String(input.dataset.sharedPath));
    elements.sharedCatalogResultCount.textContent = `显示 ${filteredSharedDocuments().filter((item) => !item.invalid).length} / ${(sharedCatalogData.documents || []).length} 篇 · 已勾选 ${selectedRemotePaths.size} 篇`;
    elements.sharedMount.disabled = !selectedRemotePaths.size;
  });
  elements.sharedCatalogList.addEventListener('click', (event) => {
    const collectionButton = event.target.closest('[data-shared-mount-prefix]');
    const documentButton = event.target.closest('[data-shared-mount-path]');
    if (collectionButton) mountShared({ remotePrefix: collectionButton.dataset.sharedMountPrefix, button: collectionButton });
    else if (documentButton) mountShared({ paths: [documentButton.dataset.sharedMountPath], button: documentButton });
  });
  elements.sharedMountSelectAll.addEventListener('click', () => {
    const mounts = sharedData.mounts || [];
    if (mounts.length && selectedMountIds.size === mounts.length) selectedMountIds.clear();
    else for (const mount of mounts) selectedMountIds.add(String(mount.id));
    renderSharedMounts();
  });
  elements.sharedSyncSelected.addEventListener('click', syncSelectedSharedMounts);
  elements.sharedUpload.addEventListener('click', uploadShared);
  elements.sharedUploadCancel.addEventListener('click', cancelSharedUpload);
  elements.sharedUploadSelectAll.addEventListener('click', () => {
    const maximum = Number(sharedData.limits?.maxUploadDocuments || 1000);
    for (const item of filteredSharedUploadItems()) {
      if (selectedUploadTaskIds.size >= maximum) break;
      selectedUploadTaskIds.add(String(item.task.id));
    }
    renderSharedUploads();
  });
  for (const control of [elements.sharedUploadFilter, elements.sharedUploadUserFilter, elements.sharedUploadCollectionFilter, elements.sharedUploadSort]) control.addEventListener('input', renderSharedUploads);
  elements.sharedUploadDurationMin.addEventListener('input', () => { normalizeSharedUploadDuration('minimum'); renderSharedUploads(); });
  elements.sharedUploadDurationMax.addEventListener('input', () => { normalizeSharedUploadDuration('maximum'); renderSharedUploads(); });
  elements.sharedUploadList.addEventListener('change', (event) => {
    const input = event.target.closest('[data-shared-upload-task]');
    if (!input) return;
    const id = String(input.dataset.sharedUploadTask);
    const maximum = Number(sharedData.limits?.maxUploadDocuments || 1000);
    if (input.checked && selectedUploadTaskIds.size >= maximum && !selectedUploadTaskIds.has(id)) {
      input.checked = false;
      notify('准备上传列表已满', `一次最多上传 ${maximum} 篇文档。`);
    } else if (input.checked) selectedUploadTaskIds.add(id);
    else { selectedUploadTaskIds.delete(id); selectedPreparedTaskIds.delete(id); }
    renderSharedUploads();
  });
  for (const control of [elements.sharedUploadPrepareCollectionFilter, elements.sharedUploadPrepareFilter]) control.addEventListener('input', renderSharedUploads);
  elements.sharedUploadPrepareSelectAll.addEventListener('click', () => {
    const selectedItems = shareableUploadItems().filter((item) => selectedUploadTaskIds.has(String(item.task.id)));
    for (const item of filteredPreparedUploadItems(selectedItems)) selectedPreparedTaskIds.add(String(item.task.id));
    renderSharedUploads();
  });
  elements.sharedUploadPrepareRemove.addEventListener('click', () => {
    if (!selectedPreparedTaskIds.size) return;
    for (const id of selectedPreparedTaskIds) selectedUploadTaskIds.delete(id);
    selectedPreparedTaskIds.clear();
    renderSharedUploads();
  });
  elements.sharedUploadPrepareList.addEventListener('change', (event) => {
    const input = event.target.closest('[data-shared-upload-prep-select]');
    if (!input) return;
    const id = String(input.dataset.sharedUploadPrepSelect);
    if (input.checked) selectedPreparedTaskIds.add(id);
    else selectedPreparedTaskIds.delete(id);
    renderSharedUploadPreparation(shareableUploadItems());
  });
  elements.sharedUploadPrepareList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-shared-upload-remove]');
    if (!button) return;
    const id = String(button.dataset.sharedUploadRemove);
    selectedUploadTaskIds.delete(id);
    selectedPreparedTaskIds.delete(id);
    renderSharedUploads();
  });
  elements.sharedMountList.addEventListener('change', (event) => {
    const input = event.target.closest('[data-shared-mount-select]');
    if (!input) return;
    if (input.checked) selectedMountIds.add(String(input.dataset.sharedMountSelect));
    else selectedMountIds.delete(String(input.dataset.sharedMountSelect));
    renderSharedMounts();
  });
  elements.sharedMountList.addEventListener('click', handleSharedAction);
  $('#localVideoImportClose').addEventListener('click', () => closeImportModal('video'));
  $('#localVideoImportCancel').addEventListener('click', () => closeImportModal('video'));
  $('#localDocumentImportClose').addEventListener('click', () => closeImportModal('document'));
  $('#localDocumentImportCancel').addEventListener('click', () => closeImportModal('document'));
  elements.page.addEventListener('click', (event) => {
    const card = event.target.closest('[data-outside-open]');
    if (card && card.closest('#outsideToolStack')) { openOutsideTool(card.dataset.outsideOpen); return; }
    handleJobAction(event);
  });
  elements.page.addEventListener('keydown', (event) => {
    const card = event.target.closest('[data-outside-open]');
    if (!card || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    openOutsideTool(card.dataset.outsideOpen);
  });
  elements.toolBack.addEventListener('click', () => closeOutsideTool());
  elements.multipartViewerCollection.addEventListener('change', renderMultipart);
  document.querySelector('[data-page="outside-bilibili"]')?.addEventListener('click', () => {
    closeOutsideTool({ focus: false });
    if (outsideBackendReady) refresh().catch((error) => notify('刷新本地工具失败', error));
  });
  window.orchestrator.onLocalToolboxEvent((event) => {
    if (event.localToolbox) { localRefreshGate.next(); state = event.localToolbox; renderJobs(); renderOutsideCards(); }
    else refresh().catch(() => {});
  });
  window.orchestrator.onMultipartEvent((event) => {
    if (event.multiPart) { multipartRefreshGate.next(); multipartState = event.multiPart; renderMultipart(); renderOutsideCards(); }
    else refresh().catch(() => {});
  });
  window.orchestrator.onSharedEvent((event) => {
    if (event.operation) updateSharedOperation(event.operation);
    if (event.sharedKnowledge) {
      sharedRefreshGate.next();
      applySharedState(event.sharedKnowledge);
      if (event.type === 'shared-operation-progress') renderSharedOperation();
      else { renderShared(); renderOutsideCards(); }
    }
    else refresh().catch(() => {});
  });
  window.orchestrator.onRuntime((data) => {
    if (!data?.backendReady) return;
    outsideBackendReady = true;
    scheduleInitialReadyRefresh();
    if (activeToolId === 'shared') ensureSharedRepositoryReady().catch(() => {});
  });
  window.orchestrator.onBootstrap((data) => {
    if (data?.phase !== 'ready') return;
    outsideBackendReady = true;
    scheduleInitialReadyRefresh();
    if (activeToolId === 'shared') ensureSharedRepositoryReady().catch(() => {});
  });
  window.orchestrator.getRuntime().then((data) => {
    outsideBackendReady = Boolean(data?.backendReady);
    scheduleInitialReadyRefresh();
    if (outsideBackendReady && activeToolId === 'shared') ensureSharedRepositoryReady().catch(() => {});
  }).catch(() => {});
})();
