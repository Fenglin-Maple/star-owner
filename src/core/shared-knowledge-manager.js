const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { collectionDirs, ensureDir, safeName, assertInside } = require('./workspace');
const { GitRuntime } = require('./git-runtime');
const { sharedRepositoryTemplate } = require('./shared-repository-template');

const DEFAULT_REPOSITORY = Object.freeze({ owner: 'Fenglin-Maple', ownerId: '124229028', name: 'Blibili-Markdowns', branch: 'main', private: false, htmlUrl: 'https://github.com/Fenglin-Maple/Blibili-Markdowns' });
const SHARED_USER_ID = 'shared-user';
const SHARED_USER_NAME = '共享';
const DOCUMENT_META_FILE = '_star-owner-document.json';
const SHAREABLE_EXTENSIONS = new Set(['.md', '.json', '.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif']);
const MAX_SHARED_FILE_BYTES = 25 * 1024 * 1024;
const MAX_SHARED_DOCUMENT_FILES = 256;
const MAX_SHARED_DOCUMENT_BYTES = 100 * 1024 * 1024;
const MAX_SHARED_PR_DOCUMENTS = 1000;
const MAX_SHARED_PR_BYTES = 1024 * 1024 * 1024;
const MAX_REMOTE_METADATA_BYTES = 512 * 1024;
const MAX_REMOTE_CATALOG_BYTES = 32 * 1024 * 1024;
const MAX_REMOTE_CATALOG_DOCUMENTS = 100000;
const REPOSITORY_MARKER_FILE = '_star-owner-repository.json';
const REPOSITORY_SCHEMA_VERSION = 1;
const REQUIRED_REPOSITORY_CAPABILITIES = Object.freeze(['bilibili-summary', 'single-video-summary', 'multipart-summary', 'catalog-v1']);
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const APPLICATION_VERSION = require('../../package.json').version;

class SharedKnowledgeManager {
  constructor({ store, encryptSecret, decryptSecret, openExternal, emit, repository = DEFAULT_REPOSITORY, request = null, gitRuntime = null }) {
    this.store = store;
    this.encryptSecret = encryptSecret;
    this.decryptSecret = decryptSecret;
    this.openExternal = openExternal || (async () => {});
    this.emit = emit || (() => {});
    this.defaultRepository = normalizeRepository({ ...DEFAULT_REPOSITORY, ...repository });
    this.requestOverride = request;
    this.gitRuntime = gitRuntime || new GitRuntime({ projectRoot: path.join(__dirname, '..', '..') });
    this.activeUpload = null;
    this.activeOperation = null;
    this.lastUploadEmission = 0;
    this.lastOperationEmission = 0;
    this.catalogCache = new Map();
    this.githubLoginCache = new Map();
    this.ensureSharedUser();
    this.ensureRepositoryRegistry();
    this.normalizeSharedMountRecords();
  }

  get repository() {
    const saved = this.store.get('settings', 'sharedRepository');
    try { return saved ? normalizeRepository(saved) : { ...this.defaultRepository }; }
    catch { return { ...this.defaultRepository }; }
  }

  state() {
    const settings = this.store.get('settings', 'sharedGithub') || {};
    return {
      repository: { ...this.repository },
      repositories: this.registeredRepositories(),
      repositoryHealth: this.repositoryHealth(this.repository),
      authenticated: Boolean(settings.encryptedToken || process.env.STAR_OWNER_GITHUB_TOKEN),
      login: String(settings.login || ''),
      userId: String(settings.userId || ''),
      authMethod: String(settings.authMethod || (settings.encryptedToken ? 'token' : '')),
      collections: this.store.listCollections().filter((item) => item.collectionKind === 'shared').map(publicCollection),
      mounts: this.store.list('sharedMounts').map(publicMount),
      documents: this.store.list('tasks').filter((task) => task.sourceType === 'shared-bilibili' || task.sourceType === 'shared-bilibili-multipart-summary').map(publicSharedTask),
      git: this.gitRuntime.state(),
      upload: this.activeUpload ? publicUpload(this.activeUpload) : null,
      operation: this.activeOperation ? publicOperation(this.activeOperation) : null,
      limits: { maxUploadDocuments: MAX_SHARED_PR_DOCUMENTS, maxUploadBytes: MAX_SHARED_PR_BYTES }
    };
  }

  operationState() { return this.activeOperation ? publicOperation(this.activeOperation) : null; }

  async setRepository(input = {}) {
    return this.runOperation({ type: 'repository-link', message: '正在检查 GitHub 仓库...' }, async () => {
      this.assertRepositoryChangeAllowed();
      const requested = parseRepositoryInput(input.repository || input.url || input.fullName || input, input.branch);
      const token = this.optionalAuthToken();
      this.reportOperation({ stage: 'repository', progress: 0.18, message: `正在确认仓库 ${requested.owner}/${requested.name} 是否存在...` }, true);
      let inspected;
      try {
        inspected = await this.inspectRepository(requested, token);
        this.reportOperation({ stage: 'contract', progress: 0.58, message: `正在验证 ${REPOSITORY_MARKER_FILE} 和共享能力...` }, true);
        const contract = await this.validateRepositoryContract(inspected, token);
        this.saveVerifiedRepository(inspected, contract);
        this.catalogCache.delete(repositoryIdentity(inspected));
        this.reportOperation({ stage: 'saved', progress: 0.96, message: '仓库符合星藏家共享规范，正在保存连接...' }, true);
        this.emitState('shared-repository-changed', { repository: inspected });
        return { repository: inspected, contract, role: this.repositoryRole(inspected, this.state()) };
      } catch (error) {
        this.updateRepositoryHealth(inspected || requested, 'unavailable', error);
        throw error;
      }
    });
  }

  async checkRepository() {
    return this.runOperation({ type: 'repository-check', message: '正在检查已连接的共享仓库...' }, async () => {
      const requested = this.repository;
      const token = this.optionalAuthToken();
      let inspected;
      try {
        this.reportOperation({ stage: 'repository', progress: 0.22, message: `正在检查 ${requested.owner}/${requested.name} 是否存在...` }, true);
        inspected = await this.inspectRepository(requested, token);
        this.reportOperation({ stage: 'contract', progress: 0.62, message: '正在核对共享仓库规范标记...' }, true);
        const contract = await this.validateRepositoryContract(inspected, token);
        this.saveVerifiedRepository(inspected, contract);
        this.reportOperation({ stage: 'available', progress: 0.96, message: '共享仓库连接正常。' }, true);
        return { available: true, repository: inspected, contract };
      } catch (error) {
        this.updateRepositoryHealth(inspected || requested, 'unavailable', error);
        throw error;
      }
    });
  }

  async createRepository(input = {}) {
    return this.runOperation({ type: 'repository-create', message: '正在创建 GitHub 共享仓库...' }, async () => {
      this.assertRepositoryChangeAllowed();
      const auth = await this.requireAuth();
      const name = validateRepositoryName(input.name || 'star-owner-shared-knowledge');
      const description = String(input.description || '由星藏家管理的 B站视频总结共享文档仓库').trim().slice(0, 350);
      let created;
      this.reportOperation({ stage: 'creating', progress: 0.05, message: `正在创建公开仓库 ${auth.user.login}/${name}...` }, true);
      try {
        created = await this.githubRequest('/user/repos', {
          token: auth.token,
          method: 'POST',
          body: { name, description, private: false, auto_init: true, has_issues: true, has_projects: false, has_wiki: false }
        });
      } catch (error) {
        if (error.status === 422) throw new Error(`GitHub 账户中可能已经存在名为 ${name} 的仓库，请换一个名称，或在“连接共享仓库”中验证该仓库。`);
        throw error;
      }
      const repository = repositoryFromApi(created, { owner: auth.user.login, name, branch: 'main' });
      if (String(repository.ownerId || '') !== String(auth.user.id || '')) throw new Error('GitHub 返回的仓库主人与当前授权账户不一致，已停止初始化。');
      const files = sharedRepositoryTemplate(repository);
      try {
        for (let index = 0; index < files.length; index += 1) {
          const file = files[index];
          this.reportOperation({
            stage: 'initializing',
            progress: 0.12 + (index / Math.max(1, files.length)) * 0.72,
            current: index,
            total: files.length,
            message: `正在写入初始化文件 ${index + 1} / ${files.length}：${file.relative}`
          });
          const existing = await this.findRepositoryFile(repository, file.relative, auth.token);
          const body = {
            message: `chore: initialize Star Owner sharing (${index + 1}/${files.length})`,
            content: file.buffer.toString('base64'),
            branch: repository.branch
          };
          if (existing?.sha) body.sha = existing.sha;
          await this.githubRequest(`/repos/${repository.owner}/${repository.name}/contents/${encodePath(file.relative)}`, { token: auth.token, method: 'PUT', body });
        }
      } catch (error) {
        throw new Error(`GitHub 仓库已创建，但预置配置未能全部写入：${error.message || String(error)}。仓库地址：${repository.htmlUrl}`);
      }
      this.reportOperation({ stage: 'validating', progress: 0.88, current: files.length, total: files.length, message: '初始化完成，正在复核共享仓库规范...' }, true);
      const contract = await this.validateRepositoryContract(repository, auth.token);
      this.saveVerifiedRepository(repository, contract);
      this.catalogCache.delete(repositoryIdentity(repository));
      this.reportOperation({ stage: 'ready', progress: 0.97, message: '仓库已创建并通过规范校验。' }, true);
      this.emitState('shared-repository-created', { repository });
      return { repository, contract, created: true, initializedFiles: files.length };
    });
  }

  cancelUpload() {
    if (!this.activeUpload || this.activeUpload.status !== 'running') return { canceled: false, message: '当前没有正在上传的共享文档。' };
    this.activeUpload.status = 'cancelling';
    this.activeUpload.message = '正在中止上传并清理临时分支...';
    this.activeUpload.controller.abort();
    this.reportUpload({}, true);
    return { canceled: true, uploadId: this.activeUpload.id };
  }

  async openLogin() {
    await this.openExternal(`https://github.com/${this.repository.owner}/${this.repository.name}`);
    return { ok: true, url: `https://github.com/${this.repository.owner}/${this.repository.name}`, message: '已打开 GitHub。返回应用后可点击“浏览器登录 GitHub”完成项目内置凭据授权，也可以粘贴 Fine-grained Token 作为备用；浏览器授权凭据只保存在星藏家的独立 DPAPI 加密存储中。' };
  }

  async browserLogin() {
    const credential = await this.gitRuntime.browserLogin();
    const value = validateGithubToken(credential.password);
    const user = await this.githubRequest('/user', { token: value });
    const current = this.store.get('settings', 'sharedGithub') || {};
    this.store.set('settings', 'sharedGithub', {
      id: 'sharedGithub',
      encryptedToken: this.encryptSecret(value),
      login: user.login || credential.username || '',
      userId: String(user.id || ''),
      authMethod: 'browser',
      updatedAt: new Date().toISOString()
    });
    this.store.save();
    this.emitState('shared-github-authenticated');
    return { login: user.login || credential.username || '', userId: String(user.id || ''), authenticated: true, authMethod: 'browser', previousLogin: current.login || '' };
  }

  async setToken(token) {
    const value = validateGithubToken(token);
    if (!value) throw new Error('GitHub Token 不能为空。');
    const user = await this.githubRequest('/user', { token: value });
    const current = this.store.get('settings', 'sharedGithub') || {};
    this.store.set('settings', 'sharedGithub', { id: 'sharedGithub', encryptedToken: this.encryptSecret(value), login: user.login || '', userId: String(user.id || ''), authMethod: 'token', updatedAt: new Date().toISOString() });
    this.store.save();
    this.emitState('shared-github-authenticated');
    return { login: user.login || '', userId: String(user.id || ''), authenticated: true, previousLogin: current.login || '' };
  }

  async clearToken() {
    const gitCredential = typeof this.gitRuntime.clearCredentialStore === 'function'
      ? await this.gitRuntime.clearCredentialStore()
      : { cleared: false, scope: 'unavailable' };
    this.store.delete('settings', 'sharedGithub');
    this.store.save();
    this.emitState('shared-github-logged-out');
    return { authenticated: false, cleared: true, scope: 'application-only', gitCredential, message: '已清除星藏家应用数据库与内置 Git 私有存储中的 GitHub 授权，不会修改系统 Git、系统凭据库或用户全局 Git 配置。' };
  }

  async remoteCatalog(repositoryInput = null, options = {}) {
    const repository = normalizeRepository(repositoryInput || this.repository);
    return this.runOperation({ type: 'catalog-read', message: `正在读取 ${repository.owner}/${repository.name} 的远程目录...` }, async () => (
      this.readRemoteCatalog(repository, { force: options.force !== false, progressStart: 0.03, progressEnd: 0.97 })
    ));
  }

  async readRemoteCatalog(repositoryInput = null, options = {}) {
    const repository = normalizeRepository(repositoryInput || this.repository);
    this.assertVerifiedRepository(repository);
    const cacheKey = repositoryIdentity(repository);
    const cached = this.catalogCache.get(cacheKey);
    if (!options.force && cached && Date.now() - cached.cachedAt < CATALOG_CACHE_TTL_MS) {
      this.reportOperation({ stage: 'catalog-cache', progress: progressWithin(options, 0.96), message: `正在使用刚刚读取的远程目录（${cached.value.total} 篇）...` }, true);
      return cached.value;
    }
    const token = this.optionalAuthToken();
    this.reportOperation({ stage: 'catalog-index', progress: progressWithin(options, 0.08), message: '正在一次性读取远程目录索引 catalog.json...' }, true);
    try {
      const indexed = await this.readRemoteCatalogIndex(repository, token, options);
      this.catalogCache.set(cacheKey, { cachedAt: Date.now(), value: indexed });
      return indexed;
    } catch (error) {
      if (isAbortError(error)) throw error;
      this.reportOperation({
        stage: 'catalog-fallback',
        progress: progressWithin(options, 0.12),
        message: `目录索引不可用，正在兼容读取仓库文件树：${String(error.message || error).slice(0, 160)}`
      }, true);
    }
    return this.readRemoteCatalogFromTree(repository, token, options, cacheKey);
  }

