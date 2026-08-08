const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { nodeChildProcessSpec, projectRuntimeEnvironment, resolveNvidiaSmi, resolveSystemExecutable } = require('../src/core/child-process-io');
const { serviceEnvironment } = require('../src/core/asr-service');
const { resolveCommand } = require('../tools/video-tool');

const root = path.resolve(__dirname, '..');
const poisonedEnvironment = {
  ...process.env,
  PATH: `${path.join(root, 'fake-global-node')}${path.delimiter}C:\\Users\\Public\\global-tools`,
  Path: 'C:\\Users\\Public\\shadow-path',
  PYTHONPATH: 'C:\\Users\\Public\\global-python',
  PYTHONHOME: 'C:\\Users\\Public\\global-python-home',
  FASTER_WHISPER_BIN: 'C:\\Users\\Public\\global-faster-whisper.exe',
  NODE_PATH: 'C:\\Users\\Public\\global-node-modules',
  NODE_OPTIONS: '--require C:\\Users\\Public\\global-hook.js',
  ELECTRON_RUN_AS_NODE: 'stale'
};

const runtime = projectRuntimeEnvironment(poisonedEnvironment, root);
const runtimePath = String(runtime.PATH || '').toLowerCase();
assert(runtimePath.includes(path.join(root, 'runtime', 'faster-whisper').toLowerCase()), 'project Python runtime was not added to PATH');
assert(!runtimePath.includes('fake-global-node') && !runtimePath.includes('global-tools') && !runtimePath.includes('shadow-path'), 'global PATH entries leaked into the project runtime');
assert(!runtime.PYTHONPATH.toLowerCase().includes('global-python'), 'global PYTHONPATH leaked into the project runtime');
for (const key of ['FASTER_WHISPER_BIN', 'NODE_PATH', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'PYTHONHOME']) {
  assert.strictEqual(runtime[key], undefined, `${key} was not removed from the project runtime`);
}
assert.strictEqual(runtime.PYTHONNOUSERSITE, '1');

const node = nodeChildProcessSpec(poisonedEnvironment);
assert.strictEqual(path.resolve(node.executable), path.resolve(process.execPath), 'Node child process did not use the current application executable');
assert(!String(node.env.PATH).toLowerCase().includes('fake-global-node'), 'Node child inherited a global PATH entry');

const asr = serviceEnvironment(root);
const expectedSitePackages = process.platform === 'win32'
  ? path.resolve(root, 'runtime', 'faster-whisper', 'Lib', 'site-packages')
  : path.join(root, 'runtime', 'faster-whisper', 'lib', 'python3.12', 'site-packages');
assert.strictEqual(path.resolve(asr.PYTHONPATH), expectedSitePackages);
assert(!String(asr.PATH).toLowerCase().includes('global-tools'), 'ASR service inherited a global PATH entry');
assert.strictEqual(asr.FASTER_WHISPER_BIN, undefined);

if (process.platform === 'win32') {
  const nvidiaFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'star-owner-nvidia-path-test-'));
  try {
    const systemNvidia = path.join(nvidiaFixture, 'System32', 'nvidia-smi.exe');
    fs.mkdirSync(path.dirname(systemNvidia), { recursive: true });
    fs.writeFileSync(systemNvidia, 'fixture');
    const nvidiaEnvironment = {
      ...poisonedEnvironment,
      SystemRoot: nvidiaFixture,
      WINDIR: nvidiaFixture,
      ProgramFiles: path.join(nvidiaFixture, 'Program Files')
    };
    assert.strictEqual(path.resolve(resolveNvidiaSmi(nvidiaEnvironment)), path.resolve(systemNvidia), 'nvidia-smi was not resolved from the Windows driver directory');
    fs.rmSync(systemNvidia, { force: true });
    const programNvidia = path.join(nvidiaFixture, 'Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe');
    fs.mkdirSync(path.dirname(programNvidia), { recursive: true });
    fs.writeFileSync(programNvidia, 'fixture');
    assert.strictEqual(path.resolve(resolveNvidiaSmi(nvidiaEnvironment)), path.resolve(programNvidia), 'nvidia-smi did not use the standard NVIDIA NVSMI directory fallback');
    fs.rmSync(programNvidia, { force: true });
    assert.strictEqual(resolveNvidiaSmi(nvidiaEnvironment), '', 'nvidia-smi fell back to a PATH executable');
  } finally {
    fs.rmSync(nvidiaFixture, { recursive: true, force: true });
  }
  for (const command of ['cmd.exe', 'powershell.exe', 'taskkill.exe', 'tar.exe']) {
    const executable = resolveSystemExecutable(command);
    assert(executable && path.isAbsolute(executable) && /\\(?:System32|Sysnative)\\/i.test(executable), `${command} was not resolved from the Windows system directory`);
  }
  const shell = resolveSystemExecutable('cmd.exe');
  const commandResult = spawnSync(shell, ['/d', '/s', '/c', 'chcp 65001>nul & echo runtime-isolation'], { env: runtime, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(commandResult.status, 0, `controlled CMD environment failed: ${commandResult.stderr || commandResult.stdout}`);
  assert(/runtime-isolation/i.test(commandResult.stdout), 'controlled CMD did not produce output');
}

for (const command of ['ffmpeg', 'yt-dlp', 'faster-whisper']) {
  const executable = resolveCommand(command);
  assert(executable && path.isAbsolute(executable) && executable.toLowerCase().startsWith(root.toLowerCase()), `${command} did not resolve to the project runtime`);
}

const child = spawnSync(process.execPath, ['-e', "const { resolveCommand } = require('./tools/video-tool'); console.log(resolveCommand('faster-whisper'));"], {
  cwd: root,
  env: runtime,
  encoding: 'utf8',
  windowsHide: true
});
assert.strictEqual(child.status, 0, `runtime-isolation child failed: ${child.stderr || child.stdout}`);
assert(path.resolve(String(child.stdout).trim()).toLowerCase().startsWith(root.toLowerCase()), 'child process resolved faster-whisper outside the project');

console.log('runtime isolation test passed');
