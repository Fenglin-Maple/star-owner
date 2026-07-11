const fs = require('fs');
const path = require('path');
const { writeFileRecoverable } = require('./atomic-file');

function repairPortablePythonHome(projectRoot = path.resolve(__dirname, '..', '..')) {
  const root = path.resolve(projectRoot);
  const configFile = path.join(root, 'runtime', 'faster-whisper', 'pyvenv.cfg');
  const pythonHome = findBundledPythonHome(path.join(root, 'runtime', 'python'));
  if (!fs.existsSync(configFile) || !pythonHome) {
    return { available: false, changed: false, configFile, pythonHome: pythonHome || '' };
  }

  const current = fs.readFileSync(configFile, 'utf8');
  const line = `home = ${pythonHome}`;
  const next = /^home\s*=.*$/m.test(current)
    ? current.replace(/^home\s*=.*$/m, line)
    : `${line}\n${current}`;
  if (next === current) return { available: true, changed: false, configFile, pythonHome };
  writeFileRecoverable(configFile, Buffer.from(next, 'utf8'));
  return { available: true, changed: true, configFile, pythonHome };
}

function findBundledPythonHome(pythonRoot) {
  if (!fs.existsSync(pythonRoot)) return '';
  for (const entry of fs.readdirSync(pythonRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(pythonRoot, entry.name);
    if (fs.existsSync(path.join(directory, process.platform === 'win32' ? 'python.exe' : 'bin/python'))) return directory;
  }
  return '';
}

module.exports = { findBundledPythonHome, repairPortablePythonHome };