  async readRemoteCatalogIndex(repository, token, options = {}) {
    const record = await this.readRemoteJsonRecord('catalog.json', MAX_REMOTE_CATALOG_BYTES, repository, token);
    const catalog = record.value;
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new Error('catalog.json 不是有效对象。');
    if (Number(catalog.schemaVersion || 0) !== 1) throw new Error(`catalog.json 版本不兼容：${catalog.schemaVersion || '空'}。`);
    if (!Array.isArray(catalog.documents)) throw new Error('catalog.json 缺少 documents 列表。');
    if (catalog.documents.length > MAX_REMOTE_CATALOG_DOCUMENTS) throw new Error(`catalog.json 文档数量超过 ${MAX_REMOTE_CATALOG_DOCUMENTS} 篇安全上限。`);
    if (Number(catalog.total) !== catalog.documents.length) throw new Error('catalog.json 的 total 与 documents 数量不一致。');
    const seen = new Set();
    const documents = catalog.documents.map((entry) => {
      const metadataPath = String(entry?.metadataPath || '').replace(/\\/g, '/');
      assertRemotePath(metadataPath);
      if (!metadataPath.endsWith(`/${DOCUMENT_META_FILE}`)) throw new Error(`catalog.json 包含无效元数据路径：${metadataPath}`);
      if (seen.has(metadataPath)) throw new Error(`catalog.json 包含重复文档路径：${metadataPath}`);
      seen.add(metadataPath);
      const document = {
        ...entry,
        sourceType: entry.sourceType || 'bilibili-video-summary',
        documentType: entry.documentType || 'single-video',
        path: metadataPath,
        metadataPath,
        remoteSha: String(entry.remoteSha || entry.metadataSha || ''),
        updatedAt: entry.updatedAt || entry.uploadedAt || ''
      };
      validateRemoteMetadata(document, metadataPath);
      return document;
    });
    this.reportOperation({ stage: 'catalog-users', progress: progressWithin(options, 0.72), current: documents.length, total: documents.length, message: `目录索引已读取，共 ${documents.length} 篇；正在整理贡献者名称...` }, true);
    await this.resolveCatalogGithubLogins(documents, token);
    documents.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || String(a.path).localeCompare(String(b.path)));
    const value = {
      repository: { ...repository },
      branchSha: '',
      catalogSha: String(record.sha || ''),
      generatedAt: String(catalog.generatedAt || ''),
      catalogSource: 'index',
      total: documents.length,
      documents
    };
    this.reportOperation({ stage: 'catalog-ready', progress: progressWithin(options, 0.98), current: documents.length, total: documents.length, message: `远程目录索引读取完成，共 ${documents.length} 篇文档。` }, true);
    return value;
  }

  async readRemoteCatalogFromTree(repository, token, options = {}, cacheKey = repositoryIdentity(repository)) {
    this.reportOperation({ stage: 'catalog-tree', progress: progressWithin(options, 0.14), message: '正在读取 GitHub 仓库文件树...' }, true);
    let tree;
    try {
      tree = await this.githubRequest(`/repos/${repository.owner}/${repository.name}/git/trees/${encodeURIComponent(repository.branch)}?recursive=1`, { token });
    } catch (error) {
      if (error.status === 409) {
        const empty = { repository: { ...repository }, branchSha: '', total: 0, documents: [], empty: true };
        this.catalogCache.set(cacheKey, { cachedAt: Date.now(), value: empty });
        return empty;
      }
      throw error;
    }
    if (tree.truncated) throw new Error('共享仓库目录过大，GitHub 返回了不完整目录；请先缩小仓库后再读取。');
    const entries = Array.isArray(tree.tree) ? tree.tree : [];
    const metadataEntries = entries.filter((item) => item.type === 'blob' && item.path.endsWith(`/${DOCUMENT_META_FILE}`));
    const result = [];
    for (let index = 0; index < metadataEntries.length; index += 1) {
      const entry = metadataEntries[index];
      this.reportOperation({
        stage: 'catalog-metadata',
        progress: progressWithin(options, 0.14 + ((index + 1) / Math.max(1, metadataEntries.length)) * 0.66),
        current: index + 1,
        total: metadataEntries.length,
        message: `正在读取远程文档信息 ${index + 1} / ${metadataEntries.length}...`
      });
      try {
        assertRemotePath(entry.path);
        const metadata = await this.readRemoteFile(entry.path, MAX_REMOTE_METADATA_BYTES, repository, token);
        validateRemoteMetadata(metadata, entry.path);
        result.push({ ...metadata, path: entry.path, metadataPath: entry.path, remoteSha: entry.sha, updatedAt: metadata.updatedAt || metadata.uploadedAt || '' });
      } catch (error) {
        result.push({ path: entry.path, metadataPath: entry.path, remoteSha: entry.sha, invalid: true, error: error.message || String(error) });
      }
    }
    this.reportOperation({ stage: 'catalog-users', progress: progressWithin(options, 0.84), message: '正在整理贡献者与收藏夹目录...' }, true);
    await this.resolveCatalogGithubLogins(result, token);
    result.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || String(a.path).localeCompare(String(b.path)));
    const value = { repository: { ...repository }, branchSha: tree.sha || '', catalogSha: '', generatedAt: '', catalogSource: 'tree', total: result.length, documents: result };
    this.catalogCache.set(cacheKey, { cachedAt: Date.now(), value });
    this.reportOperation({ stage: 'catalog-ready', progress: progressWithin(options, 0.98), current: result.length, total: result.length, message: `远程目录读取完成，共 ${result.length} 篇文档。` }, true);
    return value;
  }

  async upload(input = {}) {
    if (this.activeUpload) throw new Error('已有一批共享文档正在上传，请等待完成或先中止。');
    const taskIds = [...new Set((input.taskIds || []).map(String))];
    if (!taskIds.length) throw new Error('请至少选择一篇已完成的 B站视频总结文档。');
    if (taskIds.length > MAX_SHARED_PR_DOCUMENTS) throw new Error(`一次最多上传 ${MAX_SHARED_PR_DOCUMENTS} 篇共享文档。`);
    const controller = new AbortController();
    this.activeUpload = {
      id: `shared-upload:${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      controller,
      status: 'running',
      stage: 'authorizing',
      progress: 0.01,
      current: 0,
      total: taskIds.length,
      message: '正在验证 GitHub 授权和目标仓库...',
      startedAt: new Date().toISOString()
    };
    this.reportUpload({}, true);
    let branch = '';
    let forkOwner = '';
    let forkName = '';
    let prCreated = false;
    try {
      const auth = await this.requireAuth();
      throwIfAborted(controller.signal);
      const githubUserId = String(auth.user.id || '').trim();
      if (!/^\d+$/.test(githubUserId)) throw new Error('GitHub 账户缺少稳定数字 ID，无法创建共享目录。请退出后重新授权。');
      const tasks = taskIds.map((id) => this.store.getTask(id)).filter(Boolean);
      if (tasks.length !== taskIds.length) throw new Error('准备上传列表中有文档已被删除或失效，请刷新后重新选择。');
      const documents = [];
      const documentIds = new Set();
      let totalBytes = 0;
      for (let index = 0; index < tasks.length; index += 1) {
        throwIfAborted(controller.signal);
        const document = this.prepareDocument({ ...tasks[index], githubUserId, githubUserLogin: auth.user.login });
        if (documentIds.has(document.documentId)) throw new Error(`选中的文档存在重复共享身份：${document.documentId}。请保留同一来源的一条记录。`);
        documentIds.add(document.documentId);
        documents.push(document);
        totalBytes += document.totalBytes;
        if (totalBytes > MAX_SHARED_PR_BYTES) throw new Error(`本次共享提交总大小不能超过 ${formatMiB(MAX_SHARED_PR_BYTES)}。请减少文档数量或图片资源。`);
        this.reportUpload({ stage: 'preparing', progress: 0.03 + ((index + 1) / tasks.length) * 0.22, current: index + 1, message: `正在校验第 ${index + 1} / ${tasks.length} 篇文档...` });
      }

      const repository = await this.inspectRepository(this.repository, auth.token, controller.signal);
      await this.validateRepositoryContract(repository, auth.token, controller.signal);
      const ownerMode = String(repository.ownerId || '') === String(auth.user.id || '');
      this.reportUpload({ stage: 'repository', progress: 0.27, current: tasks.length, message: ownerMode ? '已确认当前账户是仓库主人，正在创建临时分支...' : '已确认目标为他人仓库，正在准备 Fork 和 Pull Request...' }, true);
      const base = await this.githubRequest(`/repos/${repository.owner}/${repository.name}/git/ref/heads/${encodeURIComponent(repository.branch)}`, { token: auth.token, signal: controller.signal });
      if (!base.object?.sha) throw new Error(`共享仓库 ${repository.branch} 分支尚未初始化，请先提交初始文件或使用应用的一键创建仓库功能。`);
      branch = `star-owner/${safeBranch(auth.user.login)}-${Date.now().toString(36)}`;
      const fork = ownerMode
        ? { owner: repository.owner, name: repository.name, full_name: `${repository.owner}/${repository.name}`, _ownerRepository: true }
        : await this.ensureFork(auth.user.login, auth.token, repository, controller.signal);
      await this.waitForFork(fork, auth.token, repository, controller.signal);
      forkOwner = String(fork.owner?.login || fork.owner || auth.user.login);
      forkName = String(fork.name || repository.name);
      const uploaded = documents.map((document) => ({ taskId: document.task.id, documentId: document.documentId, remoteRoot: document.remoteRoot, metadataPath: `${document.remoteRoot}/${DOCUMENT_META_FILE}` }));
      if (this.requestOverride) {
        await this.githubRequest(`/repos/${forkOwner}/${forkName}/git/refs`, { token: auth.token, method: 'POST', body: { ref: `refs/heads/${branch}`, sha: base.object.sha }, signal: controller.signal });
        let completedFiles = 0;
        const totalFiles = documents.reduce((sum, document) => sum + document.files.length, 0);
        for (const document of documents) {
          for (const file of document.files) {
            throwIfAborted(controller.signal);
            const pathName = `${document.remoteRoot}/${file.relative}`;
            const existing = await this.findRepositoryFile({ owner: forkOwner, name: forkName, branch }, pathName, auth.token, controller.signal);
            const body = { message: `docs: update ${document.documentId}`, content: readUploadFile(file).toString('base64'), branch };
            if (existing?.sha) body.sha = existing.sha;
            await this.githubRequest(`/repos/${forkOwner}/${forkName}/contents/${encodePath(pathName)}`, { token: auth.token, method: 'PUT', body, signal: controller.signal });
            completedFiles += 1;
            this.reportUpload({ stage: 'writing', progress: 0.35 + (completedFiles / Math.max(1, totalFiles)) * 0.48, message: `正在写入共享文件 ${completedFiles} / ${totalFiles}...` });
          }
        }
      } else {
        await this.gitRuntime.commitAndPush({
          upstream: repository,
          fork: { owner: forkOwner, name: forkName },
          baseBranch: repository.branch,
          branch,
          token: auth.token,
          signal: controller.signal,
          files: documents.flatMap((document) => document.files.map((file) => ({ relative: `${document.remoteRoot}/${file.relative}`, buffer: file.buffer, sourcePath: file.sourcePath }))),
          replaceRoots: documents.map((document) => document.remoteRoot),
          message: `docs: update ${documents.length} shared document${documents.length === 1 ? '' : 's'}`,
          author: githubCommitAuthor(auth.user),
          onProgress: (event) => this.reportUpload({ stage: event.stage || 'git', progress: 0.34 + Number(event.progress || 0) * 0.5, message: event.message || '正在通过内置 Git 提交共享文档...' })
        });
      }
      throwIfAborted(controller.signal);
      this.reportUpload({ stage: 'pull-request', progress: 0.9, message: '文件已推送，正在创建 Pull Request...' }, true);
      const head = ownerMode ? branch : `${forkOwner}:${branch}`;
      const pr = await this.githubRequest(`/repos/${repository.owner}/${repository.name}/pulls`, {
        token: auth.token,
        method: 'POST',
        signal: controller.signal,
        body: { title: String(input.title || `星藏家共享文档 · ${documents.length} 篇`), body: buildPullRequestBody(documents), head, base: repository.branch }
      });
      prCreated = true;
      const record = { id: this.activeUpload.id, prNumber: pr.number, prUrl: pr.html_url, branch, repository, uploaded, status: 'open', createdAt: this.activeUpload.startedAt, updatedAt: new Date().toISOString() };
      this.store.set('sharedUploads', record.id, record);
      for (const item of uploaded) {
        const task = this.store.getTask(item.taskId);
        if (!task) continue;
        this.store.set('tasks', task.id, { ...task, sharedDocumentId: item.documentId, sharedRemotePath: item.metadataPath, sharedUploadRepository: repository, sharedUploadPr: pr.html_url, sharedUpdatedAt: record.updatedAt });
      }
      this.store.commit();
      this.reportUpload({ status: 'completed', stage: 'completed', progress: 1, current: tasks.length, message: `已创建 Pull Request，共 ${tasks.length} 篇文档。` }, true);
      this.emitState('shared-upload-created', { prUrl: pr.html_url, repository });
      return record;
    } catch (error) {
      if (branch && forkOwner && forkName && !prCreated) {
        await this.githubRequest(`/repos/${forkOwner}/${forkName}/git/refs/heads/${encodePath(branch)}`, { method: 'DELETE', token: this.optionalAuthToken() }).catch(() => {});
      }
      if (controller.signal.aborted || isAbortError(error)) {
        const canceled = new Error('共享文档上传已由用户中止，临时目录和可识别的临时分支已清理。');
        canceled.code = 'SHARED_UPLOAD_CANCELLED';
        throw canceled;
      }
      throw error;
    } finally {
      this.activeUpload = null;
      this.emitState('shared-upload-finished');
    }
  }

  async mount(input = {}) {
    return this.runOperation({ type: 'mount', message: '正在准备挂载远程共享文档...' }, async () => this.performMount(input));
  }

  async performMount(input = {}) {
    // The renderer may only submit paths/prefixes. Re-read the authoritative catalog
    // here so stale or forged renderer metadata cannot make the app fetch arbitrary files.
    const catalog = await this.readRemoteCatalog(this.repository, { force: false, progressStart: 0.03, progressEnd: 0.25 });
    const repository = normalizeRepository(catalog.repository || this.repository);
    const prefix = normalizeRemotePrefix(input.remotePrefix || '');
    const requested = !prefix && Array.isArray(input.paths) && input.paths.length
      ? new Set(input.paths.map(String))
      : null;
    let documents = catalog.documents.filter((document) => !document.invalid && (!requested || requested.has(document.path)) && (!prefix || document.path.startsWith(`${prefix}/`) || document.path === prefix));
    if (!documents.length) throw new Error('没有选择可挂载的远程 B站视频总结文档或收藏夹目录。');
    const knownCollectionIds = new Set(this.store.listCollections().map((item) => String(item.id)));
    const collection = this.requireOrCreateCollection(input.collectionId, input.collectionName || defaultMountName(prefix, documents));
    const createdCollection = !knownCollectionIds.has(String(collection.id));
    this.clearSharedExclusions(collection.id, documents.map((item) => item.path), repository);
    const groups = groupRemoteCollectionDocuments(documents);
    const mounts = [];
    const createdMounts = [];
    const now = new Date().toISOString();
    for (const group of groups) {
      const existing = this.store.list('sharedMounts').find((item) => String(item.collectionId) === String(collection.id)
        && sameRepository(item.repository || DEFAULT_REPOSITORY, repository)
        && mountRemoteCollectionPrefix(item) === group.prefix);
      const coversWholeCollection = Boolean(prefix && remotePrefixCovers(prefix, group.prefix));
      const mount = existing || {
        id: `mount:${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
        collectionId: collection.id,
        collectionName: collection.name,
        scope: coversWholeCollection ? 'collection' : 'documents',
        remotePrefix: group.prefix,
        remotePaths: [],
        repository: { ...repository },
        createdAt: now,
        updatedAt: now
      };
      if (!existing) createdMounts.push(mount);
      mount.collectionName = collection.name;
      mount.scope = mount.scope === 'collection' || coversWholeCollection ? 'collection' : 'documents';
      mount.remotePrefix = group.prefix;
      mount.remotePaths = [...new Set([...(mount.remotePaths || []), ...group.documents.map((item) => item.path)].map(String))];
      Object.assign(mount, remoteMountDescription(group.documents[0], group.prefix));
      mount.repository = { ...repository };
      mount.updatedAt = existing ? (mount.updatedAt || now) : now;
      this.store.set('sharedMounts', mount.id, mount);
      mounts.push(mount);
    }
    this.store.commit();
    let results;
    try {
      results = await this.syncMountBatchInternal(mounts, catalog, { progressStart: 0.26, progressEnd: 0.96 });
    } catch (error) {
      for (const mount of [...createdMounts].reverse()) this.rollbackNewMount(mount, collection, false);
      if (createdCollection && !this.store.listTasks({ collectionId: collection.id }).length) {
        fs.rmSync(collection.collectionRoot, { recursive: true, force: true });
        this.store.delete('collections', collection.id);
        this.store.save();
      }
      throw error;
    }
    const output = results.map((result) => publicMount(this.store.get('sharedMounts', result.id) || result));
    const primary = output[0] || publicMount(mounts[0]);
    this.emitState('shared-mount-created', { mountId: primary.id, mountIds: output.map((item) => item.id), collectionId: collection.id });
    return {
      ...primary,
      mounts: output,
      mountCount: output.length,
      remoteDocumentCount: output.reduce((sum, item) => sum + Number(item.remoteDocumentCount || 0), 0),
      unchanged: results.every((result) => result.unchanged)
    };
  }

  rollbackNewMount(mount, collection, createdCollection) {
    const tasks = this.store.listTasks({ collectionId: mount.collectionId }).filter((task) => {
      const mountIds = Array.isArray(task.sharedMountIds) ? task.sharedMountIds : [task.sharedMountId];
      return mountIds.map(String).includes(String(mount.id));
    });
    for (const task of tasks) {
      const remaining = (Array.isArray(task.sharedMountIds) ? task.sharedMountIds : [task.sharedMountId])
        .filter((id) => id && String(id) !== String(mount.id));
      if (remaining.length) {
        this.store.set('tasks', task.id, { ...task, sharedMountIds: remaining, sharedMountId: remaining.at(-1), updatedAt: new Date().toISOString() });
        continue;
      }
      if (task.artifactDir) fs.rmSync(task.artifactDir, { recursive: true, force: true });
      this.store.delete('tasks', task.id);
      this.store.delete('videos', task.id);
    }
    this.store.delete('sharedMounts', mount.id);
    if (createdCollection && !this.store.listTasks({ collectionId: collection.id }).length) {
      fs.rmSync(collection.collectionRoot, { recursive: true, force: true });
      this.store.delete('collections', collection.id);
    }
    this.store.save();
  }

  async syncMount(mountId, catalogInput = null) {
    return this.runOperation({ type: 'mount-sync', message: '正在同步共享挂载...' }, async () => (
      this.syncMountInternal(mountId, catalogInput, { progressStart: 0.03, progressEnd: 0.97 })
    ));
  }

  async syncMounts(mountIds = []) {
    const ids = [...new Set((Array.isArray(mountIds) ? mountIds : []).map(String).filter(Boolean))];
    if (!ids.length) throw new Error('请至少选择一个需要同步的本地共享挂载。');
    return this.runOperation({ type: 'mount-sync-batch', message: `正在同步 ${ids.length} 个共享挂载...` }, async () => {
      const mounts = ids.map((id) => this.store.get('sharedMounts', id));
      if (mounts.some((mount) => !mount)) throw new Error('选中的共享挂载中有记录已经不存在，请刷新列表后重试。');
      const catalogs = new Map();
      const repositories = [];
      for (const mount of mounts) {
        const repository = normalizeRepository(mount.repository || DEFAULT_REPOSITORY);
        const key = repositoryIdentity(repository);
        if (!repositories.some((item) => item.key === key)) repositories.push({ key, repository });
      }
      for (let index = 0; index < repositories.length; index += 1) {
        const item = repositories[index];
        const start = 0.03 + (index / Math.max(1, repositories.length)) * 0.25;
        const end = 0.03 + ((index + 1) / Math.max(1, repositories.length)) * 0.25;
        catalogs.set(item.key, await this.readRemoteCatalog(item.repository, { force: true, progressStart: start, progressEnd: end }));
      }
      const output = [];
      for (let index = 0; index < repositories.length; index += 1) {
        const item = repositories[index];
        const repositoryMounts = mounts.filter((mount) => repositoryIdentity(mount.repository || DEFAULT_REPOSITORY) === item.key);
        const start = 0.3 + (index / Math.max(1, repositories.length)) * 0.66;
        const end = 0.3 + ((index + 1) / Math.max(1, repositories.length)) * 0.66;
        output.push(...await this.syncMountBatchInternal(repositoryMounts, catalogs.get(item.key), { progressStart: start, progressEnd: end }));
      }
      return {
        synced: output.length,
        unchanged: output.filter((mount) => mount.unchanged).length,
        downloaded: output.reduce((sum, mount) => sum + Number(mount.downloaded || 0), 0),
        mounts: output
      };
    });
  }

  async syncMountBatchInternal(mounts = [], catalog, progressOptions = {}) {
    if (!mounts.length) return [];
    const repository = normalizeRepository(mounts[0].repository || DEFAULT_REPOSITORY);
    if (mounts.some((mount) => !sameRepository(mount.repository || DEFAULT_REPOSITORY, repository))) {
      throw new Error('一次共享挂载批处理只能同步同一个 GitHub 仓库。');
    }
    const start = Number(progressOptions.progressStart || 0.03);
    const end = Number(progressOptions.progressEnd || 0.97);
    const processMounts = async (transport = {}) => {
      const output = [];
      for (let index = 0; index < mounts.length; index += 1) {
        const mount = mounts[index];
        const mountStart = start + (index / Math.max(1, mounts.length)) * (end - start);
        const mountEnd = start + ((index + 1) / Math.max(1, mounts.length)) * (end - start);
        this.reportOperation({
          stage: 'mount-sync',
          progress: mountStart,
          current: index,
          total: mounts.length,
          message: `正在同步远程收藏夹 ${index + 1} / ${mounts.length}：${mount.remoteCollectionName || mount.collectionName || mount.id}`
        }, true);
        output.push(await this.syncMountInternal(mount.id, catalog, { ...transport, progressStart: mountStart, progressEnd: mountEnd }));
      }
      return output;
    };
    const requiresDownload = mounts.some((mount) => this.mountPendingDocuments(mount, catalog).length > 0);
    if (!requiresDownload) return processMounts();
    const canUseCheckout = typeof this.gitRuntime?.withReadOnlyCheckout === 'function'
      && (!this.requestOverride || this.gitRuntime.allowCheckoutWithRequestOverride === true);
    if (canUseCheckout) {
      try {
        return await this.gitRuntime.withReadOnlyCheckout({
          repository,
          token: this.optionalAuthToken(),
          onProgress: (event) => this.reportOperation({
            stage: event.stage || 'git-download',
            progress: start + Number(event.progress || 0) * (end - start) * 0.2,
            current: 0,
            total: mounts.length,
            message: event.message || '正在一次性下载共享仓库快照...'
          }, true)
        }, async ({ root }) => processMounts({ checkoutRoot: root }));
      } catch (error) {
        if (isAbortError(error) || error?.code !== 'SHARED_GIT_CHECKOUT_FAILED') throw error;
        this.reportOperation({ stage: 'mount-api-fallback', progress: start + (end - start) * 0.08, message: `内置 Git 快照不可用，正在切换 GitHub API 兼容下载：${String(error.message || error).slice(0, 180)}` }, true);
      }
    }
    const remoteTree = await this.readRepositoryTree(repository, this.optionalAuthToken());
    return processMounts({ remoteTree });
  }

  mountDocuments(mount, catalog) {
    const repository = normalizeRepository(mount.repository || DEFAULT_REPOSITORY);
    const scope = mount.scope || 'documents';
    return catalog.documents.filter((document) => {
      if (document.invalid || this.isSharedExcluded(mount.collectionId, document.path, repository)) return false;
      return scope === 'collection'
        ? (document.path.startsWith(`${mount.remotePrefix}/`) || document.path === mount.remotePrefix)
        : (mount.remotePaths || []).includes(document.path);
    });
  }

  mountPendingDocuments(mount, catalog) {
    const repository = normalizeRepository(mount.repository || DEFAULT_REPOSITORY);
    return this.mountDocuments(mount, catalog).filter((document) => {
      const existing = this.findMountedDocumentTask(mount, document, repository);
      return !existing || !this.remoteDocumentMatchesLocal(document, existing);
    });
  }

  async syncMountInternal(mountId, catalogInput = null, progressOptions = {}) {
    const mount = this.store.get('sharedMounts', String(mountId || ''));
    if (!mount) throw new Error('共享挂载不存在。');
    const repository = normalizeRepository(mount.repository || DEFAULT_REPOSITORY);
    const catalog = catalogInput || await this.readRemoteCatalog(repository, { force: true, progressStart: progressOptions.progressStart || 0.03, progressEnd: Math.min(0.32, progressOptions.progressEnd || 0.32) });
    if (catalog.repository && !sameRepository(catalog.repository, repository)) throw new Error('共享挂载目录来自其它 GitHub 仓库，已拒绝交叉同步。');
    const scope = mount.scope || 'documents';
    const documents = this.mountDocuments(mount, catalog);
    const currentPaths = new Set(documents.map((document) => document.path));
    const localTasks = this.store.listTasks({ collectionId: mount.collectionId }).filter((task) => {
      const mountIds = Array.isArray(task.sharedMountIds) ? task.sharedMountIds : [task.sharedMountId];
      return mountIds.map(String).includes(String(mount.id)) && ['shared-bilibili', 'shared-bilibili-multipart-summary'].includes(task.sourceType);
    });
    const pendingImports = [];
    let reusedDocuments = 0;
    for (const document of documents) {
      const existing = this.findMountedDocumentTask(mount, document, repository);
      if (existing && this.remoteDocumentMatchesLocal(document, existing)) {
        this.attachDocumentToMount(existing, mount, document, repository);
        reusedDocuments += 1;
      } else {
        pendingImports.push(document);
      }
    }
    if (pendingImports.length) await this.importMountDocuments(pendingImports, mount, repository, progressOptions);
    let remoteStateChanged = false;
    for (const task of localTasks) {
      if (task.sharedRemotePath && !currentPaths.has(task.sharedRemotePath)) {
        if (this.isSharedExcluded(mount.collectionId, task.sharedRemotePath, repository)) {
          if (task.remoteState !== 'local-deleted') {
            this.store.set('tasks', task.id, { ...task, remoteState: 'local-deleted', updatedAt: new Date().toISOString() });
            remoteStateChanged = true;
          }
        } else if (!this.isCoveredByAnotherMount(mount, task.sharedRemotePath)) {
          if (task.remoteState !== 'remote-deleted') {
            this.store.set('tasks', task.id, { ...task, remoteState: 'remote-deleted', remoteDeletedAt: task.remoteDeletedAt || new Date().toISOString(), updatedAt: new Date().toISOString() });
            remoteStateChanged = true;
          }
        }
      }
    }
    const now = new Date().toISOString();
    mount.remotePaths = scope === 'collection'
      ? documents.map((item) => item.path)
      : [...new Set([...mount.remotePaths || [], ...documents.map((item) => item.path)])];
    if (documents[0]) Object.assign(mount, remoteMountDescription(documents[0], mount.remotePrefix));
    mount.remoteFingerprint = sharedDocumentsFingerprint(documents);
    mount.lastCheckedAt = now;
    const unchanged = pendingImports.length === 0 && !remoteStateChanged;
    if (!unchanged || !mount.lastSyncedAt) mount.lastSyncedAt = now;
    mount.updatedAt = unchanged ? (mount.updatedAt || now) : now;
    this.store.set('sharedMounts', mount.id, mount);
    this.store.commit();
    this.emitState('shared-mount-synced', { mountId: mount.id, collectionId: mount.collectionId, unchanged });
    return { ...publicMount(mount), unchanged, downloaded: pendingImports.length, reused: reusedDocuments };
  }

  findMountedDocumentTask(mount, document, repository) {
    const documentId = String(document.documentId || '');
    return this.store.listTasks({ collectionId: mount.collectionId }).find((task) => task.multiPartRole !== 'part'
      && ['shared-bilibili', 'shared-bilibili-multipart-summary'].includes(task.sourceType)
      && String(task.sharedRemotePath || '') === String(document.path || '')
      && (!documentId || String(task.sharedDocumentId || '') === documentId)
      && sameRepository(task.sharedRepository || DEFAULT_REPOSITORY, repository));
  }

  remoteDocumentMatchesLocal(document, task) {
    if (!task?.artifactDir || !task.outputMarkdown || !task.metadataFile) return false;
    if (!fs.existsSync(task.artifactDir) || !fs.existsSync(task.outputMarkdown) || !fs.existsSync(task.metadataFile)) return false;
    const metadata = readJsonFile(task.metadataFile);
    if (!metadata || String(metadata.documentId || '') !== String(document.documentId || '')) return false;
    const isMultipartParent = metadata.multiPartRole === 'parent' || metadata.documentType === 'multipart-parent';
    if (localSharedDocumentModified(task.artifactDir, metadata, isMultipartParent)) return false;
    let compared = false;
    if (document.contentSha256) {
      compared = true;
      if (String(metadata.contentSha256 || '') !== String(document.contentSha256)) return false;
    }
    if (document.remoteSha && task.sharedRemoteSha) {
      compared = true;
      if (String(document.remoteSha) !== String(task.sharedRemoteSha)) return false;
    }
    const remoteUpdatedAt = String(document.updatedAt || document.uploadedAt || '');
    if (remoteUpdatedAt && task.remoteUpdatedAt) {
      compared = true;
      if (remoteUpdatedAt !== String(task.remoteUpdatedAt)) return false;
    }
    return compared;
  }

  attachDocumentToMount(task, mount, document, repository) {
    const related = this.store.listTasks({ collectionId: mount.collectionId }).filter((item) => item.id === task.id
      || (item.multiPartParentId && item.multiPartParentId === task.id));
    const now = new Date().toISOString();
    for (const item of related) {
      const mountIds = [...new Set([...(Array.isArray(item.sharedMountIds) ? item.sharedMountIds : [item.sharedMountId]), mount.id].filter(Boolean).map(String))];
      const next = {
        ...item,
        sharedMountId: mount.id,
        sharedMountIds: mountIds,
        sharedRepository: repository,
        sharedRemoteSha: document.remoteSha || item.sharedRemoteSha || '',
        remoteUpdatedAt: document.updatedAt || document.uploadedAt || item.remoteUpdatedAt || '',
        remoteState: 'active'
      };
      const changed = JSON.stringify([item.sharedMountId, item.sharedMountIds, item.sharedRemoteSha, item.remoteUpdatedAt, item.remoteState])
        !== JSON.stringify([next.sharedMountId, next.sharedMountIds, next.sharedRemoteSha, next.remoteUpdatedAt, next.remoteState]);
      if (changed) this.store.set('tasks', item.id, { ...next, updatedAt: now });
    }
  }

  async importMountDocuments(documents, mount, repository, progressOptions = {}) {
    const token = this.optionalAuthToken();
    const start = Number(progressOptions.progressStart || 0.08);
    const end = Number(progressOptions.progressEnd || 0.94);
    const importFrom = async ({ checkoutRoot = '', remoteTree = null, progressStart = start } = {}) => {
      for (let index = 0; index < documents.length; index += 1) {
        const document = documents[index];
        this.reportOperation({
          stage: checkoutRoot ? 'mount-copy' : 'mount-download',
          progress: progressStart + ((index + 1) / Math.max(1, documents.length)) * (end - progressStart),
          current: index + 1,
          total: documents.length,
          message: `${checkoutRoot ? '正在从本地快照导入' : '正在下载并挂载'}文档 ${index + 1} / ${documents.length}：${document.title || document.bvid || document.documentId}`
        });
        await this.importRemoteDocument(document, mount, { checkoutRoot, remoteTree });
      }
    };
    if (progressOptions.checkoutRoot) {
      await importFrom({ checkoutRoot: progressOptions.checkoutRoot, progressStart: start });
      return;
    }
    if (progressOptions.remoteTree) {
      await importFrom({ remoteTree: progressOptions.remoteTree, progressStart: start });
      return;
    }
    const canUseCheckout = typeof this.gitRuntime?.withReadOnlyCheckout === 'function'
      && (!this.requestOverride || this.gitRuntime.allowCheckoutWithRequestOverride === true);
    if (canUseCheckout) {
      try {
        await this.gitRuntime.withReadOnlyCheckout({
          repository,
          token,
          onProgress: (event) => this.reportOperation({
            stage: event.stage || 'git-download',
            progress: start + Number(event.progress || 0) * (end - start) * 0.24,
            current: 0,
            total: documents.length,
            message: event.message || '正在一次性下载共享仓库快照...'
          }, true)
        }, async ({ root }) => importFrom({ checkoutRoot: root, progressStart: start + (end - start) * 0.24 }));
        return;
      } catch (error) {
        if (isAbortError(error) || error?.code !== 'SHARED_GIT_CHECKOUT_FAILED') throw error;
        this.reportOperation({ stage: 'mount-api-fallback', progress: start + (end - start) * 0.08, message: `内置 Git 快照不可用，正在切换 GitHub API 兼容下载：${String(error.message || error).slice(0, 180)}` }, true);
      }
    }
    const remoteTree = await this.readRepositoryTree(repository, token);
    await importFrom({ remoteTree, progressStart: start + (end - start) * 0.12 });
  }

  async readRepositoryTree(repository, token) {
    const tree = await this.githubRequest(`/repos/${repository.owner}/${repository.name}/git/trees/${encodeURIComponent(repository.branch)}?recursive=1`, { token });
    if (tree.truncated) throw new Error('共享仓库目录过大，GitHub 返回了不完整目录；无法安全导入文档。');
    return tree;
  }

  async unmount(mountId) {
    const mount = this.store.get('sharedMounts', String(mountId || ''));
    if (!mount) return { deleted: false };
    for (const task of this.store.listTasks({ collectionId: mount.collectionId }).filter((item) => {
      const mountIds = Array.isArray(item.sharedMountIds) ? item.sharedMountIds : [item.sharedMountId];
      return mountIds.map(String).includes(String(mount.id));
    })) {
      const remaining = (Array.isArray(task.sharedMountIds) ? task.sharedMountIds : [task.sharedMountId])
        .filter((id) => id && String(id) !== String(mount.id));
      this.store.set('tasks', task.id, { ...task, sharedMountIds: remaining, sharedMountId: remaining.at(-1) || '', updatedAt: new Date().toISOString() });
    }
    this.store.delete('sharedMounts', mount.id);
    this.store.save();
    this.emitState('shared-mount-removed', { mountId: mount.id });
    return { deleted: true, mountId: mount.id };
  }

  prepareDocument(task) {
    if (task.status !== 'done' || !task.outputMarkdown || !fs.existsSync(task.outputMarkdown)) throw new Error(`文档未完成或文件不存在：${task.title || task.id}`);
    if (task.multiPartRole === 'part') throw new Error(`多P视频请从父任务目录上传，不能单独上传 P${task.page || ''}：${task.title || task.id}`);
    let multipartParts = [];
    if (task.multiPartRole === 'parent') {
      multipartParts = this.store.listTasks({ collectionId: task.collectionId }).filter((item) => item.multiPartParentId === task.id && item.multiPartRole === 'part' && item.pageState !== 'removed');
      if (!multipartParts.length || multipartParts.some((item) => item.status !== 'done' || !item.outputMarkdown || !fs.existsSync(item.outputMarkdown))) {
        throw new Error(`多P父任务尚未完成全部 P，暂不能上传共享：${task.title || task.bvid}`);
      }
    }
    const collection = this.store.getCollectionById(task.collectionId) || {};
    if (!isShareableBilibiliTask(task, collection)) throw new Error(`只允许上传 B站视频总结产物：${task.title || task.id}`);
    const documentId = stableDocumentId(task, collection);
    const remoteRoot = remoteRootFor(task, collection, documentId);
    const sourceRoot = path.resolve(task.multiPartRole === 'parent' ? task.artifactDir : path.dirname(task.outputMarkdown));
    const files = buildSharedDocumentFiles(task, sourceRoot, multipartParts);
    validateShareableFiles(files);
    const preferredMarkdown = task.multiPartRole === 'parent' ? 'index.md' : 'summary.md';
    const markdownFile = files.find((file) => file.relative.toLowerCase() === preferredMarkdown);
    if (!markdownFile || !fs.readFileSync(markdownFile.sourcePath, 'utf8').trim()) throw new Error(`共享文档缺少非空 Markdown：${task.title || task.id}`);
    const now = new Date().toISOString();
    const sourceBilibiliUid = String(task.sourceBilibiliUid || task.bilibiliUid || collection.bilibiliUid || collection.userId || '').trim();
    const remoteCollectionId = task.multiPartRole === 'parent'
      ? `multipart:${collection.id}`
      : task.singleTask
        ? `single:${collection.stableId || collection.id}`
        : `bilibili:${collection.mediaId || collection.id}`;
      const metadata = {
      schemaVersion: 3,
      documentId,
      sourceType: 'bilibili-video-summary',
      documentType: task.multiPartRole === 'parent' ? 'multipart-parent' : 'single-video',
        contributorGithubId: String(task.githubUserId || ''),
        contributorGithubLogin: String(task.githubUserLogin || ''),
      bilibiliUid: sourceBilibiliUid,
      remoteCollectionId,
      bvid: task.bvid || '',
      title: task.title || '',
      owner: task.owner || '',
      collectionName: collection.name || '',
      collectionId: collection.id || '',
      userName: collection.userName || '',
      userId: collection.userId || '',
      parentDocumentId: task.multiPartRole === 'parent' ? documentId : (task.parentDocumentId || task.multiPartParentId || ''),
      partId: task.multiPartId || '',
      page: task.page || 0,
      multiPartRole: task.multiPartRole || '',
      cid: task.cid || '',
      sourceCollectionKind: collection.collectionKind || (task.singleTask ? 'single-bilibili' : 'bilibili'),
      uploadedAt: task.sharedUploadedAt || task.sharedCreatedAt || now,
      updatedAt: now,
      completedAt: task.completedAt || '',
      entryMarkdown: preferredMarkdown,
      files: files.map((item) => item.relative),
      contentSha256: sha256File(markdownFile.sourcePath),
      markdownSha256: Object.fromEntries(files.filter((item) => /\.md$/i.test(item.relative)).map((item) => [item.relative, sha256File(item.sourcePath)])),
      assetSha256: Object.fromEntries(files.filter((item) => !/\.md$/i.test(item.relative)).map((item) => [item.relative, sha256File(item.sourcePath)]))
    };
    if (task.multiPartRole === 'parent') {
      metadata.parts = readMultipartManifest(sourceRoot);
    }
    metadata.fileSizes = Object.fromEntries(files.map((item) => [item.relative, item.size]));
    metadata.totalBytes = files.reduce((sum, item) => sum + item.size, 0);
    const metadataBuffer = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    files.push({ relative: DOCUMENT_META_FILE, buffer: metadataBuffer, size: metadataBuffer.length });
    validateShareableFiles(files);
    return { task, documentId, remoteRoot, files, metadata, totalBytes: metadata.totalBytes };
  }

  async importRemoteDocument(document, mount, { checkoutRoot = '', remoteTree = null } = {}) {
    if (document.invalid) return null;
    let metadata = document;
    const collection = this.store.getCollectionById(mount.collectionId);
    if (!collection) throw new Error('共享收藏夹不存在。');
    const repository = normalizeRepository(mount.repository || DEFAULT_REPOSITORY);
    const documentId = String(metadata.documentId || hash(document.path));
    const existing = this.store.listTasks({ collectionId: mount.collectionId }).find((task) => task.sharedDocumentId === documentId
      && String(task.sharedRemotePath || '') === String(document.path || '')
      && sameRepository(task.sharedRepository || DEFAULT_REPOSITORY, repository));
    const legacyRepository = sameRepository(repository, DEFAULT_REPOSITORY);
    const taskId = existing?.id || (legacyRepository ? `shared:${mount.collectionId}:${documentId}` : `shared:${mount.collectionId}:${hash(repositoryIdentity(repository))}:${documentId}`);
    const folder = existing?.artifactDir ? path.basename(existing.artifactDir) : safeName(legacyRepository ? documentId : `${documentId}-${hash(repositoryIdentity(repository)).slice(0, 8)}`, 'shared-document', 120);
    const target = assertInside(collection.collectionRoot, path.join(collection.collectionRoot, folder));
    const temp = `${target}.incoming-${Date.now().toString(36)}`;
    fs.rmSync(temp, { recursive: true, force: true });
    ensureDir(temp);
    const remoteRoot = document.path.slice(0, -DOCUMENT_META_FILE.length).replace(/\/+$/, '');
    assertRemotePath(remoteRoot);
    let installed = false;
    try {
      const token = this.optionalAuthToken();
      let downloadedBytes = 0;
      if (checkoutRoot) {
        const files = collectCheckoutDocumentFiles(checkoutRoot, remoteRoot);
        validateRemoteTree(files.map((file) => ({ type: 'blob', path: `${remoteRoot}/${file.relative}`, size: file.size })), remoteRoot);
        for (const file of files) {
          const destination = assertInside(temp, path.join(temp, file.relative));
          ensureDir(path.dirname(destination));
          fs.copyFileSync(file.sourcePath, destination);
          downloadedBytes += file.size;
        }
      } else {
        const tree = remoteTree || await this.readRepositoryTree(repository, token);
        const files = (tree.tree || []).filter((entry) => entry.type === 'blob' && (entry.path === document.path || entry.path.startsWith(`${remoteRoot}/`)));
        validateRemoteTree(files, remoteRoot);
        for (const entry of files) {
          const relative = entry.path === document.path ? DOCUMENT_META_FILE : entry.path.slice(remoteRoot.length + 1);
          if (!isShareableRelative(relative)) continue;
          const destination = assertInside(temp, path.join(temp, relative));
          ensureDir(path.dirname(destination));
          const body = await this.readRemoteFileBytes(entry.path, MAX_SHARED_FILE_BYTES, entry.sha, repository, token);
          downloadedBytes += body.length;
          if (downloadedBytes > MAX_SHARED_DOCUMENT_BYTES) throw new Error(`远程共享文档总大小不能超过 ${formatMiB(MAX_SHARED_DOCUMENT_BYTES)}。`);
          fs.writeFileSync(destination, body);
        }
      }
      if (downloadedBytes > MAX_SHARED_DOCUMENT_BYTES) throw new Error(`远程共享文档总大小不能超过 ${formatMiB(MAX_SHARED_DOCUMENT_BYTES)}。`);
      if (!fs.existsSync(path.join(temp, DOCUMENT_META_FILE))) throw new Error(`远程文档元数据缺失：${document.path}`);
      let incomingMetadata;
      try { incomingMetadata = JSON.parse(fs.readFileSync(path.join(temp, DOCUMENT_META_FILE), 'utf8')); }
      catch { throw new Error(`远程文档元数据不是有效 JSON：${document.path}`); }
      validateRemoteMetadata(incomingMetadata, document.path);
      if (String(incomingMetadata.documentId) !== documentId) throw new Error(`远程文档 ID 与目录不一致：${document.path}`);
      metadata = { ...document, ...incomingMetadata, path: document.path, metadataPath: document.metadataPath || document.path, remoteSha: document.remoteSha || '' };
      const isMultipartParent = metadata.multiPartRole === 'parent' || metadata.documentType === 'multipart-parent';
      const existingMetadata = existing?.metadataFile ? readJsonFile(existing.metadataFile) : null;
      const incomingUpdatedAt = String(incomingMetadata.updatedAt || incomingMetadata.uploadedAt || '');
      const remoteChanged = Boolean(existing && (
        (document.remoteSha && String(document.remoteSha) !== String(existing.sharedRemoteSha || ''))
        || (incomingMetadata.contentSha256 && String(incomingMetadata.contentSha256) !== String(existingMetadata?.contentSha256 || ''))
        || (incomingUpdatedAt && incomingUpdatedAt !== String(existing.remoteUpdatedAt || ''))
      ));
      const localModified = existing?.artifactDir && fs.existsSync(existing.artifactDir)
        ? localSharedDocumentModified(existing.artifactDir, existingMetadata, isMultipartParent)
        : false;
      const mountIds = [...new Set([...(Array.isArray(existing?.sharedMountIds) ? existing.sharedMountIds : [existing?.sharedMountId]), mount.id].filter(Boolean).map(String))];
      if (existing && localModified) {
        const preserved = { ...existing, sharedRepository: repository, sharedMountId: mount.id, sharedMountIds: mountIds, remoteUpdatedAt: incomingMetadata.updatedAt || incomingMetadata.uploadedAt || existing.remoteUpdatedAt || '', remoteState: remoteChanged ? 'sync-conflict' : 'local-modified', updatedAt: new Date().toISOString() };
        fs.rmSync(temp, { recursive: true, force: true });
        this.store.set('tasks', existing.id, preserved);
        return preserved;
      }
      if (existing && !remoteChanged && fs.existsSync(target)) {
        const preserved = { ...existing, sharedRepository: repository, sharedMountId: mount.id, sharedMountIds: mountIds, remoteState: 'active', updatedAt: new Date().toISOString() };
        fs.rmSync(temp, { recursive: true, force: true });
        this.store.set('tasks', existing.id, preserved);
        return preserved;
      }
      const incomingMarkdownName = findMarkdown(temp, incomingMetadata.entryMarkdown || (isMultipartParent ? 'index.md' : 'summary.md'));
      if (!incomingMarkdownName) throw new Error(`远程文档缺少 Markdown：${document.path}`);
      const previous = `${target}.previous-${Date.now().toString(36)}`;
      if (fs.existsSync(target)) fs.renameSync(target, previous);
      try {
        fs.renameSync(temp, target);
        fs.rmSync(previous, { recursive: true, force: true });
        installed = true;
      } catch (error) {
        fs.rmSync(target, { recursive: true, force: true });
        if (fs.existsSync(previous)) fs.renameSync(previous, target);
        throw error;
      }
      const markdownName = incomingMarkdownName;
      const now = new Date().toISOString();
      const task = {
        ...(existing || {}),
        id: taskId,
        collectionId: mount.collectionId,
        bvid: metadata.bvid || '',
        title: metadata.title || path.basename(remoteRoot),
        owner: metadata.owner || '',
        duration: Number(metadata.duration || 0),
        url: metadata.bvid ? `https://www.bilibili.com/video/${metadata.bvid}` : '',
        status: 'done',
        enabled: false,
        knowledgeActive: true,
        sourceType: isMultipartParent ? 'shared-bilibili-multipart-summary' : 'shared-bilibili',
        sharedMountId: mount.id,
        sharedMountIds: mountIds,
        sharedRepository: repository,
        sharedDocumentId: metadata.documentId || documentId,
        sharedRemotePath: document.path,
        sharedRemoteSha: document.remoteSha || '',
        remoteState: 'active',
        remoteUpdatedAt: metadata.updatedAt || metadata.uploadedAt || '',
        artifactDir: target,
        outputMarkdown: path.join(target, markdownName),
        metadataFile: path.join(target, DOCUMENT_META_FILE),
        allowedRoot: collection.collectionRoot,
        workspaceId: collection.workspaceId,
        workspaceRoot: collection.workspaceRoot,
        multiPartParentId: isMultipartParent ? taskId : '',
        parentDocumentId: isMultipartParent ? documentId : (metadata.parentDocumentId || ''),
        multiPartId: metadata.partId || '',
        multiPartRole: metadata.partId ? 'part' : (metadata.parentDocumentId ? 'parent' : ''),
        completedAt: metadata.completedAt || now,
        importedAt: now,
        updatedAt: now
      };
      this.store.set('tasks', task.id, task);
      if (isMultipartParent) this.importMultipartParts(metadata, target, task, document.path, now);
      const currentCollection = this.store.getCollectionById(collection.id);
      if (currentCollection) this.store.set('collections', collection.id, { ...currentCollection, videoCount: this.store.listTasks({ collectionId: collection.id }).filter((item) => item.status === 'done').length, updatedAt: now });
      return task;
    } catch (error) {
      if (!installed) fs.rmSync(temp, { recursive: true, force: true });
      throw error;
    }
  }

  importMultipartParts(metadata, parentRoot, parentTask, remotePath, now) {
    const parts = Array.isArray(metadata.parts) ? metadata.parts : readMultipartManifest(parentRoot);
    const existing = this.store.listTasks({ collectionId: parentTask.collectionId }).filter((task) => task.multiPartParentId === parentTask.id && task.multiPartRole === 'part');
    const nextIds = new Set();
    for (const part of parts) {
      const cid = String(part.cid || part.multiPartId || '').trim();
      if (!cid) continue;
      const previous = existing.find((task) => String(task.cid || task.multiPartId || '') === cid);
      const id = previous?.id || `${parentTask.id}:part:${cid}`;
      nextIds.add(id);
      const partRoot = assertInside(parentRoot, path.join(parentRoot, 'parts', `cid-${safeName(cid, 'part', 40)}`));
      const markdown = findMarkdown(partRoot, 'summary.md');
      if (!markdown) continue;
      this.store.set('tasks', id, {
        id,
        collectionId: parentTask.collectionId,
        bvid: parentTask.bvid,
        title: part.title || `${parentTask.title} P${part.page || ''}`.trim(),
        owner: parentTask.owner,
        duration: Number(part.duration || 0),
        url: parentTask.url ? `${parentTask.url}?p=${Number(part.page || 1)}` : '',
        status: 'done',
        enabled: false,
        knowledgeActive: true,
        sourceType: 'shared-bilibili-multipart-summary',
        sharedMountId: parentTask.sharedMountId,
        sharedMountIds: parentTask.sharedMountIds || [parentTask.sharedMountId].filter(Boolean),
        sharedRepository: parentTask.sharedRepository,
        sharedDocumentId: parentTask.sharedDocumentId,
        sharedRemotePath: remotePath,
        sharedRemoteSha: parentTask.sharedRemoteSha,
        remoteState: 'active',
        remoteUpdatedAt: parentTask.remoteUpdatedAt,
        artifactDir: partRoot,
        outputMarkdown: path.join(partRoot, markdown),
        metadataFile: parentTask.metadataFile,
        allowedRoot: parentTask.allowedRoot,
        workspaceId: parentTask.workspaceId,
        workspaceRoot: parentTask.workspaceRoot,
        multiPartParentId: parentTask.id,
        parentDocumentId: parentTask.sharedDocumentId,
        multiPartId: cid,
        multiPartRole: 'part',
        cid,
        page: Number(part.page || 0),
        part: String(part.part || ''),
        completedAt: part.completedAt || parentTask.completedAt || now,
        importedAt: parentTask.importedAt || now,
        updatedAt: now
      });
    }
    for (const task of existing) if (!nextIds.has(task.id)) this.store.delete('tasks', task.id);
  }

  requireOrCreateCollection(collectionId, name) {
    if (collectionId) {
      const collection = this.store.getCollectionById(String(collectionId));
      if (!collection || collection.collectionKind !== 'shared') throw new Error('请选择共享用户下的共享收藏夹。');
      return collection;
    }
    const normalized = String(name || '').trim();
    if (!normalized) throw new Error('共享收藏夹名称不能为空。');
    const existing = this.store.listCollections().find((item) => item.collectionKind === 'shared' && item.name === normalized);
    if (existing) return existing;
    this.ensureSharedUser();
    const workspace = this.store.getDefaultWorkspace();
    const dirs = collectionDirs(workspace.root, SHARED_USER_NAME, normalized);
    const now = new Date().toISOString();
    return this.store.upsertCollection({ id: `shared:${crypto.randomUUID()}`, userId: SHARED_USER_ID, userName: SHARED_USER_NAME, name: normalized, storageName: normalized, label: 'shared', internal: true, collectionKind: 'shared', workspaceId: workspace.id, workspaceRoot: workspace.root, collectionRoot: dirs.root, videosDir: dirs.root, exportDir: dirs.exports, videoCount: 0, createdAt: now, updatedAt: now });
  }

  ensureSharedUser() { this.store.upsertUser({ id: SHARED_USER_ID, mid: SHARED_USER_ID, name: SHARED_USER_NAME, internal: true, shared: true }); }

  ensureRepositoryRegistry() {
    const current = this.repository;
    const settings = this.store.get('settings', 'sharedRepositories') || {};
    const repositories = Array.isArray(settings.repositories) ? [...settings.repositories] : [];
    let changed = false;
    const add = (repository, builtIn) => {
      if (repositories.some((item) => sameRepository(item, repository))) return;
      repositories.push({
        ...repository,
        verified: builtIn,
        builtIn,
        health: 'unchecked',
        verifiedAt: builtIn ? 'built-in' : '',
        lastCheckedAt: '',
        addedAt: new Date().toISOString()
      });
      changed = true;
    };
    add(this.defaultRepository, true);
    add(current, sameRepository(current, this.defaultRepository));
    if (!changed) return;
    this.store.set('settings', 'sharedRepositories', { id: 'sharedRepositories', repositories });
    this.store.save();
  }

  registeredRepositories() {
    const settings = this.store.get('settings', 'sharedRepositories') || {};
    const repositories = Array.isArray(settings.repositories) ? settings.repositories : [];
    return repositories.map((item) => {
      let repository;
      try { repository = normalizeRepository(item); }
      catch { return null; }
      return {
        ...repository,
        verified: item.verified === true,
        builtIn: item.builtIn === true,
        health: String(item.health || 'unchecked'),
        verifiedAt: String(item.verifiedAt || ''),
        lastCheckedAt: String(item.lastCheckedAt || ''),
        error: String(item.error || '')
      };
    }).filter(Boolean).sort((left, right) => {
      if (sameRepository(left, this.repository)) return -1;
      if (sameRepository(right, this.repository)) return 1;
      return `${left.owner}/${left.name}`.localeCompare(`${right.owner}/${right.name}`, 'en');
    });
  }

  repositoryHealth(repositoryInput = this.repository) {
    let repository;
    try { repository = normalizeRepository(repositoryInput); }
    catch { return { status: 'invalid', checkedAt: '', error: '共享仓库配置无效。' }; }
    const entry = this.registeredRepositories().find((item) => sameRepository(item, repository));
    return {
      status: entry?.health || 'unchecked',
      checkedAt: entry?.lastCheckedAt || '',
      verified: entry?.verified === true,
      error: entry?.error || ''
    };
  }

  assertVerifiedRepository(repositoryInput = this.repository) {
    const repository = normalizeRepository(repositoryInput);
    const entry = this.registeredRepositories().find((item) => sameRepository(item, repository));
    if (!entry?.verified) throw new Error(`共享仓库 ${repository.owner}/${repository.name} 尚未通过星藏家规范校验，请先点击“检测并连接”。`);
    return repository;
  }

  saveVerifiedRepository(repositoryInput, contract) {
    const repository = normalizeRepository(repositoryInput);
    const settings = this.store.get('settings', 'sharedRepositories') || {};
    const repositories = Array.isArray(settings.repositories) ? [...settings.repositories] : [];
    const index = repositories.findIndex((item) => {
      try { return sameRepository(item, repository); } catch { return false; }
    });
    const previous = index >= 0 ? repositories[index] : {};
    const now = new Date().toISOString();
    const record = {
      ...previous,
      ...repository,
      verified: true,
      builtIn: previous.builtIn === true || sameRepository(repository, this.defaultRepository),
      health: 'available',
      verifiedAt: previous.verifiedAt && previous.verifiedAt !== 'built-in' ? previous.verifiedAt : now,
      lastCheckedAt: now,
      addedAt: previous.addedAt || now,
      error: '',
      contract: {
        schemaVersion: Number(contract?.schemaVersion || 0),
        type: String(contract?.type || ''),
        capabilities: [...(contract?.capabilities || [])]
      }
    };
    if (index >= 0) repositories[index] = record;
    else repositories.push(record);
    this.store.set('settings', 'sharedRepositories', { id: 'sharedRepositories', repositories });
    this.saveRepository(repository);
    this.store.save();
    return record;
  }

  updateRepositoryHealth(repositoryInput, health, error = null) {
    let repository;
    try { repository = normalizeRepository(repositoryInput); }
    catch { return; }
    const settings = this.store.get('settings', 'sharedRepositories') || {};
    const repositories = Array.isArray(settings.repositories) ? [...settings.repositories] : [];
    const index = repositories.findIndex((item) => {
      try { return sameRepository(item, repository); } catch { return false; }
    });
    if (index < 0) return;
    repositories[index] = {
      ...repositories[index],
      ...repository,
      health: String(health || 'unchecked'),
      lastCheckedAt: new Date().toISOString(),
      error: error ? String(error.message || error).slice(0, 500) : ''
    };
    this.store.set('settings', 'sharedRepositories', { id: 'sharedRepositories', repositories });
    this.store.save();
  }

  assertRepositoryChangeAllowed() {
    if (this.activeUpload) throw new Error('共享文档正在上传，不能切换或创建仓库。请等待完成或先中止上传。');
  }

  saveRepository(repository) {
    const normalized = normalizeRepository(repository);
    this.store.set('settings', 'sharedRepository', { id: 'sharedRepository', ...normalized, updatedAt: new Date().toISOString() });
    this.store.save();
    return normalized;
  }

  optionalAuthToken() {
    const settings = this.store.get('settings', 'sharedGithub') || {};
    const raw = process.env.STAR_OWNER_GITHUB_TOKEN || '';
    try { return validateGithubToken(raw || (settings.encryptedToken ? this.decryptSecret(settings.encryptedToken) : '')); }
    catch { return ''; }
  }

  async inspectRepository(repositoryInput, token = '', signal = null) {
    const requested = parseRepositoryInput(repositoryInput);
    const info = await this.githubRequest(`/repos/${requested.owner}/${requested.name}`, { token, signal });
    const repository = repositoryFromApi(info, requested);
    if (repository.private && !token) throw new Error('该共享仓库不是公开仓库，请先授权有访问权限的 GitHub 账户。');
    return repository;
  }

  async validateRepositoryContract(repositoryInput, token = '', signal = null) {
    const repository = normalizeRepository(repositoryInput);
    let marker;
    try {
      marker = await this.readRemoteFile(REPOSITORY_MARKER_FILE, MAX_REMOTE_METADATA_BYTES, repository, token, signal);
    } catch (error) {
      if (error.status === 404 || /not found|404/i.test(String(error.message || error))) {
        throw new Error(`该仓库不是星藏家共享文档仓库：缺少 ${REPOSITORY_MARKER_FILE}。请连接由星藏家创建或按共享规范初始化的仓库。`);
      }
      throw error;
    }
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) throw new Error(`${REPOSITORY_MARKER_FILE} 不是有效的共享仓库配置。`);
    if (Number(marker.schemaVersion || 0) !== REPOSITORY_SCHEMA_VERSION) throw new Error(`共享仓库规范版本不兼容：需要 schemaVersion ${REPOSITORY_SCHEMA_VERSION}。`);
    if (String(marker.type || '') !== 'star-owner-shared-knowledge') throw new Error('仓库标记类型不正确，不允许作为星藏家共享仓库连接。');
    const markerRepository = String(marker.repository || '').toLowerCase();
    const expectedRepository = `${repository.owner}/${repository.name}`.toLowerCase();
    if (markerRepository !== expectedRepository) throw new Error(`${REPOSITORY_MARKER_FILE} 声明的仓库为 ${marker.repository || '空'}，与当前仓库 ${repository.owner}/${repository.name} 不一致。`);
    if (String(marker.defaultBranch || '') !== String(repository.branch || 'main')) throw new Error(`共享仓库标记的默认分支与 GitHub 实际默认分支不一致（${marker.defaultBranch || '空'} / ${repository.branch}）。`);
    const capabilities = new Set(Array.isArray(marker.capabilities) ? marker.capabilities.map(String) : []);
    const missing = REQUIRED_REPOSITORY_CAPABILITIES.filter((item) => !capabilities.has(item));
    if (missing.length) throw new Error(`共享仓库缺少应用需要的能力标记：${missing.join('、')}。`);
    return {
      schemaVersion: REPOSITORY_SCHEMA_VERSION,
      type: 'star-owner-shared-knowledge',
      repository: `${repository.owner}/${repository.name}`,
      defaultBranch: repository.branch,
      capabilities: [...capabilities]
    };
  }

  async resolveCatalogGithubLogins(documents, token = '') {
    const pending = new Map();
    for (const document of documents) {
      if (document.invalid) continue;
      const contributorId = String(document.contributorGithubId || String(document.path || '').split('/')[0] || '').trim();
      document.contributorGithubId = contributorId;
      const declaredLogin = String(document.contributorGithubLogin || '').trim();
      if (declaredLogin) {
        document.contributorGithubLogin = declaredLogin;
        if (contributorId) this.githubLoginCache.set(contributorId, declaredLogin);
        continue;
      }
      if (!/^\d+$/.test(contributorId)) continue;
      if (this.githubLoginCache.has(contributorId)) document.contributorGithubLogin = this.githubLoginCache.get(contributorId);
      else pending.set(contributorId, null);
    }
    for (const contributorId of pending.keys()) {
      let login = '';
      try {
        const profile = await this.githubRequest(`/user/${encodeURIComponent(contributorId)}`, { token });
        login = String(profile?.login || '').trim();
      } catch {}
      this.githubLoginCache.set(contributorId, login);
      for (const document of documents) if (String(document.contributorGithubId || '') === contributorId && !document.contributorGithubLogin) document.contributorGithubLogin = login;
    }
  }

  repositoryRole(repository = this.repository, authState = this.state()) {
    const sameId = repository.ownerId && authState.userId && String(repository.ownerId) === String(authState.userId);
    const sameLogin = repository.owner && authState.login && String(repository.owner).toLowerCase() === String(authState.login).toLowerCase();
    return sameId || (!repository.ownerId && sameLogin) ? 'owner' : 'contributor';
  }

  async runOperation(seed, callback) {
    if (this.activeOperation) throw new Error(`共享工具正在执行“${this.activeOperation.message || this.activeOperation.type}”，请等待当前操作完成。`);
    this.activeOperation = {
      id: `shared-operation:${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      type: String(seed?.type || 'operation'),
      status: 'running',
      stage: 'starting',
      progress: 0,
      current: 0,
      total: 0,
      message: String(seed?.message || '正在执行共享工具操作...'),
      startedAt: new Date().toISOString()
    };
    this.reportOperation({}, true);
    let finished;
    try {
      const result = await callback(this.activeOperation);
      this.reportOperation({ status: 'completed', stage: 'completed', progress: 1, message: operationCompletedMessage(this.activeOperation.type) }, true);
      finished = publicOperation(this.activeOperation);
      return result;
    } catch (error) {
      this.reportOperation({ status: 'failed', stage: 'failed', message: error.message || String(error) }, true);
      finished = publicOperation(this.activeOperation);
      throw error;
    } finally {
      this.activeOperation = null;
      this.emit({ type: 'shared-operation-finished', operation: finished, sharedKnowledge: this.state() });
    }
  }

  reportOperation(patch = {}, force = false) {
    if (!this.activeOperation) return;
    Object.assign(this.activeOperation, patch, { updatedAt: new Date().toISOString() });
    this.activeOperation.progress = Math.max(0, Math.min(1, Number(this.activeOperation.progress || 0)));
    const now = Date.now();
    if (!force && now - this.lastOperationEmission < 80) return;
    this.lastOperationEmission = now;
    this.emitState('shared-operation-progress', { operation: publicOperation(this.activeOperation) });
  }

  reportUpload(patch = {}, force = false) {
    if (!this.activeUpload) return;
    Object.assign(this.activeUpload, patch, { updatedAt: new Date().toISOString() });
    this.activeUpload.progress = Math.max(0, Math.min(1, Number(this.activeUpload.progress || 0)));
    const now = Date.now();
    if (!force && now - this.lastUploadEmission < 100) return;
    this.lastUploadEmission = now;
    this.emitState('shared-upload-progress', { upload: publicUpload(this.activeUpload) });
  }

  isSharedExcluded(collectionId, remotePath, repository = this.repository) {
    return Boolean(this.store.get('sharedExclusions', sharedExclusionId(collectionId, remotePath, repository))
      || this.store.get('sharedExclusions', sharedExclusionId(collectionId, remotePath)));
  }

  clearSharedExclusions(collectionId, remotePaths = [], repository = this.repository) {
    for (const remotePath of remotePaths) {
      this.store.delete('sharedExclusions', sharedExclusionId(collectionId, remotePath, repository));
      this.store.delete('sharedExclusions', sharedExclusionId(collectionId, remotePath));
    }
  }

  normalizeSharedMountRecords(preferredMountId = '') {
    const mounts = this.store.list('sharedMounts');
    if (!mounts.length) return '';
    const groups = new Map();
    const survivors = new Map();
    const usedIds = new Set();
    let preferredTarget = '';
    for (const mount of mounts) {
      let repository;
      try { repository = normalizeRepository(mount.repository || DEFAULT_REPOSITORY); }
      catch { repository = { ...DEFAULT_REPOSITORY }; }
      const source = { ...mount, repository };
      const paths = [...new Set((mount.remotePaths || []).map(String).filter(Boolean))];
      const pathGroups = new Map();
      for (const remotePath of paths) {
        const remotePrefix = remoteCollectionPrefixForPath(remotePath) || mountRemoteCollectionPrefix(source);
        if (!pathGroups.has(remotePrefix)) pathGroups.set(remotePrefix, []);
        pathGroups.get(remotePrefix).push(remotePath);
      }
      if (!pathGroups.size) pathGroups.set(mountRemoteCollectionPrefix(source), []);
      for (const [remotePrefix, remotePaths] of pathGroups) {
        if (!remotePrefix) continue;
        const key = `${String(mount.collectionId || '')}|${repositoryIdentity(repository)}|${remotePrefix}`;
        if (!groups.has(key)) groups.set(key, {
          key,
          collectionId: String(mount.collectionId || ''),
          repository,
          remotePrefix,
          remotePaths: new Set(),
          sources: [],
          collectionScope: false
        });
        const group = groups.get(key);
        for (const remotePath of remotePaths) group.remotePaths.add(remotePath);
        group.sources.push(source);
        const sourcePrefix = normalizeRemotePrefix(source.remotePrefix || '');
        if (source.scope === 'collection' && remotePrefixCovers(sourcePrefix, remotePrefix)) group.collectionScope = true;
      }
    }
    const byCreated = (left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')) || String(left.id).localeCompare(String(right.id));
    for (const group of [...groups.values()].sort((left, right) => left.key.localeCompare(right.key))) {
      const sources = [...group.sources].sort((left, right) => {
        const preferred = Number(String(right.id) === String(preferredMountId)) - Number(String(left.id) === String(preferredMountId));
        return preferred || byCreated(left, right);
      });
      const reusable = sources.find((source) => !usedIds.has(String(source.id)));
      const id = reusable ? String(reusable.id) : `mount:collection-${hash(group.key)}`;
      usedIds.add(id);
      const source = reusable || sources[0] || {};
      const remotePaths = [...group.remotePaths].sort();
      const scope = group.collectionScope ? 'collection' : 'documents';
      const unchangedShape = sources.length === 1
        && String(source.remotePrefix || '') === group.remotePrefix
        && String(source.scope || 'documents') === scope
        && [...new Set((source.remotePaths || []).map(String))].sort().join('\n') === remotePaths.join('\n');
      const survivor = {
        ...source,
        id,
        collectionId: group.collectionId,
        scope,
        remotePrefix: group.remotePrefix,
        remotePaths,
        remoteCollectionPrefix: group.remotePrefix,
        remoteCollectionName: source.remoteCollectionName || remoteCollectionFallbackName(group.remotePrefix),
        repository: { ...group.repository },
        createdAt: sources.reduce((value, item) => !value || String(item.createdAt || '') < value ? String(item.createdAt || value) : value, ''),
        lastSyncedAt: sources.reduce((value, item) => latestIso(value, item.lastSyncedAt), ''),
        lastCheckedAt: sources.reduce((value, item) => latestIso(value, item.lastCheckedAt), ''),
        updatedAt: sources.reduce((value, item) => latestIso(value, item.updatedAt), ''),
        remoteFingerprint: unchangedShape ? source.remoteFingerprint : ''
      };
      survivors.set(id, survivor);
      if (!preferredTarget && sources.some((item) => String(item.id) === String(preferredMountId))) preferredTarget = id;
    }
    let changed = false;
    for (const mount of mounts) {
      if (!survivors.has(String(mount.id))) {
        this.store.delete('sharedMounts', mount.id);
        changed = true;
      }
    }
    for (const mount of survivors.values()) {
      const original = mounts.find((item) => String(item.id) === String(mount.id));
      if (!original || JSON.stringify(original) !== JSON.stringify(mount)) {
        this.store.set('sharedMounts', mount.id, mount);
        changed = true;
      }
    }
    const survivingMounts = [...survivors.values()];
    for (const task of this.store.list('tasks').filter((item) => ['shared-bilibili', 'shared-bilibili-multipart-summary'].includes(item.sourceType))) {
      const matching = survivingMounts.filter((mount) => String(mount.collectionId) === String(task.collectionId)
        && sameRepository(mount.repository || DEFAULT_REPOSITORY, task.sharedRepository || DEFAULT_REPOSITORY)
        && mountCoversPath(mount, task.sharedRemotePath));
      const mountIds = matching.map((mount) => String(mount.id));
      const primary = mountIds.includes(String(preferredMountId || '')) ? String(preferredMountId) : (mountIds.at(-1) || '');
      const currentIds = [...new Set((Array.isArray(task.sharedMountIds) ? task.sharedMountIds : [task.sharedMountId]).filter(Boolean).map(String))];
      if (currentIds.join('\n') !== mountIds.join('\n') || String(task.sharedMountId || '') !== primary) {
        this.store.set('tasks', task.id, { ...task, sharedMountIds: mountIds, sharedMountId: primary, updatedAt: new Date().toISOString() });
        changed = true;
      }
    }
    if (changed) this.store.save();
    const preferred = String(preferredMountId || '');
    if (preferred && survivors.has(preferred)) return preferred;
    return preferredTarget || preferred;
  }

  isCoveredByAnotherMount(currentMount, remotePath) {
    return this.store.list('sharedMounts').some((mount) => String(mount.id) !== String(currentMount.id)
      && String(mount.collectionId) === String(currentMount.collectionId)
      && sameRepository(mount.repository || DEFAULT_REPOSITORY, currentMount.repository || DEFAULT_REPOSITORY)
      && mountCoversPath(mount, remotePath));
  }

  async requireAuth() {
    const settings = this.store.get('settings', 'sharedGithub') || {};
    const raw = process.env.STAR_OWNER_GITHUB_TOKEN || '';
    const token = validateGithubToken(raw || (settings.encryptedToken ? this.decryptSecret(settings.encryptedToken) : ''));
    if (!token) throw new Error('请先点击“浏览器登录 GitHub”，或展开更多授权选项粘贴 Token。浏览远程目录无需登录，创建 Fork/PR 必须授权。');
    const user = settings.login && /^\d+$/.test(String(settings.userId || ''))
      ? { login: settings.login, id: settings.userId }
      : await this.githubRequest('/user', { token });
    return { token, user };
  }

  async ensureFork(login, token, repositoryInput = this.repository, signal = null) {
    const repository = normalizeRepository(repositoryInput);
    const pathName = `/repos/${login}/${repository.name}`;
    try {
      const existing = await this.githubRequest(pathName, { token, signal });
      if (existing?.fork === true && String(existing?.parent?.full_name || '').toLowerCase() === `${repository.owner}/${repository.name}`.toLowerCase()) return existing;
      throw new Error(`GitHub 账户 ${login} 已存在同名但不是共享仓库 Fork 的仓库，请重命名该仓库后再上传。`);
    }
    catch (error) {
      if (error.status !== 404) throw error;
      const fork = await this.githubRequest(`/repos/${repository.owner}/${repository.name}/forks`, { token, signal, method: 'POST', body: { default_branch_only: false } });
      return { ...fork, _createdByApplication: true };
    }
  }

  async waitForFork(fork, token, repositoryInput = this.repository, signal = null) {
    const repository = normalizeRepository(repositoryInput);
    if (this.requestOverride || !fork?._createdByApplication) return fork;
    const owner = fork.owner?.login || fork.owner;
    const repo = fork.name || repository.name;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      throwIfAborted(signal);
      try {
        const current = await this.githubRequest(`/repos/${owner}/${repo}`, { token, signal });
        if (current?.id) return current;
      } catch (error) {
        if (error.status !== 404 && error.status !== 409) throw error;
      }
      await abortableDelay(1500, signal);
    }
    throw new Error('GitHub Fork 尚未准备完成，请稍后重试共享上传。');
  }

  async findRepositoryFile(repositoryInput, pathName, token, signal = null) {
    const repository = normalizeRepository(repositoryInput);
    try { return await this.githubRequest(`/repos/${repository.owner}/${repository.name}/contents/${encodePath(pathName)}?ref=${encodeURIComponent(repository.branch)}`, { token, signal }); }
    catch (error) { if (error.status === 404) return null; throw error; }
  }

  async readRemoteJsonRecord(pathName, maxBytes, repositoryInput = this.repository, token = this.optionalAuthToken(), signal = null) {
    assertRemotePath(pathName);
    const repository = normalizeRepository(repositoryInput);
    const endpoint = `/repos/${repository.owner}/${repository.name}/contents/${encodePath(pathName)}?ref=${encodeURIComponent(repository.branch)}`;
    const payload = await this.githubRequest(endpoint, { token, signal });
    let encoded = String(payload.content || '');
    if (!encoded && payload.sha && !this.requestOverride) {
      const blob = await this.githubRequest(`/repos/${repository.owner}/${repository.name}/git/blobs/${encodeURIComponent(payload.sha)}`, { token, signal });
      encoded = String(blob.content || '');
    }
    if (!encoded) throw new Error(`远程 JSON 文件不可读取：${pathName}`);
    const body = Buffer.from(encoded.replace(/\s+/g, ''), 'base64');
    if (body.length > maxBytes) throw new Error(`远程 JSON 文件过大（上限 ${formatMiB(maxBytes)}）：${pathName}`);
    let value;
    try { value = JSON.parse(body.toString('utf8')); }
    catch { throw new Error(`远程 JSON 文件格式无效：${pathName}`); }
    return { value, sha: String(payload.sha || ''), size: body.length };
  }

  async readRemoteFile(pathName, maxBytes = MAX_SHARED_FILE_BYTES, repository = this.repository, token = this.optionalAuthToken(), signal = null) { return JSON.parse((await this.readRemoteFileBytes(pathName, maxBytes, '', repository, token, signal)).toString('utf8')); }
  async readRemoteFileBytes(pathName, maxBytes = MAX_SHARED_FILE_BYTES, blobSha = '', repositoryInput = this.repository, token = this.optionalAuthToken(), signal = null) {
    assertRemotePath(pathName);
    const repository = normalizeRepository(repositoryInput);
    const endpoint = blobSha && !this.requestOverride
      ? `/repos/${repository.owner}/${repository.name}/git/blobs/${encodeURIComponent(blobSha)}`
      : `/repos/${repository.owner}/${repository.name}/contents/${encodePath(pathName)}?ref=${encodeURIComponent(repository.branch)}`;
    const payload = await this.githubRequest(endpoint, { token, signal });
    if (!payload.content) throw new Error(`远程文件不是可读取内容：${pathName}`);
    const value = Buffer.from(String(payload.content).replace(/\s+/g, ''), 'base64');
    if (value.length > maxBytes) throw new Error(`远程共享文件过大（上限 ${formatMiB(maxBytes)}）：${pathName}`);
    return value;
  }

  async githubRequest(endpoint, options = {}) {
    throwIfAborted(options.signal);
    if (this.requestOverride) return this.requestOverride(endpoint, options);
    const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': `star-owner/${APPLICATION_VERSION}` };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.body) headers['content-type'] = 'application/json';
    const response = await fetch(`https://api.github.com${endpoint}`, { method: options.method || 'GET', headers, body: options.body ? JSON.stringify(options.body) : undefined, signal: combinedSignal(options.signal, 60000) });
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text.slice(0, 500) }; }
    if (!response.ok) { const error = new Error(`GitHub API ${response.status}: ${body.message || text.slice(0, 300)}`); error.status = response.status; throw error; }
    return body;
  }

  publicMount(mount) { return publicMount(mount); }
  emitState(type, detail = {}) { this.emit({ type, ...detail, sharedKnowledge: this.state() }); }
}

