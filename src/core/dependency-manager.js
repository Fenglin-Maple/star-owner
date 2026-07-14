const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { recoverAtomicFile, writeFileRecoverable } = require('./atomic-file');
const { ensureDir } = require('./workspace');

const REPOSITORY = 'Fenglin-Maple/star-owner';

class DependencyManager {
  constructor({ store, projectRoot, version, emit, onInstalled, acquireInstall }) {
    this.store = store;
    this.projectRoot = path.resolve(projectRoot);
    this.version = version;
    this.emit = emit || (() => {});
    this.onInstalled = onInstalled || (async () => {});
    this.acquireInstall = acquireInstall || (async () => async () => {});
    this.downloadRoot = ensureDir(path.join(this.projectRoot, 'runtime', '.downloads'));
    this.progress = new Map();
    this.pendingPackages = new Map();
    this.queue = Promise.resolve();
    this.installJournal = path.join(this.projectRoot, 'runtime', '.install-transaction.json');
    this.recovery = this.recoverInterruptedInstall();
  }

  definitions() {
    return [
      {
        id: 'runtime-base',
        name: '媒体与 ASR 基础运行时',
        description: '项目内 Python、Microsoft VC++、faster-whisper、CTranslate2、FFmpeg、yt-dlp 与 CUDA 运行库。',
        required: true,
        assetName: `Star-Owner-v${this.version}-runtime-win-x64.zip`,
        assetPattern: /Star-Owner-v[\d.]+-runtime-win-x64\.zip$/i,
        fallbackAssetPattern: /Star-Owner-v[\d.]+-win-x64-core\.zip$/i,
        probes: [
          'runtime/python/cpython-3.12.13-windows-x86_64-none/python.exe',
          'runtime/faster-whisper/Lib/site-packages/faster_whisper',
          'runtime/faster-whisper/Lib/site-packages/yt_dlp',
          'runtime/vc-runtime/msvcp140.dll'
        ]
      },
      {
        id: 'model-small',
        name: 'faster-whisper small 模型',
        description: '内置轻量多语言 ASR 模型，速度更快、显存占用更低。',
        required: true,
        assetName: `Star-Owner-v${this.version}-model-small.zip`,
        assetPattern: /Star-Owner-v[\d.]+-model-small\.zip$/i,
        probes: ['runtime/models/small/model.bin', 'runtime/models/small/config.json']
      },
      {
        id: 'model-medium',
        name: 'faster-whisper medium 模型',
        description: '默认内置多语言 ASR 模型，在准确率、速度和 8GB 显存之间更均衡。',
        required: true,
        assetName: `Star-Owner-v${this.version}-model-medium.zip`,
        assetPattern: /Star-Owner-v[\d.]+-model-medium\.zip$/i,
        probes: ['runtime/models/medium/model.bin', 'runtime/models/medium/config.json']
      }
    ];
  }

  state() {
    const packages = this.definitions().map((definition) => {
      const progress = this.progress.get(definition.id) || {};
      const available = definition.probes.every((probe) => fs.existsSync(path.join(this.projectRoot, probe)));
      return {
        ...definition,
        available,
        status: progress.status || (available ? 'available' : 'missing'),
        progress: Number(progress.progress || (available ? 1 : 0)),
        downloadedBytes: Number(progress.downloadedBytes || 0),
        totalBytes: Number(progress.totalBytes || 0),
        message: progress.message || (available ? '已安装并通过路径检查' : '未检测到完整依赖'),
        source: progress.source || ''
      };
    });
    const prompt = this.store.get('settings', 'dependencyPrompt') || {};
    const missingRequired = packages.filter((item) => item.required && !item.available);
    return {
      repository: `https://github.com/${REPOSITORY}`,
      releasePage: `https://github.com/${REPOSITORY}/releases`,
      packages,
      missingRequired: missingRequired.map((item) => item.id),
      ready: missingRequired.length === 0,
      needsPrompt: missingRequired.length > 0 && prompt.version !== this.version,
      promptVersion: prompt.version || '',
      recovery: this.recovery || { recovered: false }
    };
  }

  acknowledgePrompt(download) {
    this.store.set('settings', 'dependencyPrompt', { id: 'dependencyPrompt', version: this.version, download: Boolean(download), acknowledgedAt: new Date().toISOString() });
    this.store.save();
    return this.state();
  }

  async downloadRequired() {
    const required = this.state().packages.filter((item) => item.required && !item.available).map((item) => item.id);
    const results = [];
    for (const id of required) results.push(await this.download(id));
    return { results, state: this.state() };
  }

