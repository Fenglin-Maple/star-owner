const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { resolveSystemExecutable } = require('./child-process-io');
const { ensureDir } = require('./workspace');

const REPOSITORY = 'Fenglin-Maple/star-owner';
const RELEASES_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const CORE_ASSET = /^Star-Owner-v([0-9]+\.[0-9]+\.[0-9]+)-win-x64-core\.zip$/i;
const MIN_MIGRATION_VERSION = '1.0.3';

class UpdateManager {
  constructor({ projectRoot, version, emit, fetchImpl = global.fetch, platform = process.platform } = {}) {
    this.projectRoot = path.resolve(projectRoot || process.cwd());
    this.version = String(version || '0.0.0');
    this.emit = emit || (() => {});
    this.fetchImpl = fetchImpl;
    this.platform = platform;
    this.updateRoot = ensureDir(path.join(this.projectRoot, '.updates'));
    this.downloadRoot = ensureDir(path.join(this.updateRoot, 'downloads'));
    this.stateData = {
      currentVersion: this.version,
      status: 'idle',
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      message: '尚未检查更新',
      release: null,
      prepared: false,
      portable: this.isPortable()
    };
    this.prepared = null;
    this.restoreOperationResult();
  }

  isPortable() {
    return fs.existsSync(path.join(this.projectRoot, 'portable-manifest.json'))
      && fs.existsSync(path.join(this.projectRoot, 'Start-StarOwner.cmd'));
  }

  state() {
    return {
      ...this.stateData,
      repository: `https://github.com/${REPOSITORY}`,
      releasePage: `https://github.com/${REPOSITORY}/releases`,
      prepared: Boolean(this.prepared && fs.existsSync(this.prepared.packageRoot)),
      portable: this.isPortable(),
      migrationVersion: MIN_MIGRATION_VERSION
    };
  }

  publish(patch) {
    this.stateData = { ...this.stateData, ...patch };
    this.emit({ type: 'update-progress', state: this.state() });
    return this.state();
  }

  async check() {
    this.publish({ status: 'checking', progress: 0.02, message: '正在查询 GitHub 最新稳定 Release' });
    try {
      const release = await this.fetchJson(RELEASES_URL);
      const resolved = resolveCoreRelease(release);
      resolved.checksum = await this.resolveChecksum(resolved);
      const updateAvailable = compareVersions(resolved.version, this.version) > 0;
      this.publish({
        status: updateAvailable ? 'available' : 'up-to-date',
        progress: 1,
        message: updateAvailable ? `发现新版本 v${resolved.version}` : `当前已是最新稳定版本 v${this.version}`,
        release: resolved,
        prepared: false
      });
      return this.state();
    } catch (error) {
      this.publish({ status: 'error', progress: 0, message: error.message || String(error) });
      throw error;
    }
  }

  async prepare() {
    try {
      return await this.prepareInternal();
    } catch (error) {
      this.publish({ status: 'error', progress: 0, prepared: false, message: error.message || String(error) });
      throw error;
    }
  }

  async prepareInternal() {
    if (!this.stateData.release || compareVersions(this.stateData.release.version, this.version) <= 0) await this.check();
    const release = this.stateData.release;
    if (!release || compareVersions(release.version, this.version) <= 0) return this.state();
    if (!release.checksum) throw new Error('GitHub Release 缺少核心包 SHA-256 校验值，已停止安装。请补充同名 .sha256 资产后重试。');
    if (!this.isPortable()) throw new Error('当前目录不是便携发布包，开发目录不能直接覆盖更新。请下载新 Release 或先完成手动迁移。');
    const archive = path.join(this.downloadRoot, release.asset.name);
    const partial = `${archive}.partial`;
    this.publish({ status: 'downloading', progress: 0.03, downloadedBytes: fs.existsSync(partial) ? fs.statSync(partial).size : 0, totalBytes: Number(release.asset.size || 0), message: `正在下载 ${release.asset.name}` });
    if (!fs.existsSync(archive) || await sha256(archive) !== release.checksum) {
      await this.downloadFile(release.asset.url, partial, release.asset.name, Number(release.asset.size || 0), release.checksum);
      if (fs.existsSync(archive)) fs.rmSync(archive, { force: true });
      fs.renameSync(partial, archive);
      this.publish({ status: 'verifying', progress: 0.9, message: '正在校验核心包 SHA-256' });
    }
    const actual = await sha256(archive);
    if (actual !== release.checksum) {
      fs.rmSync(archive, { force: true });
      throw new Error(`核心包 SHA-256 不匹配，已拒绝安装：${actual}`);
    }
    const tar = resolveSystemExecutable('tar.exe');
    if (!tar) throw new Error('Windows 系统缺少 tar.exe，无法检查更新包。');
    const inspection = await inspectArchive(archive, this.projectRoot, tar);
    const stagingRoot = path.join(this.updateRoot, `staging-v${release.version}`);
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    ensureDir(stagingRoot);
    await runCommand(tar, ['-xf', archive, '-C', stagingRoot], this.projectRoot);
    const packageRoot = locatePackageRoot(stagingRoot, inspection.prefix);
    validateStagedPackage(packageRoot, release.version);
    this.prepared = { archive, stagingRoot, packageRoot, release };
    this.publish({ status: 'ready', progress: 1, prepared: true, message: `v${release.version} 已下载并校验通过，等待重启安装` });
    return this.state();
  }

