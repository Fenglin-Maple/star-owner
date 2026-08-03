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
  const ai = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'ai.js'), 'utf8');
  assert(ai.includes('event.replaceContent || session.contentIsNotice') && ai.includes('session.contentIsNotice = false'), 'Agent model output did not replace an empty-response or validation notice on the first real content delta');
  console.log('renderer state guard test passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