function stableDocumentId(task, collection) {
  const githubId = String(task.githubUserId || 'unknown-github-user');
  const bilibiliUid = String(task.sourceBilibiliUid || task.bilibiliUid || collection.bilibiliUid || collection.userId || 'unknown-bilibili-user');
  const sourceCollection = task.multiPartRole === 'parent'
    ? `multipart:${collection.id || 'unknown-collection'}`
    : task.singleTask
      ? `single:${collection.stableId || collection.id}`
      : `bilibili:${collection.mediaId || collection.id}`;
  return `doc-${hash(`v1|github:${githubId}|bilibili:${bilibiliUid}|collection:${sourceCollection}|bvid:${String(task.bvid || '').toUpperCase()}`)}`;
}

function githubCommitAuthor(user) {
  const login = String(user?.login || '').trim();
  const id = String(user?.id || '').trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login) || !/^\d+$/.test(id)) throw new Error('GitHub 账户身份不完整，无法生成可归属到贡献者的提交作者。请退出后重新授权。');
  return { name: login, email: `${id}+${login}@users.noreply.github.com` };
}
function remoteRootFor(task, collection, documentId) {
  const author = safeName(task.githubUserId || 'pending-github-id', 'pending-github-id', 80);
  const namespace = task.multiPartParentId || task.multiPartRole === 'parent' ? 'multipart' : task.singleTask ? 'single' : 'bilibili';
  const collectionSegment = `col-${hash(`${namespace}|${collection.id || 'unknown-collection'}`)}`;
  return `${author}/${namespace}/${collectionSegment}/${safeName(documentId, 'document', 150)}`;
}
function sharedExclusionId(collectionId, remotePath, repository = null) {
  const repositoryPart = repository ? `|${repositoryIdentity(repository)}` : '';
  return `shared-exclusion:${hash(`${String(collectionId || '')}|${String(remotePath || '')}${repositoryPart}`)}`;
}
function mountCoversPath(mount = {}, remotePath = '') {
  const pathName = String(remotePath || '');
  if (mount.scope === 'collection') return pathName.startsWith(`${String(mount.remotePrefix || '')}/`) || pathName === String(mount.remotePrefix || '');
  return (mount.remotePaths || []).map(String).includes(pathName);
}
function remoteCollectionPrefixForPath(remotePath = '') {
  const segments = String(remotePath || '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.at(-1) === DOCUMENT_META_FILE) segments.pop();
  if (segments.length >= 3) return segments.slice(0, 3).join('/');
  return segments.length > 1 ? segments.slice(0, -1).join('/') : segments.join('/');
}
function mountRemoteCollectionPrefix(mount = {}) {
  const explicit = String(mount.remoteCollectionPrefix || '').trim();
  if (explicit) return normalizeRemotePrefix(explicit);
  const remotePath = (mount.remotePaths || []).find(Boolean);
  if (remotePath) return remoteCollectionPrefixForPath(remotePath);
  const prefix = normalizeRemotePrefix(mount.remotePrefix || '');
  const segments = prefix.split('/').filter(Boolean);
  return segments.length >= 3 ? segments.slice(0, 3).join('/') : prefix;
}
function remoteCollectionFallbackName(remotePrefix = '') {
  return String(remotePrefix || '').split('/').filter(Boolean).at(-1) || '远程收藏夹';
}
function remoteMountDescription(document = {}, remotePrefix = '') {
  return {
    remoteCollectionPrefix: remotePrefix,
    remoteCollectionId: String(document.remoteCollectionId || ''),
    remoteCollectionName: String(document.collectionName || '').trim() || remoteCollectionFallbackName(remotePrefix),
    remoteContributorGithubLogin: String(document.contributorGithubLogin || ''),
    remoteContributorGithubId: String(document.contributorGithubId || ''),
    remoteBilibiliName: String(document.userName || ''),
    remoteBilibiliUid: String(document.bilibiliUid || document.userId || '')
  };
}
function groupRemoteCollectionDocuments(documents = []) {
  const groups = new Map();
  for (const document of documents) {
    const prefix = remoteCollectionPrefixForPath(document.path);
    if (!prefix) continue;
    if (!groups.has(prefix)) groups.set(prefix, { prefix, documents: [] });
    groups.get(prefix).documents.push(document);
  }
  return [...groups.values()];
}
function remotePrefixCovers(parent, child) {
  const parentPrefix = String(parent || '').replace(/\/+$/, '');
  const childPrefix = String(child || '').replace(/\/+$/, '');
  if (!parentPrefix || !childPrefix) return parentPrefix === childPrefix;
  return childPrefix === parentPrefix || childPrefix.startsWith(`${parentPrefix}/`);
}
function latestIso(left, right) {
  return String(left || '').localeCompare(String(right || '')) >= 0 ? String(left || '') : String(right || '');
}
function collectShareableFiles(root) {
  const result = [];
  const visit = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && isShareableRelative(path.relative(root, target))) result.push({ path: target, relative: path.relative(root, target).split(path.sep).join('/') });
    }
  };
  visit(root);
  return result;
}
function collectCheckoutDocumentFiles(checkoutRoot, remoteRoot) {
  const checkout = path.resolve(checkoutRoot);
  const sourceRoot = assertInside(checkout, path.join(checkout, ...String(remoteRoot || '').split('/')));
  if (!fs.existsSync(sourceRoot)) throw new Error(`共享仓库快照缺少远程文档目录：${remoteRoot}`);
  const rootStat = fs.lstatSync(sourceRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`共享仓库快照包含无效文档目录：${remoteRoot}`);
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const sourcePath = assertInside(sourceRoot, path.join(directory, entry.name));
      if (entry.isSymbolicLink()) throw new Error(`远程共享文档不允许符号链接：${path.relative(sourceRoot, sourcePath)}`);
      if (entry.isDirectory()) {
        visit(sourcePath);
        continue;
      }
      if (!entry.isFile()) throw new Error(`远程共享文档包含非常规文件：${path.relative(sourceRoot, sourcePath)}`);
      const relative = path.relative(sourceRoot, sourcePath).split(path.sep).join('/');
      const stat = fs.lstatSync(sourcePath);
      files.push({ sourcePath, relative, size: stat.size });
      if (files.length > MAX_SHARED_DOCUMENT_FILES) throw new Error(`远程共享文档文件数量超过 ${MAX_SHARED_DOCUMENT_FILES} 个。`);
    }
  };
  visit(sourceRoot);
  return files;
}
function buildSharedDocumentFiles(task, sourceRoot, multipartParts = []) {
  const root = path.resolve(sourceRoot);
  const files = [];
  const seen = new Set();
  const add = (sourcePath, relative) => {
    const source = assertInside(root, path.resolve(sourcePath));
    const normalized = String(relative || '').replace(/\\/g, '/');
    if (seen.has(normalized)) return;
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`共享文档包含无效文件：${normalized}`);
    seen.add(normalized);
    files.push({ relative: normalized, sourcePath: source, size: stat.size });
  };
  add(task.outputMarkdown, task.multiPartRole === 'parent' ? 'index.md' : 'summary.md');
  if (task.multiPartRole === 'parent') {
    for (const part of [...multipartParts].sort((a, b) => Number(a.page || 0) - Number(b.page || 0))) {
      const cid = String(part.cid || part.multiPartId || '').trim();
      if (!cid) throw new Error(`多P共享子任务缺少 CID：${part.title || part.id}`);
      add(part.outputMarkdown, `parts/cid-${safeName(cid, 'part', 40)}/summary.md`);
    }
  }
  for (const file of collectShareableFiles(root)) {
    if (!/\.(?:png|jpe?g|webp|avif|gif)$/i.test(file.relative)) continue;
    add(file.path, file.relative);
  }
  return files;
}
function isShareableRelative(relative) {
  const value = String(relative || '').replace(/\\/g, '/');
  const extension = path.extname(value).toLowerCase();
  return value && !value.split('/').includes('..') && !value.startsWith('/') && SHAREABLE_EXTENSIONS.has(extension) && !/(?:cookie|secret|api[-_]?key|token|credential|database|sqlite|session)/i.test(value);
}
function findMarkdown(root, preferred = '') {
  const files = collectShareableFiles(root).filter((file) => /\.md$/i.test(file.relative) && path.basename(file.relative) !== DOCUMENT_META_FILE);
  const preferredName = String(preferred || '').replace(/\\/g, '/').toLowerCase();
  return files.find((file) => file.relative.toLowerCase() === preferredName)?.relative
    || files.find((file) => !/^agent-draft(?:-\d+)?\.md$/i.test(path.basename(file.relative)))?.relative
    || files[0]?.relative
    || '';
}
function readJsonFile(file) {
  try { return file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch { return null; }
}
function localSharedDocumentModified(root, metadata, isMultipartParent = false) {
  if (!metadata?.contentSha256) return true;
  const markdown = findMarkdown(root, metadata.entryMarkdown || (isMultipartParent ? 'index.md' : 'summary.md'));
  if (!markdown || sha256(fs.readFileSync(path.join(root, markdown))) !== String(metadata.contentSha256)) return true;
  for (const [relative, expected] of Object.entries(metadata.assetSha256 || {})) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== String(expected)) return true;
  }
  return false;
}
function publicMount(mount) { const { remotePaths, ...safe } = mount || {}; return { ...safe, remoteDocumentCount: Array.isArray(remotePaths) ? remotePaths.length : 0 }; }
function publicCollection(collection) { const { cookieFile, collectionRoot, videosDir, exportDir, ...safe } = collection || {}; return safe; }
function publicSharedTask(task) { return { id: task.id, title: task.title, owner: task.owner || '', bvid: task.bvid, collectionId: task.collectionId, multiPartRole: task.multiPartRole || '', sharedDocumentId: task.sharedDocumentId, sharedRemotePath: task.sharedRemotePath, sharedRemoteSha: task.sharedRemoteSha || '', sharedRepository: task.sharedRepository || DEFAULT_REPOSITORY, sharedMountIds: task.sharedMountIds || (task.sharedMountId ? [task.sharedMountId] : []), remoteState: task.remoteState || 'active', remoteUpdatedAt: task.remoteUpdatedAt || '', updatedAt: task.updatedAt || '' }; }
function defaultMountName(prefix, documents) { return safeName(documents[0]?.collectionName || prefix.split('/').filter(Boolean).at(-1) || '共享收藏夹', '共享收藏夹', 80); }
function commonPrefix(paths) {
  if (!paths.length) return '';
  const roots = paths.map((value) => String(value || '').split('/').slice(0, -1));
  const output = [];
  for (let index = 0; index < roots[0].length; index += 1) {
    if (roots.every((segments) => segments[index] === roots[0][index])) output.push(roots[0][index]);
    else break;
  }
  return output.join('/');
}
function sharedDocumentsFingerprint(documents = []) {
  const records = (documents || []).map((document) => [
    String(document.path || ''),
    String(document.contentSha256 || document.remoteSha || document.updatedAt || document.uploadedAt || '')
  ]).sort((left, right) => left[0].localeCompare(right[0]));
  return sha256(Buffer.from(JSON.stringify(records), 'utf8'));
}
function safeBranch(value) { return safeName(value || 'user', 'user', 50).replace(/[^a-zA-Z0-9._-]+/g, '-'); }
function encodePath(value) { return String(value || '').split('/').map(encodeURIComponent).join('/'); }
function hash(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 24); }
function sha256(value) { return crypto.createHash('sha256').update(value || '').digest('hex'); }
function readMultipartManifest(root) {
  const file = path.join(root, 'metadata.json');
  if (!fs.existsSync(file)) return [];
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(value.parts) ? value.parts.map((part) => ({
      cid: String(part.cid || part.multiPartId || ''),
      page: Number(part.page || 0),
      part: String(part.part || ''),
      title: String(part.title || ''),
      duration: Number(part.duration || 0),
      completedAt: String(part.completedAt || ''),
      status: String(part.status || '')
    })) : [];
  } catch {
    return [];
  }
}
function buildPullRequestBody(documents) {
  const lines = ['由星藏家生成的 B站视频总结共享文档。', '', '本 PR 只包含已完成 Markdown 总结、必要元数据和图片资源，不包含原始视频、音频、ASR 缓存、Cookie 或 API Key。', '', `共 ${documents.length} 篇：`];
  let included = 0;
  for (const item of documents) {
    const line = `- ${item.documentId} · ${item.metadata.title || item.task.title}`;
    if (lines.join('\n').length + line.length > 56000) break;
    lines.push(line);
    included += 1;
  }
  if (included < documents.length) lines.push(`- ...另有 ${documents.length - included} 篇，详见本 PR 文件列表。`);
  return lines.join('\n');
}

