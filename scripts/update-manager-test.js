const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const { UpdateManager, cleanupManagedUpdateArtifacts, commandLineContainsProjectRoot, findRunningProjectProcesses, resolveCoreRelease, validateArchiveEntries, validateStagedPackage, waitForUpdaterReady } = require('../src/core/update-manager');

function runPowerShell(script, args) {
  const result = runPowerShellResult(script, args);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`PowerShell helper failed (${result.status}): ${result.stdout}\n${result.stderr}`);
  return result;
}

function runPowerShellResult(script, args) {
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000
  });
}

function helperArgs(mode, root, extra = {}) {
  const args = [
    '-Mode', mode,
    '-ProjectRoot', root,
    '-ProcessId', '2147483647',
    '-StagedRoot', extra.stagedRoot || '',
    '-SourceWorkspace', extra.sourceWorkspace || '',
    '-TargetVersion', extra.targetVersion || '9.9.9',
    '-OperationId', extra.operationId || `test-operation-${Date.now()}`,
    '-Relaunch'
  ];
  if (extra.cancelFile) args.push('-CancelFile', extra.cancelFile);
  if (extra.testStepDelayMilliseconds) args.push('-TestStepDelayMilliseconds', String(extra.testStepDelayMilliseconds));
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function touch(file, timestamp) {
  fs.utimesSync(file, timestamp, timestamp);
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

async function waitForPath(file, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

async function waitForJson(file, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = readJson(file);
      if (predicate(value)) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for JSON state in ${file}`);
}

function createValidStagedPackage(packageRoot, version = '9.9.9') {
  const files = [
    'src/main.js',
    'Start-StarOwner.cmd',
    'scripts/apply-portable-operation.ps1',
    'scripts/recover-portable-operation.ps1',
    'tools/updater/StarOwnerUpdater.cs',
    'tools/updater/StarOwnerUpdater.exe',
    'tools/updater/build-updater.ps1',
    'tools/faster-whisper-cli.py',
    'node_modules/electron/dist/electron.exe',
    'node_modules/mammoth/package.json',
    'node_modules/pdf-parse/package.json',
    'node_modules/sql.js/package.json',
    'node_modules/mermaid/dist/mermaid.min.js',
    'runtime/git/cmd/git.exe',
    'runtime/faster-whisper/Scripts/python.exe',
    'runtime/faster-whisper/Lib/site-packages/faster_whisper/__init__.py',
    'runtime/faster-whisper/Lib/site-packages/yt_dlp/__init__.py',
    'runtime/faster-whisper/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-fixture.exe',
    'runtime/vc-runtime/concrt140.dll',
    'runtime/vc-runtime/msvcp140.dll',
    'runtime/vc-runtime/msvcp140_codecvt_ids.dll',
    'runtime/vc-runtime/vcruntime140.dll',
    'runtime/vc-runtime/vcruntime140_1.dll',
    'runtime/python/cpython-3.12.13-windows-x86_64-none/python.exe'
  ];
  for (const relative of files) {
    const target = path.join(packageRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'fixture');
  }
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'star-owner', version, dependencyReleaseVersion: '1.0.0' }));
  fs.writeFileSync(path.join(packageRoot, 'package-lock.json'), JSON.stringify({ name: 'star-owner', version, packages: { '': { name: 'star-owner', version } } }));
  fs.writeFileSync(path.join(packageRoot, 'portable-manifest.json'), JSON.stringify({ version, dependencyReleaseVersion: '1.0.0', platform: 'win-x64', launcher: 'Start-StarOwner.cmd' }));
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'star-owner-update-test-'));
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });

  const handshakeFile = path.join(root, 'handshake.json');
  const handshakeChild = new EventEmitter();
  setTimeout(() => fs.writeFileSync(handshakeFile, JSON.stringify({ operationId: 'handshake-fixture', status: 'ready', updaterPid: 4242 })), 40);
  const handshake = await waitForUpdaterReady({ child: handshakeChild, readyFile: handshakeFile, operationId: 'handshake-fixture', timeoutMs: 1000, pollMs: 20 });
  assert.strictEqual(handshake.updaterPid, 4242, 'updater handshake did not return the native updater PID');
  const twoWayReady = path.join(root, 'two-way-ready.json');
  const twoWayAcknowledge = path.join(root, 'two-way-ack.json');
  const twoWayChild = new EventEmitter();
  setTimeout(() => fs.writeFileSync(twoWayReady, JSON.stringify({ operationId: 'two-way-fixture', status: 'ready', updaterPid: 4343 })), 30);
  const twoWayResponder = (async () => {
    await waitForPath(twoWayAcknowledge, 1000);
    assert.strictEqual(readJson(twoWayAcknowledge).status, 'acknowledged', 'application did not acknowledge updater readiness');
    fs.writeFileSync(twoWayReady, JSON.stringify({ operationId: 'two-way-fixture', status: 'accepted', updaterPid: 4343, helperPid: 4444 }));
  })();
  const twoWayHandshake = await waitForUpdaterReady({ child: twoWayChild, readyFile: twoWayReady, acknowledgeFile: twoWayAcknowledge, operationId: 'two-way-fixture', timeoutMs: 1500, pollMs: 20 });
  await twoWayResponder;
  assert.strictEqual(twoWayHandshake.helperPid, 4444, 'application quit before the native updater accepted the handoff');
  const exitedChild = new EventEmitter();
  setTimeout(() => exitedChild.emit('exit', 7, null), 20);
  await assert.rejects(waitForUpdaterReady({ child: exitedChild, readyFile: path.join(root, 'never-ready-exit.json'), operationId: 'exit-fixture', timeoutMs: 1000, pollMs: 20 }), /接管前退出/, 'an updater that exited before readiness was accepted');
  const timeoutChild = new EventEmitter();
  await assert.rejects(waitForUpdaterReady({ child: timeoutChild, readyFile: path.join(root, 'never-ready-timeout.json'), operationId: 'timeout-fixture', timeoutMs: 80, pollMs: 20 }), /启动超时/, 'a missing updater handshake did not time out');

  const nativeUpdater = path.join(__dirname, '..', 'tools', 'updater', 'StarOwnerUpdater.exe');
  assert(fs.existsSync(nativeUpdater), 'native updater executable is missing');
  const probeRoot = path.join(root, 'native probe 中文 path');
  fs.mkdirSync(probeRoot, { recursive: true });
  const probeReady = path.join(probeRoot, 'ready.txt');
  const probeComplete = path.join(probeRoot, 'complete.txt');
  const probeArgs = ['--probe', probeReady, probeComplete, '900', 'detached-fixture'];
  const launcherCode = `const {spawn}=require('child_process');const child=spawn(${JSON.stringify(nativeUpdater)},${JSON.stringify(probeArgs)},{detached:true,windowsHide:true,stdio:'ignore'});child.unref();`;
  const probeLauncher = spawnSync(process.execPath, ['-e', launcherCode], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.strictEqual(probeLauncher.status, 0, `native updater probe launcher failed: ${probeLauncher.stderr || probeLauncher.stdout}`);
  await waitForPath(probeReady, 5000);
  await waitForPath(probeComplete, 5000);
  assert.strictEqual(fs.readFileSync(probeComplete, 'utf8'), 'detached-fixture:complete', 'native updater did not survive its launcher process');

  const manager = new UpdateManager({ projectRoot, version: '1.2.7', platform: 'win32', fetchImpl: async () => { throw new Error('network not used'); } });
  const partial = path.join(manager.downloadRoot, 'core.zip.partial');
  const bytes = Buffer.from('complete archive fixture');
  fs.writeFileSync(partial, bytes);
  let requests = 0;
  manager.fetchImpl = async (_url, options) => {
    requests += 1;
    if (options.headers.Range) return new Response(null, { status: 416 });
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
  };
  await manager.downloadFile('https://example.invalid/core.zip', partial, 'core.zip', bytes.length, require('crypto').createHash('sha256').update(bytes).digest('hex'));
  assert.strictEqual(requests, 1, 'a complete partial archive was downloaded again after HTTP 416');

  fs.writeFileSync(partial, Buffer.from('stale partial'));
  requests = 0;
  await manager.downloadFile('https://example.invalid/core.zip', partial, 'core.zip', bytes.length, require('crypto').createHash('sha256').update(bytes).digest('hex'));
  assert.strictEqual(requests, 2, 'an invalid HTTP 416 partial archive was not restarted from byte zero');
  assert.deepStrictEqual(fs.readFileSync(partial), bytes, 'restarted update download did not write the complete archive');

  fs.mkdirSync(path.join(manager.updateRoot), { recursive: true });
  fs.writeFileSync(path.join(manager.updateRoot, 'operation-journal.json'), JSON.stringify({ operationId: 'incomplete-1', status: 'applying' }));
  const recovered = new UpdateManager({ projectRoot, version: '1.2.7', platform: 'win32', fetchImpl: async () => { throw new Error('network not used'); } });
  assert.strictEqual(recovered.state().lastOperation.status, 'incomplete', 'incomplete update journal was not exposed after restart');
  fs.rmSync(path.join(manager.updateRoot, 'operation-journal.json'), { force: true });

  assert.strictEqual(validateArchiveEntries(['Star-Owner/package.json', 'Star-Owner/templates/video-summary-template.md']).prefix, 'Star-Owner');
  assert.throws(() => validateArchiveEntries(['Star-Owner/package.json', '../outside.txt']), /不安全|unsafe|路径/);
  for (const unsafeEntry of [
    'C:/escape/package.json',
    'C:\\escape\\package.json',
    '//server/share/package.json',
    '\\\\?\\C:\\escape\\package.json',
    'Star-Owner/./payload.txt',
    'Star-Owner//payload.txt',
    'Star-Owner/payload.txt:stream',
    'Star-Owner/NUL.txt',
    'Star-Owner/trailing./payload.txt',
    `Star-Owner/control${String.fromCharCode(0)}.txt`
  ]) {
    assert.throws(() => validateArchiveEntries(['Star-Owner/package.json', unsafeEntry]), /不安全|路径|Win32|控制字符|数据流|保留设备名|尾随字符/);
  }
  assert.throws(() => validateArchiveEntries(['Star-Owner/package.json', 'star-owner/PACKAGE.JSON']), /重复路径/);
  const stagedValidationRoot = path.join(root, 'validated-stage');
  createValidStagedPackage(stagedValidationRoot);
  assert.doesNotThrow(() => validateStagedPackage(stagedValidationRoot, '9.9.9'), 'a complete portable core package was rejected');
  fs.rmSync(path.join(stagedValidationRoot, 'tools', 'updater', 'StarOwnerUpdater.exe'), { force: true });
  assert.throws(() => validateStagedPackage(stagedValidationRoot, '9.9.9'), /StarOwnerUpdater|更新器|必需文件/, 'package without the native updater passed staged validation');
  createValidStagedPackage(stagedValidationRoot);
  const stableAsset = {
    name: 'Star-Owner-v9.9.9-win-x64-core.zip',
    browser_download_url: 'https://example.invalid/core.zip',
    size: 123,
    digest: `sha256:${'a'.repeat(64)}`
  };
  const stableRelease = resolveCoreRelease({ id: 99, tag_name: 'v9.9.9', draft: false, prerelease: false, assets: [stableAsset, { name: `${stableAsset.name}.sha256`, browser_download_url: 'https://example.invalid/core.sha256' }] });
  assert.strictEqual(stableRelease.version, '9.9.9', 'stable core release was not resolved');
  assert.throws(() => resolveCoreRelease({ tag_name: 'v9.9.10', draft: false, prerelease: true, assets: [] }), /稳定|stable/, 'pre-release was accepted as an automatic update');
  fs.rmSync(path.join(stagedValidationRoot, 'runtime', 'git'), { recursive: true, force: true });
  assert.throws(() => validateStagedPackage(stagedValidationRoot, '9.9.9'), /runtime\\git|runtime\/git/, 'package without Portable Git passed staged validation');
  createValidStagedPackage(stagedValidationRoot);
  const manifest = readJson(path.join(stagedValidationRoot, 'portable-manifest.json'));
  manifest.version = '9.9.8';
  fs.writeFileSync(path.join(stagedValidationRoot, 'portable-manifest.json'), JSON.stringify(manifest));
  assert.throws(() => validateStagedPackage(stagedValidationRoot, '9.9.9'), /manifest|portable/, 'manifest version mismatch passed staged validation');
  createValidStagedPackage(stagedValidationRoot);
  fs.rmSync(path.join(stagedValidationRoot, 'runtime', 'python'), { recursive: true, force: true });
  assert.throws(() => validateStagedPackage(stagedValidationRoot, '9.9.9'), /基础 Python|Python|必需文件/, 'package without base Python passed staged validation');
  createValidStagedPackage(stagedValidationRoot);
  assert(commandLineContainsProjectRoot('"D:\\Old Star Owner\\node_modules\\electron\\dist\\electron.exe" "D:\\Old Star Owner"', 'D:\\Old Star Owner'), 'project process command line was not recognized');
  assert(!commandLineContainsProjectRoot('"D:\\Old Star Owner 2\\electron.exe"', 'D:\\Old Star Owner'), 'a sibling project command line was treated as the migration source');

  const cleanupRoot = path.join(root, 'cleanup-project', '.updates');
  const cleanupDownloads = path.join(cleanupRoot, 'downloads');
  fs.mkdirSync(cleanupDownloads, { recursive: true });
  const oldTime = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
  for (let index = 1; index <= 3; index += 1) {
    const backup = path.join(cleanupRoot, `operation-backup-fixture-${index}`);
    fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(path.join(backup, 'marker.txt'), String(index));
    touch(backup, new Date(Date.now() - index * 1000));
    const archive = path.join(cleanupDownloads, `Star-Owner-v9.9.${index}-win-x64-core.zip`);
    fs.writeFileSync(archive, String(index));
    touch(archive, new Date(Date.now() - index * 1000));
  }
  for (let index = 1; index <= 2; index += 1) {
    const partialArchive = path.join(cleanupDownloads, `Star-Owner-v8.8.${index}-win-x64-core.zip.partial`);
    fs.writeFileSync(partialArchive, String(index));
    touch(partialArchive, index === 1 ? new Date() : oldTime);
  }
  fs.mkdirSync(path.join(cleanupRoot, 'staging-v9.9.9'), { recursive: true });
  fs.writeFileSync(path.join(cleanupRoot, 'user-note.txt'), 'not managed');
  const cleanup = cleanupManagedUpdateArtifacts(cleanupRoot);
  assert(cleanup.removed.some((item) => item.endsWith('staging-v9.9.9')), 'stale update staging directory was retained');
  assert.strictEqual(fs.readdirSync(cleanupRoot).filter((name) => name.startsWith('operation-backup-')).length, 2, 'operation backup retention did not keep exactly two recent backups');
  assert.strictEqual(fs.readdirSync(cleanupDownloads).filter((name) => CORE_ZIP(name)).length, 2, 'core archive retention did not keep two recent archives');
  assert.strictEqual(fs.readdirSync(cleanupDownloads).filter((name) => name.endsWith('.partial')).length, 1, 'partial archive retention did not keep one resumable download');
  assert(fs.existsSync(path.join(cleanupRoot, 'user-note.txt')), 'update cleanup removed an unrecognized user file');

  const helper = path.join(__dirname, 'apply-portable-operation.ps1');
  const stage = path.join(projectRoot, '.updates', 'stage');
  fs.mkdirSync(path.join(stage, 'node_modules', 'electron', 'dist'), { recursive: true });
  fs.mkdirSync(path.join(stage, 'runtime', 'git', 'cmd'), { recursive: true });
  fs.mkdirSync(path.join(stage, 'templates'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'templates'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'node_modules', 'electron', 'dist'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'runtime', 'git', 'cmd'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  fs.writeFileSync(path.join(stage, 'DESIGN_SHARED_KNOWLEDGE.md'), 'new-shared-design');
  fs.writeFileSync(path.join(stage, 'runtime', 'git', 'cmd', 'git.exe'), 'new-portable-git');
  fs.writeFileSync(path.join(stage, 'templates', 'video-summary-template.md'), 'new-template');
  fs.writeFileSync(path.join(stage, 'node_modules', 'electron', 'dist', 'electron.exe'), 'electron');
  fs.writeFileSync(path.join(projectRoot, 'templates', 'video-summary-template.md'), 'old-template');
  fs.writeFileSync(path.join(projectRoot, 'DESIGN_SHARED_KNOWLEDGE.md'), 'old-shared-design');
  fs.writeFileSync(path.join(projectRoot, 'runtime', 'git', 'cmd', 'git.exe'), 'old-portable-git');
  const preservedRuntime = [
    ['runtime/python/cpython-3.12.13-windows-x86_64-none/python.exe', 'old-python'],
    ['runtime/faster-whisper/marker.txt', 'old-faster-whisper'],
    ['runtime/vc-runtime/msvcp140.dll', 'old-vc-runtime'],
    ['runtime/models/large-v3-turbo/model.bin', 'old-model']
  ];
  const stagedRuntime = [
    ['runtime/python/cpython-3.12.13-windows-x86_64-none/python.exe', 'new-python'],
    ['runtime/faster-whisper/marker.txt', 'new-faster-whisper'],
    ['runtime/vc-runtime/msvcp140.dll', 'new-vc-runtime'],
    ['runtime/models/large-v3-turbo/model.bin', 'new-model']
  ];
  for (const [relative, content] of preservedRuntime) {
    fs.mkdirSync(path.dirname(path.join(projectRoot, relative)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, relative), content);
  }
  for (const [relative, content] of stagedRuntime) {
    fs.mkdirSync(path.dirname(path.join(stage, relative)), { recursive: true });
    fs.writeFileSync(path.join(stage, relative), content);
  }
  runPowerShell(helper, helperArgs('update', projectRoot, { stagedRoot: stage, targetVersion: '9.9.9', operationId: 'update-fixture' }));
  assert.strictEqual(fs.readFileSync(path.join(projectRoot, 'templates', 'video-summary-template.md'), 'utf8'), 'new-template', 'portable update did not replace templates');
  assert.strictEqual(fs.readFileSync(path.join(projectRoot, 'DESIGN_SHARED_KNOWLEDGE.md'), 'utf8'), 'new-shared-design', 'portable update did not replace shared design documentation');
  assert.strictEqual(fs.readFileSync(path.join(projectRoot, 'runtime', 'git', 'cmd', 'git.exe'), 'utf8'), 'new-portable-git', 'portable update did not install the project-local Git runtime');
  for (const [relative, content] of preservedRuntime) {
    assert.strictEqual(fs.readFileSync(path.join(projectRoot, relative), 'utf8'), content, `portable update unexpectedly replaced preserved runtime path: ${relative}`);
  }
  const successfulResult = readJson(path.join(projectRoot, '.updates', 'operation-result.json'));
  assert.strictEqual(successfulResult.status, 'succeeded', 'portable update helper did not write a success result');
  assert.strictEqual(successfulResult.phase, 'complete', 'portable update helper did not record its terminal phase');
  assert.strictEqual(successfulResult.progress, 1, 'portable update helper did not complete its progress contract');

  const cancelledRoot = path.join(root, 'cancelled update 中文 project');
  const cancelledStage = path.join(cancelledRoot, '.updates', 'stage');
  const cancelledFile = path.join(cancelledRoot, '.updates', 'updater-cancel-cancel-fixture.json');
  fs.mkdirSync(path.join(cancelledRoot, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(cancelledStage, 'node_modules', 'electron', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(cancelledRoot, 'assets', 'state.txt'), 'original');
  fs.writeFileSync(path.join(cancelledStage, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  fs.writeFileSync(path.join(cancelledStage, 'node_modules', 'electron', 'dist', 'electron.exe'), 'electron');
  fs.writeFileSync(cancelledFile, JSON.stringify({ operationId: 'cancel-fixture' }));
  const cancelled = runPowerShellResult(helper, helperArgs('update', cancelledRoot, { stagedRoot: cancelledStage, targetVersion: '9.9.9', operationId: 'cancel-fixture', cancelFile: cancelledFile }));
  assert.notStrictEqual(cancelled.status, 0, 'a pre-requested cancellation unexpectedly succeeded');
  assert.strictEqual(fs.readFileSync(path.join(cancelledRoot, 'assets', 'state.txt'), 'utf8'), 'original', 'cancellation changed the original application before rollback');
  assert.strictEqual(readJson(path.join(cancelledRoot, '.updates', 'operation-result.json')).status, 'cancelled', 'cancellation did not record a cancelled terminal result');

  const partialRoot = path.join(root, 'partial apply cancellation project');
  const partialStage = path.join(partialRoot, '.updates', 'stage');
  const partialCancel = path.join(partialRoot, '.updates', 'updater-cancel-partial-cancel.json');
  for (const relative of ['assets', 'src']) {
    fs.mkdirSync(path.join(partialRoot, relative), { recursive: true });
    fs.mkdirSync(path.join(partialStage, relative), { recursive: true });
    fs.writeFileSync(path.join(partialRoot, relative, 'state.txt'), `old-${relative}`);
    fs.writeFileSync(path.join(partialStage, relative, 'state.txt'), `new-${relative}`);
  }
  fs.mkdirSync(path.join(partialStage, 'node_modules', 'electron', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(partialStage, 'node_modules', 'electron', 'dist', 'electron.exe'), 'electron');
  fs.writeFileSync(path.join(partialStage, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  const partialArgs = helperArgs('update', partialRoot, {
    stagedRoot: partialStage,
    targetVersion: '9.9.9',
    operationId: 'partial-cancel',
    cancelFile: partialCancel,
    testStepDelayMilliseconds: 180
  });
  const partialProcess = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, ...partialArgs], { windowsHide: true, stdio: 'ignore' });
  await waitForSpawn(partialProcess);
  await waitForJson(path.join(partialRoot, '.updates', 'operation-journal.json'), (value) => value.status === 'applying' && value.item === 'src', 30000);
  assert.strictEqual(fs.readFileSync(path.join(partialRoot, 'assets', 'state.txt'), 'utf8'), 'new-assets', 'partial cancellation fixture did not reach a changed state');
  fs.writeFileSync(partialCancel, JSON.stringify({ operationId: 'partial-cancel' }));
  const partialExit = await new Promise((resolve) => partialProcess.once('exit', resolve));
  assert.notStrictEqual(partialExit, 0, 'mid-apply cancellation unexpectedly succeeded');
  assert.strictEqual(readJson(path.join(partialRoot, '.updates', 'operation-result.json')).status, 'cancelled', 'mid-apply cancellation did not record a cancelled result');
  assert.strictEqual(fs.readFileSync(path.join(partialRoot, 'assets', 'state.txt'), 'utf8'), 'old-assets', 'mid-apply cancellation did not restore an already replaced directory');
  assert.strictEqual(fs.readFileSync(path.join(partialRoot, 'src', 'state.txt'), 'utf8'), 'old-src', 'mid-apply cancellation did not preserve the next directory');

  const nativeRoot = path.join(root, 'native updater 中文 project');
  const nativeUpdates = path.join(nativeRoot, '.updates');
  const nativeStage = path.join(nativeUpdates, 'stage');
  const nativeOperationId = 'native-updater-fixture';
  fs.mkdirSync(path.join(nativeRoot, 'templates'), { recursive: true });
  fs.mkdirSync(path.join(nativeRoot, 'node_modules', 'electron', 'dist'), { recursive: true });
  fs.mkdirSync(path.join(nativeStage, 'templates'), { recursive: true });
  fs.mkdirSync(path.join(nativeStage, 'node_modules', 'electron', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(nativeRoot, 'templates', 'state.txt'), 'old');
  fs.writeFileSync(path.join(nativeRoot, 'node_modules', 'electron', 'dist', 'electron.exe'), 'old-electron');
  fs.writeFileSync(path.join(nativeStage, 'templates', 'state.txt'), 'new');
  fs.writeFileSync(path.join(nativeStage, 'node_modules', 'electron', 'dist', 'electron.exe'), 'new-electron');
  fs.writeFileSync(path.join(nativeStage, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  const nativeRequest = path.join(nativeUpdates, 'operation-request.json');
  const nativeReady = path.join(nativeUpdates, `updater-ready-${nativeOperationId}.json`);
  const nativeAcknowledge = path.join(nativeUpdates, `updater-ack-${nativeOperationId}.json`);
  const nativeCancel = path.join(nativeUpdates, `updater-cancel-${nativeOperationId}.json`);
  const nativeLog = path.join(nativeUpdates, `updater-${nativeOperationId}.log`);
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  fs.writeFileSync(nativeRequest, JSON.stringify({
    operationId: nativeOperationId,
    mode: 'update',
    projectRoot: nativeRoot,
    stagedRoot: nativeStage,
    sourceWorkspace: '',
    targetVersion: '9.9.9',
    processId: 2147483647,
    updaterHelperPath: helper,
    updaterRecoveryPath: path.join(__dirname, 'recover-portable-operation.ps1'),
    updaterPowerShellPath: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    updaterCommandPath: path.join(systemRoot, 'System32', 'cmd.exe'),
    updaterReadyFile: nativeReady,
    updaterAcknowledgeFile: nativeAcknowledge,
    updaterCancelFile: nativeCancel,
    updaterLogFile: nativeLog,
    updaterIconPath: path.join(__dirname, '..', 'assets', 'star-note.png'),
    disableRelaunch: true,
    headless: true
  }, null, 2));
  const nativeProcess = spawn(nativeUpdater, ['--request', nativeRequest], { windowsHide: true, stdio: 'ignore' });
  await waitForSpawn(nativeProcess);
  await waitForPath(nativeReady, 5000);
  fs.writeFileSync(nativeAcknowledge, JSON.stringify({ operationId: nativeOperationId, status: 'acknowledged' }));
  await waitForPath(path.join(nativeUpdates, 'operation-result.json'), 30000);
  const nativeResult = readJson(path.join(nativeUpdates, 'operation-result.json'));
  assert.strictEqual(nativeResult.status, 'succeeded', `native updater operation failed: ${nativeResult.message || ''}`);
  assert.strictEqual(fs.readFileSync(path.join(nativeRoot, 'templates', 'state.txt'), 'utf8'), 'new', 'native updater did not apply the staged package');
  assert(fs.readFileSync(nativeLog, 'utf8').includes('helper process started'), 'native updater did not persist its diagnostic log');
  if (nativeProcess.exitCode === null && nativeProcess.signalCode === null) await new Promise((resolve) => nativeProcess.once('exit', resolve));

  const crashRoot = path.join(root, 'native crash recovery project');
  const crashUpdates = path.join(crashRoot, '.updates');
  const crashBackup = path.join(crashUpdates, 'operation-backup-native-crash-fixture');
  const crashHelper = path.join(root, 'crashing-helper.ps1');
  fs.mkdirSync(path.join(crashRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(crashBackup, 'src'), { recursive: true });
  fs.writeFileSync(path.join(crashRoot, 'src', 'state.txt'), 'partially-replaced');
  fs.writeFileSync(path.join(crashBackup, 'src', 'state.txt'), 'known-good');
  fs.writeFileSync(crashHelper, `param([string]$Mode,[string]$ProjectRoot,[int]$ProcessId,[string]$StagedRoot,[string]$SourceWorkspace,[string]$TargetVersion,[string]$OperationId,[string]$CancelFile)\n$updates=Join-Path $ProjectRoot '.updates'\n[ordered]@{operationId=$OperationId;mode=$Mode;status='applying';projectRoot=$ProjectRoot;backup=(Join-Path $updates ('operation-backup-'+$OperationId));backedUpPaths=@('src');absentPaths=@();phase='apply';item='src';progress=0.7}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $updates 'operation-journal.json') -Encoding UTF8\nexit 9\n`);
  const crashOperationId = 'native-crash-fixture';
  const crashRequest = path.join(crashUpdates, 'operation-request.json');
  const crashReady = path.join(crashUpdates, `updater-ready-${crashOperationId}.json`);
  const crashAcknowledge = path.join(crashUpdates, `updater-ack-${crashOperationId}.json`);
  const crashLog = path.join(crashUpdates, `updater-${crashOperationId}.log`);
  fs.writeFileSync(crashRequest, JSON.stringify({
    operationId: crashOperationId,
    mode: 'update',
    projectRoot: crashRoot,
    stagedRoot: path.join(crashUpdates, 'stage'),
    sourceWorkspace: '',
    targetVersion: '9.9.9',
    processId: 2147483647,
    updaterHelperPath: crashHelper,
    updaterRecoveryPath: path.join(__dirname, 'recover-portable-operation.ps1'),
    updaterPowerShellPath: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    updaterCommandPath: path.join(systemRoot, 'System32', 'cmd.exe'),
    updaterReadyFile: crashReady,
    updaterAcknowledgeFile: crashAcknowledge,
    updaterCancelFile: path.join(crashUpdates, `updater-cancel-${crashOperationId}.json`),
    updaterLogFile: crashLog,
    updaterIconPath: path.join(__dirname, '..', 'assets', 'star-note.png'),
    disableRelaunch: true,
    headless: true
  }, null, 2));
  const crashUpdater = spawn(nativeUpdater, ['--request', crashRequest], { windowsHide: true, stdio: 'ignore' });
  await waitForSpawn(crashUpdater);
  await waitForPath(crashReady, 5000);
  fs.writeFileSync(crashAcknowledge, JSON.stringify({ operationId: crashOperationId, status: 'acknowledged' }));
  await waitForJson(path.join(crashUpdates, 'operation-result.json'), (value) => value.status === 'rolled-back', 30000);
  assert.strictEqual(fs.readFileSync(path.join(crashRoot, 'src', 'state.txt'), 'utf8'), 'known-good', 'native updater did not recover after an abrupt helper exit');
  assert(fs.readFileSync(crashLog, 'utf8').includes('Starting recovery helper'), 'native updater did not log automatic recovery');
  if (crashUpdater.exitCode === null && crashUpdater.signalCode === null) await new Promise((resolve) => crashUpdater.once('exit', resolve));

  const handoffRoot = path.join(root, 'full handoff 中文 project');
  const handoffStage = path.join(handoffRoot, '.updates', 'stage');
  const handoffMarker = path.join(root, 'handoff-scheduled.json');
  for (const relative of [
    'tools/updater/StarOwnerUpdater.exe',
    'assets/star-note.png',
    'scripts/apply-portable-operation.ps1',
    'scripts/recover-portable-operation.ps1',
    'node_modules/electron/dist/electron.exe',
    'package.json'
  ]) fs.mkdirSync(path.dirname(path.join(handoffRoot, relative)), { recursive: true });
  fs.copyFileSync(nativeUpdater, path.join(handoffRoot, 'tools', 'updater', 'StarOwnerUpdater.exe'));
  fs.copyFileSync(path.join(__dirname, '..', 'assets', 'star-note.png'), path.join(handoffRoot, 'assets', 'star-note.png'));
  fs.copyFileSync(helper, path.join(handoffRoot, 'scripts', 'apply-portable-operation.ps1'));
  fs.copyFileSync(path.join(__dirname, 'recover-portable-operation.ps1'), path.join(handoffRoot, 'scripts', 'recover-portable-operation.ps1'));
  fs.writeFileSync(path.join(handoffRoot, 'node_modules', 'electron', 'dist', 'electron.exe'), 'old-electron');
  fs.writeFileSync(path.join(handoffRoot, 'package.json'), JSON.stringify({ version: '1.7.0' }));
  fs.mkdirSync(path.join(handoffStage, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(handoffStage, 'node_modules', 'electron', 'dist'), { recursive: true });
  fs.copyFileSync(helper, path.join(handoffStage, 'scripts', 'apply-portable-operation.ps1'));
  fs.copyFileSync(path.join(__dirname, 'recover-portable-operation.ps1'), path.join(handoffStage, 'scripts', 'recover-portable-operation.ps1'));
  fs.writeFileSync(path.join(handoffStage, 'node_modules', 'electron', 'dist', 'electron.exe'), 'new-electron');
  fs.writeFileSync(path.join(handoffStage, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  const handoffCode = `const fs=require('fs');const {UpdateManager}=require(${JSON.stringify(path.join(__dirname, '..', 'src', 'core', 'update-manager.js'))});(async()=>{const manager=new UpdateManager({projectRoot:${JSON.stringify(handoffRoot)},version:'1.7.0',platform:'win32',fetchImpl:async()=>{throw new Error('not used')},updaterHeadless:true,updaterDisableRelaunch:true});const value=await manager.launchOperation({mode:'update',stagedRoot:${JSON.stringify(handoffStage)},targetVersion:'9.9.9'});fs.writeFileSync(${JSON.stringify(handoffMarker)},JSON.stringify(value));})().catch(error=>{console.error(error);process.exit(1)});`;
  const handoffLauncher = spawnSync(process.execPath, ['-e', handoffCode], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.strictEqual(handoffLauncher.status, 0, `update-manager handoff process failed: ${handoffLauncher.stderr || handoffLauncher.stdout}`);
  const handoff = readJson(handoffMarker);
  assert.strictEqual(handoff.scheduled, true, 'update manager did not acknowledge the native updater handshake');
  assert(Number(handoff.updaterPid) > 0, 'update manager did not return the updater process ID');
  await waitForJson(path.join(handoffRoot, '.updates', 'operation-result.json'), (value) => value.status === 'succeeded', 30000);
  assert.strictEqual(fs.readFileSync(path.join(handoffRoot, 'node_modules', 'electron', 'dist', 'electron.exe'), 'utf8'), 'new-electron', 'full update-manager handoff did not apply the staged package');

  const failedRoot = path.join(root, 'backup-failure-project');
  const failedStage = path.join(failedRoot, '.updates', 'stage');
  const failedOperationId = 'backup-failure-fixture';
  fs.mkdirSync(path.join(failedRoot, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(failedStage, 'node_modules', 'electron', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(failedRoot, 'assets', 'original.txt'), 'must survive backup failure');
  fs.writeFileSync(path.join(failedStage, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  fs.writeFileSync(path.join(failedStage, 'node_modules', 'electron', 'dist', 'electron.exe'), 'electron');
  const blockedBackup = path.join(failedRoot, '.updates', `operation-backup-${failedOperationId}`);
  fs.writeFileSync(blockedBackup, 'block backup directory creation');
  const failed = runPowerShellResult(helper, helperArgs('update', failedRoot, { stagedRoot: failedStage, targetVersion: '9.9.9', operationId: failedOperationId }));
  assert.notStrictEqual(failed.status, 0, 'backup failure fixture unexpectedly succeeded');
  assert.strictEqual(fs.readFileSync(path.join(failedRoot, 'assets', 'original.txt'), 'utf8'), 'must survive backup failure', 'rollback deleted an original path that was never backed up');
  assert.strictEqual(readJson(path.join(failedRoot, '.updates', 'operation-result.json')).status, 'rolled-back', 'safe no-op rollback did not record its result');

  const recoveryScript = path.join(__dirname, 'recover-portable-operation.ps1');
  const recoveryRoot = path.join(root, 'startup-recovery-project');
  const recoveryUpdates = path.join(recoveryRoot, '.updates');
  const recoveryBackup = path.join(recoveryUpdates, 'operation-backup-recovery-fixture');
  fs.mkdirSync(path.join(recoveryRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(recoveryBackup, 'src'), { recursive: true });
  fs.writeFileSync(path.join(recoveryRoot, 'src', 'state.txt'), 'partially-updated');
  fs.writeFileSync(path.join(recoveryBackup, 'src', 'state.txt'), 'known-good');
  fs.writeFileSync(path.join(recoveryUpdates, 'operation-journal.json'), JSON.stringify({
    operationId: 'recovery-fixture',
    mode: 'update',
    status: 'applying',
    projectRoot: recoveryRoot,
    backup: recoveryBackup,
    backedUpPaths: ['src'],
    absentPaths: []
  }));
  runPowerShell(recoveryScript, ['-ProjectRoot', recoveryRoot]);
  assert.strictEqual(fs.readFileSync(path.join(recoveryRoot, 'src', 'state.txt'), 'utf8'), 'known-good', 'pre-launch recovery did not restore the backed-up application path');
  assert(!fs.existsSync(path.join(recoveryUpdates, 'operation-journal.json')), 'pre-launch recovery left the completed journal behind');
  assert.strictEqual(readJson(path.join(recoveryUpdates, 'operation-result.json')).status, 'rolled-back', 'pre-launch recovery did not record a rolled-back result');
  const launcher = fs.readFileSync(path.join(__dirname, '..', 'packaging', 'Start-StarOwner.cmd'), 'utf8');
  assert(launcher.includes('recover-portable-operation.ps1') && launcher.indexOf('recover-portable-operation.ps1') < launcher.indexOf('electron.exe'), 'portable launcher does not recover interrupted operations before Electron starts');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert(mainSource.includes('await updateManager.launchPreparedUpdate()') && mainSource.includes('await updateManager.launchMigration(sourceRoot)'), 'main process can quit before the updater handoff promise resolves');

  const source = path.join(root, 'old project');
  fs.mkdirSync(path.join(source, 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ version: '1.0.3' }));
  fs.writeFileSync(path.join(source, 'workspace', 'orchestrator.sqlite'), Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(80)]));
  if (process.platform === 'win32') {
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', source], { windowsHide: true, stdio: 'ignore' });
    await waitForSpawn(sleeper);
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const running = findRunningProjectProcesses(source, { platform: 'win32' });
      assert(running.some((item) => item.pid === sleeper.pid), 'running source application process was not detected');
      assert.throws(() => manager.inspectMigrationSource(source), /仍在运行/, 'migration inspection accepted a running source application');
      const blockedRoot = path.join(root, 'blocked-migration-project');
      fs.mkdirSync(path.join(blockedRoot, 'workspace'), { recursive: true });
      fs.writeFileSync(path.join(blockedRoot, 'workspace', 'target-marker.txt'), 'keep target workspace');
      const blocked = runPowerShellResult(helper, helperArgs('migrate', blockedRoot, { sourceWorkspace: path.join(source, 'workspace'), targetVersion: '9.9.9', operationId: 'running-source-fixture' }));
      assert.notStrictEqual(blocked.status, 0, 'migration helper copied a workspace while its source application was running');
      assert.strictEqual(fs.readFileSync(path.join(blockedRoot, 'workspace', 'target-marker.txt'), 'utf8'), 'keep target workspace', 'blocked migration changed the target workspace');
      assert.strictEqual(readJson(path.join(blockedRoot, '.updates', 'operation-result.json')).status, 'rolled-back', 'blocked migration did not record a safe rollback result');
    } finally {
      sleeper.kill();
      await new Promise((resolve) => sleeper.once('exit', resolve));
    }
  }
  runPowerShell(helper, helperArgs('migrate', projectRoot, { sourceWorkspace: path.join(source, 'workspace'), targetVersion: '9.9.9', operationId: 'migration-fixture' }));
  assert(fs.existsSync(path.join(projectRoot, 'workspace', 'orchestrator.sqlite')), 'portable migration helper did not copy the old workspace');
  assert.strictEqual(readJson(path.join(projectRoot, '.updates', 'operation-result.json')).status, 'succeeded', 'portable migration helper did not write a success result');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('update and migration integration test passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

function CORE_ZIP(name) {
  return /^Star-Owner-v\d+\.\d+\.\d+-win-x64-core\.zip$/i.test(String(name || ''));
}
