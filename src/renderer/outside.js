(() => {
  const $ = (selector) => document.querySelector(selector);
  const elements = {
    page: $('#page-outside-bilibili'),
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
    sharedCatalog: $('#sharedCatalog'),
    sharedFilter: $('#sharedFilter'),
    sharedRemotePrefix: $('#sharedRemotePrefix'),
    sharedCatalogList: $('#sharedCatalogList'),
    sharedCollection: $('#sharedCollection'),
    sharedCollectionName: $('#sharedCollectionName'),
    sharedMount: $('#sharedMount'),
    sharedSyncAll: $('#sharedSyncAll'),
    sharedMountList: $('#sharedMountList'),
    sharedUpload: $('#sharedUpload'),
    sharedUploadFilter: $('#sharedUploadFilter'),
    sharedUploadList: $('#sharedUploadList')
  };
  if (!elements.page) return;

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
  let previewTimer = null;

  async function refresh() {
    const [local, multipart, shared, currentSnapshot] = await Promise.all([
      window.orchestrator.localToolboxState(),
      window.orchestrator.multiPartState(),
      window.orchestrator.sharedState(),
      window.orchestrator.snapshot()
    ]);
    state = local;
    multipartState = multipart;
    sharedData = shared;
    snapshot = currentSnapshot;
    renderJobs();
    renderMultipart();
    renderShared();
    return state;
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
    const agentState = await window.orchestrator.internalAgentState();
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
      return `<article class="multipart-parent-record" data-parent-record="${escAttr(parent.id)}"><div class="multipart-parent-head"><div><strong>${esc(parent.title)}</strong><small>${esc(parent.bvid)} · ${esc(parent.collectionName || '')} · ${status}</small></div><div class="multipart-parent-actions"><button class="ghost-button compact-button" type="button" data-multipart-action="refresh" data-parent-id="${escAttr(parent.id)}">刷新 P</button>${parent.activeSessions?.length ? `<button class="secondary-button compact-button" type="button" data-multipart-action="stop" data-parent-id="${escAttr(parent.id)}">停止</button>` : `<button class="primary-button compact-button" type="button" data-multipart-action="start" data-parent-id="${escAttr(parent.id)}">继续</button>`}<button class="ghost-button compact-button danger-text" type="button" data-multipart-action="delete" data-parent-id="${escAttr(parent.id)}">删除</button></div></div><div class="local-progress"><span style="width:${Math.round(Number(parent.progress || 0) * 100)}%"></span></div><div class="multipart-parent-summary">${parent.completed}/${parent.total} P · ${Math.round(Number(parent.progress || 0) * 100)}% · ${esc(status)}</div><div class="multipart-parent-pages">${pages}</div></article>`;
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

  function renderShared() {
    const method = sharedData.authMethod === 'browser' ? '浏览器授权' : sharedData.authMethod === 'token' ? 'Token 授权' : '';
    const login = sharedData.authenticated ? `已授权：${sharedData.login || 'GitHub 用户'}（${sharedData.userId || 'ID 已隐藏'}${method ? ` · ${method}` : ''}）` : '公共仓库目录可以直接浏览；上传和创建 Pull Request 需要 GitHub 授权。';
    elements.sharedAuthStatus.textContent = login;
    elements.sharedLogout.hidden = !sharedData.authenticated;
    renderSharedCollections();
    renderSharedCatalog();
    renderSharedMounts();
    renderSharedUploads();
  }

  function filteredSharedDocuments() {
    const query = elements.sharedFilter.value.trim().toLocaleLowerCase();
    const prefix = elements.sharedRemotePrefix.value;
    return (sharedCatalogData.documents || []).filter((document) => {
      const matchesPrefix = !prefix || sharedDocumentRoot(document).startsWith(`${prefix}/`) || sharedDocumentRoot(document) === prefix;
      const matchesQuery = !query || [document.title, document.owner, document.bvid, document.collectionName, document.userName, document.documentId, document.path].some((value) => String(value || '').toLocaleLowerCase().includes(query));
      return matchesPrefix && matchesQuery;
    });
  }

  function sharedDocumentLocalStatus(document) {
    const targetCollectionId = elements.sharedCollection.value === '__new__' ? '' : elements.sharedCollection.value;
    const matches = (sharedData.documents || []).filter((item) => String(item.sharedRemotePath || '') === String(document.path || '') || String(item.sharedDocumentId || '') === String(document.documentId || ''));
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
    const prefixes = [...new Set((sharedCatalogData.documents || []).map(sharedCollectionPrefix).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const currentPrefix = elements.sharedRemotePrefix.value;
    elements.sharedRemotePrefix.innerHTML = `<option value="">选择远程收藏夹目录（可选）</option>${prefixes.map((prefix) => `<option value="${escAttr(prefix)}">${esc(prefix)}</option>`).join('')}`;
    if (prefixes.includes(currentPrefix)) elements.sharedRemotePrefix.value = currentPrefix;
    elements.sharedCatalogList.innerHTML = documents.length ? documents.map((document) => {
      const status = sharedDocumentLocalStatus(document);
      const updated = document.updatedAt || document.uploadedAt || '时间未知';
      return `<label class="shared-catalog-row shared-state-${escAttr(status.code)}"><input class="app-checkbox" type="checkbox" data-shared-path="${escAttr(document.path)}" ${document.invalid ? 'disabled' : ''} /><span class="shared-catalog-main"><strong>${esc(document.title || document.documentId || document.path)}</strong><small>${esc(document.bvid || '无 BV')} · ${esc(document.owner || '')} · ${esc(document.collectionName || '')} · ${esc(status.label)}</small></span><span class="shared-catalog-status"><strong>${esc(status.label)}</strong><br>${esc(updated)}<br>${esc(document.path)}</span></label>`;
    }).join('') : '<div class="empty-state">没有匹配的远程共享文档。</div>';
  }

  async function loadSharedCatalog() {
    setBusy(elements.sharedCatalog, true, '读取中');
    try { sharedCatalogData = await window.orchestrator.sharedCatalog(); renderSharedCatalog(); }
    catch (error) { notify('读取 GitHub 共享目录失败', error); }
    finally { setBusy(elements.sharedCatalog, false, '读取远程目录'); }
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

  async function mountShared() {
    const paths = [...elements.sharedCatalogList.querySelectorAll('[data-shared-path]:checked')].map((input) => input.dataset.sharedPath);
    const remotePrefix = elements.sharedRemotePrefix.value;
    if (!paths.length && !remotePrefix) return notify('无法挂载共享文档', '请选择文档，或选择一个远程收藏夹目录。');
    try { await window.orchestrator.sharedMount({ paths, remotePrefix, ...sharedCollectionPayload() }); await refresh(); }
    catch (error) { notify('挂载共享文档失败', error); }
  }

  function renderSharedMounts() {
    const mounts = sharedData.mounts || [];
    elements.sharedMountList.innerHTML = mounts.length ? mounts.map((mount) => `<div class="shared-mount-row-item"><div><strong>${esc(mount.collectionName || mount.collectionId)}</strong><small>${esc(mount.remotePrefix || '')} · ${Number(mount.remoteDocumentCount || 0)} 篇 · ${mount.lastSyncedAt ? `上次同步 ${esc(mount.lastSyncedAt)}` : '尚未同步'}</small></div><div class="shared-mount-actions"><button class="secondary-button compact-button" type="button" data-shared-action="sync" data-mount-id="${escAttr(mount.id)}">同步</button><button class="ghost-button compact-button danger-text" type="button" data-shared-action="unmount" data-mount-id="${escAttr(mount.id)}">解除挂载</button></div></div>`).join('') : '<div class="empty-state">还没有共享挂载。</div>';
  }

  function renderSharedUploads() {
    const query = elements.sharedUploadFilter.value.trim().toLocaleLowerCase();
    const tasks = (snapshot.tasks || []).filter((task) => task.status === 'done' && task.outputMarkdown && !String(task.sourceType || '').startsWith('shared-') && task.sourceType !== 'local-video' && task.sourceType !== 'local-document' && task.multiPartRole !== 'part' && (task.bvid || task.multiPartRole === 'parent'))
      .filter((task) => !query || [task.title, task.bvid, task.owner, task.collectionName, task.collectionId].some((value) => String(value || '').toLocaleLowerCase().includes(query)));
    elements.sharedUploadList.innerHTML = tasks.length ? tasks.map((task) => `<label class="shared-upload-row"><input class="app-checkbox" type="checkbox" data-shared-upload-task="${escAttr(task.id)}" /><span><strong>${esc(task.title || task.bvid)}</strong><small>${esc(task.bvid || '')} · ${esc(task.collectionName || task.collectionId || '')} · ${task.sharedUploadPr ? '已创建过 PR' : '未上传'}</small></span></label>`).join('') : '<div class="empty-state">暂无可上传的 B站视频总结产物。</div>';
  }

  async function uploadShared() {
    const taskIds = [...elements.sharedUploadList.querySelectorAll('[data-shared-upload-task]:checked')].map((input) => input.dataset.sharedUploadTask);
    if (!taskIds.length) return notify('无法创建共享 PR', '请至少选择一篇已完成的 B站视频总结。');
    setBusy(elements.sharedUpload, true, '创建中');
    try { const result = await window.orchestrator.sharedUpload({ taskIds }); await refresh(); if (result.prUrl) await window.orchestrator.openExternal(result.prUrl); }
    catch (error) { notify('创建 GitHub Fork / PR 失败', error); }
    finally { setBusy(elements.sharedUpload, false, '创建 Fork / PR'); }
  }

  async function handleSharedAction(event) {
    const button = event.target.closest('[data-shared-action]');
    if (!button) return;
    try {
      if (button.dataset.sharedAction === 'sync') await window.orchestrator.sharedSyncMount(button.dataset.mountId);
      else if (button.dataset.sharedAction === 'unmount') await window.orchestrator.sharedUnmount(button.dataset.mountId);
      await refresh();
    } catch (error) { notify('共享挂载操作失败', error); }
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
    setBusy(button, true, '正在检查');
    try {
      const result = await (mode === 'folder' ? window.orchestrator.localVideoSelectFolder() : window.orchestrator.localVideoSelectFiles());
      if (result.canceled) return;
      videoSelection = result.selection;
      openImportModal('video');
      await loadVideoPreview();
    } catch (error) { notify('视频读取失败', error); }
    finally { setBusy(button, false, mode === 'folder' ? '选择视频/音频文件夹' : '选择视频/音频'); }
  }

  async function chooseDocuments() {
    setBusy(elements.documentChoose, true, '正在检查');
    try {
      const result = await window.orchestrator.localDocumentSelectFiles();
      if (result.canceled) return;
      documentSelection = result.selection;
      openImportModal('document');
      await loadDocumentPreview();
    } catch (error) { notify('文档读取失败', error); }
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
    updateCollectionInput(type);
  }

  function closeImportModal(type) {
    (type === 'video' ? elements.videoModal : elements.documentModal).hidden = true;
    if (type === 'video') { videoSelection = null; videoPreview = null; }
    else { documentSelection = null; documentPreview = null; }
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
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => (type === 'video' ? loadVideoPreview() : loadDocumentPreview()).catch((error) => notify('检查同名文件失败', error)), 180);
  }

  async function loadVideoPreview() {
    if (!videoSelection) return;
    elements.videoStart.disabled = true;
    const payload = collectionPayload('video');
    if (!payload.collectionId && !payload.collectionName) {
      elements.videoList.innerHTML = '<div class="local-selection-summary">请输入收藏夹名称。</div>';
      return;
    }
    videoPreview = await window.orchestrator.localVideoPreview({ selectionId: videoSelection.id, ...payload });
    elements.videoSummary.textContent = `读取到 ${videoPreview.files.length} 个视频或音频${videoPreview.rejected.length ? `，另有 ${videoPreview.rejected.length} 个文件不可读` : ''}`;
    renderImportList('video', videoPreview.files);
    elements.videoStart.disabled = false;
  }

  async function loadDocumentPreview() {
    if (!documentSelection) return;
    elements.documentStart.disabled = true;
    const payload = collectionPayload('document');
    if (!payload.collectionId && !payload.collectionName) {
      elements.documentList.innerHTML = '<div class="local-selection-summary">请输入收藏夹名称。</div>';
      return;
    }
    documentPreview = await window.orchestrator.localDocumentPreview({ selectionId: documentSelection.id, ...payload });
    elements.documentSummary.textContent = `读取到 ${documentPreview.files.length} 个文档${documentPreview.rejected.length ? `，另有 ${documentPreview.rejected.length} 个文件不支持` : ''}`;
    renderImportList('document', documentPreview.files);
    elements.documentStart.disabled = false;
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

  function toggleOutsideTool(button) {
    const tool = button.closest('.outside-tool');
    const body = tool?.querySelector('.outside-tool-body');
    if (!body) return;
    const expanded = body.hidden;
    body.hidden = !expanded;
    button.setAttribute('aria-expanded', String(expanded));
    button.querySelector('span').textContent = expanded ? '收起' : '展开';
    tool.classList.toggle('is-expanded', expanded);
  }

  function notify(title, detail, type = 'error') {
    const message = detail?.message || String(detail || '');
    if (typeof window.showToast === 'function') window.showToast(title, message, type);
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

  function esc(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
  function escAttr(value) { return esc(value); }

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
  elements.sharedLogout.addEventListener('click', () => window.orchestrator.sharedLogout().then(refresh).catch((error) => notify('退出 GitHub 授权失败', error)));
  elements.sharedCatalog.addEventListener('click', loadSharedCatalog);
  elements.sharedFilter.addEventListener('input', renderSharedCatalog);
  elements.sharedRemotePrefix.addEventListener('change', renderSharedCatalog);
  elements.sharedCollection.addEventListener('change', renderSharedCatalog);
  elements.sharedMount.addEventListener('click', mountShared);
  elements.sharedSyncAll.addEventListener('click', async () => {
    try { for (const mount of sharedData.mounts || []) await window.orchestrator.sharedSyncMount(mount.id); await refresh(); }
    catch (error) { notify('同步共享挂载失败', error); }
  });
  elements.sharedUpload.addEventListener('click', uploadShared);
  elements.sharedUploadFilter.addEventListener('input', renderSharedUploads);
  elements.sharedMountList.addEventListener('click', handleSharedAction);
  $('#localVideoImportClose').addEventListener('click', () => closeImportModal('video'));
  $('#localVideoImportCancel').addEventListener('click', () => closeImportModal('video'));
  $('#localDocumentImportClose').addEventListener('click', () => closeImportModal('document'));
  $('#localDocumentImportCancel').addEventListener('click', () => closeImportModal('document'));
  elements.page.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-outside-tool-toggle]');
    if (toggle) { toggleOutsideTool(toggle); return; }
    handleJobAction(event);
  });
  elements.multipartViewerCollection.addEventListener('change', renderMultipart);
  document.querySelector('[data-page="outside-bilibili"]')?.addEventListener('click', () => refresh().catch((error) => notify('刷新本地工具失败', error)));
  window.orchestrator.onLocalToolboxEvent((event) => {
    if (event.localToolbox) { state = event.localToolbox; renderJobs(); }
    else refresh().catch(() => {});
  });
  window.orchestrator.onMultipartEvent((event) => {
    if (event.multiPart) { multipartState = event.multiPart; renderMultipart(); }
    else refresh().catch(() => {});
  });
  window.orchestrator.onSharedEvent((event) => {
    if (event.sharedKnowledge) { sharedData = event.sharedKnowledge; renderShared(); }
    else refresh().catch(() => {});
  });
  refresh().catch((error) => notify('加载本地工具失败', error));
})();
