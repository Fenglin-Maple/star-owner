const { RequestGate, SerialQueue, runLatestRequest, streamMatches } = require('../src/renderer/renderer-guards');
const fs = require('fs');
const path = require('path');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function fakeButton(label) {
  const listeners = new Map();
  return {
    disabled: false,
    textContent: label,
    addEventListener(type, listener) { listeners.set(type, listener); },
    click() { return listeners.get('click')?.(); }
  };
}

(async () => {
  const queue = new SerialQueue();
  const order = [];
  const first = queue.run(async () => {
    order.push('first-start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push('first-end');
    throw new Error('expected queue failure');
  });
  const second = queue.run(async () => {
    order.push('second');
    return 'second-result';
  });
  let firstFailed = false;
  try { await first; } catch { firstFailed = true; }
  assert(firstFailed, 'serial queue test did not preserve the first failure');
  assert(await second === 'second-result' && order.join(',') === 'first-start,first-end,second', 'serial queue did not preserve order or recover after a failed operation');

  const gate = new RequestGate();
  const stale = gate.next();
  const current = gate.next();
  assert(!gate.isCurrent(stale) && gate.isCurrent(current), 'request gate did not reject stale async results');
  assert(streamMatches({ id: 'new-message' }, 'new-message') && !streamMatches({ id: 'new-message' }, 'old-message'), 'stream guard did not reject an old message event');

  const refreshButton = fakeButton('刷新本地目录');
  const buttonGate = new RequestGate();
  const snapshotGate = new RequestGate();
  let snapshotRequest = deferred();
  let renderedSnapshot = { tasks: [{ id: 'old' }] };
  const refreshNotices = [];
  const renderSnapshots = [];
  const handleRefreshClick = () => runLatestRequest({
    requestGate: buttonGate,
    resultGate: snapshotGate,
    onStart: () => { refreshButton.disabled = true; refreshButton.textContent = '刷新中'; },
    request: () => snapshotRequest.promise,
    onAccept: (value) => {
      renderedSnapshot = value;
      renderSnapshots.push(value.tasks.map((task) => task.id).join(','));
      refreshNotices.push('success');
    },
    onReject: () => refreshNotices.push('error'),
    onFinish: () => { refreshButton.disabled = false; refreshButton.textContent = '刷新本地目录'; }
  });
  refreshButton.addEventListener('click', handleRefreshClick);

  const successfulRefresh = refreshButton.click();
  assert(refreshButton.disabled && refreshButton.textContent === '刷新中', 'shared local refresh did not enter its busy state immediately after click');
  snapshotRequest.resolve({ tasks: [{ id: 'new' }] });
  await successfulRefresh;
  assert(renderedSnapshot.tasks[0].id === 'new' && renderSnapshots.at(-1) === 'new' && refreshNotices.at(-1) === 'success', 'shared local refresh did not apply and render the successful snapshot');
  assert(!refreshButton.disabled && refreshButton.textContent === '刷新本地目录', 'shared local refresh did not restore its button after success');

  snapshotRequest = deferred();
  const snapshotBeforeFailure = renderedSnapshot;
  const failedRefresh = refreshButton.click();
  snapshotRequest.reject(new Error('expected snapshot failure'));
  await failedRefresh;
  assert(renderedSnapshot === snapshotBeforeFailure && refreshNotices.at(-1) === 'error', 'shared local refresh did not preserve the previous list or report a current failure');
  assert(!refreshButton.disabled && refreshButton.textContent === '刷新本地目录', 'shared local refresh did not restore its button after failure');

  const olderFullSnapshot = deferred();
  const olderFullGeneration = snapshotGate.next();
  const olderFullRefresh = olderFullSnapshot.promise.then((value) => {
    if (snapshotGate.isCurrent(olderFullGeneration)) renderedSnapshot = value;
  });
  snapshotRequest = deferred();
  const newerManualRefresh = refreshButton.click();
  olderFullSnapshot.resolve({ tasks: [{ id: 'stale-full' }] });
  snapshotRequest.resolve({ tasks: [{ id: 'latest-manual' }] });
  await Promise.all([olderFullRefresh, newerManualRefresh]);
  assert(renderedSnapshot.tasks[0].id === 'latest-manual', 'an older full refresh overwrote the newer manual snapshot');

  snapshotRequest = deferred();
  const staleManualRefresh = refreshButton.click();
  const newerFullGeneration = snapshotGate.next();
  snapshotRequest.resolve({ tasks: [{ id: 'stale-manual' }] });
  await staleManualRefresh;
  if (snapshotGate.isCurrent(newerFullGeneration)) renderedSnapshot = { tasks: [{ id: 'latest-full' }] };
  assert(renderedSnapshot.tasks[0].id === 'latest-full' && !refreshButton.disabled, 'a stale manual refresh overwrote the newer full snapshot or left its button busy');

  const outside = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'outside.js'), 'utf8');
  assert(['localRefreshGate', 'multipartRefreshGate', 'sharedRefreshGate', 'snapshotRefreshGate', 'sharedUploadRefreshGate'].every((name) => outside.includes(`const ${name} = new RequestGate()`)), 'outside toolbox did not isolate refresh generations by state domain');
  assert(outside.includes('if (!Object.values(accepted).some(Boolean)) return state'), 'outside toolbox refresh did not reject a fully stale snapshot');
  assert(outside.includes('videoPreviewTimer') && outside.includes('documentPreviewTimer') && !outside.includes('let previewTimer = null'), 'video and document previews still shared one debounce timer');
  assert(outside.includes('videoPreviewGate.isCurrent(generation)') && outside.includes('documentPreviewGate.isCurrent(generation)'), 'local import previews did not reject stale responses');
  assert(outside.includes("if (event.localToolbox) { localRefreshGate.next()") && outside.includes("if (event.multiPart) { multipartRefreshGate.next()"), 'push events did not invalidate their matching in-flight toolbox state');
  assert(outside.includes('data-multipart-details') && outside.includes('multipartPartStatusLabel') && outside.includes('multiPartStopPart({ parentId'), 'multi-part parent viewer is missing expandable per-P progress or the isolated stop action');
  assert(['resume-part', 'retry-part', 'resume-stopped', 'retry-failed'].every((action) => outside.includes(`'${action}'`)), 'multi-part stopped or failed P tasks are missing continue/retry controls');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const multipartManager = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'multipart-manager.js'), 'utf8');
  assert(main.includes('multipartHotEvent') && main.includes("['stream', 'multipart-progress', 'session-updated']") && multipartManager.includes("}, 400);"), 'multi-part token events are still sent to the renderer without throttling');
  assert(main.includes('highFrequencyMultipartEvent') && main.includes("['stream', 'session-updated', 'multipart-progress']"), 'multi-part progress is still exported into the persistent activity log');
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const ragRenderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'rag.js'), 'utf8');
  const ragCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'rag.css'), 'utf8');
  assert(ragRenderer.includes('renderKnowledgeMenu(elements.knowledgeMenu, selected, session)') && ragRenderer.includes('renderKnowledgeMenu(elements.headKnowledgeMenu, selected, session)'), 'RAG knowledge picker menus do not share the same renderer');
  assert(ragRenderer.includes('groupKnowledgeCatalog(state.knowledgeCatalog)') && ragRenderer.includes('const userKey = userId ? `id:${userId}`') && ragRenderer.includes('item.kindInfo?.code'), 'RAG knowledge picker is not grouped by stable user identity and collection kind');
  assert(ragRenderer.includes('dataset.knowledgeUserKey') && ragRenderer.includes('dataset.knowledgeKindCode') && ragRenderer.includes('dataset.knowledgeCollectionId') && ragRenderer.includes('rag-knowledge-document-count'), 'RAG knowledge picker is missing semantic hierarchy or document count markers');
  assert(ragRenderer.includes('for (const kindGroup of menu.querySelectorAll') && ragRenderer.includes('for (const userGroup of menu.querySelectorAll'), 'RAG knowledge picker search does not collapse empty kind and user groups');
  assert(ragCss.includes('.rag-knowledge-user-group') && ragCss.includes('.rag-knowledge-kind-group') && ragCss.includes('.rag-knowledge-option { min-height: 40px; display: grid; grid-template-columns: 18px minmax(0, 1fr);') && ragCss.includes('.rag-knowledge-option-copy small') && ragCss.includes('white-space: nowrap'), 'RAG knowledge picker hierarchy or no-wrap document count layout is missing');
  const repositoryCardIndex = index.indexOf('<details class="shared-repository-card">');
  assert(repositoryCardIndex >= 0 && !index.slice(repositoryCardIndex, repositoryCardIndex + 120).includes(' open'), 'shared repository configuration must be collapsed by default');
  assert(index.includes('<summary class="shared-repository-summary"><strong>当前共享仓库</strong>') && index.includes('class="shared-repository-config"'), 'shared repository status summary or configuration body is missing');
  assert(index.includes('挂载到本地共享收藏夹') && index.includes('我的 本地B站总结文档'), 'shared download/upload labels do not identify their local destinations and sources');
  assert(index.includes('id="sharedUploadRefresh"') && index.includes('刷新本地目录'), 'shared upload flow is missing the local-directory refresh action');
  assert((index.match(/shared-list-heading/g) || []).length >= 4 && ['远程共享文档目录', '本地共享收藏夹与远程挂载', '我的 本地B站总结文档', '准备上传列表'].every((label) => index.includes(label)), 'shared list regions are missing descriptive headings');
  assert((index.match(/class="outside-pane-title shared-pane-title"/g) || []).length === 2 && index.includes('浏览远程共享目录') && index.includes('筛选本地已完成的 B站总结文档'), 'shared column headings are missing their paired descriptions');
  assert(index.includes('sharedClearMountSelection') && index.includes('shared-mount-flow-arrow') && index.indexOf('id="sharedMount"') < index.indexOf('id="sharedCollection"') && index.indexOf('id="sharedCollection"') < index.indexOf('id="sharedGithubFilter"'), 'shared mount target was not moved between the remote commands and filters');
  const mountArrowIndex = index.indexOf('shared-mount-flow-arrow');
  assert(index.includes('远程目录筛选') && index.indexOf('id="sharedCatalogList"') < mountArrowIndex && mountArrowIndex < index.indexOf('id="sharedMountSelectAll"') && index.indexOf('id="sharedClearMountSelection"') < index.indexOf('id="sharedMountList"'), 'local shared-collection controls were not placed between the remote and local lists');
  assert(index.indexOf('id="sharedUploadSelectAll"') < index.indexOf('id="sharedUploadResultCount"') && index.indexOf('id="sharedUploadSelectAll"') < index.indexOf('id="sharedUploadUserFilter"'), 'shared upload selection actions were not moved above the candidate filters');
  assert(index.includes('shared-upload-flow-arrow') && index.indexOf('id="sharedUploadList"') < index.indexOf('shared-upload-flow-arrow') && index.indexOf('shared-upload-flow-arrow') < index.indexOf('id="sharedUploadPrepareList"'), 'upload candidate and preparation lists do not expose their downward relationship');
  assert(index.indexOf('id="sharedUploadRefresh"') < index.indexOf('id="sharedUploadSelectAll"') && index.indexOf('id="sharedUploadSelectAll"') < index.indexOf('id="sharedUpload"'), 'shared upload actions are not ordered as refresh, select-all, then PR');
  assert(index.includes('星<b lang="en">owner</b>') && (index.match(/class="shared-filter-chevron"/g) || []).length === 6 && (index.match(/class="shared-filter-control"/g) || []).length === 6, 'owner wordmark or persistent shared filter controls are missing');
  const outsideCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'outside.css'), 'utf8');
  assert(outsideCss.includes('.shared-upload-list { height: auto;') && outsideCss.includes('grid-template-rows: subgrid') && outsideCss.includes('.shared-layout > .outside-pane > .shared-flow-arrow') && outsideCss.includes('.shared-repository-summary') && outsideCss.includes('.shared-repository-card[open]') && outsideCss.includes('.shared-pane-title-copy > small') && outsideCss.includes('border-top-width: 3px') && outsideCss.includes('border-top-color: var(--accent)') && outsideCss.includes('.shared-pane-target { padding-top: 10px; border-top: 1px solid var(--line); }') && /display:\s*flex;\s*flex-direction:\s*column;\s*grid-row:\s*auto;/.test(outsideCss) && outsideCss.includes('--shared-source-list-height') && outsideCss.includes('--shared-target-list-height') && outsideCss.includes('.shared-action-grid') && outsideCss.includes('grid-template-areas: "primary status" "secondary tertiary"') && outsideCss.includes('width: 58%') && outsideCss.includes('background: color-mix(in srgb, var(--content) 92%, var(--accent) 8%)') && outsideCss.includes('.shared-tool-body { --panel: var(--row); }') && outside.includes('sharedUploadTree(visibleItems') && outside.includes('sharedUploadTree(items'), 'shared directories lost the aligned flow tracks, theme-colored top border, responsive stacking, action grid, or distinct list surfaces');
  assert((outsideCss.match(/\.shared-mount-row, \.shared-catalog-filter-grid, \.shared-upload-filter-grid \{ width: 100%; max-width: 100%; \}/g) || []).length === 1 && outsideCss.includes('.shared-mount-row { grid-template-columns: 1fr; }'), 'shared filters still expand at the desktop breakpoint or the narrow mount fields do not stack');
  assert(index.includes('class="outside-tool-body shared-tool-body"') && !index.includes('class="outside-tool-body shared-tool-body" hidden>\n                  <div class="outside-tool-meta"'), 'the shared theme variables are not attached to the reparented shared-tool body');
  assert(index.indexOf('id="sharedUploadDurationMax"') < index.indexOf('shared-upload-title shared-list-heading') && index.indexOf('shared-upload-title shared-list-heading') < index.indexOf('id="sharedUploadList"'), 'the local upload list heading is not positioned directly above its list');
  assert(outside.includes('async function refreshSharedLocalDirectory') && outside.includes('resultGate: snapshotRefreshGate') && outside.includes('runLatestRequest({') && outside.includes('elements.sharedUploadRefresh.addEventListener'), 'shared local-directory refresh is not connected to the shared snapshot generation');
  assert(styles.includes('.app-title b {') && styles.includes('"Segoe Script"') && styles.includes('font-style: italic;') && styles.includes('body.theme-bili .app-title b { color: #ffffff; }') && styles.includes('body.theme-endfield .app-title b { color: var(--signal); }') && styles.includes('.overview-layout > .activity-panel { flex: 0 1 auto; min-height: 176px; height: clamp(176px, 24vh, 220px);') && styles.includes('.overview-layout > *:not(.activity-panel) { flex: 0 0 auto; }') && styles.includes('.overview-layout:has(.quickstart-disclosure[open]) > .activity-panel'), 'brand title theme contrast or responsive recent-status height is missing');
  assert(outsideCss.includes('.outside-tool-detail.is-local-tool .outside-detail-head {') && outsideCss.includes('justify-content: center;') && outsideCss.includes('.outside-tool-detail.is-local-tool .outside-back-button') && outsideCss.includes('position: absolute;') && outsideCss.includes('--shared-action-width: 248px;') && outsideCss.includes('0 10px 24px var(--shadow)') && outsideCss.includes('.shared-filter-chevron') && outsideCss.includes('::-webkit-calendar-picker-indicator') && outside.includes('input.showPicker()') && outside.includes('const filterChevron') && outside.includes('event.stopPropagation()'), 'local tool heading alignment, fixed shared actions, themed pane shadow, or clickable datalist chevrons are missing');
  assert(index.includes('id="sharedCollectionToggle"') && index.includes('id="sharedCollectionCreateTrigger"') && index.includes('id="sharedCollectionCreateInput"') && index.includes('id="sharedCollectionCreateConfirm"') && index.includes('id="sharedCollectionCreateCancel"') && !index.includes('id="sharedCollectionName"') && ['placeholder="全部"'].every((placeholder) => (index.match(new RegExp(placeholder, 'g')) || []).length >= 7) && index.includes('<option value="completed-desc">新到旧</option>') && index.includes('<option value="completed-asc">旧到新</option>'), 'shared collection picker, compact filter placeholders, or sort labels are missing');
  assert(outside.includes('automaticSharedCollectionName()') && outside.includes('sharedCollectionNewName.trim()') && outside.includes('sharedCollectionCreateTrigger.hidden = true') && outside.includes('elements.sharedCollectionCreateInput.focus()') && outside.includes('elements.sharedUploadSort.addEventListener(\'change\'') && outside.includes('documentCount || item.videoCount') && outside.includes('requestAnimationFrame(() => elements.sharedCollectionToggle.focus())') && outside.includes(':not([hidden])'), 'shared collection creation fallback or keyboard-aware picker behavior is missing');
  assert(outsideCss.includes('.shared-collection-menu') && outsideCss.includes('.shared-collection-create-row') && outsideCss.includes('.shared-collection-option[aria-checked="true"]') && outsideCss.includes('input[list]') && outsideCss.includes('.outside-tool-detail.is-local-tool { width: min(100%, 960px); margin-inline: auto; }') && outsideCss.includes('.outside-tool-detail.is-local-tool { width: 100%; margin-inline: 0; }') && outsideCss.includes('.outside-tool-detail.is-local-tool .outside-tool-detail-body'), 'shared picker visuals or left-edge local-tool navigation layout are missing');
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  assert(index.indexOf('dompurify/dist/purify.min.js') < index.indexOf('src="./app.js"') && app.includes('window.DOMPurify.sanitize') && app.includes('ALLOW_DATA_ATTR: false') && app.includes('normalizeReadmeLinks(template.content)') && app.includes('window.orchestrator.resolveReadmeImage(source)') && app.includes('link.dataset.readmeProjectLink = \'true\'') && app.includes("link.dataset.readmeProjectLink !== 'true'") && app.includes('window.orchestrator.openProjectPath(projectPath)'), 'project README HTML is not strictly sanitized before rendering, local images bypass the main-process resolver, or safe project links are not preserved');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  assert(preload.includes("multiPartStopPart: (payload) => ipcRenderer.invoke('multipart:stop-part', payload)"), 'multi-part per-P stop IPC was not exposed through the preload boundary');
  const ai = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'ai.js'), 'utf8');
  assert(ai.includes('event.replaceContent || session.contentIsNotice') && ai.includes('session.contentIsNotice = false'), 'Agent model output did not replace an empty-response or validation notice on the first real content delta');
  console.log('renderer state guard test passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
