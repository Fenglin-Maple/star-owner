const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ensureDir } = require('./workspace');

const REPOSITORY = 'Fenglin-Maple/star-owner';

class DependencyManager {
  constructor({ store, projectRoot, version, emit, onInstalled }) {
    this.store = store;
    this.projectRoot = path.resolve(projectRoot);
    this.version = version;
    this.emit = emit || (() => {});
    this.onInstalled = onInstalled || (async () => {});
    this.downloadRoot = ensureDir(path.join(this.projectRoot, 'runtime', '.downloads'));
    this.progress = new Map();
    this.queue = Promise.resolve();
  }

  definitions() {
    return [
      {
        id: 'runtime-base',
        name: '媒体与 ASR 基础运行时',
        description: '项目内 Python、faster-whisper、CTranslate2、FFmpeg、yt-dlp 与 CUDA 运行库。',
        required: true,
        assetName: `Star-Owner-v${this.version}-runtime-win-x64.zip`,
        assetPattern: /Star-Owner-v[\d.]+-runtime-win-x64\.zip$/i,
        fallbackAssetPattern: /Star-Owner-v[\d.]+-win-x64-core\.zip$/i,
        probes: [
          'runtime/python/cpython-3.12.13-windows-x86_64-none/python.exe',
          'runtime/faster-whisper/Lib/site-packages/faster_whisper'
        ]
      },
      {
        id: 'model-small',
        name: 'faster-whisper small 模型',
        description: '内置轻量多语言 ASR 模型，速度更快、显存占用更低。',
        required: true,
        assetName: `Star-Owner-v${this.version}-model-small.zip`,
        assetPattern: /Star-Owner-v[\d.]+-model-small\.zip$/i,
        probes: ['runtime/models/small/model.bin']
      },
      {
        id: 'model-medium',
        name: 'faster-whisper medium 模型',
        description: '默认内置多语言 ASR 模型，在准确率、速度和 8GB 显存之间更均衡。',
        required: true,
        assetName: `Star-Owner-v${this.version}-model-medium.zip`,
        assetPattern: /Star-Owner-v[\d.]+-model-medium\.zip$/i,
        probes: ['runtime/models/medium/model.bin']
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
      promptVersion: prompt.version || ''
    };
  }

  acknowledgePrompt(download) {
    this.store.set('settings', 'dependencyPrompt', { id: 'dependencyPrompt', version: this.version, download: Boolean(download), acknowledgedAt: new Date().toISOString() });
    this.store.save();
    return this.state();
  }

  downloadRequired() {
    const required = this.state().packages.filter((item) => item.required && !item.available).map((item) => item.id);
    return this.enqueue(async () => {
      const results = [];
      for (const id of required) {
        try { results.push(await this.downloadNow(id)); }
        catch (error) { this.update(id, { status: 'failed', message: error.message || String(error) }); throw error; }
      }
      return { results, state: this.state() };
    });
  }

  download(packageId) {
    return this.enqueue(async () => {
      try { return await this.downloadNow(packageId); }
      catch (error) { this.update(packageId, { status: 'failed', message: error.message || String(error) }); throw error; }
    });
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
    if (checksum && checksum !== actual) throw new Error(`依赖包 SHA-256 不匹配：${actual}`);
    this.update(definition.id, { status: 'installing', progress: 0.93, message: checksum ? '校验通过，正在安装' : 'Release 未提供校验文件，正在安装' });
    await this.extractArchive(archive, definition, release.fallback);
    const available = definition.probes.every((probe) => fs.existsSync(path.join(this.projectRoot, probe)));
    if (!available) throw new Error(`依赖包已解压，但缺少预期文件：${definition.probes.join(', ')}`);
    this.update(definition.id, { status: 'available', progress: 1, message: '安装完成', downloadedBytes: release.asset.size, totalBytes: release.asset.size });
    await this.onInstalled(definition.id);
    return { id: definition.id, archive, checksum: checksum || actual, state: this.state() };
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
    if (!candidates.length) {
      try {
        const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=10`, { headers: githubHeaders(), signal: AbortSignal.timeout(30000) });
        if (response.ok) candidates.push(...await response.json());
      } catch { /* handled below */ }
    }
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
    const response = await fetch(url, { headers: githubHeaders(), redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`依赖下载失败 (${response.status})`);
    const total = Number(response.headers.get('content-length') || 0);
    const file = fs.createWriteStream(target);
    const reader = response.body.getReader();
    let downloaded = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        downloaded += value.byteLength;
        if (!file.write(Buffer.from(value))) await new Promise((resolve) => file.once('drain', resolve));
        const fraction = total ? downloaded / total : Math.min(0.85, 0.08 + Math.log10(1 + downloaded) * 0.06);
        this.update(packageId, { status: 'downloading', progress: Math.min(0.88, 0.03 + fraction * 0.85), downloadedBytes: downloaded, totalBytes: total, message: total ? `已下载 ${formatBytes(downloaded)} / ${formatBytes(total)}` : `已下载 ${formatBytes(downloaded)}` });
      }
    } finally {
      await new Promise((resolve, reject) => file.end((error) => error ? reject(error) : resolve()));
    }
  }

  async extractArchive(archive, definition, fallback = false) {
    const listing = await run('tar.exe', ['-tf', archive], this.projectRoot);
    const entries = listing.split(/\r?\n/).filter(Boolean);
    for (const entry of entries) {
      const normalized = entry.replaceAll('\\', '/');
      if (path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) throw new Error(`依赖包包含不安全路径：${entry}`);
      if (!fallback && !normalized.startsWith('runtime/')) throw new Error(`依赖包包含非 runtime 路径：${entry}`);
    }
    if (fallback) {
      const normalized = entries.map((entry) => entry.replaceAll('\\', '/'));
      const pythonEntry = normalized.find((entry) => /(^|\/)runtime\/python(?:\/|$)/.test(entry));
      const whisperEntry = normalized.find((entry) => /(^|\/)runtime\/faster-whisper(?:\/|$)/.test(entry));
      if (!pythonEntry || !whisperEntry) throw new Error('兼容核心包中未找到完整的 runtime/python 与 runtime/faster-whisper。');
      const prefix = pythonEntry.match(/^(.*?)(?=runtime\/python(?:\/|$))/)?.[1] || '';
      if (!whisperEntry.startsWith(`${prefix}runtime/faster-whisper`)) throw new Error('兼容核心包的 runtime 目录层级不一致。');
      const strip = prefix.split('/').filter(Boolean).length;
      const args = ['-xf', archive, '-C', this.projectRoot];
      if (strip) args.push('--strip-components', String(strip));
      args.push(`${prefix}runtime/python`, `${prefix}runtime/faster-whisper`);
      await run('tar.exe', args, this.projectRoot);
    } else {
      await run('tar.exe', ['-xf', archive, '-C', this.projectRoot], this.projectRoot);
    }
    this.update(definition.id, { status: 'installing', progress: 0.98, message: fallback ? '已从兼容核心包提取运行时，正在检查' : '正在检查安装结果' });
  }

  update(id, patch) {
    const current = this.progress.get(id) || {};
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.progress.set(id, next);
    this.emit({ type: 'dependency-progress', packageId: id, package: { id, ...next }, state: this.state() });
  }
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
