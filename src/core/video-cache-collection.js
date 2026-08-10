const LOCAL_MEDIA_CACHE_SOURCE = 'local-media';

function isLocalMediaRecord(record = {}) {
  return record.localImported === true || record.sourceType === 'local-video';
}

function isLocalMediaCacheCollection(collection = {}, records = []) {
  if (collection.videoCacheSource === LOCAL_MEDIA_CACHE_SOURCE) return true;
  const collectionId = String(collection.id || '');
  return Boolean(collectionId) && records.some((record) => (
    String(record.collectionId || '') === collectionId && isLocalMediaRecord(record)
  ));
}

module.exports = {
  LOCAL_MEDIA_CACHE_SOURCE,
  isLocalMediaCacheCollection,
  isLocalMediaRecord
};