function isShareableBilibiliTask(task = {}, collection = {}) {
  const sourceType = String(task.sourceType || '');
  if (!task.bvid || sourceType.startsWith('local-') || sourceType.startsWith('shared-')) return false;
  if (task.multiPartRole === 'part') return false;
  if (task.multiPartRole === 'parent') {
    return collection.collectionKind === 'bilibili-multipart' && collection.internal === true;
  }
  if (task.singleTask === true) {
    return collection.internal === true
      && !collection.mediaId
      && !['video-cache', 'multimodal-document', 'document-archive', 'bilibili-multipart', 'shared'].includes(collection.collectionKind);
  }
  return Boolean(collection.mediaId)
    && collection.internal !== true
    && !['video-cache', 'multimodal-document', 'document-archive', 'bilibili-multipart', 'shared'].includes(collection.collectionKind);
}

function validateShareableFiles(files) {
  if (!Array.isArray(files) || !files.length) throw new Error('共享文档没有可上传的 Markdown 或图片资源。');
  if (files.length > MAX_SHARED_DOCUMENT_FILES) throw new Error(`单篇共享文档最多包含 ${MAX_SHARED_DOCUMENT_FILES} 个文件。`);
  let total = 0;
  for (const file of files) {
    if (!isShareableRelative(file.relative)) throw new Error(`共享文档包含不允许的文件：${file.relative}`);
    const bytes = uploadFileSize(file);
    if (bytes > MAX_SHARED_FILE_BYTES) throw new Error(`共享文件过大（单文件上限 ${formatMiB(MAX_SHARED_FILE_BYTES)}）：${file.relative}`);
    total += bytes;
  }
  if (total > MAX_SHARED_DOCUMENT_BYTES) throw new Error(`单篇共享文档总大小不能超过 ${formatMiB(MAX_SHARED_DOCUMENT_BYTES)}。`);
  return { files: files.length, totalBytes: total };
}

