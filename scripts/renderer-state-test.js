const { RequestGate, SerialQueue, streamMatches } = require('../src/renderer/renderer-guards');

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
  console.log('renderer state guard test passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