  launchPreparedUpdate() {
    if (!this.prepared || !fs.existsSync(this.prepared.packageRoot)) throw new Error('没有可安装的已校验更新包，请重新检查更新。');
    return this.launchOperation({
      mode: 'update',
      stagedRoot: this.prepared.packageRoot,
      targetVersion: this.prepared.release.version
    });
  }

  inspectMigrationSource(sourceRoot) {
    const source = path.resolve(String(sourceRoot || ''));
    if (!source || samePath(source, this.projectRoot)) throw new Error('旧版本目录不能是当前目录。');
    const sourceWorkspace = path.join(source, 'workspace');
    const database = path.join(sourceWorkspace, 'orchestrator.sqlite');
    if (!fs.existsSync(sourceWorkspace) || !fs.statSync(sourceWorkspace).isDirectory()) throw new Error('选择的目录没有找到 workspace。');
    if (!fs.existsSync(database) || !fs.statSync(database).isFile()) throw new Error('旧版本 workspace 中没有找到 orchestrator.sqlite。');
    const header = fs.readFileSync(database).subarray(0, 16).toString('utf8');
    if (header !== 'SQLite format 3\u0000') throw new Error('旧版本数据库不是有效的 SQLite 文件，已拒绝迁移。');
    const metadata = readJsonIfPresent(path.join(source, 'package.json')) || readJsonIfPresent(path.join(source, 'portable-manifest.json')) || {};
    const oldVersion = String(metadata.version || metadata.appVersion || '');
    if (oldVersion && compareVersions(oldVersion, MIN_MIGRATION_VERSION) < 0) throw new Error(`仅支持从 v${MIN_MIGRATION_VERSION} 或更高版本迁移，检测到 v${oldVersion}。`);
    if (isInside(source, this.projectRoot) || isInside(this.projectRoot, source)) throw new Error('旧版本目录不能是当前目录的子目录或父目录。');
    return { sourceRoot: source, sourceWorkspace, database, oldVersion: oldVersion || '未知', portable: fs.existsSync(path.join(source, 'portable-manifest.json')) };
  }

  launchMigration(sourceRoot) {
    const migration = this.inspectMigrationSource(sourceRoot);
    return this.launchOperation({ mode: 'migrate', sourceWorkspace: migration.sourceWorkspace, targetVersion: this.version });
  }

