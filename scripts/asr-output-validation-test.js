const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ToolRunner } = require('../src/core/tool-runner');
const { validateAsrArtifacts } = require('../src/core/validation');

const root = path.join(__dirname, '..', '.cache', 'asr-output-validation-test');

function writeArtifacts(artifactDir, segments) {
  const directory = path.join(artifactDir, 'asr');
  fs.mkdirSync(directory, { recursive: true });
  const srt = segments.map((item, index) => [
    String(index + 1),
    `${formatTime(item.start)} --> ${formatTime(item.end)}`,
    item.text,
    ''
  ].join('\n')).join('\n');
  const timed = segments.map((item) => `[${formatTime(item.start)} --> ${formatTime(item.end)}] ${item.text}`).join('\n');
  fs.writeFileSync(path.join(directory, 'transcript.srt'), srt, 'utf8');
  fs.writeFileSync(path.join(directory, 'asr-transcript.txt'), timed ? `${timed}\n` : '', 'utf8');
  fs.writeFileSync(path.join(directory, 'asr-result.json'), `${JSON.stringify({ language: 'zh', segments }, null, 2)}\n`, 'utf8');
}

function formatTime(seconds) {
  const milliseconds = Math.max(0, Math.round(Number(seconds) * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const remainder = milliseconds % 60_000;
  const secs = Math.floor(remainder / 1000);
  const millis = remainder % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function fakeService(artifactDir, { alwaysInvalid = false } = {}) {
  const calls = [];
  return {
    calls,
    cancel() {},
    async request(request, { onProgress } = {}) {
      calls.push({ ...request });
      onProgress?.({ progress: 1, audioSeconds: 10, totalSeconds: 10 });
      const valid = !alwaysInvalid && calls.length >= 3;
      writeArtifacts(artifactDir, valid
        ? [{ id: 0, start: 1, end: 2, text: '最终有效句段' }]
        : [{ id: 0, start: 2, end: 3, text: '第一句' }, { id: 1, start: 1, end: 4, text: '第二句' }]);
      return { ok: true, language: 'zh', segments: valid ? 1 : 2 };
    }
  };
}

(async () => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const runner = new ToolRunner({ store: {} });

  const retryRoot = path.join(root, 'retry-success');
  const retryOutput = path.join(retryRoot, 'asr');
  const retryService = fakeService(retryRoot);
  const retryResult = await runner.requestValidatedAsr({
    service: retryService,
    outputDir: retryOutput,
    artifactDir: retryRoot,
    timeoutMs: 30_000,
    request: { id: 'asr-retry-success', action: 'transcribe', audio: 'fixture.wav', outputDir: retryOutput, language: 'auto', beamSize: 5, conditionOnPreviousText: true }
  });
  assert.strictEqual(retryService.calls.length, 3, 'ASR output validation did not use all three attempts');
  assert.strictEqual(retryService.calls[0].conditionOnPreviousText, true);
  assert.strictEqual(retryService.calls[1].conditionOnPreviousText, false);
  assert.strictEqual(retryService.calls[2].beamSize, 1);
  assert.strictEqual(retryResult.retryCount, 2);
  assert(validateAsrArtifacts(retryRoot).ok, 'third ASR attempt did not leave valid artifacts');

  const shapeRoot = path.join(root, 'shape-retry');
  const shapeOutput = path.join(shapeRoot, 'asr');
  const shapeService = {
    calls: 0,
    cancel() {},
    async request() {
      this.calls += 1;
      if (this.calls < 3) {
        const error = new Error('Whisper sentence output is malformed');
        error.code = 'ASR_OUTPUT_INVALID';
        throw error;
      }
      writeArtifacts(shapeRoot, [{ id: 0, start: 1, end: 2, text: '修复后的句段' }]);
      return { ok: true, language: 'zh', segments: 1 };
    }
  };
  await runner.requestValidatedAsr({
    service: shapeService,
    outputDir: shapeOutput,
    artifactDir: shapeRoot,
    timeoutMs: 30_000,
    request: { id: 'asr-shape-retry', action: 'transcribe', audio: 'fixture.wav', outputDir: shapeOutput, language: 'auto' }
  });
  assert.strictEqual(shapeService.calls, 3, 'normalization errors did not enter the ASR retry path');

  const emptyRoot = path.join(root, 'empty-speech');
  const emptyOutput = path.join(emptyRoot, 'asr');
  const emptyService = {
    calls: 0,
    cancel() {},
    async request() {
      this.calls += 1;
      writeArtifacts(emptyRoot, []);
      return { ok: true, language: 'zh', segments: 0 };
    }
  };
  const emptyResult = await runner.requestValidatedAsr({
    service: emptyService,
    outputDir: emptyOutput,
    artifactDir: emptyRoot,
    timeoutMs: 30_000,
    request: { id: 'asr-empty-speech', action: 'transcribe', audio: 'fixture.wav', outputDir: emptyOutput, language: 'auto' }
  });
  assert.strictEqual(emptyService.calls, 1, 'a valid empty ASR result was retried');
  assert.strictEqual(emptyResult.retryCount, 0);

  const failureRoot = path.join(root, 'retry-failure');
  const failureOutput = path.join(failureRoot, 'asr');
  const failureService = fakeService(failureRoot, { alwaysInvalid: true });
  await assert.rejects(
    () => runner.requestValidatedAsr({
      service: failureService,
      outputDir: failureOutput,
      artifactDir: failureRoot,
      timeoutMs: 30_000,
      request: { id: 'asr-retry-failure', action: 'transcribe', audio: 'fixture.wav', outputDir: failureOutput, language: 'auto' }
    }),
    (error) => error.code === 'ASR_OUTPUT_INVALID' && /3/.test(error.message)
  );
  assert.strictEqual(failureService.calls.length, 3, 'ASR retry exceeded or stopped before the three-attempt limit');

  const infrastructureService = {
    calls: 0,
    cancel() {},
    async request() {
      this.calls += 1;
      const error = new Error('CUDA runtime unavailable');
      error.code = 'ASR_INFRASTRUCTURE_FAILURE';
      throw error;
    }
  };
  await assert.rejects(
    () => runner.requestValidatedAsr({
      service: infrastructureService,
      outputDir: path.join(root, 'infrastructure', 'asr'),
      artifactDir: path.join(root, 'infrastructure'),
      timeoutMs: 30_000,
      request: { id: 'asr-infrastructure', action: 'transcribe', audio: 'fixture.wav', language: 'auto' }
    }),
    (error) => error.code === 'ASR_INFRASTRUCTURE_FAILURE'
  );
  assert.strictEqual(infrastructureService.calls, 1, 'infrastructure failures must not enter output retries');

  const cancelledService = { calls: 0, cancel() {}, async request() { this.calls += 1; } };
  const cancelled = new Error('cancelled');
  cancelled.code = 'RUN_CANCELLED';
  await assert.rejects(
    () => runner.requestValidatedAsr({
      service: cancelledService,
      outputDir: path.join(root, 'cancelled', 'asr'),
      artifactDir: path.join(root, 'cancelled'),
      isCancelled: () => true,
      cancelError: () => cancelled,
      request: { id: 'asr-cancelled', action: 'transcribe', audio: 'fixture.wav', language: 'auto' }
    }),
    (error) => error.code === 'RUN_CANCELLED'
  );
  assert.strictEqual(cancelledService.calls, 0, 'a cancelled workflow started an ASR retry');

  const malformedRoot = path.join(root, 'malformed-json-segment');
  writeArtifacts(malformedRoot, []);
  fs.writeFileSync(path.join(malformedRoot, 'asr', 'asr-result.json'), `${JSON.stringify({ segments: [null] })}\n`, 'utf8');
  const malformedValidation = validateAsrArtifacts(malformedRoot);
  assert.strictEqual(malformedValidation.ok, false, 'a null ASR segment passed validation');
  assert(malformedValidation.errors.length > 0, 'malformed ASR validation did not return a diagnostic');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('ASR output validation and retry test passed');
})().catch((error) => {
  fs.rmSync(root, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});
