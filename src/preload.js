const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orchestrator', {
  getRuntime: () => ipcRenderer.invoke('app:get-runtime'),
  checkLogin: () => ipcRenderer.invoke('bili:check-login'),
  prepareAccountSwitch: () => ipcRenderer.invoke('bili:prepare-account-switch'),
  listFolders: () => ipcRenderer.invoke('bili:list-folders'),
  syncCollection: (payload) => ipcRenderer.invoke('api:sync-collection', payload),
  snapshot: () => ipcRenderer.invoke('store:snapshot'),
  setTasksEnabled: (payload) => ipcRenderer.invoke('tasks:set-enabled', payload),
  updateFilenameMetadata: (value) => ipcRenderer.invoke('settings:filename-metadata', value),
  updateWorker: (payload) => ipcRenderer.invoke('workers:update', payload),
  exportMarkdown: (payload) => ipcRenderer.invoke('exports:markdown', payload),
  readDocument: (taskId) => ipcRenderer.invoke('documents:read', taskId),
  openDocument: (taskId) => ipcRenderer.invoke('documents:open', taskId),
  deleteDocument: (taskId) => ipcRenderer.invoke('documents:delete', taskId),
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
  copyImage: (source) => ipcRenderer.invoke('clipboard:write-image', source),
  readReadme: () => ipcRenderer.invoke('docs:read-readme'),
  openReadme: () => ipcRenderer.invoke('docs:open-readme'),
  openProjectPath: (value) => ipcRenderer.invoke('docs:open-project-path', value),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  ragState: (sessionId) => ipcRenderer.invoke('rag:state', sessionId),
  ragSaveProvider: (payload) => ipcRenderer.invoke('rag:provider-save', payload),
  ragDeleteProvider: (providerId) => ipcRenderer.invoke('rag:provider-delete', providerId),
  ragFetchModels: (providerId) => ipcRenderer.invoke('rag:models-fetch', providerId),
  ragUpdateModels: (payload) => ipcRenderer.invoke('rag:models-update', payload),
  ragCreateSession: (payload) => ipcRenderer.invoke('rag:session-create', payload),
  ragUpdateSession: (payload) => ipcRenderer.invoke('rag:session-update', payload),
  ragDeleteSession: (sessionId) => ipcRenderer.invoke('rag:session-delete', sessionId),
  ragCompactSession: (sessionId) => ipcRenderer.invoke('rag:session-compact', sessionId),
  ragSend: (payload) => ipcRenderer.invoke('rag:send', payload),
  ragStop: (sessionId) => ipcRenderer.invoke('rag:stop', sessionId),
  ragChooseSandbox: () => ipcRenderer.invoke('rag:choose-sandbox'),
  ragCreateSandbox: () => ipcRenderer.invoke('rag:create-sandbox'),
  ragImportAttachments: (sessionId) => ipcRenderer.invoke('rag:attachments-import', sessionId),
  ragImportClipboardImage: (sessionId) => ipcRenderer.invoke('rag:clipboard-image-import', sessionId),
  ragDiscardAttachment: (sessionId, attachmentId) => ipcRenderer.invoke('rag:attachment-discard', { sessionId, attachmentId }),
  ragResolveApproval: (payload) => ipcRenderer.invoke('rag:approval-resolve', payload),
  ragRenderMarkdown: (markdown, sessionId) => ipcRenderer.invoke('rag:render-markdown', { markdown, sessionId }),
  internalAgentState: () => ipcRenderer.invoke('internal-agent:state'),
  internalAgentCreateCollection: (name) => ipcRenderer.invoke('internal-agent:collection-create', name),
  internalAgentOpenCollection: (collectionId) => ipcRenderer.invoke('internal-agent:collection-open', collectionId),
  internalAgentOpenOutput: (sessionId) => ipcRenderer.invoke('internal-agent:output-open', sessionId),
  internalAgentCreateSession: (payload) => ipcRenderer.invoke('internal-agent:session-create', payload),
  internalAgentInspectSingle: (payload) => ipcRenderer.invoke('internal-agent:single-inspect', payload),
  internalAgentCreateSingle: (payload) => ipcRenderer.invoke('internal-agent:single-create', payload),
  internalAgentStart: (sessionId) => ipcRenderer.invoke('internal-agent:start', sessionId),
  internalAgentPause: (sessionId) => ipcRenderer.invoke('internal-agent:pause', sessionId),
  internalAgentStop: (sessionId) => ipcRenderer.invoke('internal-agent:stop', sessionId),
  internalAgentDelete: (sessionId) => ipcRenderer.invoke('internal-agent:delete', sessionId),
  videoCacheState: () => ipcRenderer.invoke('video-cache:state'),
  videoCacheCreateCollection: (name) => ipcRenderer.invoke('video-cache:collection-create', name),
  videoCacheSubmit: (payload) => ipcRenderer.invoke('video-cache:submit', payload),
  videoCacheResumeLogin: () => ipcRenderer.invoke('video-cache:resume-login'),
  videoCacheOpen: (id) => ipcRenderer.invoke('video-cache:open', id),
  videoCacheDeleteVideos: (ids) => ipcRenderer.invoke('video-cache:delete-videos', ids),
  videoCacheDeleteCollection: (id) => ipcRenderer.invoke('video-cache:delete-collection', id),
  dependencyState: () => ipcRenderer.invoke('dependencies:state'),
  dependencyAcknowledge: (payload) => ipcRenderer.invoke('dependencies:acknowledge', payload),
  dependencyDownload: (packageId) => ipcRenderer.invoke('dependencies:download', packageId),
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
  },
  onRagEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('rag:event', listener);
    return () => ipcRenderer.removeListener('rag:event', listener);
  },
  onInternalAgentEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('internal-agent:event', listener);
    return () => ipcRenderer.removeListener('internal-agent:event', listener);
  },
  onDependencyEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('dependency:event', listener);
    return () => ipcRenderer.removeListener('dependency:event', listener);
  },
  onVideoCacheEvent: (callback) => {
    const listener = (_event, data) => {
      if (String(data?.type || '').startsWith('video-cache-')) callback(data);
    };
    ipcRenderer.on('app:event', listener);
    return () => ipcRenderer.removeListener('app:event', listener);
  }
});
