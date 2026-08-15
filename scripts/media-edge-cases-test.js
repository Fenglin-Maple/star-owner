const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const { PassThrough } = require('stream');
const { nodeChildProcessSpec, readUtf8, utf8ChildEnvironment } = require('../src/core/child-process-io');
const { assessBilibiliPageMetadata, bilibiliMetadataRetryDelay, bilibiliRiskControlDelay, buildBundle, extractFrames, fetchCompleteVideoData, fetchPlainJson, hasCompleteMetadataRequirement, isBilibiliRiskControlResponse, readReusableVideoInfo, resolveCommand } = require('../tools/video-tool');
const { hasReusableMultipartInfo, requiresCompleteBilibiliMetadata, ToolRunner } = require('../src/core/tool-runner');
const { isBilibiliMetadataIncompleteMessage } = require('../src/core/media-errors');
const { MIN_ARTIFACT_NAME_LENGTH, PROJECT_ROOT, PathSafetyError, evaluateWorkspacePathSafety, fitArtifactName, safeName } = require('../src/core/workspace');

(async () => {
  const root = path.join(PROJECT_ROOT, 'workspace', '.star-note', 'media-edge-cases-92%test');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const reusableInfoRoot = path.join(root, 'reusable-info');
  fs.mkdirSync(reusableInfoRoot, { recursive: true });
  fs.writeFileSync(path.join(reusableInfoRoot, 'info.json'), `${JSON.stringify({ bvid: 'BV1xx411c7mD', cid: '123', page: 2, pages: [{ cid: '123', page: 2 }] })}\n`, 'utf8');
  assert(readReusableVideoInfo('https://www.bilibili.com/video/BV1xx411c7mD?p=2', reusableInfoRoot, { 'reuse-info': true, cid: '123', page: '2' }), 'matching multi-part metadata was not reused');
  assert.strictEqual(readReusableVideoInfo('https://www.bilibili.com/video/BV1xx411c7mD?p=3', reusableInfoRoot, { 'reuse-info': true, cid: '999', page: '3' }), null, 'mismatched multi-part metadata was reused');
  assert(hasReusableMultipartInfo({ bvid: 'BV1xx411c7mD', cid: '123', multiPartRole: 'part' }, reusableInfoRoot), 'tool runner did not accept the matching parent metadata snapshot');
  assert(!hasReusableMultipartInfo({ bvid: 'BV1xx411c7mD', cid: '999', multiPartRole: 'part' }, reusableInfoRoot), 'tool runner accepted metadata from another P');
  assert(isBilibiliRiskControlResponse(412, { code: -412 }, '{"message":"Request was banned"}'), 'HTTP 412 was not recognized as Bilibili risk control');
  assert(isBilibiliRiskControlResponse(200, { code: -412 }, ''), 'Bilibili API -412 was not recognized when HTTP status was 200');
  const retryDelay = bilibiliRiskControlDelay(0, { 'risk-control-base-delay-ms': 100 });
  assert(retryDelay >= 350 && retryDelay < 1000, 'Bilibili risk-control retry delay is outside the bounded jitter window');
  assert.deepStrictEqual(assessBilibiliPageMetadata({ videos: 1, pages: [{ page: 1 }] }).complete, true, 'complete single-part metadata was rejected');
  assert.deepStrictEqual(assessBilibiliPageMetadata({ videos: 2, pages: [{ page: 1 }, { page: 2 }] }).complete, true, 'complete multi-part metadata was rejected before support inspection');
  assert.strictEqual(assessBilibiliPageMetadata({ videos: 2, pages: [{ page: 1 }] }).complete, false, 'partial pages response was accepted despite a videos count mismatch');
  assert.strictEqual(assessBilibiliPageMetadata({ videos: 1, pages: [] }).complete, false, 'empty pages response was accepted');
  assert.strictEqual(hasCompleteMetadataRequirement({}), false, 'complete metadata validation became implicit for ordinary video requests');
  assert.strictEqual(hasCompleteMetadataRequirement({ 'metadata-retries': 2 }), true, 'complete metadata validation flag was not recognized');
  assert(isBilibiliMetadataIncompleteMessage('[video-tool] B站视频元数据不完整（已尝试 3 次）'), 'metadata-incomplete child-process output was not classified');
  assert.strictEqual(bilibiliMetadataRetryDelay(0, { 'metadata-retry-base-delay-ms': 0 }), 0, 'metadata retry test delay was not configurable');
  let metadataRequests = 0;
  const recoveredMetadata = await fetchCompleteVideoData('BV1metadata01', { 'metadata-retries': 2, 'metadata-retry-base-delay-ms': 0 }, async () => {
    metadataRequests += 1;
    return metadataRequests < 3
      ? { code: 0, data: { videos: 2, pages: [{ page: 1 }] } }
      : { code: 0, data: { videos: 2, pages: [{ page: 1 }, { page: 2 }] } };
  });
  assert(metadataRequests === 3 && recoveredMetadata.data.pages.length === 2, 'incomplete metadata did not recover on the third bounded attempt');
  let incompleteMetadataError = null;
  metadataRequests = 0;
  try {
    await fetchCompleteVideoData('BV1metadata02', { 'metadata-retries': 2, 'metadata-retry-base-delay-ms': 0 }, async () => {
      metadataRequests += 1;
      return { code: 0, data: { videos: 87, pages: [{ page: 1 }] } };
    });
  } catch (error) { incompleteMetadataError = error; }
  assert(metadataRequests === 3 && incompleteMetadataError?.code === 'BILIBILI_METADATA_INCOMPLETE' && incompleteMetadataError.attempts === 3, 'persistent incomplete metadata did not stop after three attempts with a dedicated error');
  let riskControlRequests = 0;
  const riskControlServer = http.createServer((_request, response) => {
    riskControlRequests += 1;
    response.writeHead(riskControlRequests === 1 ? 412 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(riskControlRequests === 1 ? { code: -412, message: 'Request was banned' } : { code: 0, data: { recovered: true } }));
  });
  await new Promise((resolve, reject) => riskControlServer.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  try {
    const address = riskControlServer.address();
    const recovered = await fetchPlainJson(`http://127.0.0.1:${address.port}/view`, { 'risk-control-retries': 1, 'risk-control-base-delay-ms': 100 });
    assert(recovered.code === 0 && riskControlRequests === 2, 'Bilibili HTTP 412 did not recover through bounded retry');
  } finally {
    await new Promise((resolve) => riskControlServer.close(resolve));
  }
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
  let childToolRun = { id: 'metadata-child-process-run', logFile: path.join(root, 'metadata-child-process.log') };
  const childRunner = new ToolRunner({
    store: {
      getToolRun: () => childToolRun,
      updateToolRun: (_id, patch) => {
        childToolRun = { ...childToolRun, ...patch };
        return childToolRun;
      }
    }
  });
  let childProcessError = null;
  try {
    await childRunner.runChild(
      { runId: childToolRun.id, cancelled: false },
      ['-e', "process.stderr.write('B站视频元数据不完整（已尝试 3 次）：pages 缺失。'); process.exit(7)"],
      60_000
    );
  } catch (error) {
    childProcessError = error;
  }
  assert(childProcessError?.code === 'BILIBILI_METADATA_INCOMPLETE' && childProcessError.attempts === 3, 'ToolRunner did not preserve the dedicated metadata error from a child process');
  const cookieFile = path.join(root, 'cookies.txt');
  fs.writeFileSync(cookieFile, '# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\ttest-session\n', 'utf8');
  const multipartArgs = runner.buildArgs({
    task: { bvid: 'BV1xx411c7mD', cid: '123', page: 2, multiPartRole: 'part' },
    action: 'subtitles',
    collection: { cookieFile },
    artifactDir: root,
    options: { reuseInfo: true }
  });
  assert(multipartArgs.includes('--cookies') && multipartArgs.includes(cookieFile), 'multi-part tool arguments did not include the collection Cookie');
  assert(multipartArgs.includes('--reuse-info') && multipartArgs.includes('--risk-control-retries'), 'multi-part tool arguments did not enable metadata reuse and risk-control retry');
  const singleArgs = runner.buildArgs({
    task: { bvid: 'BV1xx411c7mD', singleTask: true, cookieFile },
    action: 'info',
    collection: {},
    artifactDir: root,
    options: {}
  });
  assert(singleArgs.includes('--cookies') && singleArgs.includes(cookieFile), 'queued single-video arguments lost the task Cookie when the internal collection had none');
  assert(singleArgs.includes('--risk-control-retries') && singleArgs[singleArgs.indexOf('--risk-control-retries') + 1] === '3', 'single-video metadata did not enable bounded risk-control retries');
  assert.throws(() => runner.buildArgs({
    task: { bvid: 'BV1xx411c7mD', singleTask: true, cookieFile: path.join(root, 'missing-cookies.txt') },
    action: 'info',
    collection: {},
    artifactDir: root,
    options: {}
  }), (error) => error.code === 'BILIBILI_COOKIE_REQUIRED', 'single-video execution silently fell back to anonymous Bilibili access when its Cookie became unavailable');
  const ordinaryArgs = runner.buildArgs({ task: { bvid: 'BV1xx411c7mD', cookieFile }, action: 'subtitles', collection: {}, artifactDir: root, options: {} });
  assert(!ordinaryArgs.includes('--cookies') && !ordinaryArgs.includes('--reuse-info') && !ordinaryArgs.includes('--risk-control-retries') && !ordinaryArgs.includes('--metadata-retries'), 'Bilibili safeguards leaked into an unclassified ordinary video path');
  const ordinaryCollectionArgs = runner.buildArgs({ task: { bvid: 'BV1xx411c7mD' }, action: 'info', collection: { cookieFile }, artifactDir: root, options: {} });
  assert(ordinaryCollectionArgs.includes('--cookies') && ordinaryCollectionArgs.includes(cookieFile) && !ordinaryCollectionArgs.includes('--metadata-retries'), 'unclassified collection unexpectedly received Bilibili pages validation');
  const biliCollectionArgs = runner.buildArgs({ task: { bvid: 'BV1xx411c7mD' }, action: 'info', collection: { mediaId: 'folder-1', cookieFile }, artifactDir: root, options: { requireCompleteMetadata: true } });
  assert(biliCollectionArgs.includes('--metadata-retries'), 'Bilibili favorite collection did not enable complete metadata validation');
  const localCacheArgs = runner.buildArgs({ task: { bvid: 'LOCAL-VIDEO', localImported: true, sourceType: 'local-video' }, action: 'info', collection: { collectionKind: 'video-cache', videoCacheSource: 'local-media', cookieFile }, artifactDir: root, options: { requireCompleteMetadata: true } });
  assert(!localCacheArgs.includes('--metadata-retries'), 'local imported media incorrectly received Bilibili pages validation');
  const downloadedCacheArgs = runner.buildArgs({ task: { bvid: 'BV1xx411c7mD', cachedVideoId: 'cache-1' }, action: 'info', collection: { collectionKind: 'video-cache', cookieFile }, artifactDir: root, options: { requireCompleteMetadata: true } });
  assert(!downloadedCacheArgs.includes('--metadata-retries'), 'downloaded Bilibili cache unexpectedly received the Agent-only pages validation');
  assert(requiresCompleteBilibiliMetadata({ bvid: 'BV1xx411c7mD' }, { mediaId: 'folder-1' }, { requireCompleteMetadata: true }) === true, 'Bilibili favorite collection did not qualify for complete metadata validation');
  assert(requiresCompleteBilibiliMetadata({ singleTask: true, bvid: 'BV1xx411c7mD' }, { internal: true }, { requireCompleteMetadata: true }) === false, 'single-video internal collection inherited the Agent-only pages validation');
  assert(requiresCompleteBilibiliMetadata({ bvid: 'BV1xx411c7mD' }, { collectionKind: 'video-cache' }, { requireCompleteMetadata: true }) === false, 'video-cache collection inherited the Agent-only pages validation');
  assert(requiresCompleteBilibiliMetadata({ localImported: true, bvid: 'LOCAL-VIDEO' }, { mediaId: 'folder-1' }, { requireCompleteMetadata: true }) === false, 'local media bypass did not take priority over a Bilibili-shaped collection');
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
