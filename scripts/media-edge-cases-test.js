const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PassThrough } = require('stream');
const { nodeChildProcessSpec, readUtf8, utf8ChildEnvironment } = require('../src/core/child-process-io');
const { buildBundle, extractFrames, resolveCommand } = require('../tools/video-tool');
const { ToolRunner } = require('../src/core/tool-runner');
const { MIN_ARTIFACT_NAME_LENGTH, PROJECT_ROOT, PathSafetyError, evaluateWorkspacePathSafety, fitArtifactName, safeName } = require('../src/core/workspace');

(async () => {
  const root = path.join(PROJECT_ROOT, 'workspace', '.star-note', 'media-edge-cases-92%test');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const ffmpeg = resolveCommand('ffmpeg');
  assert(ffmpeg, 'Project-local FFmpeg is missing.');
  assert.strictEqual(utf8ChildEnvironment({ PATH: 'test' }).PYTHONIOENCODING, 'utf-8', 'Python child processes are not forced to UTF-8.');
  const localNode = nodeChildProcessSpec({ PATH: path.join(root, 'fake-global-node'), ELECTRON_RUN_AS_NODE: 'stale' });
  assert.strictEqual(path.resolve(localNode.executable), path.resolve(process.execPath), 'Tool child process can still resolve a global Node executable.');
  if (!process.versions.electron) assert.strictEqual(localNode.env.ELECTRON_RUN_AS_NODE, undefined, 'Plain Node child inherited an Electron runtime flag.');
  assert.strictEqual(safeName('标题\\带/非法:字符*?"<>|'), '标题带非法字符', 'Windows-reserved filename characters were not removed.');
  if (process.platform === 'win32') {
    const fittingRoot = `C:\\${'a'.repeat(156)}`;
    const fitted = fitArtifactName(fittingRoot, '长标题'.repeat(100));
    assert(fitted.length >= MIN_ARTIFACT_NAME_LENGTH, 'Recoverable long paths shortened the artifact below 24 characters.');
    assert(path.join(fittingRoot, fitted, `${fitted}.md`).length <= 259, 'Final Markdown path still exceeds the Windows limit.');
    assert(path.join(fittingRoot, fitted, 'tool-runs', `${'0'.repeat(13)}-${'t'.repeat(32)}-${'f'.repeat(6)}.log`).length <= 259, 'Tool log path still exceeds the Windows limit.');
    assert.notStrictEqual(fitArtifactName('D:\\short', 'x'.repeat(180)), fitArtifactName('D:\\short', `${'x'.repeat(180)} (2)`), 'Duplicate suffix was truncated before unique artifact hashing.');
    assert.throws(() => fitArtifactName(`C:\\${'a'.repeat(168)}`, '长标题'.repeat(100)), (error) => error instanceof PathSafetyError && error.code === 'WINDOWS_PATH_TOO_LONG');
    assert.strictEqual(evaluateWorkspacePathSafety([{ id: 'short', root: 'D:\\Star-Owner\\workspace', isDefault: true }], []).safe, true, 'Short workspace path was incorrectly rejected.');
    assert.strictEqual(evaluateWorkspacePathSafety([{ id: 'deep', root: `C:\\${'x'.repeat(100)}`, isDefault: true }], []).safe, false, 'Unsafe workspace path was not detected at startup.');
  }
  const splitUtf8 = new PassThrough();
  let decodedUtf8 = '';
  readUtf8(splitUtf8, (text) => { decodedUtf8 += text; });
  const chinese = Buffer.from('中文路径与日志', 'utf8');
  for (const byte of chinese) splitUtf8.write(Buffer.from([byte]));
  splitUtf8.end();
  await new Promise((resolve) => splitUtf8.once('end', resolve));
  assert.strictEqual(decodedUtf8, '中文路径与日志', 'Split UTF-8 chunks produced replacement characters in logs.');
  const gracefulFailure = spawnSync(process.execPath, [
    path.join(PROJECT_ROOT, 'tools', 'video-tool.js'), 'not-a-command', 'BV1xx411c7mD'
  ], { cwd: PROJECT_ROOT, windowsHide: true, encoding: 'utf8' });
  assert.strictEqual(gracefulFailure.status, 1, 'Video tool failure did not expose a conventional exit status.');
  assert(!/UV_HANDLE_CLOSING|Assertion failed/i.test(`${gracefulFailure.stdout || ''}\n${gracefulFailure.stderr || ''}`), 'Video tool failure closed libuv handles abruptly.');
  const merged = path.join(root, 'merged.mp4');
  const generated = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=1',
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', merged
  ], { windowsHide: true, stdio: 'ignore' });
  assert.strictEqual(generated.status, 0, 'Could not generate a video-only fixture.');
  fs.writeFileSync(path.join(root, 'info.json'), `${JSON.stringify({ duration: 1 })}\n`, 'utf8');

  for (const sourceName of ['bili-favorite-92%', 'cached-favorite-99%', 'single-video-90%']) {
    const sourceDir = path.join(root, sourceName);
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.copyFileSync(merged, path.join(sourceDir, 'merged.mp4'));
    fs.copyFileSync(path.join(root, 'info.json'), path.join(sourceDir, 'info.json'));
    const extracted = await extractFrames(sourceDir, 2);
    assert(extracted.length >= 1 && extracted.every((item) => /^frames\/frame-\d{3}\.jpg$/.test(item)), `${sourceName} did not receive concrete numbered frames.`);
    assert(!fs.existsSync(path.join(sourceDir, 'frames', 'frame-%03d.jpg')), `${sourceName} retained a literal FFmpeg frame placeholder.`);
    for (const item of extracted) {
      const bytes = fs.readFileSync(path.join(sourceDir, item));
      assert(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9, `${sourceName} frame is not a complete JPEG.`);
    }
  }

  const audioCommand = spawnSync(process.execPath, [
    path.join(PROJECT_ROOT, 'tools', 'video-tool.js'), 'audio', 'BV1xx411c7mD', '--out', root
  ], { cwd: PROJECT_ROOT, windowsHide: true, stdio: 'ignore' });
  assert.strictEqual(audioCommand.status, 0, 'Standalone audio preparation did not accept a video-only source.');
  const standaloneStatus = JSON.parse(fs.readFileSync(path.join(root, 'audio', 'status.json'), 'utf8'));
  assert.strictEqual(standaloneStatus.reason, 'NO_AUDIO_STREAM');

  await buildBundle('https://www.bilibili.com/video/BVNOAUDIO', root, {
    'skip-info': true,
    'skip-comments': true,
    'skip-subtitles': true,
    audio: true,
    frames: 1
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.audio?.available, false, 'A video-only source was not classified as having no audio stream.');
  assert.strictEqual(manifest.audio?.reason, 'NO_AUDIO_STREAM');
  assert(fs.existsSync(path.join(root, 'audio', 'status.json')), 'No-audio status artifact is missing.');
  assert(fs.existsSync(path.join(root, 'frames', 'frame-001.jpg')) && !fs.existsSync(path.join(root, 'frames', 'frame-%03d.jpg')), 'Bundle extraction failed when its artifact path contained a percent sign.');

  let toolRun = { id: 'no-audio-run', taskId: 'no-audio-task', artifactDir: root, logFile: path.join(root, 'run.log'), createdAt: new Date().toISOString() };
  const store = {
    getTask: () => ({ id: 'no-audio-task', duration: 1 }),
    getToolRun: () => toolRun,
    updateToolRun: (_id, patch) => { toolRun = { ...toolRun, ...patch }; return toolRun; }
  };
  const runner = new ToolRunner({ store });
  const result = await runner.runAsrStage({ warnings: [] }, toolRun);
  const asr = JSON.parse(fs.readFileSync(path.join(root, 'asr', 'asr-result.json'), 'utf8'));
  assert(result.ok && result.skipped && asr.noAudioStream && asr.diagnostics.noAudioStream, 'No-audio ASR diagnostic was not generated.');
  assert(fs.existsSync(path.join(root, 'asr', 'transcript.srt')), 'Empty SRT placeholder is missing.');
  fs.rmSync(root, { recursive: true, force: true });
  console.log('media edge-case test passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
