(() => {
  const $ = (selector) => document.querySelector(selector);
  const elements = {
    downloadPage: $('#page-cache-download'), libraryPage: $('#page-video-library'),
    inputs: $('#cacheDownloadInputs'), collection: $('#cacheDownloadCollection'), newCollection: $('#cacheNewCollectionName'), createCollection: $('#cacheCreateCollection'), customPathRow: $('#cacheCustomPathRow'), customOutput: $('#cacheCustomOutput'), chooseOutput: $('#cacheChooseOutput'), submit: $('#cacheSubmitDownloads'), refresh: $('#cacheRefreshQueue'), jobs: $('#cacheDownloadJobs'), headline: $('#cacheQueueHeadline'), queueSummary: $('#cacheQueueSummary'), metricQueued: $('#cacheMetricQueued'), metricRunning: $('#cacheMetricRunning'), metricDone: $('#cacheMetricDone'), metricFailed: $('#cacheMetricFailed'),
    libraryCollection: $('#videoLibraryCollection'), librarySearch: $('#videoLibrarySearch'), librarySort: $('#videoLibrarySort'), filterToggle: $('#videoLibraryFilterToggle'), advanced: $('#videoLibraryAdvanced'), durationMin: $('#videoLibraryDurationMin'), durationMax: $('#videoLibraryDurationMax'), durationLabel: $('#videoLibraryDurationLabel'), librarySummary: $('#videoLibrarySummary'), list: $('#videoLibraryList'), selectVisible: $('#videoSelectVisible'), invertVisible: $('#videoInvertVisible'), selectedCount: $('#videoSelectedCount'), deleteSelected: $('#videoDeleteSelected'), deleteCollection: $('#videoDeleteCollection'),
    playerEmpty: $('#videoPlayerEmpty'), playerShell: $('#videoPlayerShell'), player: $('#cacheVideoPlayer'), centerPlay: $('#videoCenterPlay'), playPause: $('#videoPlayPause'), currentTime: $('#videoCurrentTime'), totalTime: $('#videoTotalTime'), timeline: $('#videoTimeline'), mute: $('#videoMute'), volume: $('#videoVolume'), fullscreen: $('#videoFullscreen'), playerTitle: $('#videoPlayerTitle'), playerMeta: $('#videoPlayerMeta'), openExplorer: $('#videoOpenExplorer'),
    loginModal: $('#cacheLoginRequiredModal'), loginVideo: $('#cacheLoginRequiredVideo'), loginReason: $('#cacheLoginRequiredReason'), loginLater: $('#cacheLoginLater'), resumeLogin: $('#cacheResumeLogin'), goLogin: $('#cacheGoLogin'),
    confirmModal: $('#cacheConfirmModal'), confirmTitle: $('#cacheConfirmTitle'), confirmMessage: $('#cacheConfirmMessage'), confirmCancel: $('#cacheConfirmCancel'), confirmAccept: $('#cacheConfirmAccept')
  };

  let state = { collections: [], videos: [], jobs: [], defaultCollectionId: '' };
  let selected = new Set();
  let activeVideoId = '';
  let visibleVideos = [];
  let confirmAction = null;
  let refreshTimer = null;

  async function refresh({ quiet = false } = {}) {
    try {
      state = await window.orchestrator.videoCacheState();
      render();
    } catch (error) {
      if (!quiet) toast('视频缓存尚未就绪', error.message || String(error), 'error');
    }
  }

  function render(nextState) {
    if (nextState) state = nextState;
    renderCollections();
    renderQueue();
    renderLibrary();
  }

  function renderCollections() {
    const previous = elements.collection.value;
    elements.collection.innerHTML = state.collections.map((item) => `<option value="${attr(item.id)}">${html(item.name)} (${Number(item.videoCount || 0)})</option>`).join('');
    elements.collection.value = state.collections.some((item) => item.id === previous) ? previous : (state.defaultCollectionId || state.collections[0]?.id || '');

    const libraryPrevious = elements.libraryCollection.value;
    elements.libraryCollection.innerHTML = '<option value="">全部缓存收藏夹</option>' + state.collections.map((item) => `<option value="${attr(item.id)}">${html(item.name)} (${Number(item.videoCount || 0)})</option>`).join('');
    elements.libraryCollection.value = state.collections.some((item) => item.id === libraryPrevious) ? libraryPrevious : '';
  }

  function renderQueue() {
    const jobs = state.jobs || [];
    const queued = jobs.filter((item) => item.status === 'queued').length;
    const running = jobs.filter((item) => item.status === 'running').length;
    const completed = jobs.filter((item) => item.status === 'completed').length;
    const failed = jobs.filter((item) => ['failed', 'waiting-login'].includes(item.status)).length;
    elements.metricQueued.textContent = String(queued);
    elements.metricRunning.textContent = String(running);
    elements.metricDone.textContent = String(completed);
    elements.metricFailed.textContent = String(failed);
    elements.headline.textContent = running ? `${running} 个正在下载` : queued ? `${queued} 个等待下载` : '队列空闲';
    elements.headline.parentElement.classList.toggle('busy', Boolean(running || queued));
    elements.queueSummary.textContent = jobs.length ? `最近 ${jobs.length} 条记录 · 并发上限 ${state.maxConcurrent || 3}` : '暂无任务';
    elements.jobs.innerHTML = jobs.length ? jobs.map(jobCard).join('') : '<div class="cache-empty"><svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg><strong>下载队列为空</strong><span>提交后可离开本页，任务会在后台继续。</span></div>';
  }

  function jobCard(job) {
    const collection = state.collections.find((item) => item.id === job.collectionId);
    const progress = Math.max(0, Math.min(1, Number(job.progress || 0)));
    const status = statusLabel(job.status);
    const queue = job.queuePosition ? `队列第 ${job.queuePosition} 位` : '';
    const speed = job.speed ? `${job.speed}${job.eta ? ` · ETA ${job.eta}` : ''}` : queue;
    return `<article class="cache-job-card"><strong title="${attr(job.input)}">${html(job.bvid || job.input)}</strong><em class="${attr(job.status)}">${status}</em><div class="cache-job-meta"><span>${html(collection?.name || job.collectionId)}</span><span>${html(job.phase || '')}</span></div><span class="cache-job-meta">${html(formatDate(job.createdAt))}</span><div class="cache-job-progress"><div><span>${html(speed || job.phase || '')}</span><strong>${Math.round(progress * 100)}%</strong></div><div class="cache-progress-track"><span style="width:${Math.round(progress * 100)}%"></span></div></div>${job.error ? `<div class="cache-job-error" title="${attr(job.error)}">${html(shortError(job.error))}</div>` : ''}</article>`;
  }

  function renderLibrary() {
    const collectionId = elements.libraryCollection.value;
    const query = elements.librarySearch.value.trim().toLowerCase();
    const allForCollection = state.videos.filter((item) => !collectionId || item.collectionId === collectionId);
    const maxDuration = Math.max(1, ...allForCollection.map((item) => Number(item.duration || 0)));
    const oldMax = Number(elements.durationMax.max || 1);
    const wasAtMax = Number(elements.durationMax.value || oldMax) >= oldMax;
    elements.durationMin.max = String(maxDuration);
    elements.durationMax.max = String(maxDuration);
    if (wasAtMax || Number(elements.durationMax.value) > maxDuration) elements.durationMax.value = String(maxDuration);
    if (Number(elements.durationMin.value) > maxDuration) elements.durationMin.value = '0';
    let min = Number(elements.durationMin.value || 0);
    let max = Number(elements.durationMax.value || maxDuration);
    if (min > max) [min, max] = [max, min];
    elements.durationLabel.textContent = `${duration(min)} - ${duration(max)}`;
    visibleVideos = allForCollection.filter((item) => {
      const haystack = [item.title, item.bvid, item.owner, ...(item.tags || [])].join(' ').toLowerCase();
      const seconds = Number(item.duration || 0);
      return (!query || haystack.includes(query)) && seconds >= min && seconds <= max;
    }).sort((a, b) => {
      const delta = (Date.parse(a.downloadedAt || '') || 0) - (Date.parse(b.downloadedAt || '') || 0);
      return elements.librarySort.value === 'asc' ? delta : -delta;
    });
    selected = new Set([...selected].filter((id) => state.videos.some((item) => item.id === id)));
    elements.librarySummary.textContent = `${visibleVideos.length} / ${allForCollection.length} 个视频`;
    elements.selectedCount.textContent = `已选 ${selected.size}`;
    elements.deleteSelected.disabled = !selected.size;
    const currentCollection = state.collections.find((item) => item.id === collectionId);
    elements.deleteCollection.disabled = !currentCollection || Boolean(currentCollection.protected);
    elements.deleteCollection.title = currentCollection?.protected ? '默认缓存收藏夹必须保留' : (!currentCollection ? '请先选择一个收藏夹' : '删除收藏夹及其视频文件');
    elements.list.innerHTML = visibleVideos.length ? visibleVideos.map(videoItem).join('') : '<div class="cache-empty"><svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zM10 9l5 3-5 3z"/></svg><strong>没有匹配的视频缓存</strong><span>可调整收藏夹、关键词或时长范围。</span></div>';
    for (const item of elements.list.querySelectorAll('[data-cache-video]')) {
      item.addEventListener('click', (event) => {
        if (event.target.closest('input')) return;
        selectVideo(item.dataset.cacheVideo);
      });
      item.querySelector('input')?.addEventListener('change', (event) => {
        event.target.checked ? selected.add(item.dataset.cacheVideo) : selected.delete(item.dataset.cacheVideo);
        renderLibrary();
      });
    }
    if (activeVideoId && !state.videos.some((item) => item.id === activeVideoId)) clearPlayer();
  }

  function videoItem(video) {
    const thumb = video.cover ? `<img src="${attr(video.cover)}" alt="" loading="lazy" />` : '<svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zM10 9l5 3-5 3z"/></svg>';
    const collection = state.collections.find((item) => item.id === video.collectionId);
    return `<div class="video-library-item ${video.id === activeVideoId ? 'active' : ''} ${video.fileExists ? '' : 'missing'}" data-cache-video="${attr(video.id)}" role="button" tabindex="0"><input class="app-checkbox" type="checkbox" ${selected.has(video.id) ? 'checked' : ''} aria-label="选择 ${attr(video.title || video.bvid)}" /><div class="video-library-thumb">${thumb}</div><div class="video-library-copy"><strong title="${attr(video.title || video.bvid)}">${html(video.title || video.bvid)}</strong><span>${html(video.bvid)} · ${html(video.owner || '未知 UP')} · ${duration(video.duration)}</span><small>${html(collection?.name || '')} · ${html(formatDate(video.downloadedAt))}${video.tags?.length ? ` · ${html(video.tags.slice(0, 4).join(' / '))}` : ''}</small></div><em class="video-file-state ${video.fileExists ? '' : 'missing'}">${video.fileExists ? '可播放' : '文件缺失'}</em></div>`;
  }

  function selectVideo(id) {
    const video = state.videos.find((item) => item.id === id);
    activeVideoId = id;
    renderLibrary();
    if (!video?.fileExists || !video.playbackUrl) {
      clearPlayer();
      toast('缓存文件不存在', '记录仍保留在视频库中，可删除后重新下载。', 'error');
      return;
    }
    elements.player.src = video.playbackUrl;
    elements.player.load();
    elements.playerEmpty.hidden = true;
    elements.playerShell.hidden = false;
    elements.centerPlay.hidden = false;
    elements.playerTitle.textContent = video.title || video.bvid;
    elements.playerMeta.textContent = `${video.bvid} · ${video.owner || '未知 UP'} · ${duration(video.duration)} · ${formatDate(video.downloadedAt)}`;
  }

  function clearPlayer() {
    activeVideoId = '';
    elements.player.pause();
    elements.player.removeAttribute('src');
    elements.player.load();
    elements.playerShell.hidden = true;
    elements.playerEmpty.hidden = false;
  }

  function togglePlayback() {
    if (!elements.player.src) return;
    if (elements.player.paused) elements.player.play().catch((error) => toast('无法播放视频', error.message, 'error'));
    else elements.player.pause();
  }

  async function submitDownloads() {
    const custom = document.querySelector('input[name="cacheDestination"]:checked')?.value === 'custom';
    if (custom && !elements.customOutput.value) return toast('请选择自定义输出目录', '目录确认后才能加入下载队列。', 'info');
    elements.submit.disabled = true;
    try {
      const result = await window.orchestrator.videoCacheSubmit({ inputs: elements.inputs.value, collectionId: elements.collection.value, outputDir: custom ? elements.customOutput.value : '' });
      state = result.state;
      elements.inputs.value = '';
      render();
      toast('已加入下载队列', `${result.jobs.length} 个视频将按资源情况并行处理。`, 'success');
    } catch (error) { toast('无法提交缓存任务', error.message || String(error), 'error'); }
    finally { elements.submit.disabled = false; }
  }

  async function createCollection() {
    elements.createCollection.disabled = true;
    try {
      const collection = await window.orchestrator.videoCacheCreateCollection(elements.newCollection.value);
      elements.newCollection.value = '';
      await refresh({ quiet: true });
      elements.collection.value = collection.id;
      elements.libraryCollection.value = collection.id;
      renderLibrary();
      toast('缓存收藏夹已创建', collection.name, 'success');
    } catch (error) { toast('创建失败', error.message || String(error), 'error'); }
    finally { elements.createCollection.disabled = false; }
  }

  function askConfirmation({ title, message, action }) {
    elements.confirmTitle.textContent = title;
    elements.confirmMessage.textContent = message;
    confirmAction = action;
    elements.confirmModal.hidden = false;
  }

  function closeConfirmation() {
    elements.confirmModal.hidden = true;
    confirmAction = null;
  }

  async function runConfirmedAction() {
    const action = confirmAction;
    closeConfirmation();
    if (!action) return;
    try { await action(); await refresh({ quiet: true }); }
    catch (error) { toast('删除失败', error.message || String(error), 'error'); }
  }

  function scheduleRefresh(nextState) {
    if (nextState) state = nextState;
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; nextState ? render() : refresh({ quiet: true }); }, 100);
  }

  for (const radio of document.querySelectorAll('input[name="cacheDestination"]')) radio.addEventListener('change', () => { elements.customPathRow.hidden = radio.value !== 'custom' || !radio.checked; });
  elements.chooseOutput.addEventListener('click', async () => { const result = await window.orchestrator.videoCacheChooseOutput(); if (!result.canceled) elements.customOutput.value = result.path; });
  elements.createCollection.addEventListener('click', createCollection);
  elements.submit.addEventListener('click', submitDownloads);
  elements.refresh.addEventListener('click', () => refresh());
  elements.libraryCollection.addEventListener('change', renderLibrary);
  elements.librarySearch.addEventListener('input', renderLibrary);
  elements.librarySort.addEventListener('change', renderLibrary);
  elements.durationMin.addEventListener('input', renderLibrary);
  elements.durationMax.addEventListener('input', renderLibrary);
  elements.filterToggle.addEventListener('click', () => { const open = elements.advanced.hidden; elements.advanced.hidden = !open; elements.filterToggle.setAttribute('aria-expanded', String(open)); });
  elements.selectVisible.addEventListener('click', () => { visibleVideos.forEach((item) => selected.add(item.id)); renderLibrary(); });
  elements.invertVisible.addEventListener('click', () => { visibleVideos.forEach((item) => selected.has(item.id) ? selected.delete(item.id) : selected.add(item.id)); renderLibrary(); });
  elements.deleteSelected.addEventListener('click', () => askConfirmation({ title: `删除 ${selected.size} 个缓存视频`, message: '视频文件、元数据和对应的未完成总结任务都会一并删除，此操作无法撤销。', action: async () => { const ids = [...selected]; await window.orchestrator.videoCacheDeleteVideos(ids); selected.clear(); clearPlayer(); toast('缓存视频已删除', `${ids.length} 条记录已移除。`, 'success'); } }));
  elements.deleteCollection.addEventListener('click', () => { const collection = state.collections.find((item) => item.id === elements.libraryCollection.value); if (!collection || collection.protected) return; askConfirmation({ title: `删除“${collection.name}”`, message: '该缓存收藏夹下登记的视频缓存文件会全部删除。默认收藏夹仍会保留。', action: async () => { await window.orchestrator.videoCacheDeleteCollection(collection.id); clearPlayer(); toast('缓存收藏夹已删除', collection.name, 'success'); } }); });
  elements.confirmCancel.addEventListener('click', closeConfirmation);
  elements.confirmAccept.addEventListener('click', runConfirmedAction);
  elements.loginLater.addEventListener('click', () => { elements.loginModal.hidden = true; });
  elements.goLogin.addEventListener('click', () => { elements.loginModal.hidden = true; window.dispatchEvent(new CustomEvent('star:navigate', { detail: { page: 'login' } })); });
  elements.resumeLogin.addEventListener('click', async () => { elements.resumeLogin.disabled = true; try { const result = await window.orchestrator.videoCacheResumeLogin(); state = result.state; elements.loginModal.hidden = true; render(); toast('缓存队列已继续', `${result.resumed} 个任务已重新排队。`, 'success'); } catch (error) { toast('仍无法继续', error.message || String(error), 'error'); } finally { elements.resumeLogin.disabled = false; } });
  elements.centerPlay.addEventListener('click', togglePlayback);
  elements.playPause.addEventListener('click', togglePlayback);
  elements.player.addEventListener('click', togglePlayback);
  elements.player.addEventListener('play', () => { elements.centerPlay.hidden = true; elements.playPause.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>'; });
  elements.player.addEventListener('pause', () => { elements.centerPlay.hidden = false; elements.playPause.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z"/></svg>'; });
  elements.player.addEventListener('loadedmetadata', () => { elements.totalTime.textContent = duration(elements.player.duration); });
  elements.player.addEventListener('timeupdate', () => { elements.currentTime.textContent = duration(elements.player.currentTime); elements.timeline.value = String(elements.player.duration ? Math.round(elements.player.currentTime / elements.player.duration * 1000) : 0); });
  elements.timeline.addEventListener('input', () => { if (elements.player.duration) elements.player.currentTime = Number(elements.timeline.value) / 1000 * elements.player.duration; });
  elements.volume.addEventListener('input', () => { elements.player.volume = Number(elements.volume.value); elements.player.muted = false; });
  elements.mute.addEventListener('click', () => { elements.player.muted = !elements.player.muted; elements.volume.value = elements.player.muted ? '0' : String(elements.player.volume); });
  elements.fullscreen.addEventListener('click', () => elements.playerShell.requestFullscreen?.());
  elements.openExplorer.addEventListener('click', () => activeVideoId && window.orchestrator.videoCacheOpen(activeVideoId).catch((error) => toast('无法打开文件位置', error.message, 'error')));
  document.querySelector('[data-page="cache-download"]')?.addEventListener('click', () => refresh({ quiet: true }));
  document.querySelector('[data-page="video-library"]')?.addEventListener('click', () => refresh({ quiet: true }));

  window.orchestrator.onVideoCacheEvent((event) => {
    if (event.type === 'video-cache-login-required') {
      elements.loginVideo.textContent = event.bvid || '当前缓存任务';
      elements.loginReason.textContent = shortError(event.reason || '该视频要求登录后下载。');
      elements.loginModal.hidden = false;
    }
    scheduleRefresh(event.cacheState);
  });

  const liveTimer = setInterval(() => {
    const visible = elements.downloadPage.classList.contains('active') || elements.libraryPage.classList.contains('active');
    if (visible && state.jobs.some((item) => ['queued', 'running'].includes(item.status))) refresh({ quiet: true });
  }, 1200);
  window.addEventListener('beforeunload', () => clearInterval(liveTimer), { once: true });

  function statusLabel(value) { return ({ queued: '等待', running: '下载中', completed: '已完成', failed: '失败', 'waiting-login': '需登录' })[value] || value; }
  function duration(value) { const seconds = Math.max(0, Math.round(Number(value || 0))); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
  function formatDate(value) { const date = new Date(value || ''); return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  function shortError(value) { return String(value || '').replace(/\s+/g, ' ').slice(0, 220); }
  function html(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
  function attr(value) { return html(value); }
  function toast(title, message, type) { if (typeof window.notify === 'function') window.notify(title, message, type); else console[type === 'error' ? 'error' : 'log'](`${title}: ${message}`); }

  refresh({ quiet: true });
})();
