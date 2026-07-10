const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const electronRoot = path.join(projectRoot, 'node_modules', 'electron');
const binary = process.platform === 'win32'
  ? path.join(electronRoot, 'dist', 'electron.exe')
  : (process.platform === 'darwin'
      ? path.join(electronRoot, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
      : path.join(electronRoot, 'dist', 'electron'));

if (fs.existsSync(binary)) process.exit(0);

const installer = path.join(electronRoot, 'install.js');
if (!fs.existsSync(installer)) {
  console.error('Electron installer is missing. Run npm ci again and check the npm registry response.');
  process.exit(1);
}

console.log('Electron binary is missing; running the official package installer...');
const result = spawnSync(process.execPath, [installer], {
  cwd: electronRoot,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true
});
if (result.status !== 0 || !fs.existsSync(binary)) {
  console.error('Electron binary installation failed. See DEPLOYMENT.md for mirror and proxy troubleshooting.');
  process.exit(result.status || 1);
}
