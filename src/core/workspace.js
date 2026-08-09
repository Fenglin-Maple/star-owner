const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const WORKSPACE_ROOT = path.join(PROJECT_ROOT, 'workspace');
const WINDOWS_MAX_PATH = 259;
const MIN_ARTIFACT_NAME_LENGTH = 24;
const MAX_ARTIFACT_NAME_LENGTH = 180;
const TOOL_ID_PATH_LENGTH = 32;
const STARTUP_IDENTITY_SEGMENT_LENGTH = 48;
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

class PathSafetyError extends Error {
  constructor(targetPath, context = '文件路径') {
    const resolved = path.resolve(targetPath);
    super(buildPathTooLongMessage(resolved, context));
    this.name = 'PathSafetyError';
    this.code = 'WINDOWS_PATH_TOO_LONG';
    this.path = resolved;
    this.pathLength = resolved.length;
    this.maxPathLength = WINDOWS_MAX_PATH;
  }
}

function ensureDir(dir) {
  const resolved = assertSafeWindowsPath(dir, '目录');
  try {
    fs.mkdirSync(resolved, { recursive: true });
  } catch (error) {
    if (isPathLengthError(error, resolved)) throw new PathSafetyError(resolved, '目录');
    throw error;
  }
  return resolved;
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
  const sourceName = videoArtifactName(task, collection, filenameMetadata);
  const title = fitArtifactName(collectionDir, sourceName);
  const direct = path.join(collectionDir, title);
  if (!fs.existsSync(direct)) return direct;
  for (let index = 2; index < 1000; index += 1) {
    const candidateName = fitArtifactName(collectionDir, `${sourceName} (${index})`);
    const candidate = path.join(collectionDir, candidateName);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not allocate a unique artifact directory for ${task.bvid || task.title || 'video'}.`);
}

function fitArtifactName(collectionDir, value) {
  const root = path.resolve(collectionDir);
  const maxLength = maximumArtifactNameLength(root);
  if (maxLength < MIN_ARTIFACT_NAME_LENGTH) {
    throw new PathSafetyError(deepestArtifactPath(root, 'v'.repeat(MIN_ARTIFACT_NAME_LENGTH)), '视频工作产物路径');
  }
  const name = safeName(value, 'video-summary', 4096);
  if (name.length <= maxLength) return name;
  const suffix = crypto.createHash('sha1').update(name).digest('hex').slice(0, 8);
  return safeName(`${name.slice(0, Math.max(1, maxLength - suffix.length - 1))}-${suffix}`, 'video-summary', maxLength);
}

function maximumArtifactNameLength(collectionDir) {
  if (process.platform !== 'win32') return MAX_ARTIFACT_NAME_LENGTH;
  for (let length = MAX_ARTIFACT_NAME_LENGTH; length >= MIN_ARTIFACT_NAME_LENGTH; length -= 1) {
    if (deepestArtifactPaths(collectionDir, 'v'.repeat(length)).every((candidate) => candidate.length <= WINDOWS_MAX_PATH)) return length;
  }
  return 0;
}

function deepestArtifactPaths(collectionDir, artifactName) {
  const artifactDir = path.join(path.resolve(collectionDir), artifactName);
  return [
    path.join(artifactDir, `${artifactName}.md`),
    path.join(artifactDir, 'tool-runs', `${'0'.repeat(13)}-${'t'.repeat(TOOL_ID_PATH_LENGTH)}-${'f'.repeat(6)}.log`),
    path.join(artifactDir, 'subtitles', `p99-${'s'.repeat(48)}.json`),
    path.join(artifactDir, 'asr', 'asr-transcript.txt')
  ];
}

function deepestArtifactPath(collectionDir, artifactName) {
  return deepestArtifactPaths(collectionDir, artifactName).sort((left, right) => right.length - left.length)[0];
}

function assertSafeWindowsPath(targetPath, context = '文件路径') {
  const resolved = path.resolve(targetPath);
  if (process.platform === 'win32' && resolved.length > WINDOWS_MAX_PATH) throw new PathSafetyError(resolved, context);
  return resolved;
}

function isPathLengthError(error, targetPath = '') {
  if (process.platform !== 'win32') return error?.code === 'ENAMETOOLONG';
  return String(targetPath || '').length > WINDOWS_MAX_PATH
    || error?.code === 'ENAMETOOLONG'
    || /path too long|filename or extension is too long/i.test(String(error?.message || ''));
}

function buildPathTooLongMessage(targetPath, context = '文件路径') {
  return `${context}过长（${targetPath.length}/${WINDOWS_MAX_PATH} 个字符），Windows 无法可靠创建本次产物。请关闭星藏家并停止所有 Agent。项目内默认库应将整个项目复制到更短的位置（建议 D:\\Star-Owner），不要只移动 workspace；自定义工作库应在设置中新建更短的目录并设为默认。`;
}

function evaluateWorkspacePathSafety(workspaces = [], collections = []) {
  if (process.platform !== 'win32') return { safe: true, platform: process.platform, limit: WINDOWS_MAX_PATH, checked: [] };
  const checked = [];
  const collectionList = Array.isArray(collections) ? collections : [];
  const workspaceList = Array.isArray(workspaces) ? workspaces : [];
  const defaultWorkspaces = workspaceList.filter((item) => item?.isDefault);
  for (const workspace of defaultWorkspaces.length ? defaultWorkspaces : workspaceList.slice(0, 1)) {
    const root = path.resolve(workspace?.root || WORKSPACE_ROOT);
    const futureCollectionRoot = path.join(root, '用'.repeat(STARTUP_IDENTITY_SEGMENT_LENGTH), '收'.repeat(STARTUP_IDENTITY_SEGMENT_LENGTH));
    checked.push(pathSafetyCandidate(workspace?.id || 'workspace', root, futureCollectionRoot, '未来收藏夹预留'));
    for (const collection of collectionList.filter((item) => item.workspaceId ? item.workspaceId === workspace?.id : Boolean(workspace?.isDefault))) {
      const collectionDir = collection.collectionRoot
        ? path.resolve(collection.collectionRoot)
        : path.join(root, safeName(collection.userName || collection.userId || 'unknown-user'), safeName(collection.name || 'favorite'));
      checked.push(pathSafetyCandidate(workspace?.id || 'workspace', root, collectionDir, collection.name || collection.id || '已同步收藏夹'));
    }
  }
  const unsafe = checked.filter((item) => !item.safe).sort((left, right) => right.length - left.length);
  const longest = checked.slice().sort((left, right) => right.length - left.length)[0] || null;
  return {
    safe: unsafe.length === 0,
    platform: process.platform,
    limit: WINDOWS_MAX_PATH,
    minimumArtifactNameLength: MIN_ARTIFACT_NAME_LENGTH,
    checkedCount: checked.length,
    longest,
    unsafeCount: unsafe.length,
    unsafe: unsafe.slice(0, 10),
    message: unsafe.length ? buildPathTooLongMessage(unsafe[0].path, `${unsafe[0].label}的预计视频产物路径`) : ''
  };
}

function pathSafetyCandidate(workspaceId, workspaceRoot, collectionDir, label) {
  const candidate = deepestArtifactPath(collectionDir, 'v'.repeat(MIN_ARTIFACT_NAME_LENGTH));
  return { workspaceId, workspaceRoot, collectionRoot: collectionDir, label, path: candidate, length: candidate.length, safe: candidate.length <= WINDOWS_MAX_PATH };
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

function removePathInside(parent, candidate, { allowRoot = false } = {}) {
  const resolvedParent = path.resolve(parent);
  const resolvedCandidate = assertInside(resolvedParent, candidate);
  if (!allowRoot && sameFilesystemPath(resolvedCandidate, resolvedParent)) {
    throw new Error(`Refusing to remove the managed root itself: ${resolvedCandidate}`);
  }
  if (!fs.existsSync(resolvedCandidate)) return false;
  assertNoLinkedParent(resolvedParent, resolvedCandidate);
  const realParent = fs.realpathSync.native(resolvedParent);
  removeWithoutFollowingLinks(resolvedCandidate, realParent);
  return true;
}

async function removePathInsideAsync(parent, candidate, { allowRoot = false } = {}) {
  const resolvedParent = path.resolve(parent);
  const resolvedCandidate = assertInside(resolvedParent, candidate);
  if (!allowRoot && sameFilesystemPath(resolvedCandidate, resolvedParent)) {
    throw new Error(`Refusing to remove the managed root itself: ${resolvedCandidate}`);
  }
  try {
    await fs.promises.lstat(resolvedCandidate);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  assertNoLinkedParent(resolvedParent, resolvedCandidate);
  const realParent = await fs.promises.realpath(resolvedParent);
  await removeWithoutFollowingLinksAsync(resolvedCandidate, realParent);
  return true;
}

function assertNoLinkedParent(parent, candidate) {
  const segments = path.relative(parent, candidate).split(path.sep).filter(Boolean);
  let current = parent;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) return;
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Refusing to traverse a linked directory during removal: ${current}`);
    }
  }
}