function validateRemoteTree(entries, remoteRoot) {
  let total = 0;
  if (!Array.isArray(entries) || entries.length > MAX_SHARED_DOCUMENT_FILES) throw new Error(`远程共享文档文件数量超过 ${MAX_SHARED_DOCUMENT_FILES} 个。`);
  for (const entry of entries) {
    if (entry.type !== 'blob' || !String(entry.path || '').startsWith(`${remoteRoot}/`) && entry.path !== `${remoteRoot}/${DOCUMENT_META_FILE}`) throw new Error('远程共享目录结构不安全。');
    const relative = entry.path === `${remoteRoot}/${DOCUMENT_META_FILE}` ? DOCUMENT_META_FILE : String(entry.path).slice(`${remoteRoot}/`.length);
    if (!isShareableRelative(relative)) throw new Error(`远程共享文档包含不允许的文件：${relative}`);
    const size = Number(entry.size || 0);
    if (size > MAX_SHARED_FILE_BYTES) throw new Error(`远程共享文件过大：${relative}`);
    total += size;
  }
  if (total > MAX_SHARED_DOCUMENT_BYTES) throw new Error(`远程共享文档总大小不能超过 ${formatMiB(MAX_SHARED_DOCUMENT_BYTES)}。`);
}

function validateRemoteMetadata(metadata, metadataPath = '') {
  if (!metadata || typeof metadata !== 'object') throw new Error(`远程元数据不是对象：${metadataPath}`);
  if (metadata.sourceType !== 'bilibili-video-summary') throw new Error(`远程文档来源类型不受支持：${metadataPath}`);
  if (!String(metadata.documentId || '').trim() || /[\\/]/.test(String(metadata.documentId))) throw new Error(`远程文档 ID 无效：${metadataPath}`);
  if (metadata.entryMarkdown && (!isShareableRelative(metadata.entryMarkdown) || !/\.md$/i.test(String(metadata.entryMarkdown)))) throw new Error(`远程文档入口 Markdown 无效：${metadataPath}`);
  if (!['single-video', 'multipart-parent'].includes(String(metadata.documentType || 'single-video'))) throw new Error(`远程文档类型不受支持：${metadataPath}`);
  if (metadata.contributorGithubId && !/^\d+$/.test(String(metadata.contributorGithubId))) throw new Error(`远程贡献者 ID 无效：${metadataPath}`);
  return metadata;
}

function assertRemotePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => !part || part === '.' || part === '..') || normalized.length > 500) throw new Error('远程共享路径不安全。');
  return normalized;
}

function normalizeRemotePrefix(value) { return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '') ? assertRemotePath(String(value).replace(/\\/g, '/').replace(/\/+$/, '')) : ''; }
function formatMiB(bytes) { return `${Math.round(Number(bytes || 0) / 1024 / 1024)} MiB`; }

function validateGithubToken(value) {
  const token = String(value || '').trim();
  if (!token) throw new Error('GitHub Token 不能为空。');
  if (token.length > 512 || /[\u0000-\u001f\u007f]/.test(token)) throw new Error('GitHub Token 格式无效，不能包含控制字符或超过 512 个字符。');
  return token;
}

function normalizeRepository(value = {}) {
  const input = typeof value === 'string' ? parseRepositoryInput(value) : value;
  const owner = validateRepositoryOwner(input.owner || input.login || '');
  const name = validateRepositoryName(input.name || input.repo || '');
  const branch = validateRepositoryBranch(input.branch || input.defaultBranch || 'main');
  return {
    owner,
    ownerId: String(input.ownerId || input.owner?.id || '').trim(),
    name,
    branch,
    private: Boolean(input.private),
    htmlUrl: String(input.htmlUrl || input.html_url || `https://github.com/${owner}/${name}`)
  };
}

