const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveCommand } = require('../tools/video-tool');
const { AsrService } = require('../src/core/asr-service');
const { PROJECT_ROOT } = require('../src/core/workspace');

(async () => {
  const root = path.join(PROJECT_ROOT, 'workspace', '.star-note', 'asr-service-test');
  const audio = path.join(root, 'silence.wav');
  const ffmpeg = resolveCommand('ffmpeg');
  if (!ffmpeg) throw new Error('Project-local FFmpeg is missing. Run npm run setup:asr.');
  fs.mkdirSync(root, { recursive: true });
  const generated = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1', audio], { windowsHide: true, stdio: 'ignore' });
  if (generated.status !== 0) throw new Error('Could not generate ASR test audio.');
  await verifyModel('small', audio, root, 1);
  await verifyModel('medium', audio, root, 2);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function verifyModel(model, audio, root, requestCount) {
  const service = new AsrService({ id: `asr-gpu-${model}-test`, device: 'cuda', computeType: 'float16', model });
  try {
    await service.start();
    const pid = service.status().pid;
    const results = [];
    for (let index = 0; index < requestCount; index += 1) {
      results.push(await service.request({ id: `${model}-${index + 1}`, action: 'transcribe', audio, outputDir: path.join(root, `${model}-${index + 1}`), language: 'auto' }));
      assert.strictEqual(service.status().pid, pid, `${model} requests did not reuse the same service process`);
    }
    assert(pid && results.every((item) => item.ok && item.diagnostics && Number.isInteger(item.diagnostics.sentenceCount)), `${model} ASR service request failed`);
    console.log(`persistent ASR ${model} ok, pid=${pid}, requests=${requestCount}`);
  } finally {
    service.stop();
    await waitUntil(() => !service.child, 5000);
  }
}

async function waitUntil(predicate, timeoutMs) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('ASR service did not stop in time');
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
}
