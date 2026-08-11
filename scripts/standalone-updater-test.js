const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const JSZip = require('jszip');

const repoRoot = path.resolve(__dirname, '..');
const updater = path.join(repoRoot, 'tools', 'updater', 'StarOwnerUpdater.exe');
const packageVersion = require(path.join(repoRoot, 'package.json')).version;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function waitForExit(child, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error('standalone updater test process timed out'));
    }, timeout);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}

function runUpdater(args, timeout = 60000) {
  return waitForExit(spawn(updater, args, { cwd: repoRoot, windowsHide: true, stdio: 'ignore' }), timeout);
}

async function waitFor(predicate, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for updater state');
}

function writeFile(root, relative, value = 'fixture') {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
}

function sqliteFixture() {
  return Buffer.concat([Buffer.from('SQLite format 3\0', 'ascii'), Buffer.alloc(96, 7)]);
}

function createOldProject(root, version = '1.5.1-beta.1') {
  fs.mkdirSync(root, { recursive: true });
  writeFile(root, 'package.json', JSON.stringify({ name: 'star-owner', version, dependencyReleaseVersion: '1.0.0' }));
  writeFile(root, 'Start-StarOwner.cmd', '@echo off\r\n');
  writeFile(root, 'node_modules/electron/dist/electron.exe', 'old-electron');
  writeFile(root, 'assets/state.txt', 'old-core');
  writeFile(root, 'templates/state.txt', 'old-template');
  writeFile(root, 'workspace/orchestrator.sqlite', sqliteFixture());
  writeFile(root, 'workspace/users/user/document.md', '# preserved');
  writeFile(root, 'runtime/models/small/model.bin', 'preserved-model');
  writeFile(root, 'runtime/python/private.marker', 'preserved-python');
  writeFile(root, 'runtime/faster-whisper/private.marker', 'preserved-asr');
  writeFile(root, 'runtime/vc-runtime/private.marker', 'preserved-vc');
  writeFile(root, 'runtime/git/cmd/git.exe', 'old-git');
  writeFile(root, '.cache/shared-git/credential.txt', 'private-token');
}

async function createCoreArchive(file, version = packageVersion, options = {}) {
  const zip = new JSZip();
  const prefix = `Star-Owner-v${version}-win-x64-core`;
  const add = (relative, value = 'fixture', options) => zip.file(`${prefix}/${relative}`, value, options);
  const required = [
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
    'runtime/python/cpython-test/python.exe',
    'runtime/faster-whisper/Scripts/python.exe',
    'runtime/faster-whisper/Lib/site-packages/faster_whisper/__init__.py',
    'runtime/faster-whisper/Lib/site-packages/yt_dlp/__init__.py',
    'runtime/faster-whisper/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-fixture.exe',
    'runtime/vc-runtime/concrt140.dll',
    'runtime/vc-runtime/msvcp140.dll',
    'runtime/vc-runtime/msvcp140_codecvt_ids.dll',
    'runtime/vc-runtime/vcruntime140.dll',
    'runtime/vc-runtime/vcruntime140_1.dll'
  ];
  if (!options.legacyUpdaterless) required.push(
    'tools/updater/StarOwnerUpdater.cs',
    'tools/updater/StandaloneUpdater.cs',
    'tools/updater/UpdaterBuildInfo.cs',
    'tools/updater/StarOwnerUpdater.exe',
    'tools/updater/build-updater.ps1'
  );
  for (const relative of required) add(relative);
  add('scripts/apply-portable-operation.ps1', fs.readFileSync(path.join(repoRoot, 'scripts', 'apply-portable-operation.ps1')));
  add('scripts/recover-portable-operation.ps1', fs.readFileSync(path.join(repoRoot, 'scripts', 'recover-portable-operation.ps1')));
  if (!options.legacyUpdaterless) {
    add('tools/updater/StarOwnerUpdater.exe', fs.readFileSync(updater));
    add('tools/updater/UpdaterBuildInfo.cs', fs.readFileSync(path.join(repoRoot, 'tools', 'updater', 'UpdaterBuildInfo.cs')));
  }
  add('assets/state.txt', 'new-core');
  add('assets/star-note.png', fs.readFileSync(path.join(repoRoot, 'assets', 'star-note.png')));
  add('templates/state.txt', 'new-template');
  add('package.json', JSON.stringify({ name: 'star-owner', version, dependencyReleaseVersion: '1.0.0' }));
  add('package-lock.json', JSON.stringify({ name: 'star-owner', version, packages: { '': { name: 'star-owner', version } } }));
  add('portable-manifest.json', JSON.stringify({ version, dependencyReleaseVersion: '1.0.0', platform: 'win-x64', launcher: 'Start-StarOwner.cmd', updaterVersion: version, updaterProtocolVersion: 1 }));
  add('payload.bin', crypto.randomBytes(3 * 1024 * 1024), { compression: 'STORE' });
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 1 }, platform: 'DOS' });
  fs.writeFileSync(file, bytes);
  return bytes;
}

