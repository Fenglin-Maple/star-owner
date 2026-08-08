const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { utf8ChildEnvironment } = require('../src/core/child-process-io');

const root = path.resolve(__dirname, '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : (process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron'));
const tool = path.join(root, 'tools', 'video-tool.js');
assert(fs.existsSync(electron), `Bundled Electron executable is missing: ${electron}`);

const result = spawnSync(electron, [tool, 'health', 'info'], {
  cwd: root,
  encoding: 'utf8',
  env: {
    ...utf8ChildEnvironment(),
    ELECTRON_RUN_AS_NODE: '1',
    PATH: path.join(root, '.cache', 'intentionally-missing-global-node')
  },
  windowsHide: true,
  timeout: 30000
});

assert.strictEqual(result.status, 0, `Bundled Electron Node mode failed without global PATH:\n${result.stderr || result.stdout}`);
const payload = JSON.parse(String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1) || '{}');
assert.strictEqual(payload.response, 'pong', 'Project tool did not respond through bundled Electron Node mode.');
console.log(`Bundled Electron Node runtime test passed (${payload.node || 'unknown Node'}).`);
