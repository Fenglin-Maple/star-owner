const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  collectionSourceName,
  collectionStorageName,
  deletedCollectionName,
  isBiliCollection,
  removedFavoriteTitle,
  taskSourceTitle
} = require('./collection-state');
const { isVideoUnavailableMessage } = require('./media-errors');
const { abortTaskAttempt, cleanupAttemptFiles } = require('./task-attempt');
const { isUnavailableTask, recoverMisclassifiedUnavailableTasks } = require('./unavailable-task');
const { collectionDirs, ensureDir, timestampForFile } = require('./workspace');

class CollectionSyncService {
  constructor({ store, bili, getCurrentUser, toolRunner = null, internalAgentManager = null, onEvent }) {
    this.store = store;
    this.bili = bili;
    this.getCurrentUser = getCurrentUser;
    this.toolRunner = toolRunner;
    this.internalAgentManager = internalAgentManager;
    this.onEvent = onEvent || (() => {});
    this.active = new Set();
    this.recoverInterruptedSyncs();
    this.recoverTombstoneCleanups();
    recoverMisclassifiedUnavailableTasks({ store: this.store, onEvent: this.onEvent });
  }

  async sync(input = {}) {
    const currentUser = this.getCurrentUser();
    if (!currentUser?.isLogin) throw new Error('Not logged in to Bilibili in the desktop app.');
    const identifier = String(input.collectionName || input.collectionId || '').trim();
    if (!identifier) throw new Error('collectionName or collectionId is required.');
    const key = 'bilibili-session';
    if (this.active.has(key)) throw new Error('This Bilibili account already has a collection synchronization in progress.');
    this.active.add(key);
    try { return await this.runSync({ ...input, identifier }, currentUser); }
    finally { this.active.delete(key); }
  }

  async runSync({ identifier, label = 'bili' }, currentUser) {
    const workspace = this.store.getDefaultWorkspace();
    if (!workspace) throw new Error('No default workspace is configured.');
    let local = this.findLocalCollection(currentUser, identifier);
    let transactionId = '';
    let syncId = `sync-${currentUser.mid}-${local?.mediaId || identifier}-${Date.now()}`;
    try {
      if (local) {
        transactionId = this.beginSync(local.id, local, local);
        await this.stopCollectionWork(local, '用户开始同步该收藏夹，已中止相关 Agent 视频总结工作流。', 'collection-sync');
      }

      this.progress(syncId, local?.name || identifier, { stage: 'resolving', loaded: 0, total: null, progress: 0.02 });
      const folders = await this.bili.listFolders(currentUser.mid);
      this.assertCurrentUser(currentUser);
      await this.reconcileFolders(folders, currentUser, { excludeCollectionIds: local ? [local.id] : [] });
      const wanted = resolveRemoteFolder(folders, identifier, local?.mediaId);
      if (!wanted) {
        if (!local) throw new Error(`Collection not found: ${identifier}`);
        const deleted = this.commitDeletedCollection(local.id, transactionId, '同步时在 B站收藏夹列表中未找到该收藏夹。', 'collection-sync');
        transactionId = '';
        this.progress(syncId, deleted.collection.name, { stage: 'done', loaded: 0, total: 0, progress: 1 });
        return deleted;
      }

      if (local?.mediaId && String(local.mediaId) !== String(wanted.id)) {
        this.commitDeletedCollection(
          local.id,
          transactionId,
          `原收藏夹 ID ${local.mediaId} 已不存在；B站当前同名收藏夹使用新 ID ${wanted.id}，旧产物已归档并将新收藏夹作为独立库存同步。`,
          'collection-replaced-by-same-name'
        );
        transactionId = '';
        local = null;
      }

      const collectionId = `${currentUser.mid}:${wanted.id}`;
      local = this.store.getCollectionById(collectionId);
      const storageName = local ? collectionStorageName(local) : wanted.name;
      const dirs = collectionDirs(workspace.root, currentUser.name, storageName);
      const provisional = this.buildCollection({ currentUser, wanted, workspace, dirs, label, current: local, syncState: 'syncing', syncReady: false });
      if (!transactionId) {
        transactionId = this.beginSync(collectionId, local, provisional);
        if (local) await this.stopCollectionWork(local, '用户开始同步该收藏夹，已中止相关 Agent 视频总结工作流。', 'collection-sync');
      }

      syncId = `sync-${currentUser.mid}-${wanted.id}-${Date.now()}`;
      const expectedTotal = Number(wanted.mediaCount || 0);
      this.progress(syncId, wanted.name, { stage: 'fetching', loaded: 0, total: expectedTotal, progress: 0.05 });
      const fetched = await this.bili.listVideos(wanted.id, (progress) => {
        const total = progress.total || expectedTotal || null;
        this.progress(syncId, wanted.name, {
          stage: progress.done ? 'indexing' : 'fetching',
          loaded: progress.loaded,
          total,
          page: progress.page,
          progress: total ? Math.min(0.92, 0.05 + progress.loaded / total * 0.87) : Math.min(0.9, 0.05 + progress.page / Math.max(progress.page + 1, 2) * 0.85)
        });
      });
      const snapshot = normalizeVideoSnapshot(fetched, expectedTotal);
      const videos = snapshot.videos;
      this.assertCurrentUser(currentUser);
      const cookieFile = await this.bili.exportCookies(currentUser.name);
      this.assertCurrentUser(currentUser);
      const result = this.applySnapshot({ currentUser, wanted, snapshot, workspace, dirs, cookieFile, label, transactionId });
      transactionId = '';
      this.writeExportSafe(result.collection, videos, snapshot);
      this.progress(syncId, result.collection.name, { stage: 'done', loaded: snapshot.visibleCount, total: snapshot.reportedTotal, progress: 1, visibilityGap: snapshot.visibilityGap });
      this.onEvent({
        type: snapshot.visibilityGap > 0 ? 'collection-synced-partial-visibility' : 'collection-synced',
        collection: result.collection,
        count: videos.length,
        summary: result.summary
      });
      return result;
    } catch (error) {
      if (transactionId) this.rollbackSync(transactionId, error.message || String(error));
      this.progress(syncId, local?.name || identifier, { stage: 'error', loaded: 0, total: null, progress: 1 });
      throw error;
    }
  }

