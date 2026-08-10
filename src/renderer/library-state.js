(function exposeLibraryState(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StarOwnerLibraryState = api;
})(typeof globalThis === 'undefined' ? this : globalThis, () => {
  function isDocumentLibraryTask(task = {}) {
    return task.status === 'done'
      && Boolean(task.outputMarkdown)
      && task.knowledgeActive !== false
      && task.multiPartRole !== 'part';
  }

  function videoLibraryRecords(records = []) {
    return (Array.isArray(records) ? records : []).filter((record) => record && record.id);
  }

  return { isDocumentLibraryTask, videoLibraryRecords };
});