function createReleaseServer(coreBytes, version = packageVersion, updaterBytes = fs.readFileSync(updater)) {
  const checksum = crypto.createHash('sha256').update(coreBytes).digest('hex');
  const updaterChecksum = crypto.createHash('sha256').update(updaterBytes).digest('hex');
  const state = { rangeRequests: 0, slow: false, downloadStarted: Promise.resolve(), signalDownload: null };
  state.armDownload = () => {
    state.downloadStarted = new Promise((resolve) => { state.signalDownload = resolve; });
    return state.downloadStarted;
  };
  const server = http.createServer((request, response) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (request.url === '/latest') {
      const body = Buffer.from(JSON.stringify({
        id: 999,
        tag_name: `v${version}`,
        name: `Star Owner v${version}`,
        draft: false,
        prerelease: false,
        html_url: `${base}/release`,
        published_at: '2026-08-11T00:00:00Z',
        assets: [
          { name: `Star-Owner-v${version}-win-x64-core.zip`, browser_download_url: `${base}/core.zip`, size: coreBytes.length },
          { name: `Star-Owner-v${version}-win-x64-core.zip.sha256`, browser_download_url: `${base}/core.zip.sha256`, size: 100 },
          { name: `Star-Owner-Updater-v${version}-win-x64.exe`, browser_download_url: `${base}/updater.exe`, size: updaterBytes.length },
          { name: `Star-Owner-Updater-v${version}-win-x64.exe.sha256`, browser_download_url: `${base}/updater.exe.sha256`, size: 100 }
        ]
      }));
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length });
      response.end(body);
      return;
    }
    if (request.url === '/core.zip.sha256') {
      const body = Buffer.from(`${checksum}  Star-Owner-v${version}-win-x64-core.zip\n`, 'ascii');
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': body.length });
      response.end(body);
      return;
    }
    if (request.url === '/updater.exe.sha256') {
      const body = Buffer.from(`${updaterChecksum}  Star-Owner-Updater-v${version}-win-x64.exe\n`, 'ascii');
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': body.length });
      response.end(body);
      return;
    }
    if (request.url === '/updater.exe') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': updaterBytes.length });
      response.end(updaterBytes);
      return;
    }
    if (request.url === '/core.zip') {
      if (state.signalDownload) { state.signalDownload(); state.signalDownload = null; }
      const match = String(request.headers.range || '').match(/^bytes=(\d+)-$/);
      const start = match ? Number(match[1]) : 0;
      if (match) state.rangeRequests += 1;
      if (start >= coreBytes.length) {
        response.writeHead(416, { 'Content-Range': `bytes */${coreBytes.length}` });
        response.end();
        return;
      }
      const body = coreBytes.subarray(start);
      response.writeHead(match ? 206 : 200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': body.length,
        ...(match ? { 'Content-Range': `bytes ${start}-${coreBytes.length - 1}/${coreBytes.length}` } : {})
      });
      if (!state.slow) {
        response.end(body);
        return;
      }
      let offset = 0;
      const write = () => {
        if (response.destroyed || offset >= body.length) { if (!response.destroyed) response.end(); return; }
        const end = Math.min(body.length, offset + 32768);
        response.write(body.subarray(offset, end));
        offset = end;
        setTimeout(write, 12);
      };
      write();
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return { server, state, checksum, updaterChecksum };
}

