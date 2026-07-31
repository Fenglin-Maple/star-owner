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
    documentStart: $('#localDocumentImportStart')
  };
  if (!elements.page) return;

  let state = { jobs: [], videoCollections: [], documentCollections: [] };
  let subtitleSelection = null;
  let videoSelection = null;
  let videoPreview = null;
  let documentSelection = null;
  let documentPreview = null;
  let previewTimer = null;

  async function refresh() {
    state = await window.orchestrator.localToolboxState();
    renderJobs();
    return state;
  }

  async function chooseSubtitles() {
    setBusy(elements.subtitleChoose, true, '正在读取');
    try {
      const result = await window.orchestrator.localSubtitleSelectFolder();
      if (result.canceled) return;
      subtitleSelection = result.selection;
      elements.subtitleSelection.textContent = `${subtitleSelection.outputDirectory} · 可处理 ${subtitleSelection.files.length} 个文件${subtitleSelection.rejected.length ? ` · 忽略 ${subtitleSelection.rejected.length} 个不可读文件` : ''}`;
      elements.subtitleStart.disabled = false;
    } catch (error) { notify('读取文件夹失败', error); }
    finally { setBusy(elements.subtitleChoose, false, '选择文件夹'); }
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
    finally { setBusy(button, false, mode === 'folder' ? '选择视频文件夹' : '选择视频'); }
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
    elements.videoSummary.textContent = `读取到 ${videoPreview.files.length} 个视频${videoPreview.rejected.length ? `，另有 ${videoPreview.rejected.length} 个文件不可读` : ''}`;
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
        ? `${formatDuration(file.duration)} · ${formatBytes(file.size)} · ${file.width || '-'}×${file.height || '-'}`
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
    } catch (error) { notify('视频导入任务创建失败', error); elements.videoStart.disabled = false; }
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

  function renderJobSlot(root, job) {
    if (!job) { root.innerHTML = ''; return; }
    const active = ['queued', 'running'].includes(job.status);
    const completed = Number(job.itemCounts?.completed ?? job.items.filter((item) => item.status === 'completed').length);
    const skipped = Number(job.itemCounts?.skipped ?? job.items.filter((item) => item.status === 'skipped').length);
    const failed = Number(job.itemCounts?.failed ?? job.items.filter((item) => item.status === 'failed').length);
    const failedItems = job.items.filter((item) => item.status === 'failed');
    const progress = Math.max(0, Math.min(100, Math.round(Number(job.progress || 0) * 100)));
    root.innerHTML = `<div class="local-job"><div class="local-job-head"><div><strong>${esc(job.title)}</strong><span>${esc(job.phase || statusLabel(job.status))}</span></div><div class="local-job-actions">${active ? `<button class="secondary-button compact-button" type="button" data-local-cancel="${escAttr(job.id)}">停止</button>` : ''}${job.outputDirectories?.length ? `<button class="secondary-button compact-button" type="button" data-local-open="${escAttr(job.id)}">打开目录</button>` : ''}</div></div><div class="local-progress"><span style="width:${progress}%"></span></div><div class="local-job-summary"><span>${progress}% · 完成 ${completed}${skipped ? ` · 跳过 ${skipped}` : ''}${failed ? ` · 失败 ${failed}` : ''}</span><span>${statusLabel(job.status)}</span></div>${job.error || failed ? `<div class="local-job-errors">${job.error ? `<div>${esc(job.error)}</div>` : ''}${failedItems.slice(0, 5).map((item) => `<div>${esc(item.name)}：${esc(item.error || '处理失败')}</div>`).join('')}</div>` : ''}</div>`;
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

  function notify(title, detail) {
    const message = detail?.message || String(detail || '');
    if (typeof window.showToast === 'function') window.showToast(title, message, 'error');
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
  $('#localVideoImportClose').addEventListener('click', () => closeImportModal('video'));
  $('#localVideoImportCancel').addEventListener('click', () => closeImportModal('video'));
  $('#localDocumentImportClose').addEventListener('click', () => closeImportModal('document'));
  $('#localDocumentImportCancel').addEventListener('click', () => closeImportModal('document'));
  elements.page.addEventListener('click', handleJobAction);
  document.querySelector('[data-page="outside-bilibili"]')?.addEventListener('click', () => refresh().catch((error) => notify('刷新本地工具失败', error)));
  window.orchestrator.onLocalToolboxEvent((event) => {
    if (event.localToolbox) { state = event.localToolbox; renderJobs(); }
    else refresh().catch(() => {});
  });
  refresh().catch((error) => notify('加载本地工具失败', error));
})();