  async reconcileFolders(folders, currentUser, options = {}) {
    const excluded = new Set((options.excludeCollectionIds || []).map(String));
    const remote = new Map((folders || []).map((folder) => [String(folder.id), folder]));
    const summary = { deleted: 0, renamed: 0, restored: 0 };
    for (const collection of this.localCollections(currentUser)) {
      if (excluded.has(collection.id)) continue;
      if (collection.syncState === 'syncing') continue;
      const folder = remote.get(String(collection.mediaId || ''));
      if (!folder) {
        if (!collection.biliDeleted) {
          await this.markCollectionDeleted(collection, '读取 B站收藏夹列表时未找到该收藏夹。', 'folder-list');
          summary.deleted += 1;
        }
        continue;
      }
      const renamed = collectionSourceName(collection) !== folder.name;
      if (!renamed && !collection.biliDeleted) continue;
      const transactionId = this.beginSync(collection.id, collection, collection);
      try {
        await this.stopCollectionWork(collection, collection.biliDeleted
          ? 'B站收藏夹重新出现，需要先完成任务同步再重启 Agent 工作流。'
          : 'B站收藏夹名称已变更，需要先完成任务同步再重启 Agent 工作流。', 'folder-list');
        const latest = this.store.getCollectionById(collection.id) || collection;
        const next = {
          ...latest,
          name: folder.name,
          sourceName: folder.name,
          storageName: collectionStorageName(collection),
          biliDeleted: false,
          biliDeletedAt: '',
          syncState: 'needs-sync',
          syncReady: false,
          remoteVideoCount: Number(folder.mediaCount || 0),
          remoteUpdatedAt: folder.updatedAt || '',
          updatedAt: new Date().toISOString()
        };
        this.store.transaction(() => {
          this.store.set('collections', next.id, next);
          this.store.delete('collectionSyncTransactions', transactionId);
        });
        if (collection.biliDeleted) summary.restored += 1;
        if (renamed) summary.renamed += 1;
        this.onEvent({ type: collection.biliDeleted ? 'collection-restored-needs-sync' : 'collection-renamed-needs-sync', collectionId: next.id, collectionName: next.name });
      } catch (error) {
        this.rollbackSync(transactionId, error.message || String(error));
        throw error;
      }
    }
    return summary;
  }

