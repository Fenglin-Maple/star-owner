const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { collectionDirs, ensureDir, safeName, assertInside } = require('./workspace');
const { GitRuntime } = require('./git-runtime');

const DEFAULT_REPOSITORY = Object.freeze({ owner: 'Fenglin-Maple', name: 'Blibili-Markdowns', branch: 'main' });
const SHARED_USER_ID = 'shared-user';
const SHARED_USER_NAME = '共享';
const DOCUMENT_META_FILE = '_star-owner-document.json';
const SHAREABLE_EXTENSIONS = new Set(['.md', '.json', '.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif']);
const MAX_SHARED_FILE_BYTES = 25 * 1024 * 1024;
const MAX_SHARED_DOCUMENT_FILES = 256;
const MAX_SHARED_DOCUMENT_BYTES = 100 * 1024 * 1024;
const MAX_SHARED_PR_DOCUMENTS = 50;
const MAX_SHARED_PR_BYTES = 200 * 1024 * 1024;
const MAX_REMOTE_METADATA_BYTES = 512 * 1024;

class SharedKnowledgeManager {
  constructor({ store, encryptSecret, decryptSecret, openExternal, emit, repository = DEFAULT_REPOSITORY, request = null, gitRuntime = null }) {
    this.store = store;
    this.encryptSecret = encryptSecret;
    this.decryptSecret = decryptSecret;
    this.openExternal = openExternal || (async () => {});
    this.emit = emit || (() => {});
    this.repository = { ...DEFAULT_REPOSITORY, ...repository };
    this.requestOverride = request;
    this.gitRuntime = gitRuntime || new GitRuntime({ projectRoot: path.join(__dirname, '..', '..') });
    this.ensureSharedUser();
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
      git: this.gitRuntime.state()
    };
  }

  async openLogin() {
    await this.openExternal(`https://github.com/${this.repository.owner}/${this.repository.name}`);
    return { ok: true, url: `https://github.com/${this.repository.owner}/${this.repository.name}`, message: '已打开 GitHub。返回应用后可点击“浏览器登录 GitHub”完成项目内置凭据授权，也可以粘贴 Fine-grained Token 作为备用；凭据只保存在系统安全存储。' };
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

  clearToken() {
    this.store.delete('settings', 'sharedGithub');
    this.store.save();
    this.emitState('shared-github-logged-out');
    return { authenticated: false };
  }

  async remoteCatalog() {
    let tree;
    try {
      tree = await this.githubRequest(`/repos/${this.repository.owner}/${this.repository.name}/git/trees/${encodeURIComponent(this.repository.branch)}?recursive=1`);
    } catch (error) {
      if (error.status === 409) return { repository: { ...this.repository }, branchSha: '', total: 0, documents: [], empty: true };
      throw error;
    }
    if (tree.truncated) throw new Error('共享仓库目录过大，GitHub 返回了不完整目录；请先缩小仓库后再读取。');
    const entries = Array.isArray(tree.tree) ? tree.tree : [];
    const result = [];
    for (const entry of entries.filter((item) => item.type === 'blob' && item.path.endsWith(`/${DOCUMENT_META_FILE}`))) {
      try {
        assertRemotePath(entry.path);
        const metadata = await this.readRemoteFile(entry.path, MAX_REMOTE_METADATA_BYTES);
        validateRemoteMetadata(metadata, entry.path);
        result.push({ ...metadata, path: entry.path, metadataPath: entry.path, remoteSha: entry.sha, updatedAt: metadata.updatedAt || metadata.uploadedAt || '' });
      } catch (error) {
        result.push({ path: entry.path, metadataPath: entry.path, remoteSha: entry.sha, invalid: true, error: error.message || String(error) });
      }
    }
    result.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || String(a.path).localeCompare(String(b.path)));
    return { repository: { ...this.repository }, branchSha: tree.sha || '', total: result.length, documents: result };
  }

  async upload(input = {}) {
    const tasks = [...new Set((input.taskIds || []).map(String))].map((id) => this.store.getTask(id)).filter(Boolean);
    if (!tasks.length) throw new Error('请至少选择一篇已完成的 B站视频总结文档。');
    const auth = await this.requireAuth();
    const githubUserId = String(auth.user.id || '').trim();
    if (!/^\d+$/.test(githubUserId)) throw new Error('GitHub 账户缺少稳定数字 ID，无法创建共享目录。请退出后重新授权。');
    if (tasks.length > MAX_SHARED_PR_DOCUMENTS) throw new Error(`一次最多上传 ${MAX_SHARED_PR_DOCUMENTS} 篇共享文档。`);
    const documents = tasks.map((task) => this.prepareDocument({ ...task, githubUserId }));
    const documentIds = new Set();
    let totalBytes = 0;
    for (const document of documents) {
      if (documentIds.has(document.documentId)) throw new Error(`选中的文档存在重复共享身份：${document.documentId}。请保留同一来源的一条记录。`);
      documentIds.add(document.documentId);
      totalBytes += document.totalBytes;
    }
    if (totalBytes > MAX_SHARED_PR_BYTES) throw new Error(`本次共享提交总大小不能超过 ${formatMiB(MAX_SHARED_PR_BYTES)}。请减少文档数量或图片资源。`);
    const base = await this.githubRequest(`/repos/${this.repository.owner}/${this.repository.name}/git/ref/heads/${encodeURIComponent(this.repository.branch)}`, { token: auth.token });
    if (!base.object?.sha) throw new Error('共享仓库 main 分支尚未初始化，维护者需要先提交一个初始文件后才能创建 Pull Request。');
    const branch = `star-owner/${safeBranch(auth.user.login)}-${Date.now().toString(36)}`;
    const fork = await this.ensureFork(auth.user.login, auth.token);
    await this.waitForFork(fork, auth.token);
    const uploaded = documents.map((document) => ({ taskId: document.task.id, documentId: document.documentId, remoteRoot: document.remoteRoot, metadataPath: `${document.remoteRoot}/${DOCUMENT_META_FILE}` }));
    if (this.requestOverride) {
      await this.githubRequest(`/repos/${fork.owner}/${fork.name}/git/refs`, { token: auth.token, method: 'POST', body: { ref: `refs/heads/${branch}`, sha: base.object.sha } });
      for (const document of documents) {
        for (const file of document.files) {
          const pathName = `${document.remoteRoot}/${file.relative}`;
          const existing = await this.findRemoteFile(fork.owner, fork.name, pathName, auth.token);
          const body = { message: `docs: update ${document.documentId}`, content: file.buffer.toString('base64'), branch };
          if (existing?.sha) body.sha = existing.sha;
          await this.githubRequest(`/repos/${fork.owner}/${fork.name}/contents/${encodePath(pathName)}`, { token: auth.token, method: 'PUT', body });
        }
      }
    } else {
      await this.gitRuntime.commitAndPush({
        upstream: this.repository,
        fork: { owner: fork.owner?.login || fork.owner || auth.user.login, name: fork.name },
        baseBranch: this.repository.branch,
        branch,
        token: auth.token,
        files: documents.flatMap((document) => document.files.map((file) => ({ relative: `${document.remoteRoot}/${file.relative}`, buffer: file.buffer }))),
        replaceRoots: documents.map((document) => document.remoteRoot),
        message: `docs: update ${documents.length} shared document${documents.length === 1 ? '' : 's'}`
      });
    }
    const pr = await this.githubRequest(`/repos/${this.repository.owner}/${this.repository.name}/pulls`, {
      token: auth.token,
      method: 'POST',
      body: { title: String(input.title || `星藏家共享文档 · ${documents.length} 篇`), body: buildPullRequestBody(documents), head: `${auth.user.login}:${branch}`, base: this.repository.branch }
    });
    const record = { id: `shared-upload:${Date.now()}-${crypto.randomBytes(4).toString('hex')}`, prNumber: pr.number, prUrl: pr.html_url, branch, uploaded, status: 'open', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.store.set('sharedUploads', record.id, record);
    for (const item of uploaded) {
      const task = this.store.getTask(item.taskId);
      if (!task) continue;
      this.store.set('tasks', task.id, { ...task, sharedDocumentId: item.documentId, sharedRemotePath: item.metadataPath, sharedUploadPr: pr.html_url, sharedUpdatedAt: record.updatedAt });
    }
    this.store.commit();
    this.emitState('shared-upload-created', { prUrl: pr.html_url });
    return { ...record, repository: this.repository };
  }

  async mount(input = {}) {
    // The renderer may only submit paths/prefixes. Re-read the authoritative catalog
    // here so stale or forged renderer metadata cannot make the app fetch arbitrary files.
    const catalog = await this.remoteCatalog();
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
    this.clearSharedExclusions(collection.id, documents.map((item) => item.path));
    if (scope === 'collection') {
      const existing = this.store.list('sharedMounts').find((item) => item.collectionId === collection.id
        && item.scope === 'collection'
        && String(item.remotePrefix || '') === prefix);
      if (existing) {
        await this.syncMount(existing.id, catalog);
        return publicMount(this.store.get('sharedMounts', existing.id));
      }
    } else {
      const covered = this.store.list('sharedMounts')
        .filter((item) => item.collectionId === collection.id)
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
      repository: { ...this.repository },
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
    const catalog = catalogInput || await this.remoteCatalog();
    const scope = mount.scope || 'documents';
    const documents = catalog.documents.filter((document) => {
      if (document.invalid || this.isSharedExcluded(mount.collectionId, document.path)) return false;
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
        if (this.isSharedExcluded(mount.collectionId, task.sharedRemotePath)) {
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
      .map((file) => ({ relative: file.relative, buffer: fs.readFileSync(file.path) }));
    validateShareableFiles(files);
    const preferredMarkdown = task.multiPartRole === 'parent' ? 'index.md' : 'summary.md';
    const markdownFile = files.find((file) => file.relative.toLowerCase() === preferredMarkdown) || files.find((file) => /\.md$/i.test(file.relative));
    if (!markdownFile || !markdownFile.buffer.toString('utf8').trim()) throw new Error(`共享文档缺少非空 Markdown：${task.title || task.id}`);
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
      contentSha256: sha256(files.find((item) => /\.md$/i.test(item.relative))?.buffer || Buffer.alloc(0)),
      assetSha256: Object.fromEntries(files.filter((item) => !/\.md$/i.test(item.relative)).map((item) => [item.relative, sha256(item.buffer)]))
    };
    if (task.multiPartRole === 'parent') {
      metadata.parts = readMultipartManifest(sourceRoot);
    }
    metadata.fileSizes = Object.fromEntries(files.map((item) => [item.relative, item.buffer.length]));
    metadata.totalBytes = files.reduce((sum, item) => sum + item.buffer.length, 0);
    files.push({ relative: DOCUMENT_META_FILE, buffer: Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8') });
    validateShareableFiles(files);
    return { task, documentId, remoteRoot, files, metadata, totalBytes: metadata.totalBytes };
  }

  async importRemoteDocument(document, mount) {
    if (document.invalid) return null;
    const metadata = document;
    const collection = this.store.getCollectionById(mount.collectionId);
    if (!collection) throw new Error('共享收藏夹不存在。');
    const documentId = String(metadata.documentId || hash(document.path));
    const taskId = `shared:${mount.collectionId}:${documentId}`;
    const existing = this.store.getTask(taskId);
    const folder = safeName(documentId, 'shared-document', 120);
    const target = assertInside(collection.collectionRoot, path.join(collection.collectionRoot, folder));
    const temp = `${target}.incoming-${Date.now().toString(36)}`;
    fs.rmSync(temp, { recursive: true, force: true });
    ensureDir(temp);
    const remoteRoot = document.path.slice(0, -DOCUMENT_META_FILE.length).replace(/\/+$/, '');
    assertRemotePath(remoteRoot);
    let installed = false;
    try {
      const tree = await this.githubRequest(`/repos/${this.repository.owner}/${this.repository.name}/git/trees/${encodeURIComponent(this.repository.branch)}?recursive=1`);
      if (tree.truncated) throw new Error('共享仓库目录过大，GitHub 返回了不完整目录；无法安全导入该文档。');
      const files = (tree.tree || []).filter((entry) => entry.type === 'blob' && (entry.path === document.path || entry.path.startsWith(`${remoteRoot}/`)));
      validateRemoteTree(files, remoteRoot);
      let downloadedBytes = 0;
      for (const entry of files) {
        const relative = entry.path === document.path ? DOCUMENT_META_FILE : entry.path.slice(remoteRoot.length + 1);
        if (!isShareableRelative(relative)) continue;
        const destination = assertInside(temp, path.join(temp, relative));
        ensureDir(path.dirname(destination));
        const body = await this.readRemoteFileBytes(entry.path, MAX_SHARED_FILE_BYTES, entry.sha);
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
        const preserved = { ...existing, sharedMountId: mount.id, sharedMountIds: mountIds, remoteUpdatedAt: incomingMetadata.updatedAt || incomingMetadata.uploadedAt || existing.remoteUpdatedAt || '', remoteState: remoteChanged ? 'sync-conflict' : 'local-modified', updatedAt: new Date().toISOString() };
        fs.rmSync(temp, { recursive: true, force: true });
        this.store.set('tasks', existing.id, preserved);
        return preserved;
      }
      if (existing && !remoteChanged && fs.existsSync(target)) {
        const preserved = { ...existing, sharedMountId: mount.id, sharedMountIds: mountIds, remoteState: 'active', updatedAt: new Date().toISOString() };
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
      const id = `shared:${parentTask.collectionId}:${parentTask.sharedDocumentId}:part:${cid}`;
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

  isSharedExcluded(collectionId, remotePath) {
    return Boolean(this.store.get('sharedExclusions', sharedExclusionId(collectionId, remotePath)));
  }

  clearSharedExclusions(collectionId, remotePaths = []) {
    for (const remotePath of remotePaths) this.store.delete('sharedExclusions', sharedExclusionId(collectionId, remotePath));
  }

  isCoveredByAnotherMount(currentMount, remotePath) {
    return this.store.list('sharedMounts').some((mount) => String(mount.id) !== String(currentMount.id)
      && String(mount.collectionId) === String(currentMount.collectionId)
      && mountCoversPath(mount, remotePath));
  }

  async requireAuth() {
    const settings = this.store.get('settings', 'sharedGithub') || {};
    const raw = process.env.STAR_OWNER_GITHUB_TOKEN || '';
    const token = validateGithubToken(raw || (settings.encryptedToken ? this.decryptSecret(settings.encryptedToken) : ''));
    if (!token) throw new Error('请先点击“登录 GitHub”，完成授权后输入 Token。浏览远程目录无需登录，创建 Fork/PR 必须授权。');
    const user = settings.login && /^\d+$/.test(String(settings.userId || ''))
      ? { login: settings.login, id: settings.userId }
      : await this.githubRequest('/user', { token });
    return { token, user };
  }

  async ensureFork(login, token) {
    const pathName = `/repos/${login}/${this.repository.name}`;
    try { return await this.githubRequest(pathName, { token }); }
    catch (error) {
      if (error.status !== 404) throw error;
      const fork = await this.githubRequest(`/repos/${this.repository.owner}/${this.repository.name}/forks`, { token, method: 'POST', body: { default_branch_only: false } });
      return { ...fork, _createdByApplication: true };
    }
  }

  async waitForFork(fork, token) {
    if (this.requestOverride || !fork?._createdByApplication) return fork;
    const owner = fork.owner?.login || fork.owner;
    const repo = fork.name || this.repository.name;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const current = await this.githubRequest(`/repos/${owner}/${repo}`, { token });
        if (current?.id) return current;
      } catch (error) {
        if (error.status !== 404 && error.status !== 409) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error('GitHub Fork 尚未准备完成，请稍后重试共享上传。');
  }

  async findRemoteFile(owner, repo, pathName, token) {
    try { return await this.githubRequest(`/repos/${owner}/${repo}/contents/${encodePath(pathName)}?ref=${encodeURIComponent(this.repository.branch)}`, { token }); }
    catch (error) { if (error.status === 404) return null; throw error; }
  }

  async readRemoteFile(pathName, maxBytes = MAX_SHARED_FILE_BYTES) { return JSON.parse((await this.readRemoteFileBytes(pathName, maxBytes)).toString('utf8')); }
  async readRemoteFileBytes(pathName, maxBytes = MAX_SHARED_FILE_BYTES, blobSha = '') {
    assertRemotePath(pathName);
    const endpoint = blobSha && !this.requestOverride
      ? `/repos/${this.repository.owner}/${this.repository.name}/git/blobs/${encodeURIComponent(blobSha)}`
      : `/repos/${this.repository.owner}/${this.repository.name}/contents/${encodePath(pathName)}?ref=${encodeURIComponent(this.repository.branch)}`;
    const payload = await this.githubRequest(endpoint);
    if (!payload.content) throw new Error(`远程文件不是可读取内容：${pathName}`);
    const value = Buffer.from(String(payload.content).replace(/\s+/g, ''), 'base64');
    if (value.length > maxBytes) throw new Error(`远程共享文件过大（上限 ${formatMiB(maxBytes)}）：${pathName}`);
    return value;
  }

  async githubRequest(endpoint, options = {}) {
    if (this.requestOverride) return this.requestOverride(endpoint, options);
    const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'star-owner/1.4.1' };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.body) headers['content-type'] = 'application/json';
    const response = await fetch(`https://api.github.com${endpoint}`, { method: options.method || 'GET', headers, body: options.body ? JSON.stringify(options.body) : undefined, signal: AbortSignal.timeout(60000) });
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
function remoteRootFor(task, collection, documentId) {
  const author = safeName(task.githubUserId || 'pending-github-id', 'pending-github-id', 80);
  const namespace = task.multiPartParentId || task.multiPartRole === 'parent' ? 'multipart' : task.singleTask ? 'single' : 'bilibili';
  const collectionSegment = `col-${hash(`${namespace}|${collection.id || 'unknown-collection'}`)}`;
  return `${author}/${namespace}/${collectionSegment}/${safeName(documentId, 'document', 150)}`;
}
function sharedExclusionId(collectionId, remotePath) {
  return `shared-exclusion:${hash(`${String(collectionId || '')}|${String(remotePath || '')}`)}`;
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
function publicSharedTask(task) { return { id: task.id, title: task.title, bvid: task.bvid, collectionId: task.collectionId, sharedDocumentId: task.sharedDocumentId, sharedRemotePath: task.sharedRemotePath, sharedRemoteSha: task.sharedRemoteSha || '', sharedMountIds: task.sharedMountIds || (task.sharedMountId ? [task.sharedMountId] : []), remoteState: task.remoteState || 'active', remoteUpdatedAt: task.remoteUpdatedAt || '', updatedAt: task.updatedAt || '' }; }
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
function buildPullRequestBody(documents) { return ['由星藏家生成的 B站视频总结共享文档。', '', '本 PR 只包含已完成 Markdown 总结、必要元数据和图片资源，不包含原始视频、音频、ASR 缓存、Cookie 或 API Key。', '', ...documents.map((item) => `- ${item.documentId} · ${item.metadata.title || item.task.title}`)].join('\n'); }

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
    const bytes = Buffer.isBuffer(file.buffer) ? file.buffer.length : Buffer.byteLength(String(file.buffer || ''));
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

module.exports = { DEFAULT_REPOSITORY, DOCUMENT_META_FILE, SHARED_USER_ID, SHARED_USER_NAME, MAX_SHARED_FILE_BYTES, MAX_SHARED_DOCUMENT_FILES, MAX_SHARED_DOCUMENT_BYTES, MAX_SHARED_PR_DOCUMENTS, MAX_SHARED_PR_BYTES, SharedKnowledgeManager, collectShareableFiles, isShareableBilibiliTask, isShareableRelative, mountCoversPath, remoteRootFor, sharedExclusionId, stableDocumentId, validateGithubToken, validateShareableFiles };