function parseRepositoryInput(value, branch = '') {
  if (value && typeof value === 'object') return { ...value, branch: branch || value.branch || value.defaultBranch || '' };
  let input = String(value || '').trim();
  input = input.replace(/^git@github\.com:/i, '').replace(/^https?:\/\/(?:www\.)?github\.com\//i, '').replace(/\.git(?:\/)?$/i, '').replace(/^\/+|\/+$/g, '');
  const parts = input.split('/').filter(Boolean);
  if (parts.length !== 2) throw new Error('共享仓库格式无效，请填写 owner/repository 或完整 GitHub 仓库链接。');
  return { owner: parts[0], name: parts[1], branch: branch ? validateRepositoryBranch(branch) : '' };
}

function repositoryFromApi(info = {}, fallback = {}) {
  const owner = info.owner?.login || fallback.owner;
  return normalizeRepository({
    owner,
    ownerId: info.owner?.id || fallback.ownerId || '',
    name: info.name || fallback.name,
    branch: fallback.branch || info.default_branch || 'main',
    private: Boolean(info.private),
    htmlUrl: info.html_url || `https://github.com/${owner}/${info.name || fallback.name}`
  });
}

function validateRepositoryOwner(value) {
  const owner = String(value || '').trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) throw new Error('GitHub 仓库主人名称无效。');
  return owner;
}