  assertCurrentUser(expected) {
    const current = this.getCurrentUser();
    if (!current?.isLogin || String(current.mid || '') !== String(expected?.mid || '')) {
      throw new Error('Bilibili account changed while collection synchronization was running. The previous collection state was restored.');
    }
  }

  applySnapshot({ currentUser, wanted, snapshot, workspace, dirs, cookieFile, label, transactionId }) {
    const videos = snapshot.videos;
    const partialVisibility = snapshot.visibilityGap > 0;
    const collectionId = `${currentUser.mid}:${wanted.id}`;
    const current = this.store.getCollectionById(collectionId) || {};
    const now = new Date().toISOString();
    const remoteIds = new Set();
    const cleanup = [];
    const unavailableCleanup = [];
    const events = [];
    const summary = {
      added: 0,
      updated: 0,
      restored: 0,
      removed: 0,
      archived: 0,
      unavailable: 0,
      preservedUnresolved: 0,
      remoteReportedCount: snapshot.reportedTotal,
      remoteVisibleCount: snapshot.visibleCount,
      visibilityGap: snapshot.visibilityGap,
      partialVisibility,
      workflowsStopped: true
    };
    let collection;
    this.store.transaction(() => {
      for (const video of videos) {
        const mediaKey = stableVideoKey(video);
        const key = `${collectionId}:${mediaKey}`;
        remoteIds.add(key);
        const unavailable = isUnavailableTask(this.store, key);
        const unavailableTitle = isVideoUnavailableMessage(video.title || '');
        if (unavailable || unavailableTitle) {
          summary.unavailable += 1;
          const existing = this.store.getTask(key);
          if (unavailable && existing && existing.status !== 'done') {
            const tombstone = this.store.get('unavailableTasks', key) || { id: key, taskId: key, collectionId, bvid: video.bvid, removedAt: now };
            this.store.set('unavailableTasks', key, { ...tombstone, cleanupPending: true, cleanupTask: cleanupTaskSnapshot(existing) });
            this.store.delete('tasks', key);
            this.store.delete('videos', key);
            unavailableCleanup.push(existing);
          } else if (unavailableTitle && existing?.status !== 'done') {
            const tombstone = {
              id: key,
              taskId: key,
              collectionId,
              bvid: video.bvid,
              title: video.title,
              owner: video.owner || existing?.owner || '',
              reason: `收藏夹同步返回“${video.title}”。`,
              source: 'collection-sync',
              removedAt: now,
              cleanupPending: Boolean(existing),
              cleanupTask: existing ? cleanupTaskSnapshot(existing) : null
            };
            this.store.set('unavailableTasks', key, tombstone);
            this.store.delete('tasks', key);
            this.store.delete('videos', key);
            if (existing) unavailableCleanup.push(existing);
            events.push({ taskId: key, type: 'video-unavailable', data: { collectionId, reason: tombstone.reason, source: 'collection-sync' } });
          }
          continue;
        }
        const existing = this.store.getTask(key);
        const restoredMembership = Boolean(existing?.removedFromFavorites || existing?.favoriteState === 'removed' || existing?.favoriteState === 'collection-deleted');
        const restoredEnabled = restoredMembership ? existing?.enabledBeforeRemoval !== false : existing?.enabled !== false;
        if (!existing) summary.added += 1;
        else if (restoredMembership) summary.restored += 1;
        else summary.updated += 1;
        this.store.set('videos', key, { ...(this.store.get('videos', key) || {}), key, collectionId, ...video, favoriteState: 'active', removedFromFavorites: false, removedFromFavoritesAt: '', syncedAt: now });
        this.store.set('tasks', key, {
          enabled: restoredEnabled,
          ...(existing || {}),
          id: key,
          collectionId,
          bvid: video.bvid,
          title: video.title,
          sourceTitle: video.title,
          owner: video.owner,
          duration: video.duration,
          cover: video.cover,
          url: video.url,
          favoriteAddedAt: video.favoriteAddedAt,
          publishedAt: video.publishedAt,
          favoriteState: 'active',
          removedFromFavorites: false,
          removedFromFavoritesAt: '',
          enabledBeforeRemoval: undefined,
          enabled: restoredEnabled,
          status: existing?.status || 'pending',
          claimedBy: existing?.claimedBy || '',
          claimedAt: existing?.claimedAt || '',
          leaseExpiresAt: existing?.leaseExpiresAt || '',
          attempts: existing?.attempts || 0,
          allowedRoot: existing?.allowedRoot || dirs.root,
          artifactDir: existing?.artifactDir || '',
          outputMarkdown: existing?.outputMarkdown || '',
          validatorErrors: existing?.validatorErrors || [],
          createdAt: existing?.createdAt || now,
          updatedAt: now
        });
        this.store.delete('removedFavoriteTasks', key);
      }

      for (const task of this.store.listTasks({ collectionId })) {
        if (remoteIds.has(task.id)) continue;
        if (partialVisibility) {
          summary.preservedUnresolved += 1;
          continue;
        }
        if (task.status === 'done' && task.outputMarkdown) {
          const archived = {
            ...task,
            sourceTitle: taskSourceTitle(task),
            title: removedFavoriteTitle(task),
            favoriteState: 'removed',
            removedFromFavorites: true,
            removedFromFavoritesAt: task.removedFromFavoritesAt || now,
            enabledBeforeRemoval: task.removedFromFavorites ? task.enabledBeforeRemoval !== false : task.enabled !== false,
            enabled: false,
            updatedAt: now
          };
          this.store.set('tasks', task.id, archived);
          const video = this.store.get('videos', task.id);
          if (video) this.store.set('videos', task.id, { ...video, favoriteState: 'removed', removedFromFavorites: true, removedFromFavoritesAt: now, syncedAt: now });
          summary.archived += 1;
          events.push({ taskId: task.id, type: 'removed-from-favorites', data: { collectionId, preservedArtifact: true } });
        } else {
          this.store.delete('tasks', task.id);
          this.store.delete('videos', task.id);
          this.store.set('removedFavoriteTasks', task.id, {
            id: task.id,
            taskId: task.id,
            collectionId,
            bvid: task.bvid,
            title: taskSourceTitle(task),
            reason: '该视频已从 B站收藏夹移出，未完成任务不再派发。',
            removedAt: now,
            cleanupPending: true,
            cleanupTask: cleanupTaskSnapshot(task)
          });
          cleanup.push(task);
          summary.removed += 1;
          events.push({ taskId: task.id, type: 'removed-from-favorites', data: { collectionId, preservedArtifact: false } });
        }
      }

      const latestFavoriteAt = videos.reduce((latest, video) => String(video.favoriteAddedAt || '') > latest ? String(video.favoriteAddedAt) : latest, String(wanted.updatedAt || ''));
      collection = this.buildCollection({ currentUser, wanted, workspace, dirs, cookieFile, label, current, syncState: 'ready', syncReady: true, now });
      const activeTaskCount = this.store.listTasks({ collectionId }).filter((task) => !task.removedFromFavorites && task.favoriteState !== 'removed' && task.favoriteState !== 'collection-deleted').length;
      Object.assign(collection, {
        videoCount: activeTaskCount,
        remoteVideoCount: snapshot.reportedTotal,
        remoteReportedCount: snapshot.reportedTotal,
        remoteVisibleCount: snapshot.visibleCount,
        visibilityGap: snapshot.visibilityGap,
        partialVisibility,
        archivedDocumentCount: summary.archived,
        latestFavoriteAt,
        biliDeleted: false,
        biliDeletedAt: '',
        lastSyncSummary: summary
      });
      this.store.set('collections', collection.id, collection);
      this.store.delete('collectionSyncTransactions', transactionId);
    });
    this.cleanupRemovedTasks(cleanup);
    this.cleanupTombstonedTasks(unavailableCleanup, 'unavailableTasks', 'collection-sync');
    for (const event of events) this.store.recordTaskEvent(event.taskId, event.type, event.data);
    return { collection, count: videos.length, summary };
  }

