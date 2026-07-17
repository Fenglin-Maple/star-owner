const fs = require('fs');
const path = require('path');

const SHORTCUT_RECORD_ID = 'desktopShortcut';
const SHORTCUT_FILENAME = '星藏家.lnk';

function ensurePortableDesktopShortcut({
  projectRoot,
  desktopPath,
  executablePath,
  version,
  store,
  writeShortcutLink,
  platform = process.platform
}) {
  const root = path.resolve(projectRoot);
  if (platform !== 'win32') return { status: 'skipped', reason: 'unsupported-platform' };
  if (!fs.existsSync(path.join(root, 'portable-manifest.json'))) return { status: 'skipped', reason: 'not-portable' };
  if (!store || typeof writeShortcutLink !== 'function') throw new Error('桌面快捷方式服务未就绪。');

  const executable = path.resolve(executablePath);
  const icon = path.join(root, 'assets', 'star-note.ico');
  if (!fs.existsSync(executable)) throw new Error(`快捷方式启动程序不存在：${executable}`);
  if (!fs.existsSync(icon)) throw new Error(`快捷方式图标不存在：${icon}`);

  const previous = store.get('settings', SHORTCUT_RECORD_ID) || {};
  if (previous.completed && path.resolve(previous.projectRoot || '.') === root) {
    return { status: 'skipped', reason: 'already-completed', shortcutPath: previous.shortcutPath || '' };
  }

  const shortcutPath = path.join(path.resolve(desktopPath), SHORTCUT_FILENAME);
  const operation = fs.existsSync(shortcutPath) ? 'replace' : 'create';
  const details = {
    target: executable,
    cwd: root,
    args: `"${root}"`,
    description: '星藏家 - Bilibili 视频知识整理',
    icon,
    iconIndex: 0,
    appUserModelId: 'com.fenglin-maple.star-owner'
  };
  if (!writeShortcutLink(shortcutPath, operation, details)) throw new Error('Windows 未能写入桌面快捷方式。');

  const record = {
    id: SHORTCUT_RECORD_ID,
    completed: true,
    version: String(version || ''),
    projectRoot: root,
    shortcutPath,
    createdAt: new Date().toISOString()
  };
  store.set('settings', SHORTCUT_RECORD_ID, record);
  store.save();
  return { status: 'created', shortcutPath, operation, details };
}

module.exports = { ensurePortableDesktopShortcut, SHORTCUT_FILENAME, SHORTCUT_RECORD_ID };
