const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { recoverAtomicFile, writeFileRecoverable } = require('./atomic-file');
const { ASR_MODELS, getAsrModelByPackage, isAsrModelPackage } = require('./asr-models');
const { projectRuntimeEnvironment, readUtf8, resolveSystemExecutable } = require('./child-process-io');
const { ensureDir } = require('./workspace');

const REPOSITORY = 'Fenglin-Maple/star-owner';
const DEPENDENCY_MANIFEST_SCHEMA = 1;
const LEGACY_ADOPTION_VERSION = '1.0.0';
const OFFICIAL_DEPENDENCY_CHECKSUMS = Object.freeze({
  'Star-Owner-v1.0.0-runtime-win-x64.zip': '18b22748781b24a5fcbe3cefe307aa436e85e1ca98a939cebf2eeab5a3244b1d',
  'Star-Owner-v1.0.0-model-small.zip': '82792d0eccee4579b279224676e87824e8652133947cf197f480377315a8c878',
  'Star-Owner-v1.0.0-model-large-v3-turbo.zip': '1a6681635ec0d2f023925887d646d386bf0bc180543895e3113a2548b5cc085b'
});

class DependencyManager {
  constructor({ store, projectRoot, version, dependencyVersion, emit, onInstalled, acquireInstall, retryBaseDelayMs = 1000, maxNetworkAttempts = 5 }) {
    this.store = store;
    this.projectRoot = path.resolve(projectRoot);
    this.version = version;
    this.dependencyVersion = dependencyVersion || version;
    this.emit = emit || (() => {});
    this.onInstalled = onInstalled || (async () => {});
    this.acquireInstall = acquireInstall || (async () => async () => {});
    this.retryBaseDelayMs = Math.max(0, Number(retryBaseDelayMs) || 0);
    this.maxNetworkAttempts = Math.max(1, Math.min(10, Number(maxNetworkAttempts) || 5));
    this.downloadRoot = ensureDir(path.join(this.projectRoot, 'runtime', '.downloads'));
    this.progress = new Map();
    this.pendingPackages = new Map();
    this.pendingImports = new Map();
    this.downloadControllers = new Map();
    this.queue = Promise.resolve();
    this.installJournal = path.join(this.projectRoot, 'runtime', '.install-transaction.json');
    this.manifestRoot = ensureDir(path.join(this.projectRoot, 'runtime', '.dependency-manifests'));
    this.manifestAdoptionMarker = path.join(this.manifestRoot, 'legacy-adoption-v1.json');
    this.recovery = this.recoverInterruptedInstall();
    this.manifestAdoption = this.adoptLegacyDependencies();
  }

  definitions() {
    return [
      {
        id: 'runtime-base',
        name: '媒体与 ASR 基础运行时',
        description: '项目内 Python、Microsoft VC++、faster-whisper、CTranslate2、FFmpeg、yt-dlp 与 CUDA 运行库。',
        required: true,
        assetName: `Star-Owner-v${this.dependencyVersion}-runtime-win-x64.zip`,
        assetPattern: /Star-Owner-v[\d.]+-runtime-win-x64\.zip$/i,
        fallbackAssetPattern: /Star-Owner-v[\d.]+-win-x64-core\.zip$/i,
        probes: [
          'runtime/python/cpython-3.12.13-windows-x86_64-none/python.exe',
          'runtime/faster-whisper/Lib/site-packages/faster_whisper',
          'runtime/faster-whisper/Lib/site-packages/yt_dlp',
          'runtime/vc-runtime/msvcp140.dll'
        ]
      },
      ...ASR_MODELS.map((model) => ({
        id: model.packageId,
        modelId: model.id,
        name: `faster-whisper ${model.id} 模型`,
        description: model.description,
        required: model.required,
        assetName: `Star-Owner-v${this.dependencyVersion}-model-${model.assetSlug}.zip`,
        assetPattern: new RegExp(`Star-Owner-v[\\d.]+-model-${escapeRegex(model.assetSlug)}\\.zip$`, 'i'),
        probes: [`runtime/models/${model.id}/model.bin`, `runtime/models/${model.id}/config.json`]
      }))
    ];
  }

  state() {
    const packages = this.definitions().map((definition) => {
      const progress = this.progress.get(definition.id) || {};
      const health = this.packageHealth(definition);
      const available = health.available;
      const staleAvailableProgress = progress.status === 'available' && !available;
      const status = staleAvailableProgress
        ? 'missing'
        : (progress.status || (available ? 'available' : 'missing'));
      const message = staleAvailableProgress
        ? health.message
        : (progress.message || (available ? '已安装并通过版本与路径检查' : health.message));
      return {
        ...definition,
        available,
        status,
        progress: Number(staleAvailableProgress ? 0 : (progress.progress || (available ? 1 : 0))),
        downloadedBytes: Number(progress.downloadedBytes || 0),
        totalBytes: Number(progress.totalBytes || 0),
        message,
        source: progress.source || '',
        manifestStatus: health.manifestStatus,
        manifestSource: health.manifest?.source || '',
        releaseUrl: this.releaseUrl(),
        localImport: isAsrModelPackage(definition.id)
      };
    });
    const prompt = this.store.get('settings', 'dependencyPrompt') || {};
    const missingRequired = packages.filter((item) => item.required && !item.available);
    return {
      repository: `https://github.com/${REPOSITORY}`,
      releasePage: `https://github.com/${REPOSITORY}/releases`,
      dependencyReleasePage: this.releaseUrl(),
      dependencyReleaseVersion: this.dependencyVersion,
      packages,
      missingRequired: missingRequired.map((item) => item.id),
      ready: missingRequired.length === 0,
      needsPrompt: missingRequired.length > 0 && prompt.version !== this.version,
      promptVersion: prompt.version || '',
      recovery: this.recovery || { recovered: false },
      manifestAdoption: this.manifestAdoption || { completed: false }
    };
  }