  launchOperation({ mode, stagedRoot = '', sourceWorkspace = '', targetVersion = '' }) {
    if (this.platform !== 'win32') throw new Error('便携自动更新和迁移目前只支持 Windows。');
    const helperSource = mode === 'update' && stagedRoot
      ? path.join(path.resolve(stagedRoot), 'scripts', 'apply-portable-operation.ps1')
      : path.join(this.projectRoot, 'scripts', 'apply-portable-operation.ps1');
    if (!fs.existsSync(helperSource)) throw new Error('更新事务脚本缺失，无法安全更新。');
    if (mode === 'update' && !isInside(this.updateRoot, helperSource)) throw new Error('更新事务脚本不在受管暂存目录中。');
    const operationId = `operation-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const requestFile = path.join(this.updateRoot, 'operation-request.json');
    fs.writeFileSync(requestFile, `${JSON.stringify({
      operationId,
      mode,
      projectRoot: this.projectRoot,
      stagedRoot: stagedRoot ? path.resolve(stagedRoot) : '',
      sourceWorkspace: sourceWorkspace ? path.resolve(sourceWorkspace) : '',
      targetVersion,
      helperSource,
      requestedAt: new Date().toISOString()
    }, null, 2)}\n`, 'utf8');
    const helper = path.join(os.tmpdir(), `star-owner-operation-${process.pid}-${Date.now()}.ps1`);
    fs.copyFileSync(helperSource, helper);
    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper,
      '-Mode', mode, '-ProjectRoot', this.projectRoot, '-ProcessId', String(process.pid),
      '-StagedRoot', stagedRoot, '-SourceWorkspace', sourceWorkspace,
      '-TargetVersion', targetVersion, '-OperationId', operationId, '-Relaunch'
    ];
    const powershell = resolveSystemExecutable('powershell.exe');
    if (!powershell) throw new Error('Windows 系统缺少 PowerShell，无法执行更新或迁移。');
    const child = spawn(powershell, args, { detached: true, windowsHide: true, stdio: 'ignore' });
    child.unref();
    this.publish({ status: 'applying', progress: 1, message: mode === 'update' ? '应用即将退出并安装更新，Workspace 与依赖会保留。' : '应用即将退出并迁移旧版本数据，完成后会自动重启。' });
    return { scheduled: true, mode, targetVersion };
  }

  async fetchJson(url) {
    const response = await this.fetchImpl(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'star-owner-update-check' }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`GitHub 请求失败（${response.status}）。请检查网络或稍后重试。`);
    return response.json();
  }

  async resolveChecksum(release) {
    if (release.checksum) return release.checksum;
    if (!release.checksumUrl) return '';
    const response = await this.fetchImpl(release.checksumUrl, {
      headers: { Accept: 'text/plain', 'User-Agent': 'star-owner-update-check' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`无法读取核心包 SHA-256 校验文件（${response.status}）。`);
    const checksum = parseChecksumText(await response.text());
    if (!checksum) throw new Error('核心包 SHA-256 校验文件格式无效，已停止安装。');
    return checksum;
  }

  async downloadFile(url, target, label, expectedTotal = 0, expectedChecksum = '') {
    expectedChecksum = String(expectedChecksum || '').toLowerCase();
    let existing = fs.existsSync(target) ? fs.statSync(target).size : 0;
    const headers = { Accept: 'application/octet-stream', 'User-Agent': 'star-owner-updater' };
    if (existing) headers.Range = `bytes=${existing}-`;
    const request = (requestHeaders) => this.fetchImpl(url, { headers: requestHeaders, redirect: 'follow', signal: AbortSignal.timeout(6 * 60 * 60 * 1000) });
    let response = await request(headers);
    if (response.status === 416 && existing) {
      const partialIsComplete = Boolean((expectedTotal && existing === Number(expectedTotal)) || (!expectedTotal && expectedChecksum))
        && Boolean(expectedChecksum)
        && await sha256(target) === expectedChecksum;
      if (partialIsComplete) return;
      fs.rmSync(target, { force: true });
      existing = 0;
      response = await request({ Accept: 'application/octet-stream', 'User-Agent': 'star-owner-updater' });
    }
    if (!response.ok || !response.body) throw new Error(`更新包下载失败（${response.status}）。`);
    let range = parseContentRange(response.headers.get('content-range'));
    let resumed = existing > 0 && response.status === 206 && range?.start === existing;
    if (existing && !resumed) {
      if (response.status === 206) {
        fs.rmSync(target, { force: true });
        existing = 0;
        response = await request({ Accept: 'application/octet-stream', 'User-Agent': 'star-owner-updater' });
        if (!response.ok || !response.body) throw new Error(`更新包下载失败（${response.status}）。`);
        range = parseContentRange(response.headers.get('content-range'));
      }
      existing = 0;
      fs.rmSync(target, { force: true });
    }
    let downloaded = existing;
    const total = Number(range?.total || expectedTotal || 0);
    const meter = new (require('stream').Transform)({
      transform: (chunk, _encoding, callback) => {
        downloaded += chunk.length;
        const fraction = total ? downloaded / total : 0;
        this.publish({ status: 'downloading', progress: Math.min(0.88, 0.03 + fraction * 0.84), downloadedBytes: downloaded, totalBytes: total, message: `${label}：${formatBytes(downloaded)}${total ? ` / ${formatBytes(total)}` : ''}` });
        callback(null, chunk);
      }
    });
    await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(target, { flags: resumed ? 'a' : 'w' }));
    if (total && downloaded !== total) throw new Error(`更新包下载不完整：${formatBytes(downloaded)} / ${formatBytes(total)}。`);
  }

  restoreOperationResult() {
    const file = path.join(this.updateRoot, 'operation-result.json');
    const journal = readJsonIfPresent(path.join(this.updateRoot, 'operation-journal.json'));
    const request = readJsonIfPresent(path.join(this.updateRoot, 'operation-request.json'));
    const result = readJsonIfPresent(file);
    if (journal) {
      this.stateData.lastOperation = {
        ...journal,
        status: 'incomplete',
        message: '检测到上次更新/迁移没有写入完成结果，请检查备份后重新执行。'
      };
    } else if (request && (!result || String(result.operationId || '') !== String(request.operationId || ''))) {
      this.stateData.lastOperation = {
        ...request,
        status: 'scheduled',
        message: '上次更新/迁移已安排，但尚未收到 helper 的完成结果。'
      };
    } else if (result) {
      this.stateData.lastOperation = result;
    }
  }
}

function resolveCoreRelease(release) {
  if (!release || release.draft || release.prerelease) throw new Error('GitHub 最新 Release 不是可安装的稳定版本。');
  const tag = String(release.tag_name || '').replace(/^v/i, '');
  const match = tag.match(/^\d+\.\d+\.\d+$/);
  if (!match) throw new Error('GitHub Release 版本号不是有效的三段式版本。');
  const asset = (release.assets || []).find((item) => CORE_ASSET.test(String(item.name || '')) && CORE_ASSET.exec(String(item.name))[1] === tag);
  if (!asset) throw new Error(`Release v${tag} 中没有找到核心包 Star-Owner-v${tag}-win-x64-core.zip。`);
  const checksumAsset = (release.assets || []).find((item) => item.name === `${asset.name}.sha256`);
  const digest = String(asset.digest || '').match(/^sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase() || '';
  return {
    id: release.id || tag,
    version: tag,
    name: release.name || `v${tag}`,
    publishedAt: release.published_at || '',
    url: release.html_url || `https://github.com/${REPOSITORY}/releases/tag/v${tag}`,
    checksumUrl: checksumAsset?.browser_download_url || '',
    checksum: digest,
    asset: { name: asset.name, url: asset.browser_download_url, size: Number(asset.size || 0) }
  };
}