  download(packageId) {
    const id = String(packageId || '');
    if (this.pendingPackages.has(id)) return this.pendingPackages.get(id);
    const pending = this.enqueue(async () => {
      try { return await this.downloadNow(packageId); }
      catch (error) {
        const installed = this.state().packages.find((item) => item.id === id)?.available;
        this.update(packageId, {
          status: installed ? 'available' : 'failed',
          progress: installed ? 1 : undefined,
          message: installed ? `依赖已安装，但安装后的服务刷新失败：${error.message || String(error)}` : (error.message || String(error))
        });
        throw error;
      }
    }).finally(() => this.pendingPackages.delete(id));
    this.pendingPackages.set(id, pending);
    return pending;
  }

  enqueue(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }

  async downloadNow(packageId) {
    const definition = this.definitions().find((item) => item.id === packageId);
    if (!definition) throw new Error(`未知依赖包：${packageId}`);
    this.update(definition.id, { status: 'resolving', progress: 0.01, message: '正在查询 GitHub Release 资源' });
    const release = await this.resolveReleaseAsset(definition);
    const archive = path.join(this.downloadRoot, release.asset.name);
    const partial = `${archive}.partial`;
    this.update(definition.id, { status: 'downloading', source: release.asset.browser_download_url, progress: 0.02, message: `正在下载 ${release.asset.name}` });
    try {
      await this.downloadFile(release.asset.browser_download_url, partial, definition.id);
    } catch (error) {
      if (fs.existsSync(partial)) fs.rmSync(partial, { force: true });
      throw error;
    }
    if (fs.existsSync(archive)) fs.rmSync(archive, { force: true });
    fs.renameSync(partial, archive);
    this.update(definition.id, { status: 'verifying', progress: 0.9, message: '正在校验 SHA-256' });
    const checksum = await this.fetchChecksum(release, release.asset.name);
    const actual = await sha256(archive);
    if (!checksum) {
      fs.rmSync(archive, { force: true });
      throw new Error(`Release 缺少有效的 ${release.asset.name}.sha256，已拒绝安装未校验依赖包。`);
    }
    if (checksum !== actual) {
      fs.rmSync(archive, { force: true });
      throw new Error(`依赖包 SHA-256 不匹配：${actual}`);
    }
    let releaseInstall = null;
    try {
      releaseInstall = await this.acquireInstall(definition.id, () => {
        this.update(definition.id, { status: 'waiting-install', progress: 0.92, message: '下载与校验已完成，正在等待 Agent 工具与 ASR 队列空闲' });
      });
      this.update(definition.id, { status: 'installing', progress: 0.93, message: '资源窗口已锁定，正在安装' });
      await this.extractArchive(archive, definition, release.fallback);
      const available = definition.probes.every((probe) => fs.existsSync(path.join(this.projectRoot, probe)));
      if (!available) throw new Error(`依赖包已解压，但缺少预期文件：${definition.probes.join(', ')}`);
      this.update(definition.id, { status: 'available', progress: 1, message: '安装完成', downloadedBytes: release.asset.size, totalBytes: release.asset.size });
    } finally {
      await releaseInstall?.();
    }
    try {
      await this.onInstalled(definition.id);
    } finally {
      fs.rmSync(archive, { force: true });
    }
    return { id: definition.id, checksum, state: this.state() };
  }

