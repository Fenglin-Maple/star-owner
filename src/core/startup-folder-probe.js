const { isBiliCollection } = require('./collection-state');

class StartupFolderProbe {
  constructor({ store, bili, getCurrentUser, now = () => new Date().toISOString() }) {
    this.store = store;
    this.bili = bili;
    this.getCurrentUser = getCurrentUser;
    this.now = now;
    this.probes = new Map();
  }

  run() {
    const user = this.getCurrentUser?.();
    const userId = String(user?.mid || user?.id || '');
    if (!user?.isLogin || !userId) throw new Error('Not logged in.');
    if (this.probes.has(userId)) return this.probes.get(userId);

    const operation = this.inspect(user, userId).catch((error) => {
      this.probes.delete(userId);
      throw error;
    });
    this.probes.set(userId, operation);
    return operation;
  }

  async inspect(user, userId) {
    const folders = await this.bili.listFolders(userId);
    const activeUser = this.getCurrentUser?.();
    if (!activeUser?.isLogin || String(activeUser.mid || activeUser.id || '') !== userId) {
      throw new Error('Bilibili account changed while the startup folder list was loading.');
    }

    const localByMediaId = new Map(this.store.listCollections()
      .filter((collection) => isBiliCollection(collection) && String(collection.userId || '') === userId)
      .map((collection) => [String(collection.mediaId), collection]));
    const changes = [];
    for (const folder of folders) {
      const mediaId = String(folder.id || folder.mediaId || '');
      const local = localByMediaId.get(mediaId);
      const previousCount = localReportedCount(local);
      const currentCount = normalizedCount(folder.mediaCount);
      if (previousCount === null || currentCount === null || previousCount === currentCount) continue;
      changes.push({
        collectionId: local.id,
        mediaId,
        name: String(folder.name || local.name || mediaId),
        previousCount,
        currentCount,
        delta: currentCount - previousCount
      });
    }

    return {
      checkedAt: this.now(),
      userId,
      userName: String(user.name || userId),
      folders,
      changes,
      hasChanges: changes.length > 0
    };
  }
}

function localReportedCount(collection) {
  if (!collection) return null;
  const candidates = [
    collection.remoteReportedCount,
    collection.lastSyncSummary?.remoteReportedCount,
    collection.remoteVideoCount
  ];
  for (const value of candidates) {
    const count = normalizedCount(value);
    if (count !== null) return count;
  }
  if (collection.lastSyncedAt) return normalizedCount(collection.videoCount);
  return null;
}

function normalizedCount(value) {
  if (value === '' || value === null || value === undefined) return null;
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

module.exports = { StartupFolderProbe, localReportedCount, normalizedCount };