function removeWithoutFollowingLinks(target, realParent) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(target);
    return;
  }
  assertInside(realParent, fs.realpathSync.native(target));
  if (!stat.isDirectory()) {
    fs.rmSync(target, { force: true, maxRetries: 8, retryDelay: 150 });
    return;
  }
  for (const name of fs.readdirSync(target)) removeWithoutFollowingLinks(path.join(target, name), realParent);
  removeEmptyDirectory(target);
}

function removeEmptyDirectory(target) {
  let lastError;
  for (let attempt = 0; attempt < 9; attempt += 1) {
    try {
      fs.rmdirSync(target);
      return;
    } catch (error) {
      lastError = error;
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code) || attempt === 8) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150 * (attempt + 1));
    }
  }
  throw lastError;
}

async function removeWithoutFollowingLinksAsync(target, realParent) {
  let stat;
  try {
    stat = await fs.promises.lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    await fs.promises.unlink(target);
    return;
  }
  assertInside(realParent, await fs.promises.realpath(target));
  if (!stat.isDirectory()) {
    await fs.promises.rm(target, { force: true, maxRetries: 8, retryDelay: 150 });
    return;
  }
  for (const name of await fs.promises.readdir(target)) await removeWithoutFollowingLinksAsync(path.join(target, name), realParent);
  await removeEmptyDirectoryAsync(target);
}

