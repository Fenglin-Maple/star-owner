const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const WORKSPACE_ROOT = path.join(PROJECT_ROOT, 'workspace');
const DEFAULT_FILENAME_METADATA = Object.freeze({
  bvid: true,
  title: true,
  owner: true,
  publishedAt: true,
  favoriteAddedAt: true,
  collection: true,
  tags: true
});

function safeName(value, fallback = 'untitled', maxLength = 120) {
  let cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim() || fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned.slice(0, Math.max(1, Number(maxLength) || 120)).replace(/[. ]+$/g, '') || fallback;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function timestampForFile(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

function userRoot(userName) {
  return ensureDir(path.join(WORKSPACE_ROOT, 'users', safeName(userName || 'unknown-user')));
}

function userCookiesDir(userName) {
  return ensureDir(path.join(userRoot(userName), 'cookies'));
}

function libraryUserRoot(libraryRoot, userName) {
  return ensureDir(path.join(path.resolve(libraryRoot || WORKSPACE_ROOT), safeName(userName || 'unknown-user')));
}

function collectionRoot(libraryRoot, userName, folderName) {
  return ensureDir(path.join(libraryUserRoot(libraryRoot, userName), safeName(folderName || 'favorite')));
}

function collectionDirs(libraryRoot, userName, folderName) {
  const workspace = path.resolve(libraryRoot || WORKSPACE_ROOT);
  const root = collectionRoot(workspace, userName, folderName);
  const systemRoot = ensureDir(path.join(workspace, '.star-note'));
  const exportRoot = ensureDir(path.join(systemRoot, 'exports', safeName(userName), safeName(folderName)));
  return {
    workspace,
    user: libraryUserRoot(workspace, userName),
    root,
    videos: root,
    exports: exportRoot,
    tasks: ensureDir(path.join(systemRoot, 'tasks', safeName(userName), safeName(folderName)))
  };
}

function normalizeFilenameMetadata(value = {}, defaults = DEFAULT_FILENAME_METADATA) {
  return Object.fromEntries(Object.keys(DEFAULT_FILENAME_METADATA).map((key) => [
    key,
    value[key] === undefined ? Boolean(defaults[key]) : Boolean(value[key])
  ]));
}

function videoArtifactName(task = {}, collection = {}, filenameMetadata = DEFAULT_FILENAME_METADATA) {
  const enabled = normalizeFilenameMetadata(filenameMetadata);
  const tags = normalizeTags(task.tags);
  const parts = [];
  if (enabled.bvid) parts.push(metadataToken('BV', task.bvid || '未知'));
  if (enabled.title) parts.push(metadataToken('标题', task.title || task.bvid || '未命名', 44));
  if (enabled.owner) parts.push(metadataToken('UP', task.owner || '未知', 24));
  if (enabled.publishedAt) parts.push(metadataToken('发布日', dateForFilename(task.publishedAt)));
  if (enabled.favoriteAddedAt) parts.push(metadataToken('收藏日', dateForFilename(task.favoriteAddedAt)));
  if (enabled.collection) parts.push(metadataToken('来自收藏夹', collection.name || task.collectionName || '未知', 24));
  if (enabled.tags) parts.push(metadataToken('标签', tags.length ? tags.slice(0, 8).join('+') : '无', 48));
  return safeName(parts.join(''), task.bvid || task.title || 'video-summary', 180);
}

function videoArtifactDir(collectionDir, task = {}, collection = {}, filenameMetadata = DEFAULT_FILENAME_METADATA) {
  const title = fitArtifactName(collectionDir, videoArtifactName(task, collection, filenameMetadata));
  const direct = path.join(collectionDir, title);
  if (!fs.existsSync(direct)) return direct;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = path.join(collectionDir, safeName(`${title} (${index})`, 'video-summary', 180));
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not allocate a unique artifact directory for ${task.bvid || task.title || 'video'}.`);
}

function fitArtifactName(collectionDir, value) {
  const rootLength = path.resolve(collectionDir).length;
  // The leaf is used once as a directory and again as the Markdown basename.
  const maxLength = Math.max(32, Math.min(180, Math.floor((238 - rootLength - 7) / 2)));
  const name = safeName(value, 'video-summary', 180);
  if (name.length <= maxLength) return name;
  const suffix = crypto.createHash('sha1').update(name).digest('hex').slice(0, 8);
  return safeName(`${name.slice(0, Math.max(1, maxLength - suffix.length - 1))}-${suffix}`, 'video-summary', maxLength);
}

function metadataToken(label, value, maxValueLength = 32) {
  const cleaned = safeName(value, '未知').slice(0, maxValueLength);
  return `[${label}-${cleaned}]`;
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => {
    if (typeof item === 'string') return safeName(item, '').slice(0, 20);
    return safeName(item?.tag_name || item?.name || '', '').slice(0, 20);
  }).filter(Boolean))];
}

function dateForFilename(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return '未知';
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}

function assertInside(parent, candidate) {
  const resolvedParent = path.resolve(parent);
  const resolvedCandidate = path.resolve(candidate);
  const parentForCompare = process.platform === 'win32' ? resolvedParent.toLowerCase() : resolvedParent;
  const candidateForCompare = process.platform === 'win32' ? resolvedCandidate.toLowerCase() : resolvedCandidate;
  if (candidateForCompare !== parentForCompare && !candidateForCompare.startsWith(`${parentForCompare}${path.sep}`)) {
    throw new Error(`Path is outside allowed directory: ${candidate}`);
  }
  return resolvedCandidate;
}

function initWorkspace() {
  ensureDir(WORKSPACE_ROOT);
  ensureDir(path.join(WORKSPACE_ROOT, 'users'));
  ensureDir(path.join(WORKSPACE_ROOT, '.star-note'));
  return WORKSPACE_ROOT;
}

module.exports = {
  DEFAULT_FILENAME_METADATA,
  PROJECT_ROOT,
  WORKSPACE_ROOT,
  assertInside,
  collectionDirs,
  collectionRoot,
  ensureDir,
  fitArtifactName,
  initWorkspace,
  libraryUserRoot,
  normalizeFilenameMetadata,
  normalizeTags,
  safeName,
  timestampForFile,
  userCookiesDir,
  userRoot,
  videoArtifactName,
  videoArtifactDir
};