async function inspectArchive(archive, cwd, tar = resolveSystemExecutable('tar.exe')) {
  if (!tar) throw new Error('Windows 系统缺少 tar.exe，无法检查更新包。');
  const listing = await runCommand(tar, ['-tf', archive], cwd);
  const verbose = await runCommand(tar, ['-tvf', archive], cwd);
  if (verbose.split(/\r?\n/).some((line) => /^[lh]/i.test(line.trim()))) throw new Error('更新包包含符号链接或硬链接，已拒绝安装。');
  const entries = listing.split(/\r?\n/).map((item) => item.replaceAll('\\', '/').replace(/\/$/, '')).filter(Boolean);
  return validateArchiveEntries(entries);
}

function validateArchiveEntries(entries = []) {
  if (!entries.length) throw new Error('更新包为空。');
  for (const entry of entries) {
    if (path.posix.isAbsolute(entry) || entry.split('/').includes('..')) throw new Error(`更新包包含不安全路径：${entry}`);
  }
  const packageEntry = entries.find((entry) => /(^|\/)package\.json$/i.test(entry));
  if (!packageEntry) throw new Error('更新包缺少 package.json。');
  const prefix = packageEntry.replace(/package\.json$/i, '').replace(/\/$/, '');
  const allowedPrefix = prefix ? `${prefix}/` : '';
  if (entries.some((entry) => allowedPrefix && entry !== prefix && !entry.startsWith(allowedPrefix))) throw new Error('更新包包含多个顶层目录，已拒绝安装。');
  return { entries, prefix };
}

function locatePackageRoot(stagingRoot, prefix) {
  const root = prefix ? path.join(stagingRoot, prefix) : stagingRoot;
  return path.resolve(root);
}

function validateStagedPackage(packageRoot, version) {
  const required = ['package.json', 'src/main.js', 'Start-StarOwner.cmd', 'node_modules/electron/dist/electron.exe'];
  for (const relative of required) if (!fs.existsSync(path.join(packageRoot, relative))) throw new Error(`更新包缺少必需文件：${relative}`);
  const packageJson = readJsonIfPresent(path.join(packageRoot, 'package.json'));
  if (String(packageJson?.version || '') !== String(version)) throw new Error(`更新包版本校验失败：期望 v${version}。`);
}

function readJsonIfPresent(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return null; }
}

function parseContentRange(value) {
  const match = String(value || '').match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
  return match ? { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) } : null;
}

function parseChecksumText(value) {
  const match = String(value || '').match(/\b([0-9a-f]{64})\b/i);
  return match ? match[1].toLowerCase() : '';
}

function compareVersions(left, right) {
  const a = String(left || '0.0.0').split('.').map((item) => Number(item) || 0);
  const b = String(right || '0.0.0').split('.').map((item) => Number(item) || 0);
  for (let index = 0; index < 3; index += 1) if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0) ? 1 : -1;
  return 0;
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  const normalized = process.platform === 'win32' ? relative.toLowerCase() : relative;
  return Boolean(normalized) && !normalized.startsWith('..') && !path.isAbsolute(relative);
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function runCommand(file, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (value) => { stdout += value; });
    child.stderr.on('data', (value) => { stderr += value; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`${file} exited ${code}: ${stderr || stdout}`.trim())));
  });
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

module.exports = { CORE_ASSET, MIN_MIGRATION_VERSION, REPOSITORY, UpdateManager, compareVersions, parseChecksumText, resolveCoreRelease, validateArchiveEntries, validateStagedPackage };