async function removeEmptyDirectoryAsync(target) {
  let lastError;
  for (let attempt = 0; attempt < 9; attempt += 1) {
    try {
      await fs.promises.rmdir(target);
      return;
    } catch (error) {
      if (error.code === 'ENOENT') return;
      lastError = error;
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code) || attempt === 8) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
  throw lastError;
}

function sameFilesystemPath(left, right) {
  const normalize = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function initWorkspace() {
  ensureDir(WORKSPACE_ROOT);
  ensureDir(path.join(WORKSPACE_ROOT, 'users'));
  ensureDir(path.join(WORKSPACE_ROOT, '.star-note'));
  return WORKSPACE_ROOT;
}

module.exports = {
  DEFAULT_FILENAME_METADATA,
  MAX_ARTIFACT_NAME_LENGTH,
  MIN_ARTIFACT_NAME_LENGTH,
  PathSafetyError,
  PROJECT_ROOT,
  TOOL_ID_PATH_LENGTH,
  WINDOWS_MAX_PATH,
  WORKSPACE_ROOT,
  assertSafeWindowsPath,
  assertInside,
  collectionDirs,
  collectionRoot,
  ensureDir,
  evaluateWorkspacePathSafety,
  fitArtifactName,
  initWorkspace,
  libraryUserRoot,
  normalizeFilenameMetadata,
  normalizeTags,
  removePathInside,
  removePathInsideAsync,
  safeName,
  timestampForFile,
  userCookiesDir,
  userRoot,
  videoArtifactName,
  videoArtifactDir
};