function validateRepositoryName(value) {
  const name = String(value || '').trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === '.' || name === '..') throw new Error('GitHub 仓库名称只能包含字母、数字、点、横线或下划线，长度不能超过 100。');
  return name;
}

function validateRepositoryBranch(value) {
  const branch = String(value || '').trim();
  if (!branch || branch.length > 120 || /(?:\.\.|[~^:?*\[\\\s]|^\/|\/$|\.lock$|\/\.)/.test(branch)) throw new Error('GitHub 默认分支名称无效。');
  return branch;
}

function repositoryIdentity(repository) {
  const value = normalizeRepository(repository);
  return `${value.owner}/${value.name}@${value.branch}`.toLowerCase();
}

function sameRepository(left, right) {
  try { return repositoryIdentity(left) === repositoryIdentity(right); }
  catch { return false; }
}

function publicUpload(upload) {
  const { controller, ...safe } = upload || {};
  return { ...safe };
}

function publicOperation(operation) { return operation ? { ...operation } : null; }

function operationCompletedMessage(type) {
  return ({
    'repository-link': '共享仓库已验证并连接。',
    'repository-check': '共享仓库检查完成。',
    'repository-create': '共享仓库创建和初始化完成。',
    'catalog-read': '远程目录读取完成。',
    mount: '远程文档挂载完成。',
    'mount-sync': '共享挂载同步完成。',
    'mount-sync-batch': '选中的共享挂载已同步。'
  })[type] || '共享工具操作已完成。';
}

function progressWithin(options = {}, ratio = 0) {
  const start = Number.isFinite(Number(options.progressStart)) ? Number(options.progressStart) : 0;
  const end = Number.isFinite(Number(options.progressEnd)) ? Number(options.progressEnd) : 1;
  return start + Math.max(0, Math.min(1, Number(ratio || 0))) * Math.max(0, end - start);
}

function uploadFileSize(file = {}) {
  if (Number.isFinite(Number(file.size)) && Number(file.size) >= 0) return Number(file.size);
  if (Buffer.isBuffer(file.buffer)) return file.buffer.length;
  if (file.sourcePath) {
    const stat = fs.statSync(file.sourcePath);
    if (!stat.isFile()) throw new Error(`共享资源不是普通文件：${file.relative || file.sourcePath}`);
    return stat.size;
  }
  return Buffer.byteLength(String(file.buffer || ''));
}

function readUploadFile(file = {}) {
  if (Buffer.isBuffer(file.buffer)) return file.buffer;
  if (file.sourcePath) return fs.readFileSync(file.sourcePath);
  return Buffer.from(file.buffer || '');
}

function sha256File(file) {
  return file ? sha256(fs.readFileSync(file)) : sha256(Buffer.alloc(0));
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('操作已中止。');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  throw error;
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'ABORTED';
}

function combinedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : (signal || timeout);
}

function abortableDelay(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      const error = new Error('操作已中止。');
      error.name = 'AbortError';
      error.code = 'ABORT_ERR';
      reject(error);
    }, { once: true });
  });
}

module.exports = { DEFAULT_REPOSITORY, DOCUMENT_META_FILE, SHARED_USER_ID, SHARED_USER_NAME, MAX_SHARED_FILE_BYTES, MAX_SHARED_DOCUMENT_FILES, MAX_SHARED_DOCUMENT_BYTES, MAX_SHARED_PR_DOCUMENTS, MAX_SHARED_PR_BYTES, SharedKnowledgeManager, collectShareableFiles, githubCommitAuthor, isShareableBilibiliTask, isShareableRelative, mountCoversPath, normalizeRepository, parseRepositoryInput, remoteRootFor, repositoryIdentity, sameRepository, sharedExclusionId, stableDocumentId, validateGithubToken, validateRepositoryName, validateShareableFiles };
