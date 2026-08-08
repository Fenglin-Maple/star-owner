const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { UpdateManager, cleanupManagedUpdateArtifacts, commandLineContainsProjectRoot, findRunningProjectProcesses, resolveCoreRelease, validateArchiveEntries, validateStagedPackage } = require('../src/core/update-manager');

// macOS 应用内更新为暂缓项（当前仅 Windows 便携版语义）：非 win32 平台明确跳过并说明
if (process.platform !== 'win32') {
  console.log('跳过：应用内更新为 Windows 便携版语义（macOS 更新功能为暂缓项，见 MAC_ADAPTATION.md）');
  process.exit(0);
}

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
  return [
    '-Mode', mode,
    '-ProjectRoot', root,
    '-ProcessId', '2147483647',
    '-StagedRoot', extra.stagedRoot || '',
    '-SourceWorkspace', extra.sourceWorkspace || '',
    '-TargetVersion', extra.targetVersion || '9.9.9',
    '-OperationId', extra.operationId || `test-operation-${Date.now()}`,
    '-Relaunch'
  ];
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

function createValidStagedPackage(packageRoot, version = '9.9.9') {
  const files = [
    'src/main.js',
    'Start-StarOwner.cmd',
    'scripts/apply-portable-operation.ps1',
    'scripts/recover-portable-operation.ps1',
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
  assert.strictEqual(readJson(path.join(projectRoot, '.updates', 'operation-result.json')).status, 'succeeded', 'portable update helper did not write a success result');

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
