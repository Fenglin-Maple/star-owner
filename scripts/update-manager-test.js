const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { UpdateManager, validateArchiveEntries } = require('../src/core/update-manager');

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
  runPowerShell(helper, helperArgs('update', projectRoot, { stagedRoot: stage, targetVersion: '9.9.9', operationId: 'update-fixture' }));
  assert.strictEqual(fs.readFileSync(path.join(projectRoot, 'templates', 'video-summary-template.md'), 'utf8'), 'new-template', 'portable update did not replace templates');
  assert.strictEqual(fs.readFileSync(path.join(projectRoot, 'DESIGN_SHARED_KNOWLEDGE.md'), 'utf8'), 'new-shared-design', 'portable update did not replace shared design documentation');
  assert.strictEqual(fs.readFileSync(path.join(projectRoot, 'runtime', 'git', 'cmd', 'git.exe'), 'utf8'), 'new-portable-git', 'portable update did not install the project-local Git runtime');
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

  const source = path.join(root, 'old-project');
  fs.mkdirSync(path.join(source, 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ version: '1.0.3' }));
  fs.writeFileSync(path.join(source, 'workspace', 'orchestrator.sqlite'), Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(80)]));
  runPowerShell(helper, helperArgs('migrate', projectRoot, { sourceWorkspace: path.join(source, 'workspace'), targetVersion: '9.9.9', operationId: 'migration-fixture' }));
  assert(fs.existsSync(path.join(projectRoot, 'workspace', 'orchestrator.sqlite')), 'portable migration helper did not copy the old workspace');
  assert.strictEqual(readJson(path.join(projectRoot, '.updates', 'operation-result.json')).status, 'succeeded', 'portable migration helper did not write a success result');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('update and migration integration test passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
