const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ASR_MODELS, DEFAULT_ASR_MODEL, asrComputeType, getAsrModel, normalizeAsrModel } = require('../src/core/asr-models');
const { DependencyManager } = require('../src/core/dependency-manager');
const { ToolRunner } = require('../src/core/tool-runner');

const ids = ASR_MODELS.map((model) => model.id);
assert.deepStrictEqual(ids, ['small', 'medium', 'large-v3-turbo']);
assert.strictEqual(DEFAULT_ASR_MODEL, 'medium');
assert.strictEqual(normalizeAsrModel('large-v3-turbo'), 'large-v3-turbo');
assert.strictEqual(normalizeAsrModel('unknown-model'), 'medium');
assert.strictEqual(asrComputeType('medium', 'cuda'), 'float16');
assert.strictEqual(asrComputeType('large-v3-turbo', 'cuda'), 'int8_float16');
assert.strictEqual(asrComputeType('large-v3-turbo', 'cpu'), 'int8');
assert(getAsrModel('large-v3-turbo').gpuTotalMiB < 4096, 'Turbo must remain available below 4GB VRAM');
assert.strictEqual(getAsrModel('large-v3-turbo').gpuStartupFreeMiB, 2048, 'Turbo startup reserve must fit a typical 3GB display GPU');

const root = path.join(__dirname, '..', '.cache', 'asr-models-test');
fs.rmSync(root, { recursive: true, force: true });
const settings = new Map();
const store = {
  get: (scope, id) => settings.get(`${scope}:${id}`) || null,
  set: (scope, id, value) => settings.set(`${scope}:${id}`, value),
  save: () => {},
  commit: () => {}
};

try {
  const manager = new DependencyManager({ store, projectRoot: root, version: '1.0.6', dependencyVersion: '1.0.0' });
  const dependencyState = manager.state();
  const turboPackage = dependencyState.packages.find((item) => item.id === 'model-large-v3-turbo');
  assert(turboPackage && turboPackage.localImport && !turboPackage.required, 'Turbo optional dependency contract is missing');
  assert.strictEqual(turboPackage.assetName, 'Star-Owner-v1.0.0-model-large-v3-turbo.zip');
  assert(!dependencyState.missingRequired.includes(turboPackage.id), 'Missing optional Turbo model blocked first launch');

  const runner = new ToolRunner({ store });
  runner.configureAsrServices('large-v3-turbo');
  assert.strictEqual(runner.gpuAsr.model, 'large-v3-turbo');
  assert.strictEqual(runner.gpuAsr.computeType, 'int8_float16');
  assert.strictEqual(runner.cpuAsr.computeType, 'int8');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('ASR model registry test passed');
