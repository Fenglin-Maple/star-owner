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
    this.lastUploadEmission = 0;
    this.ensureSharedUser();
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
      authenticated: Boolean(settings.encryptedToken || process.env.STAR_OWNER_GITHUB_TOKEN),
      login: String(settings.login || ''),
      userId: String(settings.userId || ''),
      authMethod: String(settings.authMethod || (settings.encryptedToken ? 'token' : '')),
      collections: this.store.listCollections().filter((item) => item.collectionKind === 'shared').map(publicCollection),
      mounts: this.store.list('sharedMounts').map(publicMount),
      documents: this.store.list('tasks').filter((task) => task.sourceType === 'shared-bilibili' || task.sourceType === 'shared-bilibili-multipart-summary').map(publicSharedTask),
      git: this.gitRuntime.state(),
      upload: this.activeUpload ? publicUpload(this.activeUpload) : null,
      limits: { maxUploadDocuments: MAX_SHARED_PR_DOCUMENTS, maxUploadBytes: MAX_SHARED_PR_BYTES }
    };
  }

  async setRepository(input = {}) {
    this.assertRepositoryChangeAllowed();
    const requested = parseRepositoryInput(input.repository || input.url || input.fullName || input, input.branch);
    const token = this.optionalAuthToken();
    const inspected = await this.inspectRepository(requested, token);
    this.saveRepository(inspected);
    this.emitState('shared-repository-changed', { repository: inspected });
    return { repository: inspected, role: this.repositoryRole(inspected, this.state()) };
  }

  async createRepository(input = {}) {
    this.assertRepositoryChangeAllowed();
    const auth = await this.requireAuth();
    const name = validateRepositoryName(input.name || 'star-owner-shared-knowledge');
    const description = String(input.description || '由星藏家管理的 B站视频总结共享文档仓库').trim().slice(0, 350);
    let created;
    try {
      created = await this.githubRequest('/user/repos', {
        token: auth.token,
        method: 'POST',
        body: { name, description, private: false, auto_init: true, has_issues: true, has_projects: false, has_wiki: false }
      });
    } catch (error) {
      if (error.status === 422) throw new Error(`GitHub 账户中可能已经存在名为 ${name} 的仓库，请换一个名称，或在“切换共享仓库”中直接保存该仓库。`);
      throw error;
    }
    const repository = repositoryFromApi(created, { owner: auth.user.login, name, branch: 'main' });
    if (String(repository.ownerId || '') !== String(auth.user.id || '')) throw new Error('GitHub 返回的仓库主人与当前授权账户不一致，已停止初始化。');
    const files = sharedRepositoryTemplate(repository);
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
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
    this.saveRepository(repository);
    this.emitState('shared-repository-created', { repository });
    return { repository, created: true, initializedFiles: files.length };
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

  async remoteCatalog(repositoryInput = null) {
    const repository = normalizeRepository(repositoryInput || this.repository);
    const token = this.optionalAuthToken();
    let tree;
    try {
      tree = await this.githubRequest(`/repos/${repository.owner}/${repository.name}/git/trees/${encodeURIComponent(repository.branch)}?recursive=1`, { token });
    } catch (error) {
      if (error.status === 409) return { repository: { ...repository }, branchSha: '', total: 0, documents: [], empty: true };
      throw error;
    }
    if (tree.truncated) throw new Error('共享仓库目录过大，GitHub 返回了不完整目录；请先缩小仓库后再读取。');
    const entries = Array.isArray(tree.tree) ? tree.tree : [];
    const result = [];
    for (const entry of entries.filter((item) => item.type === 'blob' && item.path.endsWith(`/${DOCUMENT_META_FILE}`))) {
      try {
        assertRemotePath(entry.path);
        const metadata = await this.readRemoteFile(entry.path, MAX_REMOTE_METADATA_BYTES, repository, token);
        validateRemoteMetadata(metadata, entry.path);
        result.push({ ...metadata, path: entry.path, metadataPath: entry.path, remoteSha: entry.sha, updatedAt: metadata.updatedAt || metadata.uploadedAt || '' });
      } catch (error) {
        result.push({ path: entry.path, metadataPath: entry.path, remoteSha: entry.sha, invalid: true, error: error.message || String(error) });
      }
    }
    result.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || String(a.path).localeCompare(String(b.path)));
    return { repository: { ...repository }, branchSha: tree.sha || '', total: result.length, documents: result };
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
        const document = this.prepareDocument({ ...tasks[index], githubUserId });
        if (documentIds.has(document.documentId)) throw new Error(`选中的文档存在重复共享身份：${document.documentId}。请保留同一来源的一条记录。`);
        documentIds.add(document.documentId);
        documents.push(document);
        totalBytes += document.totalBytes;
        if (totalBytes > MAX_SHARED_PR_BYTES) throw new Error(`本次共享提交总大小不能超过 ${formatMiB(MAX_SHARED_PR_BYTES)}。请减少文档数量或图片资源。`);
        this.reportUpload({ stage: 'preparing', progress: 0.03 + ((index + 1) / tasks.length) * 0.22, current: index + 1, message: `正在校验第 ${index + 1} / ${tasks.length} 篇文档...` });
      }

      const repository = await this.inspectRepository(this.repository, auth.token, controller.signal);
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
    // The renderer may only submit paths/prefixes. Re-read the authoritative catalog
    // here so stale or forged renderer metadata cannot make the app fetch arbitrary files.
    const catalog = await this.remoteCatalog();
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
    const scope = prefix ? 'collection' : 'documents';
    this.clearSharedExclusions(collection.id, documents.map((item) => item.path), repository);
    if (scope === 'collection') {
      const existing = this.store.list('sharedMounts').find((item) => item.collectionId === collection.id
        && item.scope === 'collection'
        && sameRepository(item.repository || DEFAULT_REPOSITORY, repository)
        && String(item.remotePrefix || '') === prefix);
      if (existing) {
        await this.syncMount(existing.id, catalog);
        return publicMount(this.store.get('sharedMounts', existing.id));
      }
    } else {
      const covered = this.store.list('sharedMounts')
        .filter((item) => item.collectionId === collection.id && sameRepository(item.repository || DEFAULT_REPOSITORY, repository))
        .map((item) => item.remotePaths || [])
        .flat();
      const coveredPaths = new Set(covered.map(String));
      documents = documents.filter((item) => !coveredPaths.has(String(item.path)));
      if (!documents.length) throw new Error('选中的远程文档已经挂载到当前共享收藏夹，无需重复挂载。');
    }
    const mount = {
      id: `mount:${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
      collectionId: collection.id,
      collectionName: collection.name,
      scope,
      remotePrefix: prefix || commonPrefix(documents.map((item) => item.path)),
      remotePaths: documents.map((item) => item.path),
      repository: { ...repository },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.store.set('sharedMounts', mount.id, mount);
    this.store.commit();
    try {
      await this.syncMount(mount.id, catalog);
    } catch (error) {
      this.rollbackNewMount(mount, collection, createdCollection);
      throw error;
    }
    this.emitState('shared-mount-created', { mountId: mount.id, collectionId: collection.id });
    return publicMount(this.store.get('sharedMounts', mount.id));
  }

  rollbackNewMount(mount, collection, createdCollection) {
    const tasks = this.store.listTasks({ collectionId: mount.collectionId }).filter((task) => task.sharedMountId === mount.id);
    for (const task of tasks) {
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
    const mount = this.store.get('sharedMounts', String(mountId || ''));
    if (!mount) throw new Error('共享挂载不存在。');
    const repository = normalizeRepository(mount.repository || DEFAULT_REPOSITORY);
    const catalog = catalogInput || await this.remoteCatalog(repository);
    if (catalog.repository && !sameRepository(catalog.repository, repository)) throw new Error('共享挂载目录来自其它 GitHub 仓库，已拒绝交叉同步。');
    const scope = mount.scope || 'documents';
    const documents = catalog.documents.filter((document) => {
      if (document.invalid || this.isSharedExcluded(mount.collectionId, document.path, repository)) return false;
      return scope === 'collection'
        ? (document.path.startsWith(`${mount.remotePrefix}/`) || document.path === mount.remotePrefix)
        : (mount.remotePaths || []).includes(document.path);
    });
    const currentPaths = new Set(documents.map((document) => document.path));
    const localTasks = this.store.listTasks({ collectionId: mount.collectionId }).filter((task) => {
      const mountIds = Array.isArray(task.sharedMountIds) ? task.sharedMountIds : [task.sharedMountId];
      return mountIds.map(String).includes(String(mount.id)) && ['shared-bilibili', 'shared-bilibili-multipart-summary'].includes(task.sourceType);
    });
    for (const document of documents) await this.importRemoteDocument(document, mount);
    for (const task of localTasks) {
      if (task.sharedRemotePath && !currentPaths.has(task.sharedRemotePath)) {
        if (this.isSharedExcluded(mount.collectionId, task.sharedRemotePath, repository)) {
          this.store.set('tasks', task.id, { ...task, remoteState: 'local-deleted', updatedAt: new Date().toISOString() });
        } else if (!this.isCoveredByAnotherMount(mount, task.sharedRemotePath)) {
          this.store.set('tasks', task.id, { ...task, remoteState: 'remote-deleted', remoteDeletedAt: task.remoteDeletedAt || new Date().toISOString(), updatedAt: new Date().toISOString() });
        }
      }
    }
    mount.remotePaths = [...new Set([...mount.remotePaths || [], ...documents.map((item) => item.path)])];
    mount.lastSyncedAt = new Date().toISOString();
    mount.updatedAt = mount.lastSyncedAt;
    this.store.set('sharedMounts', mount.id, mount);
    this.store.commit();
    this.emitState('shared-mount-synced', { mountId: mount.id, collectionId: mount.collectionId });
    return publicMount(mount);
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
    if (task.multiPartRole === 'parent') {
      const parts = this.store.listTasks({ collectionId: task.collectionId }).filter((item) => item.multiPartParentId === task.id && item.multiPartRole === 'part' && item.pageState !== 'removed');
      if (!parts.length || parts.some((item) => item.status !== 'done' || !item.outputMarkdown || !fs.existsSync(item.outputMarkdown))) {
        throw new Error(`多P父任务尚未完成全部 P，暂不能上传共享：${task.title || task.bvid}`);
      }
    }
    const collection = this.store.getCollectionById(task.collectionId) || {};
    if (!isShareableBilibiliTask(task, collection)) throw new Error(`只允许上传 B站视频总结产物：${task.title || task.id}`);
    const documentId = stableDocumentId(task, collection);
    const remoteRoot = remoteRootFor(task, collection, documentId);
    const sourceRoot = path.resolve(task.multiPartRole === 'parent' ? task.artifactDir : path.dirname(task.outputMarkdown));
    const files = collectShareableFiles(sourceRoot)
      .filter((file) => file.relative !== DOCUMENT_META_FILE)
      .map((file) => ({ relative: file.relative, sourcePath: file.path, size: fs.statSync(file.path).size }));
    validateShareableFiles(files);
    const preferredMarkdown = task.multiPartRole === 'parent' ? 'index.md' : 'summary.md';
    const markdownFile = files.find((file) => file.relative.toLowerCase() === preferredMarkdown) || files.find((file) => /\.md$/i.test(file.relative));
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
      files: files.map((item) => item.relative),
      contentSha256: sha256File(files.find((item) => /\.md$/i.test(item.relative))?.sourcePath),
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

  async importRemoteDocument(document, mount) {
    if (document.invalid) return null;
    const metadata = document;
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
      const tree = await this.githubRequest(`/repos/${repository.owner}/${repository.name}/git/trees/${encodeURIComponent(repository.branch)}?recursive=1`, { token });
      if (tree.truncated) throw new Error('共享仓库目录过大，GitHub 返回了不完整目录；无法安全导入该文档。');
      const files = (tree.tree || []).filter((entry) => entry.type === 'blob' && (entry.path === document.path || entry.path.startsWith(`${remoteRoot}/`)));
      validateRemoteTree(files, remoteRoot);
      let downloadedBytes = 0;
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
      if (!fs.existsSync(path.join(temp, DOCUMENT_META_FILE))) throw new Error(`远程文档元数据缺失：${document.path}`);
      let incomingMetadata;
      try { incomingMetadata = JSON.parse(fs.readFileSync(path.join(temp, DOCUMENT_META_FILE), 'utf8')); }
      catch { throw new Error(`远程文档元数据不是有效 JSON：${document.path}`); }
      validateRemoteMetadata(incomingMetadata, document.path);
      if (String(incomingMetadata.documentId) !== documentId) throw new Error(`远程文档 ID 与目录不一致：${document.path}`);
      const isMultipartParent = metadata.multiPartRole === 'parent' || metadata.documentType === 'multipart-parent';
      const remoteChanged = Boolean(existing?.sharedRemoteSha && document.remoteSha && document.remoteSha !== existing.sharedRemoteSha);
      const localModified = existing?.artifactDir && fs.existsSync(existing.artifactDir)
        ? localSharedDocumentModified(existing.artifactDir, existing.metadataFile ? readJsonFile(existing.metadataFile) : null, isMultipartParent)
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
      const incomingMarkdownName = findMarkdown(temp, isMultipartParent ? 'index.md' : 'summary.md');
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

  repositoryRole(repository = this.repository, authState = this.state()) {
    const sameId = repository.ownerId && authState.userId && String(repository.ownerId) === String(authState.userId);
    const sameLogin = repository.owner && authState.login && String(repository.owner).toLowerCase() === String(authState.login).toLowerCase();
    return sameId || (!repository.ownerId && sameLogin) ? 'owner' : 'contributor';
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

  async readRemoteFile(pathName, maxBytes = MAX_SHARED_FILE_BYTES, repository = this.repository, token = this.optionalAuthToken()) { return JSON.parse((await this.readRemoteFileBytes(pathName, maxBytes, '', repository, token)).toString('utf8')); }
  async readRemoteFileBytes(pathName, maxBytes = MAX_SHARED_FILE_BYTES, blobSha = '', repositoryInput = this.repository, token = this.optionalAuthToken()) {
    assertRemotePath(pathName);
    const repository = normalizeRepository(repositoryInput);
    const endpoint = blobSha && !this.requestOverride
      ? `/repos/${repository.owner}/${repository.name}/git/blobs/${encodeURIComponent(blobSha)}`
      : `/repos/${repository.owner}/${repository.name}/contents/${encodePath(pathName)}?ref=${encodeURIComponent(repository.branch)}`;
    const payload = await this.githubRequest(endpoint, { token });
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
function isShareableRelative(relative) {
  const value = String(relative || '').replace(/\\/g, '/');
  const extension = path.extname(value).toLowerCase();
  return value && !value.split('/').includes('..') && !value.startsWith('/') && SHAREABLE_EXTENSIONS.has(extension) && !/(?:cookie|secret|api[-_]?key|token|credential|database|sqlite|session)/i.test(value);
}
function findMarkdown(root, preferred = '') {
  const files = collectShareableFiles(root).filter((file) => /\.md$/i.test(file.relative) && path.basename(file.relative) !== DOCUMENT_META_FILE);
  const preferredName = String(preferred || '').replace(/\\/g, '/').toLowerCase();
  return files.find((file) => file.relative.toLowerCase() === preferredName)?.relative || files[0]?.relative || '';
}
function readJsonFile(file) {
  try { return file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch { return null; }
}
function localSharedDocumentModified(root, metadata, isMultipartParent = false) {
  if (!metadata?.contentSha256) return true;
  const markdown = findMarkdown(root, isMultipartParent ? 'index.md' : 'summary.md');
  if (!markdown || sha256(fs.readFileSync(path.join(root, markdown))) !== String(metadata.contentSha256)) return true;
  for (const [relative, expected] of Object.entries(metadata.assetSha256 || {})) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== String(expected)) return true;
  }
  return false;
}
function publicMount(mount) { const { remotePaths, ...safe } = mount || {}; return { ...safe, remoteDocumentCount: Array.isArray(remotePaths) ? remotePaths.length : 0 }; }
function publicCollection(collection) { const { cookieFile, collectionRoot, videosDir, exportDir, ...safe } = collection || {}; return safe; }
function publicSharedTask(task) { return { id: task.id, title: task.title, bvid: task.bvid, collectionId: task.collectionId, sharedDocumentId: task.sharedDocumentId, sharedRemotePath: task.sharedRemotePath, sharedRemoteSha: task.sharedRemoteSha || '', sharedRepository: task.sharedRepository || DEFAULT_REPOSITORY, sharedMountIds: task.sharedMountIds || (task.sharedMountId ? [task.sharedMountId] : []), remoteState: task.remoteState || 'active', remoteUpdatedAt: task.remoteUpdatedAt || '', updatedAt: task.updatedAt || '' }; }
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