  packageManifestPath(definitionOrId) {
    const id = typeof definitionOrId === 'string' ? definitionOrId : definitionOrId?.id;
    if (!this.definitions().some((definition) => definition.id === id)) throw new Error(`未知依赖包清单：${id}`);
    return path.join(this.manifestRoot, `${id}.json`);
  }

  readPackageManifest(definition) {
    const file = this.packageManifestPath(definition);
    try { recoverAtomicFile(file); }
    catch (error) { return { manifest: null, status: 'recovery-failed', error }; }
    if (!fs.existsSync(file)) return { manifest: null, status: 'missing' };
    try { return { manifest: JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')), status: 'present' }; }
    catch (error) { return { manifest: null, status: 'invalid-json', error }; }
  }

  packageHealth(definition) {
    const missingProbes = definition.probes.filter((probe) => !fs.existsSync(path.join(this.projectRoot, probe)));
    if (missingProbes.length) {
      return { available: false, manifestStatus: 'probes-missing', message: `未检测到完整依赖：缺少 ${missingProbes.join(', ')}` };
    }
    const loaded = this.readPackageManifest(definition);
    if (!loaded.manifest) {
      return { available: false, manifestStatus: loaded.status, message: '依赖文件存在，但安装身份清单缺失或损坏，请重新安装正确版本。' };
    }
    const validation = validatePackageManifest(loaded.manifest, definition, this.dependencyVersion);
    if (!validation.valid) {
      return { available: false, manifest: loaded.manifest, manifestStatus: validation.status, message: `依赖文件存在，但版本或包身份不匹配：${validation.message}` };
    }
    return { available: true, manifest: loaded.manifest, manifestStatus: 'valid', message: '已安装并通过版本与路径检查' };
  }

  createPackageManifest(definition, metadata = {}) {
    const checksum = String(metadata.checksum || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(checksum)) throw new Error(`依赖包 ${definition.id} 缺少有效的安装校验值。`);
    return {
      schemaVersion: DEPENDENCY_MANIFEST_SCHEMA,
      packageId: definition.id,
      dependencyReleaseVersion: this.dependencyVersion,
      assetName: definition.assetName,
      checksum,
      probes: [...definition.probes],
      source: String(metadata.source || 'archive-install'),
      sourceAssetName: String(metadata.sourceAssetName || definition.assetName),
      sourceReleaseVersion: normalizeReleaseVersion(metadata.sourceReleaseVersion || this.dependencyVersion),
      fallback: Boolean(metadata.fallback),
      installedAt: metadata.installedAt || new Date().toISOString()
    };
  }

  writePackageManifest(definition, manifest) {
    const file = this.packageManifestPath(definition);
    writeFileRecoverable(file, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
    return file;
  }

  stagePackageManifest(stagingRoot, definition, metadata) {
    const manifest = this.createPackageManifest(definition, metadata);
    const relative = dependencyManifestRelativePath(definition.id);
    const target = path.join(stagingRoot, relative);
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return manifest;
  }

  adoptLegacyDependencies() {
    try { recoverAtomicFile(this.manifestAdoptionMarker); }
    catch (error) { return { completed: false, warning: `旧依赖清单迁移记录恢复失败：${error.message || String(error)}` }; }
    if (fs.existsSync(this.manifestAdoptionMarker)) {
      try {
        const marker = JSON.parse(fs.readFileSync(this.manifestAdoptionMarker, 'utf8').replace(/^\uFEFF/, ''));
        if (marker?.schemaVersion === DEPENDENCY_MANIFEST_SCHEMA && marker?.completed === true) return marker;
        return { completed: false, warning: '旧依赖清单迁移记录无效；为避免误认版本，已停止自动认领。' };
      } catch (error) {
        return { completed: false, warning: `旧依赖清单迁移记录损坏；为避免误认版本，已停止自动认领：${error.message || String(error)}` };
      }
    }
    const adoptedPackages = [];
    const rejectedPackages = [];
    const eligible = this.dependencyVersion === LEGACY_ADOPTION_VERSION;
    for (const definition of this.definitions()) {
      const manifestFile = this.packageManifestPath(definition);
      if (fs.existsSync(manifestFile)) continue;
      const probesAvailable = definition.probes.every((probe) => fs.existsSync(path.join(this.projectRoot, probe)));
      if (!probesAvailable) continue;
      const checksum = OFFICIAL_DEPENDENCY_CHECKSUMS[definition.assetName] || '';
      if (!eligible || !checksum) {
        rejectedPackages.push(definition.id);
        continue;
      }
      this.writePackageManifest(definition, this.createPackageManifest(definition, {
        checksum,
        source: 'legacy-v1.0.0-adoption',
        sourceAssetName: definition.assetName,
        sourceReleaseVersion: LEGACY_ADOPTION_VERSION
      }));
      adoptedPackages.push(definition.id);
    }
    const marker = {
      schemaVersion: DEPENDENCY_MANIFEST_SCHEMA,
      completed: true,
      dependencyReleaseVersion: this.dependencyVersion,
      eligible,
      adoptedPackages,
      rejectedPackages,
      completedAt: new Date().toISOString()
    };
    writeFileRecoverable(this.manifestAdoptionMarker, Buffer.from(`${JSON.stringify(marker, null, 2)}\n`, 'utf8'));
    return marker;
  }

  releaseUrl() {
    return `https://github.com/${REPOSITORY}/releases/tag/v${this.dependencyVersion}`;
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
    if (this.pendingImports.has(id)) return this.pendingImports.get(id);
    const controller = new AbortController();
    this.downloadControllers.set(id, controller);
    const pending = this.enqueue(async () => {
      try { return await this.downloadNow(packageId, { signal: controller.signal }); }
      catch (error) {
        const installed = this.state().packages.find((item) => item.id === id)?.available;
        if (isDependencyPause(error)) {
          this.update(packageId, {
            status: 'paused',
            message: '下载已暂停，已保留部分下载缓存；点击“继续下载”可断点续传'
          });
          return { id, paused: true, state: this.state() };
        }
        if (isDependencyCancellation(error)) {
          this.update(packageId, {
            status: installed ? 'available' : 'missing',
            progress: installed ? 1 : 0,
            message: installed ? '自动下载已中止，现有模型保持可用' : '自动下载已中止，可重新下载或从本地导入'
          });
          return { id, cancelled: true, state: this.state() };
        }
        this.update(packageId, {
          status: installed ? 'available' : 'failed',
          progress: installed ? 1 : undefined,
          message: installed ? `依赖已安装，但安装后的服务刷新失败：${error.message || String(error)}` : (error.message || String(error))
        });
        throw error;
      }
    }).finally(() => {
      this.pendingPackages.delete(id);
      if (this.downloadControllers.get(id) === controller) this.downloadControllers.delete(id);
    });
    this.pendingPackages.set(id, pending);
    return pending;
  }

  async cancelDownload(packageId) {
    const id = String(packageId || '');
    const pending = this.pendingPackages.get(id);
    if (!pending) return { id, cancelled: false };
    this.update(id, { status: 'cancelling', message: '正在中止应用自动下载并等待任务退出' });
    this.downloadControllers.get(id)?.abort(dependencyCancellationError('已切换为本地导入'));
    await pending;
    return { id, cancelled: true };
  }

  async pauseDownload(packageId) {
    const id = String(packageId || '');
    const pending = this.pendingPackages.get(id);
    if (!pending) {
      const item = this.state().packages.find((entry) => entry.id === id);
      return { id, paused: item?.status === 'paused', state: this.state() };
    }
    this.update(id, { status: 'pausing', message: '正在暂停下载，已保留当前下载缓存' });
    this.downloadControllers.get(id)?.abort(dependencyPauseError('已暂停依赖下载'));
    await pending;
    return { id, paused: true, state: this.state() };
  }

  async prepareLocalImport(packageId) {
    const id = String(packageId || '');
    const definition = this.definitions().find((item) => item.id === id && isAsrModelPackage(item.id));
    if (!definition) throw localImportError(`不支持从本地导入该依赖包：${id}`, this.releaseUrl());
    await this.cancelDownload(id);
    this.clearPackageArtifacts(id);
    const available = this.packageHealth(definition).available;
    this.update(id, {
      status: available ? 'available' : 'missing',
      progress: available ? 1 : 0,
      message: available ? '现有模型保持可用，请选择本地模型包导入' : '自动下载已中止，临时缓存已清理，请选择本地模型包导入'
    });
    return this.state();
  }

  async importLocal(packageId, sourceFile) {
    const id = String(packageId || '');
    const definition = this.definitions().find((item) => item.id === id && isAsrModelPackage(item.id));
    if (!definition) throw localImportError(`不支持从本地导入该依赖包：${id}`, this.releaseUrl());
    const source = path.resolve(String(sourceFile || ''));
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw localImportError('选择的模型包文件不存在或不可读取。', this.releaseUrl(), definition.assetName);
    if (path.basename(source) !== definition.assetName) {
      throw localImportError(`模型包版本或类型不正确。当前版本只接受 ${definition.assetName}。`, this.releaseUrl(), definition.assetName);
    }
    if (this.pendingImports.has(id)) return this.pendingImports.get(id);
    const pending = (async () => {
      await this.cancelDownload(id);
      this.clearPackageArtifacts(id, { preserve: [source] });
      return this.enqueue(() => this.importLocalNow(definition, source));
    })().finally(() => this.pendingImports.delete(id));
    this.pendingImports.set(id, pending);
    return pending;
  }

  async importLocalNow(definition, source) {
    const managedArchive = path.join(this.downloadRoot, `.import-${definition.id}-${crypto.randomBytes(6).toString('hex')}.zip`);
    let releaseInstall = null;
    try {
      this.update(definition.id, { status: 'importing', progress: 0.03, source, message: `正在复制并验证 ${definition.assetName}` });
      await fs.promises.copyFile(source, managedArchive);
      this.update(definition.id, { status: 'resolving', progress: 0.08, message: '正在读取正确版本 Release 的校验信息' });
      let release;
      let expectedChecksum;
      try {
        release = await this.resolveReleaseAsset(definition);
        if (release.asset.name !== definition.assetName) throw new Error(`Release 中未找到 ${definition.assetName}`);
        expectedChecksum = await this.resolveChecksum(release, definition.assetName);
      } catch (error) {
        throw localImportError(`无法验证模型包对应的 Release：${networkErrorMessage(error)}`, this.releaseUrl(), definition.assetName);
      }
      if (!expectedChecksum) throw localImportError(`正确版本 Release 缺少 ${definition.assetName} 的 SHA-256，已拒绝安装。`, this.releaseUrl(), definition.assetName);
      this.update(definition.id, { status: 'verifying', progress: 0.32, message: '正在校验本地模型包 SHA-256' });
      const verified = await this.verifyArchive(managedArchive, expectedChecksum);
      if (verified.actual !== expectedChecksum) {
        throw localImportError(`模型包 SHA-256 不匹配，文件可能损坏、版本错误或不是官方依赖包。`, this.releaseUrl(), definition.assetName);
      }
      this.update(definition.id, { status: 'verifying', progress: 0.58, message: '正在检查模型包目录结构和必需文件' });
      const inspection = await this.inspectArchive(managedArchive, definition, false);
      releaseInstall = await this.acquireInstall(definition.id, () => {
        this.update(definition.id, { status: 'waiting-install', progress: 0.75, message: '本地包验证通过，正在等待 Agent 工具与 ASR 队列空闲' });
      });
      this.update(definition.id, { status: 'installing', progress: 0.8, message: '资源窗口已锁定，正在原子安装本地模型包' });
      await this.extractArchive(managedArchive, definition, false, inspection, {
        checksum: expectedChecksum,
        source: 'local-import',
        sourceAssetName: definition.assetName,
        sourceReleaseVersion: release.release?.tag_name || this.dependencyVersion
      });
      const available = this.packageHealth(definition).available;
      if (!available) throw new Error(`模型包已解压，但缺少预期文件：${definition.probes.join(', ')}`);
      const bytes = fs.statSync(managedArchive).size;
      this.update(definition.id, { status: 'available', progress: 1, message: '本地模型包导入完成', downloadedBytes: bytes, totalBytes: bytes });
      const releaseMaintenance = releaseInstall;
      releaseInstall = null;
      await releaseMaintenance?.();
      await this.onInstalled(definition.id);
      this.clearPackageArtifacts(definition.id);
      return { id: definition.id, checksum: expectedChecksum, imported: true, state: this.state() };
    } catch (error) {
      const installed = this.packageHealth(definition).available;
      const normalized = error.releaseUrl ? error : localImportError(error.message || String(error), this.releaseUrl(), definition.assetName);
      this.update(definition.id, {
        status: installed ? 'available' : 'failed',
        progress: installed ? 1 : 0,
        message: installed ? `导入失败，原有模型保持可用：${normalized.message}` : normalized.message
      });
      throw normalized;
    } finally {
      await releaseInstall?.();
      fs.rmSync(managedArchive, { force: true });
    }
  }

  enqueue(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }

  async downloadNow(packageId, { signal } = {}) {
    const definition = this.definitions().find((item) => item.id === packageId);
    if (!definition) throw new Error(`未知依赖包：${packageId}`);
    throwIfDependencyCancelled(signal);
    this.update(definition.id, { status: 'resolving', progress: 0.01, message: '正在查询 GitHub Release 资源' });
    const release = await this.resolveReleaseAsset(definition, signal);
    const archive = path.join(this.downloadRoot, release.asset.name);
    const partial = `${archive}.partial`;
    this.update(definition.id, { status: 'resolving', source: release.asset.browser_download_url, progress: 0.015, message: '正在获取 SHA-256 校验信息' });
    let expectedChecksum;
    try {
      expectedChecksum = await this.resolveChecksum(release, release.asset.name, signal);
    } catch (error) {
      throwIfDependencyCancelled(signal);
      const retained = fs.existsSync(archive) ? '完整依赖包已保留；下次重试将继续校验' : '尚未开始下载依赖包';
      throw new Error(`SHA-256 校验信息获取失败，${retained}：${networkErrorMessage(error)}`);
    }
    if (!expectedChecksum) {
      throw new Error(`Release 缺少有效的 ${release.asset.name} SHA-256，已拒绝下载或安装未经校验的依赖。`);
    }
    let checksum = '';
    let verified = false;
    if (fs.existsSync(archive)) {
      this.update(definition.id, { status: 'verifying', source: release.asset.browser_download_url, progress: 0.89, message: '检测到已下载的依赖包，正在继续校验 SHA-256' });
      const cached = await this.verifyArchive(archive, expectedChecksum);
      if (cached.checksum === cached.actual) {
        checksum = cached.checksum;
        verified = true;
        const bytes = fs.statSync(archive).size;
        this.update(definition.id, { status: 'verifying', progress: 0.91, downloadedBytes: bytes, totalBytes: bytes, message: '已复用完整下载包，SHA-256 校验通过' });
      } else {
        fs.rmSync(archive, { force: true });
        this.update(definition.id, { status: 'downloading', progress: 0.02, message: '已有下载包校验不匹配，正在重新下载' });
      }
    }
    if (!verified) {
      this.update(definition.id, { status: 'downloading', source: release.asset.browser_download_url, progress: 0.02, message: `正在下载 ${release.asset.name}` });
      await this.downloadFile(release.asset.browser_download_url, partial, definition.id, signal);
      throwIfDependencyCancelled(signal);
      if (fs.existsSync(archive)) fs.rmSync(archive, { force: true });
      fs.renameSync(partial, archive);
      this.update(definition.id, { status: 'verifying', progress: 0.9, message: '正在校验 SHA-256' });
      const downloaded = await this.verifyArchive(archive, expectedChecksum);
      checksum = downloaded.checksum;
      if (checksum !== downloaded.actual) {
        fs.rmSync(archive, { force: true });
        throw new Error(`依赖包 SHA-256 不匹配：${downloaded.actual}`);
      }
    }
    let releaseInstall = null;
    try {
      releaseInstall = await this.acquireInstall(definition.id, () => {
        this.update(definition.id, { status: 'waiting-install', progress: 0.92, message: '下载与校验已完成，正在等待 Agent 工具与 ASR 队列空闲' });
      });
      this.update(definition.id, { status: 'installing', progress: 0.93, message: '资源窗口已锁定，正在安装' });
      await this.extractArchive(archive, definition, release.fallback, null, {
        checksum,
        source: 'download',
        sourceAssetName: release.asset.name,
        sourceReleaseVersion: release.release?.tag_name || this.dependencyVersion,
        fallback: release.fallback
      });
      const available = this.packageHealth(definition).available;
      if (!available) throw new Error(`依赖包已解压，但缺少预期文件：${definition.probes.join(', ')}`);
      const installedBytes = Number(release.asset.size || fs.statSync(archive).size || 0);
      this.update(definition.id, { status: 'available', progress: 1, message: '安装完成', downloadedBytes: installedBytes, totalBytes: installedBytes });
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

  async resolveReleaseAsset(definition, signal) {
    const candidates = [];
    const releaseUrls = [...new Set([
      `https://api.github.com/repos/${REPOSITORY}/releases/tags/v${this.dependencyVersion}`,
      `https://api.github.com/repos/${REPOSITORY}/releases/tags/v${this.version}`,
      `https://api.github.com/repos/${REPOSITORY}/releases/latest`
    ])];
    for (const url of releaseUrls) {
      try {
        throwIfDependencyCancelled(signal);
        const response = await fetch(url, { headers: githubHeaders(), signal: requestSignal(signal, 30000) });
        if (response.ok) candidates.push(await response.json());
      } catch (error) {
        throwIfDependencyCancelled(signal);
        /* try the next release source */
      }
    }
    try {
      throwIfDependencyCancelled(signal);
      const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=10`, { headers: githubHeaders(), signal: requestSignal(signal, 30000) });
      if (response.ok) {
        const known = new Set(candidates.map((release) => String(release.id || release.tag_name || '')));
        for (const release of await response.json()) {
          const key = String(release.id || release.tag_name || '');
          if (!key || !known.has(key)) candidates.push(release);
          if (key) known.add(key);
        }
      }
    } catch (error) {
      throwIfDependencyCancelled(signal);
      /* handled below */
    }
    const allowVersionFallback = this.dependencyVersion === this.version;
    for (const release of candidates) {
      const assets = Array.isArray(release.assets) ? release.assets : [];
      const asset = assets.find((item) => item.name === definition.assetName)
        || (allowVersionFallback && assets.find((item) => definition.assetPattern.test(item.name)));
      if (asset) return { release, asset, fallback: false };
      const fallback = allowVersionFallback && definition.fallbackAssetPattern && assets.find((item) => definition.fallbackAssetPattern.test(item.name));
      if (fallback) return { release, asset: fallback, fallback: true };
    }
    return directDependencyReleaseAsset(this.dependencyVersion, definition);
  }

  async fetchChecksum(resolved, assetName, signal) {
    const checksumAsset = (resolved.release.assets || []).find((item) => item.name === `${assetName}.sha256`);
    if (!checksumAsset) return '';
    const response = await this.fetchWithRetry(checksumAsset.browser_download_url, () => ({
      headers: githubHeaders(),
      redirect: 'follow',
      signal: requestSignal(signal, 30000)
    }), signal);
    if (!response.ok) return '';
    return (await response.text()).match(/[0-9a-f]{64}/i)?.[0]?.toLowerCase() || '';
  }

  async resolveChecksum(resolved, assetName, signal) {
    const digest = String(resolved.asset?.digest || '').match(/^sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase();
    return digest || this.fetchChecksum(resolved, assetName, signal);
  }

  async verifyArchive(archive, checksum) {
    return { checksum, actual: await sha256(archive) };
  }

  async fetchWithRetry(url, optionsFactory, signal) {
    let lastError;
    for (let attempt = 1; attempt <= this.maxNetworkAttempts; attempt += 1) {
      throwIfDependencyCancelled(signal);
      try {
        const response = await fetch(url, optionsFactory());
        if (!isRetryableStatus(response.status) || attempt === this.maxNetworkAttempts) return response;
        lastError = new Error(`HTTP ${response.status}`);
      } catch (error) {
        throwIfDependencyCancelled(signal);
        lastError = error;
      }
      await this.waitForRetry(attempt, signal);
    }
    throw lastError || new Error('网络请求失败');
  }

  async downloadFile(url, target, packageId, signal) {
    let lastError;
    for (let attempt = 1; attempt <= this.maxNetworkAttempts; attempt += 1) {
      throwIfDependencyCancelled(signal);
      let existing = fs.existsSync(target) ? fs.statSync(target).size : 0;
      const headers = githubHeaders();
      if (existing > 0) headers.range = `bytes=${existing}-`;
      try {
        const response = await fetch(url, { headers, redirect: 'follow', signal: requestSignal(signal, 6 * 60 * 60 * 1000) });
        if (response.status === 416 && existing > 0) {
          const total = parseUnsatisfiedRangeTotal(response.headers.get('content-range'));
          if (total && existing === total) return;
          fs.truncateSync(target, 0);
          throw new Error('服务器拒绝断点位置，已从头重新下载');
        }
        if (!response.ok || !response.body) throw new Error(`依赖下载失败 (${response.status})`);
        const contentRange = parseContentRange(response.headers.get('content-range'));
        const resumed = existing > 0 && response.status === 206 && contentRange?.start === existing;
        if (existing > 0 && response.status === 206 && !resumed) {
          fs.truncateSync(target, 0);
          throw new Error('服务器返回了不一致的断点范围，已从头重新下载');
        }
        if (!resumed) existing = 0;
        const remaining = Number(response.headers.get('content-length') || 0);
        const total = Number(contentRange?.total || (remaining ? existing + remaining : 0));
        let downloaded = existing;
        const manager = this;
        let lastProgressAt = 0;
        const meter = new Transform({
          transform(chunk, _encoding, callback) {
            downloaded += chunk.length;
            if (Date.now() - lastProgressAt >= 200 || (total && downloaded >= total)) {
              lastProgressAt = Date.now();
              const fraction = total ? downloaded / total : Math.min(0.85, 0.08 + Math.log10(1 + downloaded) * 0.06);
              manager.update(packageId, { status: 'downloading', progress: Math.min(0.88, 0.03 + fraction * 0.85), downloadedBytes: downloaded, totalBytes: total, message: `${resumed ? '断点续传' : '已下载'} ${formatBytes(downloaded)}${total ? ` / ${formatBytes(total)}` : ''}` });
            }
            callback(null, chunk);
          }
        });
        await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(target, { flags: resumed ? 'a' : 'w' }));
        if (total && downloaded !== total) throw new Error(`下载长度不完整：${formatBytes(downloaded)} / ${formatBytes(total)}`);
        return;
      } catch (error) {
        throwIfDependencyCancelled(signal);
        lastError = error;
        const saved = fs.existsSync(target) ? fs.statSync(target).size : 0;
        if (attempt >= this.maxNetworkAttempts) break;
        this.update(packageId, {
          status: 'downloading',
          message: `连接中断，已保留 ${formatBytes(saved)}，即将进行第 ${attempt + 1}/${this.maxNetworkAttempts} 次断点续传：${networkErrorMessage(error)}`
        });
        await this.waitForRetry(attempt, signal);
      }
    }
    const saved = fs.existsSync(target) ? fs.statSync(target).size : 0;
    throw new Error(`依赖下载失败，已保留 ${formatBytes(saved)} 供下次断点续传：${networkErrorMessage(lastError)}`);
  }

  async waitForRetry(attempt, signal) {
    const delayMs = Math.min(15000, this.retryBaseDelayMs * (2 ** Math.max(0, attempt - 1)));
    if (delayMs > 0) await abortableDelay(delayMs, signal);
  }

  async inspectArchive(archive, definition, fallback = false) {
    const tar = resolveSystemExecutable('tar.exe');
    if (!tar) throw new Error('Windows 系统缺少 tar.exe，无法检查依赖包。');
    const listing = await run(tar, ['-tf', archive], this.projectRoot);
    const verboseListing = await run(tar, ['-tvf', archive], this.projectRoot);
    if (verboseListing.split(/\r?\n/).some((line) => /^[lh]/i.test(line.trim()))) {
      throw new Error('依赖包包含符号链接或硬链接，已拒绝解压。');
    }
    const entries = listing.split(/\r?\n/).filter(Boolean);
    if (!entries.length) throw new Error('依赖包为空，未找到可安装内容。');
    for (const entry of entries) {
      const normalized = entry.replaceAll('\\', '/');
      if (path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) throw new Error(`依赖包包含不安全路径：${entry}`);
      if (!fallback && !normalized.startsWith('runtime/')) throw new Error(`依赖包包含非 runtime 路径：${entry}`);
    }
    if (!fallback) validateArchivePayload(definition, entries);
    return { entries };
  }

  async extractArchive(archive, definition, fallback = false, inspection = null, installMetadata = {}) {
    const { entries } = inspection || await this.inspectArchive(archive, definition, fallback);
    const tar = resolveSystemExecutable('tar.exe');
    if (!tar) throw new Error('Windows 系统缺少 tar.exe，无法解压依赖包。');
    const checksum = /^[0-9a-f]{64}$/i.test(String(installMetadata.checksum || ''))
      ? String(installMetadata.checksum).toLowerCase()
      : await sha256(archive);
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
        await run(tar, args, this.projectRoot);
      } else {
        await run(tar, ['-xf', archive, '-C', stagingRoot], this.projectRoot);
      }
      this.stagePackageManifest(stagingRoot, definition, {
        ...installMetadata,
        checksum,
        fallback,
        sourceAssetName: installMetadata.sourceAssetName || path.basename(archive)
      });
      this.installStagedRuntime(stagingRoot, definition);
    } finally {
      if (fs.existsSync(stagingRoot)) fs.rmSync(stagingRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    }
    this.update(definition.id, { status: 'installing', progress: 0.98, message: fallback ? '已从兼容核心包提取运行时，正在检查' : '正在检查安装结果' });
  }

  clearPackageArtifacts(packageId, { preserve = [] } = {}) {
    const id = String(packageId || '');
    const definition = this.definitions().find((item) => item.id === id);
    if (!definition) return;
    const preserved = new Set(preserve.map((item) => path.resolve(String(item || '')).toLowerCase()));
    recoverAtomicFile(this.installJournal);
    if (fs.existsSync(this.installJournal)) {
      try {
        const journal = JSON.parse(fs.readFileSync(this.installJournal, 'utf8'));
        validateInstallJournal(journal);
        if (journal.id === id) {
          if (journal.phase === 'committed') this.finalizeCommittedInstall(journal);
          else this.rollbackInstall(journal);
        }
      } catch { /* startup recovery owns malformed journals */ }
    }
    if (fs.existsSync(this.downloadRoot)) {
      for (const name of fs.readdirSync(this.downloadRoot)) {
        if (!isPackageDownloadArtifact(name, definition)) continue;
        const target = path.resolve(this.downloadRoot, name);
        if (preserved.has(target.toLowerCase())) continue;
        assertInsideDirectory(this.downloadRoot, target);
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
      }
    }
    const runtimeRoot = path.join(this.projectRoot, 'runtime');
    for (const name of fs.readdirSync(runtimeRoot)) {
      if (!name.startsWith(`.install-staging-${id}-`) && !name.startsWith(`.install-backup-${id}-`)) continue;
      const target = path.resolve(runtimeRoot, name);
      assertInstallPath(this.projectRoot, target);
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    }
    const probesAvailable = definition.probes.every((probe) => fs.existsSync(path.join(this.projectRoot, probe)));
    if (!probesAvailable && isAsrModelPackage(id)) {
      for (const relative of managedRuntimePaths(id)) {
        const target = assertInstallPath(this.projectRoot, path.join(this.projectRoot, relative));
        if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
      }
      const manifest = assertInstallPath(this.projectRoot, this.packageManifestPath(definition));
      fs.rmSync(manifest, { force: true });
      fs.rmSync(`${manifest}.bak`, { force: true });
      fs.rmSync(`${manifest}.tmp`, { force: true });
    }
  }

  update(id, patch) {
    const current = this.progress.get(id) || {};
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.progress.set(id, next);
    this.emit({ type: 'dependency-progress', packageId: id, package: { id, ...next }, state: this.state() });
  }

  installStagedRuntime(stagingRoot, definition) {
    const payloadPaths = managedRuntimePaths(definition.id).filter((relative) => fs.existsSync(path.join(stagingRoot, relative)));
    if (!payloadPaths.length) throw new Error(`Dependency archive did not contain an installable payload for ${definition.id}.`);
    const manifestRelative = dependencyManifestRelativePath(definition.id);
    if (!fs.existsSync(path.join(stagingRoot, manifestRelative))) throw new Error(`Dependency installation manifest is missing for ${definition.id}.`);
    const relativePaths = [...payloadPaths, manifestRelative];
    const backupRoot = path.join(this.projectRoot, 'runtime', `.install-backup-${definition.id}-${crypto.randomBytes(4).toString('hex')}`);
    const entries = relativePaths.map((relative) => ({
      relative,
      source: path.join(stagingRoot, relative),
      target: path.join(this.projectRoot, relative),
      backup: path.join(backupRoot, relative),
      hadOriginal: fs.existsSync(path.join(this.projectRoot, relative))
    }));
    for (const entry of entries) entry.status = 'pending';
    const journal = { id: definition.id, phase: 'installing', stagingRoot, backupRoot, entries, createdAt: new Date().toISOString() };
    this.writeInstallJournal(journal);
    try {
      for (const entry of entries) {
        ensureDir(path.dirname(entry.target));
        if (entry.hadOriginal) {
          ensureDir(path.dirname(entry.backup));
          movePath(entry.target, entry.backup);
          entry.status = 'backed-up';
          this.writeInstallJournal(journal);
        }
        movePath(entry.source, entry.target);
        entry.status = 'installed';
        this.writeInstallJournal(journal);
      }
      const missing = definition.probes.filter((probe) => !fs.existsSync(path.join(this.projectRoot, probe)));
      if (missing.length) throw new Error(`依赖安装后缺少必需文件：${missing.join(', ')}`);
      journal.phase = 'committed';
      journal.committedAt = new Date().toISOString();
      this.writeInstallJournal(journal);
      this.finalizeCommittedInstall(journal);
    } catch (error) {
      if (journal.phase !== 'committed') {
        try { this.rollbackInstall(journal); }
        catch (rollbackError) { throw new Error(`${error.message || String(error)}；依赖回滚未完成：${rollbackError.message || String(rollbackError)}`); }
      }
      throw error;
    }
  }

  writeInstallJournal(journal) {
    writeFileRecoverable(this.installJournal, Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, 'utf8'));
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
    try {
      if (journal.phase === 'committed') {
        this.finalizeCommittedInstall(journal);
        return { recovered: true, packageId: journal.id || '', action: 'finalized-committed-install' };
      }
      this.rollbackInstall(journal);
      return { recovered: true, packageId: journal.id || '', action: 'rolled-back-interrupted-install' };
    } catch (error) {
      return {
        recovered: false,
        packageId: journal.id || '',
        warning: `依赖安装未能自动恢复，已保留恢复记录：${error.message || String(error)}`
      };
    }
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
        } else if (['backed-up', 'installed'].includes(entry.status)) {
          throw new Error(`旧依赖备份缺失，拒绝生成混合 runtime：${entry.relative || entry.target}`);
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

  finalizeCommittedInstall(journal = {}) {
    if (journal.phase !== 'committed') throw new Error('Refusing to finalize an uncommitted dependency installation.');
    for (const entry of journal.entries || []) {
      const target = assertInstallPath(this.projectRoot, entry.target);
      if (!fs.existsSync(target)) throw new Error(`已提交依赖的安装目标缺失：${entry.relative || target}`);
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

function dependencyManifestRelativePath(packageId) {
  const id = String(packageId || '');
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error(`依赖包清单 ID 不安全：${id}`);
  return `runtime/.dependency-manifests/${id}.json`;
}

function validatePackageManifest(manifest, definition, dependencyVersion) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { valid: false, status: 'invalid', message: '清单格式无效' };
  if (manifest.schemaVersion !== DEPENDENCY_MANIFEST_SCHEMA) return { valid: false, status: 'schema-mismatch', message: '清单格式版本不匹配' };
  if (manifest.packageId !== definition.id) return { valid: false, status: 'package-mismatch', message: `期望 ${definition.id}` };
  if (String(manifest.dependencyReleaseVersion || '') !== String(dependencyVersion || '')) return { valid: false, status: 'version-mismatch', message: `期望依赖版本 v${dependencyVersion}` };
  if (manifest.assetName !== definition.assetName) return { valid: false, status: 'asset-mismatch', message: `期望 ${definition.assetName}` };
  const checksum = String(manifest.checksum || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(checksum)) return { valid: false, status: 'checksum-missing', message: '清单缺少有效 SHA-256' };
  const officialChecksum = OFFICIAL_DEPENDENCY_CHECKSUMS[definition.assetName];
  if (officialChecksum && checksum !== officialChecksum) return { valid: false, status: 'checksum-mismatch', message: '清单校验值与官方依赖包不一致' };
  if (!Array.isArray(manifest.probes) || JSON.stringify(manifest.probes) !== JSON.stringify(definition.probes)) {
    return { valid: false, status: 'probe-mismatch', message: '清单探针与当前包定义不一致' };
  }
  return { valid: true, status: 'valid', message: '' };
}

function normalizeReleaseVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function managedRuntimePaths(packageId) {
  if (packageId === 'runtime-base') return ['runtime/python', 'runtime/faster-whisper', 'runtime/vc-runtime'];
  const model = getAsrModelByPackage(packageId);
  if (model) return [`runtime/models/${model.id}`];
  return [];
}

function validateArchivePayload(definition, entries) {
  const allowed = managedRuntimePaths(definition.id).map((item) => item.replaceAll('\\', '/').replace(/\/$/, ''));
  if (!allowed.length) throw new Error(`依赖包没有受支持的安装目标：${definition.id}`);
  const normalizedEntries = entries.map((entry) => entry.replaceAll('\\', '/').replace(/\/$/, '')).filter(Boolean);
  for (const entry of normalizedEntries) {
    const permitted = allowed.some((root) => entry === root || entry.startsWith(`${root}/`) || root.startsWith(`${entry}/`));
    if (!permitted) throw new Error(`依赖包包含不属于 ${definition.id} 的路径：${entry}`);
  }
  const missing = definition.probes.filter((probe) => !normalizedEntries.includes(probe.replaceAll('\\', '/')));
  if (missing.length) throw new Error(`依赖包缺少必需模型文件：${missing.join(', ')}`);
}

function isPackageDownloadArtifact(name, definition) {
  const value = String(name || '');
  if (value === definition.assetName || value === `${definition.assetName}.partial`) return true;
  if (value.startsWith(`.import-${definition.id}-`) && value.endsWith('.zip')) return true;
  const model = getAsrModelByPackage(definition.id);
  if (model) return new RegExp(`^Star-Owner-v[\\d.]+-model-${escapeRegex(model.assetSlug)}\\.zip(?:\\.partial)?$`, 'i').test(value);
  if (definition.id === 'runtime-base') return /^Star-Owner-v[\d.]+-runtime-win-x64\.zip(?:\.partial)?$/i.test(value);
  return false;
}

function assertInsideDirectory(root, value) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(value);
  const relative = path.relative(resolvedRoot, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Refusing to remove dependency artifact outside its managed directory: ${target}`);
  return target;
}

function validateInstallJournal(journal) {
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)) throw new Error('journal root must be an object');
  if (!Array.isArray(journal.entries) || !journal.entries.length) throw new Error('journal entries are missing');
  for (const entry of journal.entries) {
    if (!entry || typeof entry !== 'object' || !entry.target || !entry.backup) throw new Error('journal contains an invalid install entry');
    if (entry.status && !['pending', 'backed-up', 'installed'].includes(entry.status)) throw new Error('journal contains an invalid install entry status');
  }
  if (journal.phase && !['installing', 'committed'].includes(journal.phase)) throw new Error('journal contains an invalid install phase');
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

function dependencyCancellationError(message = '依赖下载已中止') {
  const error = new Error(message);
  error.code = 'DEPENDENCY_DOWNLOAD_CANCELLED';
  return error;
}

function dependencyPauseError(message = '依赖下载已暂停') {
  const error = new Error(message);
  error.code = 'DEPENDENCY_DOWNLOAD_PAUSED';
  return error;
}

function isDependencyCancellation(error) {
  return error?.code === 'DEPENDENCY_DOWNLOAD_CANCELLED';
}

function isDependencyPause(error) {
  return error?.code === 'DEPENDENCY_DOWNLOAD_PAUSED';
}

function throwIfDependencyCancelled(signal) {
  if (!signal?.aborted) return;
  if (isDependencyPause(signal.reason)) throw signal.reason;
  if (isDependencyCancellation(signal.reason)) throw signal.reason;
  throw dependencyCancellationError(signal.reason?.message || '依赖下载已中止');
}

function requestSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function abortableDelay(delayMs, signal) {
  throwIfDependencyCancelled(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    function done() {
      signal?.removeEventListener('abort', cancelled);
      resolve();
    }
    function cancelled() {
      clearTimeout(timer);
      try { throwIfDependencyCancelled(signal); }
      catch (error) { reject(error); }
    }
    signal?.addEventListener('abort', cancelled, { once: true });
  });
}

function localImportError(message, releaseUrl, expectedAsset = '') {
  const suffix = expectedAsset ? ` 正确文件：${expectedAsset}。` : '';
  const error = new Error(`${message}${suffix} 正确版本 Release：${releaseUrl}`);
  error.code = 'DEPENDENCY_LOCAL_IMPORT_INVALID';
  error.releaseUrl = releaseUrl;
  error.expectedAsset = expectedAsset;
  return error;
}

function isRetryableStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function parseContentRange(value) {
  const match = String(value || '').match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

function parseUnsatisfiedRangeTotal(value) {
  const match = String(value || '').match(/^bytes\s+\*\/(\d+)$/i);
  return match ? Number(match[1]) : 0;
}

function networkErrorMessage(error) {
  if (!error) return '未知网络错误';
  const detail = error.cause?.message || error.cause?.code || '';
  return [error.message || String(error), detail].filter(Boolean).join(' / ');
}

function directDependencyReleaseAsset(version, definition) {
  const tag = `v${version}`;
  const base = `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}`;
  const asset = {
    name: definition.assetName,
    browser_download_url: `${base}/${encodeURIComponent(definition.assetName)}`,
    size: 0
  };
  const checksum = {
    name: `${definition.assetName}.sha256`,
    browser_download_url: `${base}/${encodeURIComponent(`${definition.assetName}.sha256`)}`,
    size: 0
  };
  return {
    release: { tag_name: tag, assets: [asset, checksum], directFallback: true },
    asset,
    fallback: false,
    directFallback: true
  };
}

function run(file, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env: projectRuntimeEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    readUtf8(child.stdout, (text) => { stdout += text; });
    readUtf8(child.stderr, (text) => { stderr += text; });
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

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { DependencyManager, REPOSITORY };
