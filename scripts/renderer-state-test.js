const { RequestGate, SerialQueue, streamMatches } = require('../src/renderer/renderer-guards');
const fs = require('fs');
const path = require('path');

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
  const outside = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'outside.js'), 'utf8');
  assert(['localRefreshGate', 'multipartRefreshGate', 'sharedRefreshGate', 'snapshotRefreshGate'].every((name) => outside.includes(`const ${name} = new RequestGate()`)), 'outside toolbox did not isolate refresh generations by state domain');
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
  const repositoryCardIndex = index.indexOf('<details class="shared-repository-card">');
  assert(repositoryCardIndex >= 0 && !index.slice(repositoryCardIndex, repositoryCardIndex + 120).includes(' open'), 'shared repository configuration must be collapsed by default');
  assert(index.includes('<summary class="shared-repository-summary"><strong>当前共享仓库</strong>') && index.includes('class="shared-repository-config"'), 'shared repository status summary or configuration body is missing');
  assert(index.includes('sharedClearMountSelection') && index.includes('shared-mount-flow-arrow') && index.indexOf('id="sharedMount"') < index.indexOf('id="sharedCollection"') && index.indexOf('id="sharedCollection"') < index.indexOf('id="sharedGithubFilter"'), 'shared mount target was not moved between the remote commands and filters');
  const mountArrowIndex = index.indexOf('shared-mount-flow-arrow');
  assert(index.includes('远程目录筛选') && index.indexOf('id="sharedCatalogList"') < mountArrowIndex && mountArrowIndex < index.indexOf('id="sharedMountSelectAll"') && index.indexOf('id="sharedClearMountSelection"') < index.indexOf('id="sharedMountList"'), 'local shared-collection controls were not placed between the remote and local lists');
  assert(index.indexOf('id="sharedUploadSelectAll"') < index.indexOf('id="sharedUploadResultCount"') && index.indexOf('id="sharedUploadSelectAll"') < index.indexOf('id="sharedUploadUserFilter"'), 'shared upload selection actions were not moved above the candidate filters');
  assert(index.includes('shared-upload-flow-arrow') && index.indexOf('id="sharedUploadList"') < index.indexOf('shared-upload-flow-arrow') && index.indexOf('shared-upload-flow-arrow') < index.indexOf('id="sharedUploadPrepareList"'), 'upload candidate and preparation lists do not expose their downward relationship');
  const outsideCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'outside.css'), 'utf8');
  assert(outsideCss.includes('.shared-upload-list { height: auto;') && outsideCss.includes('grid-template-rows: subgrid') && outsideCss.includes('.shared-layout > .outside-pane > .shared-flow-arrow') && outsideCss.includes('.shared-repository-summary') && outsideCss.includes('.shared-repository-card[open]') && /display:\s*flex;\s*flex-direction:\s*column;\s*grid-row:\s*auto;/.test(outsideCss) && outsideCss.includes('--shared-source-list-height') && outsideCss.includes('--shared-target-list-height') && outside.includes('sharedUploadTree(visibleItems') && outside.includes('sharedUploadTree(items'), 'shared directories lost the aligned flow tracks, responsive stacking, or collapsible repository configuration');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  assert(preload.includes("multiPartStopPart: (payload) => ipcRenderer.invoke('multipart:stop-part', payload)"), 'multi-part per-P stop IPC was not exposed through the preload boundary');
  const ai = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'ai.js'), 'utf8');
  assert(ai.includes('event.replaceContent || session.contentIsNotice') && ai.includes('session.contentIsNotice = false'), 'Agent model output did not replace an empty-response or validation notice on the first real content delta');
  console.log('renderer state guard test passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