  async resolveReleaseAsset(definition) {
    const candidates = [];
    for (const url of [
      `https://api.github.com/repos/${REPOSITORY}/releases/tags/v${this.version}`,
      `https://api.github.com/repos/${REPOSITORY}/releases/latest`
    ]) {
      try {
        const response = await fetch(url, { headers: githubHeaders(), signal: AbortSignal.timeout(30000) });
        if (response.ok) candidates.push(await response.json());
      } catch { /* try the next release source */ }
    }
    try {
      const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=10`, { headers: githubHeaders(), signal: AbortSignal.timeout(30000) });
      if (response.ok) {
        const known = new Set(candidates.map((release) => String(release.id || release.tag_name || '')));
        for (const release of await response.json()) {
          const key = String(release.id || release.tag_name || '');
          if (!key || !known.has(key)) candidates.push(release);
          if (key) known.add(key);
        }
      }
    } catch { /* handled below */ }
    for (const release of candidates) {
      const assets = Array.isArray(release.assets) ? release.assets : [];
      const asset = assets.find((item) => item.name === definition.assetName) || assets.find((item) => definition.assetPattern.test(item.name));
      if (asset) return { release, asset, fallback: false };
      const fallback = definition.fallbackAssetPattern && assets.find((item) => definition.fallbackAssetPattern.test(item.name));
      if (fallback) return { release, asset: fallback, fallback: true };
    }
    throw new Error(`GitHub Release 中未找到 ${definition.assetName}。请由发布者上传对应依赖资产。`);
  }

  async fetchChecksum(resolved, assetName) {
    const checksumAsset = (resolved.release.assets || []).find((item) => item.name === `${assetName}.sha256`);
    if (!checksumAsset) return '';
    const response = await fetch(checksumAsset.browser_download_url, { headers: githubHeaders(), signal: AbortSignal.timeout(30000) });
    if (!response.ok) return '';
    return (await response.text()).match(/[0-9a-f]{64}/i)?.[0]?.toLowerCase() || '';
  }

  async downloadFile(url, target, packageId) {
    const response = await fetch(url, { headers: githubHeaders(), redirect: 'follow', signal: AbortSignal.timeout(6 * 60 * 60 * 1000) });
    if (!response.ok || !response.body) throw new Error(`依赖下载失败 (${response.status})`);
    const total = Number(response.headers.get('content-length') || 0);
    let downloaded = 0;
    const manager = this;
    let lastProgressAt = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        downloaded += chunk.length;
        if (Date.now() - lastProgressAt >= 200 || (total && downloaded >= total)) {
          lastProgressAt = Date.now();
          const fraction = total ? downloaded / total : Math.min(0.85, 0.08 + Math.log10(1 + downloaded) * 0.06);
          manager.update(packageId, { status: 'downloading', progress: Math.min(0.88, 0.03 + fraction * 0.85), downloadedBytes: downloaded, totalBytes: total, message: total ? `已下载 ${formatBytes(downloaded)} / ${formatBytes(total)}` : `已下载 ${formatBytes(downloaded)}` });
        }
        callback(null, chunk);
      }
    });
    await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(target));
  }

  async extractArchive(archive, definition, fallback = false) {
    const listing = await run('tar.exe', ['-tf', archive], this.projectRoot);
    const verboseListing = await run('tar.exe', ['-tvf', archive], this.projectRoot);
    if (verboseListing.split(/\r?\n/).some((line) => /^[lh]/i.test(line.trim()))) {
      throw new Error('依赖包包含符号链接或硬链接，已拒绝解压。');
    }
    const entries = listing.split(/\r?\n/).filter(Boolean);
    for (const entry of entries) {
      const normalized = entry.replaceAll('\\', '/');
      if (path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) throw new Error(`依赖包包含不安全路径：${entry}`);
      if (!fallback && !normalized.startsWith('runtime/')) throw new Error(`依赖包包含非 runtime 路径：${entry}`);
    }
    const stagingRoot = path.join(this.projectRoot, 'runtime', `.install-staging-${definition.id}-${crypto.randomBytes(4).toString('hex')}`);
    ensureDir(stagingRoot);
    try {
      if (fallback) {
        const normalized = entries.map((entry) => entry.replaceAll('\\', '/'));
        const pythonEntry = normalized.find((entry) => /(^|\/)runtime\/python(?:\/|$)/.test(entry));
        const whisperEntry = normalized.find((entry) => /(^|\/)runtime\/faster-whisper(?:\/|$)/.test(entry));
        if (!pythonEntry || !whisperEntry) throw new Error('兼容核心包中未找到完整的 runtime/python 与 runtime/faster-whisper。');
        const prefix = pythonEntry.match(/^(.*?)(?=runtime\/python(?:\/|$))/)?.[1] || '';
        if (!whisperEntry.startsWith(`${prefix}runtime/faster-whisper`)) throw new Error('兼容核心包的 runtime 目录层级不一致。');
        const strip = prefix.split('/').filter(Boolean).length;
        const args = ['-xf', archive, '-C', stagingRoot];
        if (strip) args.push('--strip-components', String(strip));
        args.push(`${prefix}runtime/python`, `${prefix}runtime/faster-whisper`);
        await run('tar.exe', args, this.projectRoot);
      } else {
        await run('tar.exe', ['-xf', archive, '-C', stagingRoot], this.projectRoot);
      }
      this.installStagedRuntime(stagingRoot, definition);
    } finally {
      if (fs.existsSync(stagingRoot)) fs.rmSync(stagingRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    }
    this.update(definition.id, { status: 'installing', progress: 0.98, message: fallback ? '已从兼容核心包提取运行时，正在检查' : '正在检查安装结果' });
  }

  update(id, patch) {
    const current = this.progress.get(id) || {};
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.progress.set(id, next);
    this.emit({ type: 'dependency-progress', packageId: id, package: { id, ...next }, state: this.state() });
  }

  installStagedRuntime(stagingRoot, definition) {
    const relativePaths = managedRuntimePaths(definition.id).filter((relative) => fs.existsSync(path.join(stagingRoot, relative)));
    if (!relativePaths.length) throw new Error(`Dependency archive did not contain an installable payload for ${definition.id}.`);
    const backupRoot = path.join(this.projectRoot, 'runtime', `.install-backup-${definition.id}-${crypto.randomBytes(4).toString('hex')}`);
    const entries = relativePaths.map((relative) => ({
      relative,
      source: path.join(stagingRoot, relative),
      target: path.join(this.projectRoot, relative),
      backup: path.join(backupRoot, relative),
      hadOriginal: fs.existsSync(path.join(this.projectRoot, relative))
    }));
    const journal = { id: definition.id, stagingRoot, backupRoot, entries, createdAt: new Date().toISOString() };
    writeFileRecoverable(this.installJournal, Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, 'utf8'));
    try {
      for (const entry of entries) {
        ensureDir(path.dirname(entry.target));
        if (entry.hadOriginal) {
          ensureDir(path.dirname(entry.backup));
          movePath(entry.target, entry.backup);
        }
        movePath(entry.source, entry.target);
      }
      if (fs.existsSync(backupRoot)) fs.rmSync(backupRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
      fs.rmSync(this.installJournal, { force: true });
      fs.rmSync(`${this.installJournal}.bak`, { force: true });
      fs.rmSync(`${this.installJournal}.tmp`, { force: true });
    } catch (error) {
      this.rollbackInstall(journal);
      throw error;
    }
  }

  recoverInterruptedInstall() {
    recoverAtomicFile(this.installJournal);
    if (!fs.existsSync(this.installJournal)) return { recovered: false };
    let journal;
    try {
      journal = JSON.parse(fs.readFileSync(this.installJournal, 'utf8'));
      validateInstallJournal(journal);
    } catch (error) {
      const quarantined = this.quarantineInstallJournal();
      return {
        recovered: false,
        warning: `依赖安装恢复记录损坏，已隔离并继续启动：${error.message}`,
        quarantined
      };
    }
    this.rollbackInstall(journal);
    return { recovered: true, packageId: journal.id || '' };
  }

  quarantineInstallJournal() {
    const suffix = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(path.dirname(this.installJournal), `.install-transaction.corrupt-${suffix}.json`);
    fs.renameSync(this.installJournal, target);
    for (const extension of ['.bak', '.tmp']) {
      const source = `${this.installJournal}${extension}`;
      if (fs.existsSync(source)) fs.renameSync(source, `${target}${extension}`);
    }
    return target;
  }

  rollbackInstall(journal = {}) {
    for (const entry of [...(journal.entries || [])].reverse()) {
      const target = assertInstallPath(this.projectRoot, entry.target);
      const backup = assertInstallPath(this.projectRoot, entry.backup);
      if (entry.hadOriginal) {
        if (fs.existsSync(backup)) {
          if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
          ensureDir(path.dirname(target));
          movePath(backup, target);
        }
      } else if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
      }
    }
    for (const directory of [journal.backupRoot, journal.stagingRoot]) {
      if (!directory) continue;
      const safe = assertInstallPath(this.projectRoot, directory);
      if (fs.existsSync(safe)) fs.rmSync(safe, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    }
    fs.rmSync(this.installJournal, { force: true });
    fs.rmSync(`${this.installJournal}.bak`, { force: true });
    fs.rmSync(`${this.installJournal}.tmp`, { force: true });
  }
}

function managedRuntimePaths(packageId) {
  if (packageId === 'runtime-base') return ['runtime/python', 'runtime/faster-whisper', 'runtime/vc-runtime'];
  if (packageId === 'model-small') return ['runtime/models/small'];
  if (packageId === 'model-medium') return ['runtime/models/medium'];
  return [];
}

function validateInstallJournal(journal) {
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)) throw new Error('journal root must be an object');
  if (!Array.isArray(journal.entries) || !journal.entries.length) throw new Error('journal entries are missing');
  for (const entry of journal.entries) {
    if (!entry || typeof entry !== 'object' || !entry.target || !entry.backup) throw new Error('journal contains an invalid install entry');
  }
}

function assertInstallPath(projectRoot, value) {
  const runtimeRoot = path.resolve(projectRoot, 'runtime');
  const target = path.resolve(String(value || ''));
  const relative = path.relative(runtimeRoot, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Refusing dependency install operation outside the project runtime: ${target}`);
  return target;
}

function movePath(source, destination) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120 * (attempt + 1));
    }
  }
  throw lastError;
}

function githubHeaders() {
  return { accept: 'application/vnd.github+json', 'user-agent': 'star-owner-dependency-manager' };
}

function run(file, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`${file} exited ${code}: ${stderr || stdout}`.trim())));
  });
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

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

module.exports = { DependencyManager, REPOSITORY };
