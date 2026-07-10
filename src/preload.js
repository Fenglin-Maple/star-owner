const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orchestrator', {
  getRuntime: () => ipcRenderer.invoke('app:get-runtime'),
  checkLogin: () => ipcRenderer.invoke('bili:check-login'),
  prepareAccountSwitch: () => ipcRenderer.invoke('bili:prepare-account-switch'),
  listFolders: () => ipcRenderer.invoke('bili:list-folders'),
  syncCollection: (payload) => ipcRenderer.invoke('api:sync-collection', payload),
  setActiveCollection: (collectionId) => ipcRenderer.invoke('collections:set-active', collectionId),
  snapshot: () => ipcRenderer.invoke('store:snapshot'),
  setTasksEnabled: (payload) => ipcRenderer.invoke('tasks:set-enabled', payload),
  updateFilenameMetadata: (value) => ipcRenderer.invoke('settings:filename-metadata', value),
  updateWorker: (payload) => ipcRenderer.invoke('workers:update', payload),
  exportMarkdown: (payload) => ipcRenderer.invoke('exports:markdown', payload),
  readDocument: (taskId) => ipcRenderer.invoke('documents:read', taskId),
  openDocument: (taskId) => ipcRenderer.invoke('documents:open', taskId),
  listTools: () => ipcRenderer.invoke('tools:list'),
  updateTool: (payload) => ipcRenderer.invoke('tools:update', payload),
  getScheduler: () => ipcRenderer.invoke('scheduler:get'),
  updateScheduler: (patch) => ipcRenderer.invoke('scheduler:update', patch),
  listCredentials: () => ipcRenderer.invoke('credentials:list'),
  saveCredential: (payload) => ipcRenderer.invoke('credentials:save', payload),
  getCredential: (id) => ipcRenderer.invoke('credentials:get', id),
  deleteCredential: (id) => ipcRenderer.invoke('credentials:delete', id),
  listWorkspaces: () => ipcRenderer.invoke('workspaces:list'),
  addWorkspace: (payload) => ipcRenderer.invoke('workspaces:add', payload),
  setDefaultWorkspace: (id) => ipcRenderer.invoke('workspaces:set-default', id),
  removeWorkspace: (id) => ipcRenderer.invoke('workspaces:remove', id),
  copyText: (value) => ipcRenderer.invoke('clipboard:write', value),
  readReadme: () => ipcRenderer.invoke('docs:read-readme'),
  openReadme: () => ipcRenderer.invoke('docs:open-readme'),
  openProjectPath: (value) => ipcRenderer.invoke('docs:open-project-path', value),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:maximize-toggle'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  onRuntime: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('app:runtime', listener);
    return () => ipcRenderer.removeListener('app:runtime', listener);
  },
  onBootstrap: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('app:bootstrap', listener);
    return () => ipcRenderer.removeListener('app:bootstrap', listener);
  },
  onEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('app:event', listener);
    return () => ipcRenderer.removeListener('app:event', listener);
  }
});
