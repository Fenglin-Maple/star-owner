const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { projectRuntimeEnvironment, resolveSystemExecutable } = require('./child-process-io');
const { ensureDir } = require('./workspace');

const REPOSITORY = 'Fenglin-Maple/star-owner';
const RELEASES_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const CORE_ASSET = /^Star-Owner-v([0-9]+\.[0-9]+\.[0-9]+)-win-x64-core\.zip$/i;
const MIN_MIGRATION_VERSION = '1.0.3';
const UPDATE_BACKUP_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const UPDATE_DOWNLOAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

class UpdateManager {
  constructor({ projectRoot, version, emit, fetchImpl = global.fetch, platform = process.platform, updaterHeadless = false, updaterDisableRelaunch = false } = {}) {
    this.projectRoot = path.resolve(projectRoot || process.cwd());
    this.version = String(version || '0.0.0');
    this.emit = emit || (() => {});
    this.fetchImpl = fetchImpl;
    this.platform = platform;
    this.updaterHeadless = Boolean(updaterHeadless);
    this.updaterDisableRelaunch = Boolean(updaterDisableRelaunch);
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
    this.cleanupArtifacts();
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
    this.cleanupArtifacts();
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
    this.cleanupArtifacts();
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
    this.cleanupArtifacts();
    this.publish({ status: 'ready', progress: 1, prepared: true, message: `v${release.version} 已下载并校验通过，等待重启安装` });
    return this.state();
  }

  async launchPreparedUpdate() {
    if (!this.prepared || !fs.existsSync(this.prepared.packageRoot)) throw new Error('没有可安装的已校验更新包，请重新检查更新。');
    validateStagedPackage(this.prepared.packageRoot, this.prepared.release.version);
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
    const running = findRunningProjectProcesses(source, { platform: this.platform });
    if (running.length) throw new Error(`检测到旧版应用仍在运行（PID ${running.map((item) => item.pid).join(', ')}）。请先停止旧版中的所有任务并完全退出旧应用，再重新迁移。`);
    return { sourceRoot: source, sourceWorkspace, database, oldVersion: oldVersion || '未知', portable: fs.existsSync(path.join(source, 'portable-manifest.json')) };
  }

  async launchMigration(sourceRoot) {
    const migration = this.inspectMigrationSource(sourceRoot);
    return this.launchOperation({ mode: 'migrate', sourceWorkspace: migration.sourceWorkspace, targetVersion: this.version });
  }