  async markCollectionDeleted(collection, reason, source) {
    const transactionId = this.beginSync(collection.id, collection, collection);
    try {
      await this.stopCollectionWork(collection, 'B站收藏夹已删除，已中止相关 Agent 视频总结工作流。', source);
      return this.commitDeletedCollection(collection.id, transactionId, reason, source);
    } catch (error) {
      this.rollbackSync(transactionId, error.message || String(error));
      throw error;
    }
  }

  commitDeletedCollection(collectionId, transactionId, reason, source) {
    const current = this.store.getCollectionById(collectionId);
    if (!current) throw new Error(`Collection not found: ${collectionId}`);
    const now = new Date().toISOString();
    const cleanup = [];
    const events = [];
    const summary = { added: 0, updated: 0, restored: 0, removed: 0, archived: 0, unavailable: 0, workflowsStopped: true, collectionDeleted: true };
    let collection;
    this.store.transaction(() => {
      for (const task of this.store.listTasks({ collectionId })) {
        if (task.status === 'done' && task.outputMarkdown) {
          this.store.set('tasks', task.id, {
            ...task,
            sourceTitle: taskSourceTitle(task),
            title: removedFavoriteTitle(task),
            favoriteState: 'collection-deleted',
            removedFromFavorites: true,
            removedFromFavoritesAt: task.removedFromFavoritesAt || now,
            enabledBeforeRemoval: task.removedFromFavorites ? task.enabledBeforeRemoval !== false : task.enabled !== false,
            enabled: false,
            updatedAt: now
          });
          summary.archived += 1;
          events.push({ taskId: task.id, type: 'collection-deleted-artifact-preserved', data: { collectionId } });
        } else {
          this.store.delete('tasks', task.id);
          this.store.delete('videos', task.id);
          this.store.set('removedFavoriteTasks', task.id, {
            id: task.id,
            taskId: task.id,
            collectionId,
            bvid: task.bvid,
            title: taskSourceTitle(task),
            reason: 'B站收藏夹已删除，未完成任务不再派发。',
            removedAt: now,
            cleanupPending: true,
            cleanupTask: cleanupTaskSnapshot(task)
          });
          cleanup.push(task);
          summary.removed += 1;
          events.push({ taskId: task.id, type: 'collection-deleted-task-removed', data: { collectionId } });
        }
      }
      collection = {
        ...current,
        name: deletedCollectionName(current),
        sourceName: collectionSourceName(current),
        storageName: collectionStorageName(current),
        biliDeleted: true,
        biliDeletedAt: now,
        syncState: 'deleted',
        syncReady: false,
        remoteVideoCount: 0,
        videoCount: summary.archived,
        archivedDocumentCount: summary.archived,
        lastSyncSummary: summary,
        lastSyncError: String(reason || ''),
        updatedAt: now
      };
      this.store.set('collections', collection.id, collection);
      if (transactionId) this.store.delete('collectionSyncTransactions', transactionId);
    });
    this.cleanupRemovedTasks(cleanup);
    for (const event of events) this.store.recordTaskEvent(event.taskId, event.type, event.data);
    this.internalAgentManager?.markCollectionUnavailable(collection.id, 'B站收藏夹已删除，任务不可用。');
    this.onEvent({ type: 'collection-deleted-on-bilibili', collection, reason, source, summary });
    return { collection, count: 0, deleted: true, summary };
  }

