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
  const service = new AsrService({ id: 'asr-gpu-test', device: 'cuda', computeType: 'float16', model: 'small' });
  try {
    await service.start();
    const pid = service.status().pid;
    const first = await service.request({ id: 'reuse-1', action: 'transcribe', audio, outputDir: path.join(root, 'first'), language: 'zh', beamSize: 1, conditionOnPreviousText: false });
    const second = await service.request({ id: 'reuse-2', action: 'transcribe', audio, outputDir: path.join(root, 'second'), language: 'zh', beamSize: 1, conditionOnPreviousText: false });
    assert(pid, 'ASR service did not expose a PID');
    assert.strictEqual(service.status().pid, pid, 'ASR requests did not reuse the same service process');
    assert(first.ok && second.ok, 'ASR service request failed');
    console.log(`persistent ASR ok, pid=${pid}, first=${first.elapsedMs}ms, second=${second.elapsedMs}ms`);
  } finally {
    service.stop();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