  async launchOperation({ mode, stagedRoot = '', sourceWorkspace = '', targetVersion = '' }) {
    if (this.platform !== 'win32') throw new Error('便携自动更新和迁移目前只支持 Windows。');
    const helperSource = mode === 'update' && stagedRoot
      ? path.join(path.resolve(stagedRoot), 'scripts', 'apply-portable-operation.ps1')
      : path.join(this.projectRoot, 'scripts', 'apply-portable-operation.ps1');
    const recoverySource = mode === 'update' && stagedRoot
      ? path.join(path.resolve(stagedRoot), 'scripts', 'recover-portable-operation.ps1')
      : path.join(this.projectRoot, 'scripts', 'recover-portable-operation.ps1');
    const updaterSource = path.join(this.projectRoot, 'tools', 'updater', 'StarOwnerUpdater.exe');
    const iconSource = path.join(this.projectRoot, 'assets', 'star-note.png');
    if (!fs.existsSync(helperSource)) throw new Error('更新事务脚本缺失，无法安全更新。');
    if (!fs.existsSync(recoverySource)) throw new Error('更新回退脚本缺失，无法安全更新。');
    if (!fs.existsSync(updaterSource)) throw new Error('独立更新器缺失，请手动安装完整核心包后重试。');
    if (!fs.existsSync(iconSource)) throw new Error('更新器应用图标缺失，无法启动更新界面。');
    if (mode === 'update' && !isInside(this.updateRoot, helperSource)) throw new Error('更新事务脚本不在受管暂存目录中。');
    if (fs.existsSync(path.join(this.updateRoot, 'operation-journal.json'))) throw new Error('检测到尚未恢复的更新事务，请重新启动应用完成回退后再试。');
    const operationId = `operation-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const requestFile = path.join(this.updateRoot, 'operation-request.json');
    const readyFile = path.join(this.updateRoot, `updater-ready-${operationId}.json`);
    const acknowledgeFile = path.join(this.updateRoot, `updater-ack-${operationId}.json`);
    const cancelFile = path.join(this.updateRoot, `updater-cancel-${operationId}.json`);
    const logFile = path.join(this.updateRoot, `updater-${operationId}.log`);
    const temporaryRoot = path.join(os.tmpdir(), 'StarOwner', 'updater', operationId);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    ensureDir(temporaryRoot);
    const updater = path.join(temporaryRoot, 'StarOwnerUpdater.exe');
    const helper = path.join(temporaryRoot, 'apply-portable-operation.ps1');
    const recovery = path.join(temporaryRoot, 'recover-portable-operation.ps1');
    const icon = path.join(temporaryRoot, 'star-note.png');
    fs.copyFileSync(updaterSource, updater);
    fs.copyFileSync(helperSource, helper);
    fs.copyFileSync(recoverySource, recovery);
    fs.copyFileSync(iconSource, icon);
    const powershell = resolveSystemExecutable('powershell.exe');
    const command = resolveSystemExecutable('cmd.exe');
    if (!powershell) throw new Error('Windows 系统缺少 PowerShell，无法执行更新或迁移。');
    if (!command) throw new Error('Windows 系统缺少命令处理器，无法在完成后重新启动应用。');
    for (const stale of [path.join(this.updateRoot, 'operation-result.json'), requestFile, readyFile, acknowledgeFile, cancelFile]) fs.rmSync(stale, { force: true });
    fs.writeFileSync(requestFile, `${JSON.stringify({
      operationId,
      mode,
      projectRoot: this.projectRoot,
      stagedRoot: stagedRoot ? path.resolve(stagedRoot) : '',
      sourceWorkspace: sourceWorkspace ? path.resolve(sourceWorkspace) : '',
      targetVersion,
      helperSource,
      processId: process.pid,
      updaterHelperPath: helper,
      updaterRecoveryPath: recovery,
      updaterPowerShellPath: powershell,
      updaterCommandPath: command,
      updaterReadyFile: readyFile,
      updaterAcknowledgeFile: acknowledgeFile,
      updaterCancelFile: cancelFile,
      updaterLogFile: logFile,
      updaterIconPath: icon,
      headless: this.updaterHeadless,
      disableRelaunch: this.updaterDisableRelaunch,
      requestedAt: new Date().toISOString()
    }, null, 2)}\n`, 'utf8');
    const child = spawn(updater, ['--request', requestFile], {
      cwd: temporaryRoot,
      detached: true,
      env: projectRuntimeEnvironment(process.env, this.projectRoot),
      windowsHide: false,
      stdio: 'ignore'
    });
    try {
      const ready = await waitForUpdaterReady({ child, readyFile, acknowledgeFile, operationId });
      child.unref();
      this.publish({
        status: 'applying',
        progress: 1,
        message: mode === 'update'
          ? '独立更新器已接管，应用即将退出；可在更新器中查看进度或中止并回退。'
          : '独立迁移器已接管，应用即将退出；可在迁移器中查看进度或中止并回退。'
      });
      return { scheduled: true, mode, targetVersion, operationId, updaterPid: ready.updaterPid };
    } catch (error) {
      try { child.kill(); } catch {}
      fs.rmSync(requestFile, { force: true });
      fs.rmSync(readyFile, { force: true });
      fs.rmSync(acknowledgeFile, { force: true });
      this.publish({ status: 'error', progress: 0, message: `独立更新器启动失败，应用不会退出：${error.message || error}` });
      throw error;
    }
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

  cleanupArtifacts() {
    return cleanupManagedUpdateArtifacts(this.updateRoot, { prepared: this.prepared });
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
  const normalizedEntries = [];
  const seen = new Set();
  for (const rawEntry of entries) {
    const entry = normalizeArchiveEntry(rawEntry);
    const identity = entry.toLowerCase();
    if (seen.has(identity)) throw new Error(`更新包包含 Windows 下会发生覆盖的重复路径：${entry}`);
    seen.add(identity);
    normalizedEntries.push(entry);
  }
  const packageEntry = normalizedEntries.find((entry) => /(^|\/)package\.json$/i.test(entry));
  if (!packageEntry) throw new Error('更新包缺少 package.json。');
  const prefix = packageEntry.replace(/package\.json$/i, '').replace(/\/$/, '');
  const allowedPrefix = prefix ? `${prefix}/` : '';
  if (normalizedEntries.some((entry) => allowedPrefix && entry !== prefix && !entry.startsWith(allowedPrefix))) throw new Error('更新包包含多个顶层目录，已拒绝安装。');
  return { entries: normalizedEntries, prefix };
}

function normalizeArchiveEntry(rawEntry) {
  if (typeof rawEntry !== 'string' || !rawEntry) throw new Error('更新包包含空路径条目。');
  if (/[\x00-\x1f\x7f]/.test(rawEntry)) throw new Error('更新包包含控制字符路径，已拒绝安装。');
  const normalized = rawEntry.replaceAll('\\', '/').replace(/\/+$/, '');
  if (!normalized || path.posix.isAbsolute(normalized) || /^[a-z]:/i.test(normalized) || normalized.startsWith('//')) {
    throw new Error(`更新包包含 Win32 绝对路径或设备路径：${rawEntry}`);
  }
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') throw new Error(`更新包包含不安全路径段：${rawEntry}`);
    if (segment.includes(':')) throw new Error(`更新包包含 NTFS 数据流或盘符路径：${rawEntry}`);
    if (/[. ]$/.test(segment)) throw new Error(`更新包包含 Windows 下不稳定的尾随字符路径：${rawEntry}`);
    const deviceName = segment.split('.')[0].toUpperCase();
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(deviceName)) throw new Error(`更新包包含 Windows 保留设备名：${rawEntry}`);
  }
  return normalized;
}

function locatePackageRoot(stagingRoot, prefix) {
  const root = prefix ? path.join(stagingRoot, prefix) : stagingRoot;
  return path.resolve(root);
}

function validateStagedPackage(packageRoot, version) {
  const required = [
    'package.json',
    'package-lock.json',
    'portable-manifest.json',
    'src/main.js',
    'Start-StarOwner.cmd',
    'scripts/apply-portable-operation.ps1',
    'scripts/recover-portable-operation.ps1',
    'tools/updater/StarOwnerUpdater.cs',
    'tools/updater/StandaloneUpdater.cs',
    'tools/updater/StarOwnerUpdater.exe',
    'tools/updater/build-updater.ps1',
    'tools/faster-whisper-cli.py',
    'node_modules/electron/dist/electron.exe',
    'node_modules/mammoth/package.json',
    'node_modules/pdf-parse/package.json',
    'node_modules/sql.js/package.json',
    'node_modules/mermaid/dist/mermaid.min.js',
    'runtime/git/cmd/git.exe',
    'runtime/python',
    'runtime/faster-whisper/Scripts/python.exe',
    'runtime/faster-whisper/Lib/site-packages/faster_whisper',
    'runtime/faster-whisper/Lib/site-packages/yt_dlp',
    'runtime/faster-whisper/Lib/site-packages/imageio_ffmpeg/binaries',
    'runtime/vc-runtime/concrt140.dll',
    'runtime/vc-runtime/msvcp140.dll',
    'runtime/vc-runtime/msvcp140_codecvt_ids.dll',
    'runtime/vc-runtime/vcruntime140.dll',
    'runtime/vc-runtime/vcruntime140_1.dll'
  ];
  for (const relative of required) if (!fs.existsSync(path.join(packageRoot, relative))) throw new Error(`更新包缺少必需文件：${relative}`);
  const packageJson = readJsonIfPresent(path.join(packageRoot, 'package.json'));
  const packageLock = readJsonIfPresent(path.join(packageRoot, 'package-lock.json'));
  const manifest = readJsonIfPresent(path.join(packageRoot, 'portable-manifest.json'));
  if (packageJson?.name !== 'star-owner') throw new Error('更新包 package.json 的应用标识不正确。');
  if (String(packageJson?.version || '') !== String(version)) throw new Error(`更新包版本校验失败：期望 v${version}。`);
  if (!/^\d+\.\d+\.\d+$/.test(String(packageJson?.dependencyReleaseVersion || ''))) throw new Error('更新包缺少有效的依赖基线版本。');
  if (String(packageLock?.version || '') !== String(version) || String(packageLock?.packages?.['']?.version || '') !== String(version)) {
    throw new Error('更新包 package-lock.json 与应用版本不一致。');
  }
  if (String(manifest?.version || '') !== String(version)) throw new Error(`更新包 portable-manifest.json 版本校验失败：期望 v${version}。`);
  if (String(manifest?.platform || '') !== 'win-x64') throw new Error('更新包平台不是受支持的 win-x64。');
  if (String(manifest?.dependencyReleaseVersion || '') !== String(packageJson.dependencyReleaseVersion)) throw new Error('更新包依赖基线与 portable manifest 不一致。');
  if (String(manifest?.launcher || '') !== 'Start-StarOwner.cmd') throw new Error('更新包 portable manifest 的启动器声明不正确。');

  const basePythonRoot = path.join(packageRoot, 'runtime', 'python');
  const hasBasePython = fs.readdirSync(basePythonRoot, { withFileTypes: true }).some((entry) => (
    entry.isDirectory() && fs.existsSync(path.join(basePythonRoot, entry.name, process.platform === 'win32' ? 'python.exe' : 'bin/python'))
  ));
  if (!hasBasePython) throw new Error('更新包缺少项目内置基础 Python。');
  const ffmpegRoot = path.join(packageRoot, 'runtime', 'faster-whisper', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries');
  const hasFfmpeg = fs.readdirSync(ffmpegRoot, { withFileTypes: true }).some((entry) => entry.isFile() && /^ffmpeg-.*\.exe$/i.test(entry.name));
  if (!hasFfmpeg) throw new Error('更新包缺少项目内置 FFmpeg。');
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

function findRunningProjectProcesses(projectRoot, options = {}) {
  if ((options.platform || process.platform) !== 'win32') return [];
  const powershell = options.powershell || resolveSystemExecutable('powershell.exe');
  if (!powershell) throw new Error('无法确认旧版应用是否仍在运行：Windows PowerShell 不可用。');
  const script = [
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    "$names = @('electron.exe', 'node.exe')",
    'Get-CimInstance Win32_Process | Where-Object { $names -contains ([string]$_.Name).ToLowerInvariant() } | ForEach-Object {',
    '  if ($_.CommandLine) { "{0}`t{1}`t{2}" -f $_.ProcessId, $_.Name, ($_.CommandLine -replace "`r|`n", " ") }',
    '}'
  ].join('; ');
  const runner = options.spawnSyncImpl || spawnSync;
  const result = runner(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || String(result.stderr || result.stdout || '').trim() || `exit ${result.status}`;
    throw new Error(`无法确认旧版应用是否仍在运行：${detail}`);
  }
  const currentPid = Number(options.currentPid || process.pid);
  return String(result.stdout || '').split(/\r?\n/).map((line) => {
    const [pid, name, ...command] = line.split('\t');
    return { pid: Number(pid), name: String(name || ''), commandLine: command.join('\t') };
  }).filter((item) => Number.isInteger(item.pid) && item.pid > 0 && item.pid !== currentPid && commandLineContainsProjectRoot(item.commandLine, projectRoot));
}

function commandLineContainsProjectRoot(commandLine, projectRoot) {
  const command = normalizeWindowsText(commandLine);
  const root = normalizeWindowsText(path.resolve(projectRoot)).replace(/\\+$/, '');
  if (!command || !root) return false;
  let offset = command.indexOf(root);
  while (offset >= 0) {
    const before = offset > 0 ? command[offset - 1] : '';
    const after = command[offset + root.length] || '';
    const leftBoundary = !before || /[\s"'=]/.test(before);
    const rightBoundary = !after || /[\\/"']/.test(after) || (!/["']/.test(before) && /\s/.test(after));
    if (leftBoundary && rightBoundary) return true;
    offset = command.indexOf(root, offset + 1);
  }
  return false;
}

function normalizeWindowsText(value) {
  return String(value || '').trim().toLowerCase().replaceAll('/', '\\');
}

function cleanupManagedUpdateArtifacts(updateRoot, options = {}) {
  const root = path.resolve(updateRoot);
  ensureDir(root);
  const now = Number(options.now || Date.now());
  const journal = readJsonIfPresent(path.join(root, 'operation-journal.json'));
  const request = readJsonIfPresent(path.join(root, 'operation-request.json'));
  const result = readJsonIfPresent(path.join(root, 'operation-result.json'));
  const requestActive = Boolean(request && (!result || String(result.operationId || '') !== String(request.operationId || '')));
  const protectedPaths = new Set();
  const protect = (candidate) => {
    if (!candidate) return;
    const resolved = path.resolve(String(candidate));
    if (isInside(root, resolved)) protectedPaths.add(pathKey(resolved));
  };
  protect(journal?.backup);
  protect(journal?.stagedRoot);
  if (requestActive) {
    protect(request?.stagedRoot);
    protect(request?.helperSource);
  }
  if (['rollback-failed', 'recovery-failed'].includes(String(result?.status || ''))) protect(result?.backup);
  protect(options.prepared?.archive);
  protect(options.prepared?.stagingRoot);
  protect(options.prepared?.packageRoot);

  const removed = [];
  const directEntries = fs.readdirSync(root, { withFileTypes: true }).map((entry) => managedEntry(root, entry.name)).filter(Boolean);
  const staging = directEntries.filter((entry) => /^staging-v\d+\.\d+\.\d+$/i.test(entry.name));
  for (const entry of staging) {
    if (!protectedPaths.has(pathKey(entry.path)) && !journal && !requestActive) removeManagedEntry(root, entry, removed);
  }

  const backups = directEntries.filter((entry) => /^operation-backup-[a-z0-9._-]+$/i.test(entry.name)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  let retainedBackups = 0;
  for (const entry of backups) {
    if (protectedPaths.has(pathKey(entry.path))) continue;
    const retain = retainedBackups < 2 && now - entry.mtimeMs <= UPDATE_BACKUP_RETENTION_MS;
    if (retain) retainedBackups += 1;
    else removeManagedEntry(root, entry, removed);
  }

  const downloads = ensureDir(path.join(root, 'downloads'));
  const downloadEntries = fs.readdirSync(downloads, { withFileTypes: true }).map((entry) => managedEntry(downloads, entry.name)).filter(Boolean);
  cleanupDownloadGroup(downloads, downloadEntries.filter((entry) => CORE_ASSET.test(entry.name)), 2, UPDATE_DOWNLOAD_RETENTION_MS, now, protectedPaths, removed);
  cleanupDownloadGroup(downloads, downloadEntries.filter((entry) => CORE_ASSET.test(entry.name.replace(/\.partial$/i, '')) && /\.partial$/i.test(entry.name)), 1, UPDATE_DOWNLOAD_RETENTION_MS, now, protectedPaths, removed);
  return { removed, retainedBackups, activeOperation: Boolean(journal || requestActive) };
}

function cleanupDownloadGroup(root, entries, maximum, maximumAge, now, protectedPaths, removed) {
  let retained = 0;
  for (const entry of entries.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    if (protectedPaths.has(pathKey(entry.path))) continue;
    const keep = retained < maximum && now - entry.mtimeMs <= maximumAge;
    if (keep) retained += 1;
    else removeManagedEntry(root, entry, removed);
  }
}

function managedEntry(root, name) {
  const candidate = path.resolve(root, String(name || ''));
  if (path.dirname(candidate) !== path.resolve(root)) return null;
  try {
    const stat = fs.lstatSync(candidate);
    return { name: path.basename(candidate), path: candidate, mtimeMs: stat.mtimeMs, isLink: stat.isSymbolicLink() };
  } catch {
    return null;
  }
}

function removeManagedEntry(root, entry, removed) {
  if (!entry || path.dirname(path.resolve(entry.path)) !== path.resolve(root)) throw new Error('拒绝清理不属于更新缓存根目录的路径。');
  if (entry.isLink) fs.unlinkSync(entry.path);
  else fs.rmSync(entry.path, { recursive: true, force: true });
  removed.push(entry.path);
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
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
    const child = spawn(file, args, { cwd, env: projectRuntimeEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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

function waitForUpdaterReady({ child, readyFile, acknowledgeFile = '', operationId, timeoutMs = 15000, pollMs = 80 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let deadline = null;
    let acknowledged = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      if (deadline) clearTimeout(deadline);
      child?.removeListener?.('error', onError);
      child?.removeListener?.('exit', onExit);
      callback(value);
    };
    const onError = (error) => finish(reject, new Error(`无法启动独立更新器：${error.message || error}`));
    const onExit = (code, signal) => finish(reject, new Error(`独立更新器在接管前退出（code=${code ?? 'null'}, signal=${signal || 'none'}）。`));
    const inspect = () => {
      const ready = readJsonIfPresent(readyFile);
      if (String(ready?.operationId || '') !== String(operationId || '')) return;
      if (!Number.isInteger(Number(ready.updaterPid)) || Number(ready.updaterPid) <= 0) return;
      if (acknowledgeFile) {
        if (ready.status === 'ready' && !acknowledged) {
          try {
            const temporary = `${acknowledgeFile}.tmp-${process.pid}`;
            fs.writeFileSync(temporary, `${JSON.stringify({ operationId, status: 'acknowledged', acknowledgedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
            fs.renameSync(temporary, acknowledgeFile);
            acknowledged = true;
          } catch (error) {
            finish(reject, new Error(`无法确认独立更新器接管：${error.message || error}`));
          }
          return;
        }
        if (ready.status !== 'accepted') return;
      } else if (ready.status !== 'ready' && ready.status !== 'accepted') return;
      finish(resolve, ready);
    };
    child?.once?.('error', onError);
    child?.once?.('exit', onExit);
    timer = setInterval(inspect, Math.max(20, Number(pollMs) || 80));
    deadline = setTimeout(() => finish(reject, new Error('独立更新器启动超时，原应用已保持运行。')), Math.max(100, Number(timeoutMs) || 15000));
    inspect();
  });
}

module.exports = {
  CORE_ASSET,
  MIN_MIGRATION_VERSION,
  REPOSITORY,
  UpdateManager,
  cleanupManagedUpdateArtifacts,
  commandLineContainsProjectRoot,
  compareVersions,
  findRunningProjectProcesses,
  parseChecksumText,
  resolveCoreRelease,
  validateArchiveEntries,
  validateStagedPackage,
  waitForUpdaterReady
};