  async stopCollectionWork(collection, reason, source) {
    const stoppedSessions = await this.internalAgentManager?.stopCollectionForSync(collection.id, reason, source) || [];
    let abortedAttempts = 0;
    for (const task of this.store.listTasks({ collectionId: collection.id })) {
      if (!['claimed', 'rejected'].includes(task.status) || (!task.workId && !task.claimedBy)) continue;
      try {
        const result = abortTaskAttempt({ store: this.store, toolRunner: this.toolRunner, taskId: task.id, workerId: task.claimedBy, reason, source });
        if (!result.alreadyAborted) {
          abortedAttempts += 1;
          this.onEvent({ type: 'task-attempt-aborted', taskId: task.id, collectionId: collection.id, workerId: task.claimedBy, reason, source, cleanup: result.cleanup });
        }
      } catch (error) {
        this.onEvent({ type: 'task-attempt-cleanup-failed', taskId: task.id, collectionId: collection.id, reason: error.message || String(error), source });
      }
    }
    const remaining = this.store.listTasks({ collectionId: collection.id }).filter((task) => ['claimed', 'rejected'].includes(task.status) && (task.workId || task.claimedBy));
    if (remaining.length) {
      throw new Error(`Collection synchronization could not stop ${remaining.length} active task attempt(s). No remote inventory changes were applied.`);
    }
    this.onEvent({ type: 'collection-workflows-stopped-for-sync', collectionId: collection.id, collectionName: collection.name, sessions: stoppedSessions.length, attempts: abortedAttempts, reason });
    return { stoppedSessions: stoppedSessions.length, abortedAttempts };
  }

