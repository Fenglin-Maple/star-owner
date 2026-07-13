const path = require('path');

const DELETED_COLLECTION_SUFFIX = '（已在B站删除的收藏夹）';
const REMOVED_FAVORITE_SUFFIX = '（已移出收藏夹）';

function stripSuffix(value, suffix) {
  const text = String(value || '').trim();
  return text.endsWith(suffix) ? text.slice(0, -suffix.length).trim() : text;
}

function collectionSourceName(collection = {}) {
  return String(collection.sourceName || stripSuffix(collection.name, DELETED_COLLECTION_SUFFIX) || collection.mediaId || '未命名收藏夹');
}

function deletedCollectionName(collection = {}) {
  return `${collectionSourceName(collection)}${DELETED_COLLECTION_SUFFIX}`;
}

function taskSourceTitle(task = {}) {
  return String(task.sourceTitle || stripSuffix(task.title, REMOVED_FAVORITE_SUFFIX) || task.bvid || '未命名视频');
}

function removedFavoriteTitle(task = {}) {
  return `${taskSourceTitle(task)}${REMOVED_FAVORITE_SUFFIX}`;
}

function isBiliCollection(collection = {}) {
  return Boolean(collection.mediaId)
    && collection.internal !== true
    && collection.collectionKind !== 'video-cache';
}

function collectionStorageName(collection = {}) {
  const existingRootName = collection.collectionRoot ? path.basename(String(collection.collectionRoot)) : '';
  return String(collection.storageName || existingRootName || collectionSourceName(collection) || collection.name || collection.mediaId || 'favorite');
}

function collectionSyncReady(collection = {}) {
  if (!isBiliCollection(collection)) return true;
  if (collection.biliDeleted) return false;
  if (collection.syncState === 'syncing') return false;
  if (collection.syncReady === true) return true;
  return collection.syncReady === undefined && Boolean(collection.lastSyncedAt);
}

function collectionBlockReason(collection = {}, { external = false } = {}) {
  if (!collection || !collection.id) return '收藏夹不存在。';
  if (!isBiliCollection(collection)) return '';
  if (collection.biliDeleted) return 'B站收藏夹已删除，已完成产物仍可阅读，但不能继续派发视频总结任务。';
  if (collection.syncState === 'syncing') return '该收藏夹正在同步，Agent 任务已暂停。';
  if (!collectionSyncReady(collection)) return '该收藏夹尚未完成任务同步，请先在「收藏夹同步」中完成同步。';
  if (external && collection.externalDispatchPaused) return '收藏夹同步后尚未重新激活外部 Agent 任务范围。';
  return '';
}

function favoriteStatus(task = {}, collection = {}) {
  if (collection.biliDeleted || task.favoriteState === 'collection-deleted') {
    return {
      code: 'collection-deleted',
      label: 'B站收藏夹已删除',
      at: task.removedFromFavoritesAt || collection.biliDeletedAt || ''
    };
  }
  if (task.removedFromFavorites || task.favoriteState === 'removed') {
    return {
      code: 'removed',
      label: '已移出B站收藏夹',
      at: task.removedFromFavoritesAt || ''
    };
  }
  if (isBiliCollection(collection)) return { code: 'active', label: '仍在B站收藏夹中', at: '' };
  return { code: 'local', label: '本地内置收藏夹', at: '' };
}

module.exports = {
  DELETED_COLLECTION_SUFFIX,
  REMOVED_FAVORITE_SUFFIX,
  collectionBlockReason,
  collectionSourceName,
  collectionStorageName,
  collectionSyncReady,
  deletedCollectionName,
  favoriteStatus,
  isBiliCollection,
  removedFavoriteTitle,
  taskSourceTitle
};
