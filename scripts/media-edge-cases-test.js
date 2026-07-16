const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildBundle, resolveCommand } = require('../tools/video-tool');
const { ToolRunner } = require('../src/core/tool-runner');
const { PROJECT_ROOT } = require('../src/core/workspace');

(async () => {
  const root = path.join(PROJECT_ROOT, 'workspace', '.star-note', 'media-edge-cases-test');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const ffmpeg = resolveCommand('ffmpeg');
  assert(ffmpeg, 'Project-local FFmpeg is missing.');
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