  beginSync(collectionId, collectionBefore, provisional) {
    const transactionId = `collection-sync:${collectionId}`;
    const now = new Date().toISOString();
    const syncing = {
      ...(provisional || collectionBefore || { id: collectionId }),
      id: collectionId,
      syncState: 'syncing',
      syncReady: false,
      syncStartedAt: now,
      updatedAt: now
    };
    this.store.transaction(() => {
      this.store.set('collectionSyncTransactions', transactionId, {
        id: transactionId,
        collectionId,
        collectionBefore: collectionBefore || null,
        startedAt: now
      });
      this.store.set('collections', collectionId, syncing);
    });
    return transactionId;
  }

  rollbackSync(transactionId, reason) {
    const transaction = this.store.get('collectionSyncTransactions', transactionId);
    if (!transaction) return false;
    this.store.transaction(() => {
      if (transaction.collectionBefore) this.store.set('collections', transaction.collectionId, transaction.collectionBefore);
      else this.store.delete('collections', transaction.collectionId);
      this.store.delete('collectionSyncTransactions', transactionId);
    });
    this.onEvent({ type: 'collection-sync-rolled-back', collectionId: transaction.collectionId, reason: String(reason || '同步中断'), message: '收藏夹同步已回滚到上一次完整状态。' });
    return true;
  }

  recoverInterruptedSyncs() {
    const interrupted = this.store.list('collectionSyncTransactions');
    for (const transaction of interrupted) this.rollbackSync(transaction.id, '应用上次在收藏夹同步期间退出或崩溃');
  }

  recoverTombstoneCleanups() {
    for (const scope of ['removedFavoriteTasks', 'unavailableTasks']) {
      const pending = this.store.list(scope).filter((item) => item.cleanupPending && item.cleanupTask);
      if (pending.length) this.cleanupTombstonedTasks(pending.map((item) => item.cleanupTask), scope, 'startup-recovery');
    }
  }

  buildCollection({ currentUser, wanted, workspace, dirs, cookieFile = '', label, current = {}, syncState, syncReady, now = new Date().toISOString() }) {
    current = current || {};
    return {
      ...current,
      id: `${currentUser.mid}:${wanted.id}`,
      mediaId: String(wanted.id),
      userId: String(currentUser.mid),
      userName: currentUser.name,
      name: wanted.name,
      sourceName: wanted.name,
      storageName: current.storageName || collectionStorageName(current.id ? current : { name: wanted.name }),
      label,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      collectionRoot: current.collectionRoot || dirs.root,
      videosDir: current.videosDir || dirs.videos,
      exportDir: current.exportDir || dirs.exports,
      cookieFile: cookieFile || current.cookieFile || '',
      lastSyncedAt: syncReady ? now : current.lastSyncedAt || '',
      syncState,
      syncReady,
      remoteUpdatedAt: wanted.updatedAt || '',
      updatedAt: now
    };
  }

  findLocalCollection(currentUser, identifier) {
    const collections = this.localCollections(currentUser);
    const exact = collections.find((collection) => collection.id === identifier || String(collection.mediaId || '') === identifier);
    if (exact) return exact;
    const named = collections.filter((collection) => collection.name === identifier || collectionSourceName(collection) === identifier);
    if (named.length > 1) throw new Error(`Collection name is ambiguous; select it by mediaId: ${identifier}`);
    return named[0] || null;
  }

  localCollections(currentUser) {
    return this.store.listCollections().filter((collection) => isBiliCollection(collection)
      && String(collection.userId || '') === String(currentUser.mid));
  }

  cleanupRemovedTasks(tasks, source = 'collection-sync') {
    return this.cleanupTombstonedTasks(tasks, 'removedFavoriteTasks', source);
  }