(async () => {
  assert(fs.existsSync(updater), 'native updater executable is missing');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'star-owner-standalone-test-'));
  const archiveFile = path.join(root, 'core.zip');
  const coreBytes = await createCoreArchive(archiveFile);
  const remote = createReleaseServer(coreBytes);
  await new Promise((resolve) => remote.server.listen(0, '127.0.0.1', resolve));
  const releaseApi = `http://127.0.0.1:${remote.server.address().port}/latest`;
  try {
    const assetRoot = path.join(root, 'release-assets');
    const powershell = path.join(process.env.SystemRoot || process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const assetBuilder = path.join(repoRoot, 'tools', 'updater', 'build-standalone-asset.ps1');
    assert.strictEqual(await waitForExit(spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', assetBuilder, '-OutputDirectory', assetRoot, '-SkipBuild'], { cwd: repoRoot, windowsHide: true, stdio: 'ignore' }), 30000), 0, 'standalone Release asset build failed');
    const updaterAsset = path.join(assetRoot, `Star-Owner-Updater-v${packageVersion}-win-x64.exe`);
    const updaterChecksum = `${updaterAsset}.sha256`;
    assert(fs.existsSync(updaterAsset) && fs.existsSync(updaterChecksum), 'standalone Release asset or checksum is missing');
    assert(fs.readFileSync(updaterChecksum, 'ascii').toLowerCase().includes(crypto.createHash('sha256').update(fs.readFileSync(updaterAsset)).digest('hex')), 'standalone Release asset checksum is incorrect');

    const preview = path.join(root, 'standalone-preview.png');
    assert.strictEqual(await runUpdater(['--standalone-preview', preview]), 0, 'standalone updater preview failed');
    assert(fs.statSync(preview).size > 10000, 'standalone updater preview is blank or incomplete');

    const oldUpdater = path.join(root, 'StarOwnerUpdater-v1.7.2-test.exe');
    assert.strictEqual(await waitForExit(spawn('pwsh', ['-NoProfile', '-File', path.join(repoRoot, 'tools', 'updater', 'build-updater.ps1'), '-OutputPath', oldUpdater, '-TestVersionOverride', '1.7.2'], { cwd: repoRoot, windowsHide: true, stdio: 'ignore' }), 30000), 0, 'old updater compatibility fixture could not be built');
    const oldVersionOutput = path.join(root, 'old-updater-version.json');
    assert.strictEqual(await waitForExit(spawn(oldUpdater, ['--version-file', oldVersionOutput], { cwd: root, windowsHide: true, stdio: 'ignore' }), 10000), 0, 'old updater fixture did not report its version');
    assert.strictEqual(readJson(oldVersionOutput).version, '1.7.2', 'old updater fixture has the wrong embedded version');

    const versionHandoffRoot = path.join(root, 'version handoff project');
    createOldProject(versionHandoffRoot, '1.6.2');
    const versionHandoffOutput = path.join(root, 'version-handoff.json');
    assert.strictEqual(await waitForExit(spawn(oldUpdater, ['--standalone-test-handoff', versionHandoffRoot, releaseApi, versionHandoffOutput], { cwd: root, windowsHide: true, stdio: 'ignore' }), 120000), 0, 'old updater did not hand off to the target-version updater');
    const versionHandoff = readJson(versionHandoffOutput);
    assert.strictEqual(versionHandoff.sourceUpdaterVersion, '1.7.2', 'handoff was not initiated by the simulated old updater');
    assert.strictEqual(versionHandoff.version, packageVersion, 'handoff did not select the latest target version');
    const versionHandoffResult = await waitFor(() => {
      const file = path.join(versionHandoffRoot, '.updates', 'operation-result.json');
      try { const value = readJson(file); return value.status === 'succeeded' ? value : null; } catch { return null; }
    }, 120000);
    assert.strictEqual(versionHandoffResult.targetVersion, packageVersion, 'matching updater installed a different application version');
    assert.strictEqual(readJson(path.join(versionHandoffRoot, 'package.json')).version, packageVersion, 'matching updater handoff did not update the project');

    const inspectRoot = path.join(root, '旧版 pre release 项目');
    createOldProject(inspectRoot);
    const inspectOutput = path.join(root, 'inspect.json');
    assert.strictEqual(await runUpdater(['--standalone-test-inspect', inspectRoot, inspectOutput]), 0, 'valid pre-release directory was rejected');
    const inspection = readJson(inspectOutput);
    assert.strictEqual(inspection.version, '1.5.1-beta.1', 'pre-release version was not detected');
    assert(inspection.hasDatabase && inspection.hasModels && inspection.hasSharedGitCredentials, 'user-data inheritance was not detected');

    const corruptRoot = path.join(root, 'corrupt database');
    createOldProject(corruptRoot, '1.6.2');
    fs.writeFileSync(path.join(corruptRoot, 'workspace', 'orchestrator.sqlite'), 'broken');
    const corruptOutput = path.join(root, 'corrupt.json');
    assert.notStrictEqual(await runUpdater(['--standalone-test-inspect', corruptRoot, corruptOutput]), 0, 'corrupt SQLite database was accepted');
    assert.match(readJson(corruptOutput).message, /SQLite|损坏/, 'corrupt database error is unclear');

    const runningRoot = path.join(root, 'running project');
    createOldProject(runningRoot, '1.6.2');
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', runningRoot], { windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const runningOutput = path.join(root, 'running.json');
      assert.notStrictEqual(await runUpdater(['--standalone-test-inspect', runningRoot, runningOutput]), 0, 'running old application directory was accepted');
      assert.match(readJson(runningOutput).message, /仍在运行|PID/, 'running-process error is unclear');
    } finally {
      sleeper.kill();
      await waitForExit(sleeper, 5000);
    }

    const releaseJson = path.join(root, 'release.json');
    fs.writeFileSync(releaseJson, JSON.stringify({
      tag_name: 'v9.9.9', draft: false, prerelease: false,
      assets: [
        { name: 'Star-Owner-v9.9.9-win-x64-core.zip', browser_download_url: 'https://example.invalid/core.zip', size: 1, digest: `sha256:${'a'.repeat(64)}` },
        { name: 'Star-Owner-Updater-v9.9.9-win-x64.exe', browser_download_url: 'https://example.invalid/updater.exe', size: 1, digest: `sha256:${'b'.repeat(64)}` }
      ]
    }));
    const releaseOutput = path.join(root, 'release-output.json');
    assert.strictEqual(await runUpdater(['--standalone-test-release', releaseJson, releaseOutput]), 0, 'stable release was rejected');
    assert.strictEqual(readJson(releaseOutput).checksum, 'a'.repeat(64), 'GitHub asset digest was not accepted');
    const prereleaseJson = path.join(root, 'prerelease.json');
    fs.writeFileSync(prereleaseJson, JSON.stringify({ tag_name: 'v10.0.0', draft: false, prerelease: true, assets: [] }));
    const prereleaseOutput = path.join(root, 'prerelease-output.json');
    assert.notStrictEqual(await runUpdater(['--standalone-test-release', prereleaseJson, prereleaseOutput]), 0, 'pre-release was accepted as latest stable');

    const unsafeEntries = path.join(root, 'unsafe-entries.txt');
    fs.writeFileSync(unsafeEntries, 'bundle/package.json\nbundle/../escape.txt\n');
    const unsafeOutput = path.join(root, 'unsafe-output.json');
    assert.notStrictEqual(await runUpdater(['--standalone-test-entries', unsafeEntries, path.join(root, 'unsafe-stage'), unsafeOutput]), 0, 'path traversal archive entry was accepted');
    const collisionEntries = path.join(root, 'collision-entries.txt');
    fs.writeFileSync(collisionEntries, 'bundle/package.json\nbundle/Readme.md\nbundle/README.md\n');
    const collisionOutput = path.join(root, 'collision-output.json');
    assert.notStrictEqual(await runUpdater(['--standalone-test-entries', collisionEntries, path.join(root, 'collision-stage'), collisionOutput]), 0, 'case-insensitive path collision was accepted');

    const longPrefixEntries = path.join(root, 'long-prefix-entries.txt');
    const longPrefix = `Star-Owner-v${packageVersion}-win-x64-core`;
    fs.writeFileSync(longPrefixEntries, `${longPrefix}/package.json\n${longPrefix}/runtime/python/${'nested/'.repeat(9)}probe.txt\n`);
    const longPrefixStage = path.join(root, `long-stage-${'x'.repeat(72)}`);
    const longPrefixOutput = path.join(root, 'long-prefix-output.json');
    assert.strictEqual(await runUpdater(['--standalone-test-entries', longPrefixEntries, longPrefixStage, longPrefixOutput]), 0, 'validated ZIP prefix was counted against the real extraction path budget');
    assert.strictEqual(readJson(longPrefixOutput).prefix, longPrefix, 'long-path archive prefix was not detected before output-path validation');

    const recoveryRoot = path.join(root, 'interrupted old update');
    createOldProject(recoveryRoot, '1.6.2');
    const recoveryUpdates = path.join(recoveryRoot, '.updates');
    const recoveryBackup = path.join(recoveryUpdates, 'operation-backup-old-interruption');
    writeFile(recoveryRoot, 'assets/state.txt', 'partially-replaced');
    writeFile(recoveryBackup, 'assets/state.txt', 'known-good-before-interruption');
    writeFile(recoveryUpdates, 'operation-journal.json', JSON.stringify({
      operationId: 'old-interruption', mode: 'update', status: 'applying', projectRoot: recoveryRoot,
      backup: recoveryBackup, backedUpPaths: ['assets'], absentPaths: [], phase: 'apply', progress: 0.7
    }));
    const recoveryOutput = path.join(root, 'recovery-output.json');
    assert.strictEqual(await runUpdater(['--standalone-test-prepare', recoveryRoot, releaseApi, recoveryOutput], 120000), 0, 'standalone updater did not recover an interrupted transaction');
    assert.strictEqual(fs.readFileSync(path.join(recoveryRoot, 'assets', 'state.txt'), 'utf8'), 'known-good-before-interruption', 'interrupted transaction was not restored before preparation');
    assert(!fs.existsSync(path.join(recoveryUpdates, 'operation-journal.json')), 'recovered transaction journal was left active');

    const prepareRoot = path.join(root, 'prepare 中文 path');
    createOldProject(prepareRoot, '1.0.3');
    const partial = path.join(prepareRoot, '.updates', 'downloads', `Star-Owner-v${packageVersion}-win-x64-core.zip.partial`);
    fs.mkdirSync(path.dirname(partial), { recursive: true });
    fs.writeFileSync(partial, coreBytes.subarray(0, 65536));
    const prepareOutput = path.join(root, 'prepare-output.json');
    const prepareCode = await runUpdater(['--standalone-test-prepare', prepareRoot, releaseApi, prepareOutput], 120000);
    assert.strictEqual(prepareCode, 0, `standalone preparation failed: ${fs.existsSync(prepareOutput) ? readJson(prepareOutput).message || '' : 'no result'}`);
    assert(remote.state.rangeRequests > 0, 'standalone updater did not resume a partial download');
    assert.strictEqual(fs.readFileSync(path.join(prepareRoot, 'assets', 'state.txt'), 'utf8'), 'old-core', 'preparation modified the old application');
    assert(fs.existsSync(path.join(readJson(prepareOutput).packageRoot, 'portable-manifest.json')), 'prepared package root is invalid');

    const legacyArchive = path.join(root, 'legacy-1.7.0-core.zip');
    const legacyBytes = await createCoreArchive(legacyArchive, '1.7.0', { legacyUpdaterless: true });
    const legacyRemote = createReleaseServer(legacyBytes, '1.7.0');
    await new Promise((resolve) => legacyRemote.server.listen(0, '127.0.0.1', resolve));
    try {
      const legacyTarget = path.join(root, 'legacy latest target');
      createOldProject(legacyTarget, '1.6.2');
      const legacyOutput = path.join(root, 'legacy-output.json');
      const legacyApi = `http://127.0.0.1:${legacyRemote.server.address().port}/latest`;
      const legacyCode = await runUpdater(['--standalone-test-prepare', legacyTarget, legacyApi, legacyOutput], 120000);
      assert.notStrictEqual(legacyCode, 0, 'a target without a matching-version updater was accepted');
      assert.match(readJson(legacyOutput).message, /同版本更新器|必须先切换/, 'legacy updater refusal did not explain the version lock');
    } finally {
      await new Promise((resolve) => legacyRemote.server.close(resolve));
    }

    const installRoot = path.join(root, 'install transaction 中文 path');
    createOldProject(installRoot, '1.6.2');
    const preserved = {
      database: fs.readFileSync(path.join(installRoot, 'workspace', 'orchestrator.sqlite')),
      model: fs.readFileSync(path.join(installRoot, 'runtime', 'models', 'small', 'model.bin')),
      python: fs.readFileSync(path.join(installRoot, 'runtime', 'python', 'private.marker')),
      asr: fs.readFileSync(path.join(installRoot, 'runtime', 'faster-whisper', 'private.marker')),
      credential: fs.readFileSync(path.join(installRoot, '.cache', 'shared-git', 'credential.txt'))
    };
    const installOutput = path.join(root, 'install-output.json');
    const installCode = await runUpdater(['--standalone-test-install', installRoot, releaseApi, installOutput], 120000);
    assert.strictEqual(installCode, 0, `standalone transaction handoff failed: ${fs.existsSync(installOutput) ? readJson(installOutput).message || '' : 'no result'}`);
    assert(readJson(installOutput).accepted, 'transaction controller did not accept the standalone handoff');
    const operationResult = await waitFor(() => {
      const file = path.join(installRoot, '.updates', 'operation-result.json');
      try { const value = readJson(file); return value.status === 'succeeded' ? value : null; } catch { return null; }
    }, 120000);
    assert.strictEqual(operationResult.status, 'succeeded', 'standalone transaction did not complete');
    assert.strictEqual(readJson(path.join(installRoot, 'package.json')).version, packageVersion, 'standalone update did not install latest package');
    assert.strictEqual(fs.readFileSync(path.join(installRoot, 'assets', 'state.txt'), 'utf8'), 'new-core', 'standalone update did not replace core files');
    assert.deepStrictEqual(fs.readFileSync(path.join(installRoot, 'workspace', 'orchestrator.sqlite')), preserved.database, 'workspace database changed');
    assert.deepStrictEqual(fs.readFileSync(path.join(installRoot, 'runtime', 'models', 'small', 'model.bin')), preserved.model, 'model changed');
    assert.deepStrictEqual(fs.readFileSync(path.join(installRoot, 'runtime', 'python', 'private.marker')), preserved.python, 'base Python changed');
    assert.deepStrictEqual(fs.readFileSync(path.join(installRoot, 'runtime', 'faster-whisper', 'private.marker')), preserved.asr, 'ASR runtime changed');
    assert.deepStrictEqual(fs.readFileSync(path.join(installRoot, '.cache', 'shared-git', 'credential.txt')), preserved.credential, 'private GitHub credential changed');

    const cancelRoot = path.join(root, 'cancel during download');
    createOldProject(cancelRoot, '1.6.2');
    const cancelFile = path.join(root, 'cancel.request');
    const cancelOutput = path.join(root, 'cancel-output.json');
    remote.state.slow = true;
    remote.state.armDownload();
    const cancelProcess = spawn(updater, ['--standalone-test-prepare', cancelRoot, releaseApi, cancelOutput, cancelFile], { cwd: repoRoot, windowsHide: true, stdio: 'ignore' });
    await remote.state.downloadStarted;
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.writeFileSync(cancelFile, 'cancel');
    assert.notStrictEqual(await waitForExit(cancelProcess, 30000), 0, 'download cancellation unexpectedly succeeded');
    remote.state.slow = false;
    assert.strictEqual(readJson(cancelOutput).status, 'cancelled', 'download cancellation was not reported');
    assert.strictEqual(fs.readFileSync(path.join(cancelRoot, 'assets', 'state.txt'), 'utf8'), 'old-core', 'download cancellation modified the old project');
    assert(!fs.existsSync(path.join(cancelRoot, '.updates', 'operation-journal.json')), 'download cancellation started a replacement transaction');

    console.log('standalone updater integration test passed');
  } finally {
    await new Promise((resolve) => remote.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
