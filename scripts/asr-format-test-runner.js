const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const python = path.join(root, 'runtime', 'faster-whisper', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const script = path.join(root, 'scripts', 'asr-format-test.py');
const result = spawnSync(python, [script], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
