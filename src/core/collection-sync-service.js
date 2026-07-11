const fs = require('fs');
const path = require('path');
const { collectionDirs, ensureDir, timestampForFile } = require('./workspace');

class CollectionSyncService {
  constructor({ store, bili, getCurrentUser, onEvent }) {
    this.store = store;
    this.bili = bili;
    this.getCurrentUser = getCurrentUser;
    this.onEvent = onEvent || (() => {});
    this.active = new Set();
  }

  async sync(input = {}) {
    const currentUser = this.getCurrentUser();
    if (!currentUser?.isLogin) throw new Error('Not logged in to Bilibili in the desktop app.');
    const identifier = String(input.collectionName || '').trim();
    if (!identifier) throw new Error('collectionName is required.');
    const key = `${currentUser.mid}:${identifier}`;
    if (this.active.has(key)) throw new Error('This collection is already being synchronized.');
    this.active.add(key);
    try { return await this.runSync({ ...input, collectionName: identifier }, currentUser); }
    finally { this.active.delete(key); }
  }

  async runSync({ collectionName, label = 'bili' }, currentUser) {
    const identifier = collectionName;
    const folders = await this.bili.listFolders(currentUser.mid);
    const wanted = folders.find((folder) => folder.name === identifier || folder.id === identifier);
    if (!wanted) throw new Error(`Collection not found: ${identifier}`);
    const workspace = this.store.getDefaultWorkspace();
    if (!workspace) throw new Error('No default workspace is configured.');
    const dirs = collectionDirs(workspace.root, currentUser.name, wanted.name);
    const cookieFile = await this.bili.exportCookies(currentUser.name);
    const syncId = `sync-${currentUser.mid}-${wanted.id}-${Date.now()}`;
    const expectedTotal = Number(wanted.mediaCount || 0);
    this.progress(syncId, wanted.name, { stage: 'fetching', loaded: 0, total: expectedTotal, progress: 0 });
    const videos = await this.bili.listVideos(wanted.id, (progress) => {
      const total = progress.total || expectedTotal || null;
      this.progress(syncId, wanted.name, {
        stage: progress.done ? 'indexing' : 'fetching',
        loaded: progress.loaded,
        total,
        page: progress.page,
        progress: total ? Math.min(0.92, progress.loaded / total * 0.92) : Math.min(0.9, progress.page / Math.max(progress.page + 1, 2))
      });
    });
    const collection = this.persist({ currentUser, wanted, videos, workspace, dirs, cookieFile, label });
    this.writeExport(collection, videos);
    this.progress(syncId, wanted.name, { stage: 'done', loaded: videos.length, total: videos.length, progress: 1 });
    this.onEvent({ type: 'collection-synced', collection, count: videos.length });
    return { collection, count: videos.length };
  }

  persist({ currentUser, wanted, videos, workspace, dirs, cookieFile, label }) {
    const now = new Date().toISOString();
    const latestFavoriteAt = videos.reduce((latest, video) => String(video.favoriteAddedAt || '') > latest ? String(video.favoriteAddedAt) : latest, String(wanted.updatedAt || ''));
    const collectionId = `${currentUser.mid}:${wanted.id}`;
    const collection = this.store.upsertCollection({
      id: collectionId,
      mediaId: wanted.id,
      userId: String(currentUser.mid),
      userName: currentUser.name,
      name: wanted.name,
      label,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      collectionRoot: dirs.root,
      videosDir: dirs.videos,
      exportDir: dirs.exports,
      cookieFile,
      lastSyncedAt: now,
      videoCount: videos.length,
      latestFavoriteAt
    });
    for (const video of videos) this.persistVideo(collectionId, dirs, video, now);
    this.store.commit();
    return collection;
  }

  persistVideo(collectionId, dirs, video, now) {
    const key = `${collectionId}:${video.bvid}`;
    this.store.upsertVideo({ key, collectionId, ...video, syncedAt: now });
    const existing = this.store.getTask(key);
    this.store.upsertTask({
      id: key,
      collectionId,
      bvid: video.bvid,
      title: video.title,
      owner: video.owner,
      duration: video.duration,
      cover: video.cover,
      url: video.url,
      favoriteAddedAt: video.favoriteAddedAt,
      publishedAt: video.publishedAt,
      enabled: existing?.enabled !== false,
      status: existing?.status || 'pending',
      claimedBy: existing?.claimedBy || '',
      claimedAt: existing?.claimedAt || '',
      leaseExpiresAt: existing?.leaseExpiresAt || '',
      attempts: existing?.attempts || 0,
      allowedRoot: dirs.videos,
      artifactDir: existing?.artifactDir || '',
      outputMarkdown: existing?.outputMarkdown || '',
      validatorErrors: existing?.validatorErrors || [],
      createdAt: existing?.createdAt || now,
      updatedAt: now
    });
  }

  writeExport(collection, videos) {
    const exportDir = ensureDir(collection.exportDir || path.join(collection.workspaceRoot, '.star-note', 'exports'));
    const file = path.join(exportDir, `sync-${timestampForFile()}.json`);
    fs.writeFileSync(file, `${JSON.stringify({ collection, videos, exportedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  }

  progress(syncId, collectionName, detail) {
    this.onEvent({ type: 'collection-sync-progress', syncId, collectionName, ...detail });
  }
}

module.exports = { CollectionSyncService };
