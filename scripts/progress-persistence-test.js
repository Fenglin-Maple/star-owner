const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ToolRunner } = require('../src/core/tool-runner');

(async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'star-owner-progress-'));
  const logFile = path.join(tempRoot, 'run.log');
  const records = new Map([['run-1', { id: 'run-1', status: 'running', logFile }]]);
  let saves = 0;
  const store = {
    getToolRun(id) { return records.get(id) || null; },
    updateToolRun(id, patch, { persist = true } = {}) {
      const next = { ...(records.get(id) || {}), ...patch, id };
      records.set(id, next);
      if (persist !== false) this.save();
      return next;
    },
    save() { saves += 1; }
  };
  const runner = new ToolRunner({ store });
  runner.volatileRunFlushDelayMs = 20;
  runner.logFlushDelayMs = 20;

  for (let index = 0; index < 1000; index += 1) {
    runner.updateRun('run-1', { progress: index / 1000 }, { persist: false });
  }
  assert.strictEqual(saves, 0, 'volatile tool progress was exported synchronously');
  assert.strictEqual(records.get('run-1').progress, 0.999, 'latest volatile tool progress was not visible in memory');
  await delay(60);
  assert.strictEqual(saves, 1, 'volatile tool progress was not coalesced into one disk export');

  runner.updateRun('run-1', { progress: 1 }, { persist: false });
  runner.updateRun('run-1', { status: 'succeeded' });
  assert.strictEqual(saves, 2, 'terminal tool state was not persisted immediately');
  await delay(60);
  assert.strictEqual(saves, 2, 'terminal persistence left a redundant deferred export');

  for (let index = 0; index < 1000; index += 1) runner.appendLog('run-1', `progress ${index}\n`);
  assert.strictEqual(fs.existsSync(logFile), false, 'tool output was written synchronously for every chunk');
  await delay(60);
  const logText = fs.readFileSync(logFile, 'utf8');
  assert(logText.startsWith('progress 0\n') && logText.endsWith('progress 999\n'), 'batched tool log lost or reordered output');
  assert.strictEqual((logText.match(/progress /g) || []).length, 1000, 'batched tool log did not preserve every chunk');

  fs.rmSync(tempRoot, { recursive: true, force: true });

  console.log('progress persistence batching test passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
