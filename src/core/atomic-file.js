const fs = require('fs');
const path = require('path');

function recoverAtomicFile(file) {
  const target = path.resolve(file);
  const backup = `${target}.bak`;
  const temporary = `${target}.tmp`;
  if (!fs.existsSync(target) && fs.existsSync(backup)) fs.copyFileSync(backup, target);
  if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
}

function restoreAtomicBackup(file) {
  const target = path.resolve(file);
  const backup = `${target}.bak`;
  if (!fs.existsSync(backup)) return false;
  fs.copyFileSync(backup, target);
  return true;
}

function writeFileRecoverable(file, data) {
  const target = path.resolve(file);
  const temporary = `${target}.tmp`;
  const backup = `${target}.bak`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temporary, data);
  const descriptor = fs.openSync(temporary, 'r+');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  if (fs.existsSync(target)) fs.copyFileSync(target, backup);
  try {
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    fs.renameSync(temporary, target);
    if (fs.existsSync(backup)) fs.rmSync(backup, { force: true });
  } catch (error) {
    if (!fs.existsSync(target) && fs.existsSync(backup)) fs.copyFileSync(backup, target);
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    throw error;
  }
}

module.exports = { recoverAtomicFile, restoreAtomicBackup, writeFileRecoverable };