  cleanupTombstonedTasks(tasks, scope, source = 'collection-sync') {
    for (const task of tasks) {
      const tombstone = this.store.get(scope, task.id);
      try {
        const cleanup = cleanupAttemptFiles(this.store, task);
        if (tombstone) this.store.set(scope, task.id, { ...tombstone, cleanupPending: false, cleanupCompletedAt: new Date().toISOString(), cleanup });
        this.onEvent({ type: 'removed-task-cache-cleaned', taskId: task.id, collectionId: task.collectionId, source, cleanup });
      } catch (error) {
        if (tombstone) this.store.set(scope, task.id, { ...tombstone, cleanupPending: true, cleanupError: error.message || String(error) });
        this.onEvent({ type: 'removed-task-cache-cleanup-failed', taskId: task.id, collectionId: task.collectionId, reason: error.message || String(error), source });
      }
    }
    if (tasks.length) this.store.save();
  }

  writeExportSafe(collection, videos, snapshot = null) {
    try {
      const exportDir = ensureDir(collection.exportDir || path.join(collection.workspaceRoot, '.star-note', 'exports'));
      const file = path.join(exportDir, `sync-${timestampForFile()}.json`);
      fs.writeFileSync(file, `${JSON.stringify({ collection, snapshot: snapshot ? snapshotMetadata(snapshot) : null, videos, exportedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
      return file;
    } catch (error) {
      this.onEvent({ type: 'collection-sync-export-failed', collectionId: collection.id, reason: error.message || String(error) });
      return '';
    }
  }

  progress(syncId, collectionName, detail) {
    this.onEvent({ type: 'collection-sync-progress', syncId, collectionName, ...detail });
  }
}

function cleanupTaskSnapshot(task = {}) {
  return {
    id: task.id,
    collectionId: task.collectionId,
    bvid: task.bvid,
    artifactDir: task.artifactDir || '',
    allowedRoot: task.allowedRoot || '',
    workspaceRoot: task.workspaceRoot || '',
    workspaceId: task.workspaceId || '',
    cachedVideoId: task.cachedVideoId || '',
    cachedVideoFile: task.cachedVideoFile || '',
    coverFile: task.coverFile || '',
    metadataFile: task.metadataFile || ''
  };
}

function stableVideoKey(video = {}) {
  if (video.bvid) return video.bvid;
  if (video.aid) return `aid-${video.aid}`;
  const identity = [video.title, video.owner, video.publishedAt, video.duration, video.url].map((item) => String(item || '')).join('|');
  return `missing-${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
}

function resolveRemoteFolder(folders, identifier, stableMediaId = '') {
  const stable = String(stableMediaId || '');
  if (stable) {
    const match = (folders || []).find((folder) => String(folder.id) === stable);
    if (match) return match;
  }
  const exact = (folders || []).find((folder) => String(folder.id) === String(identifier || ''));
  if (exact) return exact;
  const named = (folders || []).filter((folder) => folder.name === identifier);
  if (named.length > 1) throw new Error(`Bilibili has multiple collections named "${identifier}"; select one by mediaId.`);
  return named[0] || null;
}

function normalizeVideoSnapshot(value, expectedTotal = 0) {
  const source = Array.isArray(value) ? { videos: value, completedPages: true } : (value || {});
  const videos = Array.isArray(source.videos) ? source.videos : [];
  if (source.completedPages === false) {
    throw new Error(`Bilibili favorite pagination did not finish (${videos.length} visible items loaded). No local tasks were changed.`);
  }
  const visibleCount = videos.length;
  const reportedTotal = Math.max(visibleCount, Number(source.reportedTotal || 0), Number(expectedTotal || 0));
  return {
    videos,
    reportedTotal,
    visibleCount,
    visibilityGap: Math.max(0, reportedTotal - visibleCount),
    completedPages: true
  };
}

function snapshotMetadata(snapshot) {
  return {
    reportedTotal: snapshot.reportedTotal,
    visibleCount: snapshot.visibleCount,
    visibilityGap: snapshot.visibilityGap,
    completedPages: snapshot.completedPages
  };
}

module.exports = { CollectionSyncService, normalizeVideoSnapshot };
