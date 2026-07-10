const pages = document.querySelectorAll('.page');
const navItems = document.querySelectorAll('.nav-item');
const apiBadge = document.querySelector('#apiBadge');
const userName = document.querySelector('#userName');
const userAvatar = document.querySelector('#userAvatar');
const profileTitle = document.querySelector('#profileTitle');
const profileCollections = document.querySelector('#profileCollections');
const eventLog = document.querySelector('#eventLog');
const loginOutput = document.querySelector('#loginOutput');
const folderSelect = document.querySelector('#folderSelect');
const collectionOutput = document.querySelector('#collectionOutput');
const taskList = document.querySelector('#taskList');
const toolList = document.querySelector('#toolList');
const runList = document.querySelector('#runList');
const workerList = document.querySelector('#workerList');
const exportSourceList = document.querySelector('#exportSourceList');
const exportQueueList = document.querySelector('#exportQueueList');
const documentUserSelect = document.querySelector('#documentUserSelect');
const documentCollectionSelect = document.querySelector('#documentCollectionSelect');
const documentSearch = document.querySelector('#documentSearch');
const documentSort = document.querySelector('#documentSort');
const documentFavoriteFrom = document.querySelector('#documentFavoriteFrom');
const documentFavoriteTo = document.querySelector('#documentFavoriteTo');
const documentPublishedFrom = document.querySelector('#documentPublishedFrom');
const documentPublishedTo = document.querySelector('#documentPublishedTo');
const documentDurationMin = document.querySelector('#documentDurationMin');
const documentDurationMax = document.querySelector('#documentDurationMax');
const documentList = document.querySelector('#documentList');
const documentPreview = document.querySelector('#documentPreview');
const apiDocs = document.querySelector('#apiDocs');
const apiToolAnalytics = document.querySelector('#apiToolAnalytics');
const settingsOutput = document.querySelector('#settingsOutput');
const workspaceList = document.querySelector('#workspaceList');
const labelInput = document.querySelector('#labelInput');
const themeChoices = document.querySelector('#themeChoices');
const credentialSelect = document.querySelector('#credentialSelect');
const credentialUsername = document.querySelector('#credentialUsername');
const credentialPassword = document.querySelector('#credentialPassword');
const credentialNote = document.querySelector('#credentialNote');
const biliView = document.querySelector('#biliView');
const oneClickLoginButton = document.querySelector('#oneClickLogin');
const toastViewport = document.querySelector('#toastViewport');
const bootstrapPanel = document.querySelector('#bootstrapPanel');
const bootstrapTitle = document.querySelector('#bootstrapTitle');
const bootstrapMessage = document.querySelector('#bootstrapMessage');
const bootstrapBar = document.querySelector('#bootstrapBar');
const startupLoader = document.querySelector('#startupLoader');
const startupLoaderBar = document.querySelector('#startupLoaderBar');
const toolHealthGrid = document.querySelector('#toolHealthGrid');
const toolHealthSummary = document.querySelector('#toolHealthSummary');
const smsPanel = document.querySelector('#smsPanel');
const smsStatus = document.querySelector('#smsStatus');
const smsCodeInput = document.querySelector('#smsCodeInput');
const sendSmsCodeButton = document.querySelector('#sendSmsCode');
const submitSmsCodeButton = document.querySelector('#submitSmsCode');
const syncProgress = document.querySelector('#syncProgress');
const syncProgressLabel = document.querySelector('#syncProgressLabel');
const syncProgressBar = document.querySelector('#syncProgressBar');
const syncProgressPercent = document.querySelector('#syncProgressPercent');
const taskUserSelect = document.querySelector('#taskUserSelect');
const taskCollectionSelect = document.querySelector('#taskCollectionSelect');
const taskSearch = document.querySelector('#taskSearch');
const taskSort = document.querySelector('#taskSort');
const taskDateFrom = document.querySelector('#taskDateFrom');
const taskDateTo = document.querySelector('#taskDateTo');
const durationMin = document.querySelector('#durationMin');
const durationMax = document.querySelector('#durationMax');
const agentPromptTemplate = document.querySelector('#agentPromptTemplate');
const readmeContent = document.querySelector('#readmeContent');
const readmePath = document.querySelector('#readmePath');
const schedulerStatus = document.querySelector('#schedulerStatus');
const cpuAsrToggle = document.querySelector('#cpuAsrToggle');
const cpuAsrHint = document.querySelector('#cpuAsrHint');
const gpuMemoryLabel = document.querySelector('#gpuMemoryLabel');
const gpuMemoryValue = document.querySelector('#gpuMemoryValue');
const gpuMemoryBar = document.querySelector('#gpuMemoryBar');
const schedulerPoolGrid = document.querySelector('#schedulerPoolGrid');

let runtime = {};
let folders = [];
let profileFolders = [];
let profileFoldersUpdatedAt = 0;
let profileFoldersLoading = false;
let currentUser = null;
let lastSnapshot = { users: [], collections: [], tasks: [], tools: [], toolRuns: [], workers: [], workspaces: [], activeCollection: null, analytics: { collections: {}, workers: [], tools: [] }, activities: [] };
let loginEndpointReady = false;
let loginProbeTimer = null;
let loginWatchTimer = null;
let loginWatchDeadline = 0;
let loginSyncInFlight = false;
let smsChallenge = null;
let lastLoggedInMid = '';
let initialLoginCheckDone = false;
let accountSwitchInFlight = false;
let pendingCredentialId = '';
let activeCredentialId = localStorage.getItem('activeCredentialId') || '';
const bootstrapStartedAt = Date.now();
const taskSelection = new Set();
const exportSourceSelection = new Set();
const exportQueue = new Set();
let visibleTasks = [];
let visibleExportTasks = [];
let visibleDocuments = [];
let selectedDocumentId = '';
let lastDocumentContext = '';
let documentPreviewRequest = 0;
let filenameSettingsSaveTimer = null;
let lastTaskCollectionId = '';
let snapshotPromise = null;
let snapshotRefreshTimer = null;
let transientActivity = null;
let profileCloseTimer = null;
let readmeMarkdown = '';
let readmeLoadingPromise = null;
let toolHealth = [];
let themeTransitionActive = false;
let collectionSyncInFlight = false;
let schedulerUpdateInFlight = false;
let bootstrapDismissed = false;
let bootstrapHideTimer = null;
let backendSnapshotLoaded = false;

const TEXT = {
  navOverview: '\u542f\u52a8\u9875',
  navLogin: 'B\u7ad9\u767b\u5f55',
  navCollections: '\u6536\u85cf\u5939',
  navTasks: '\u4efb\u52a1',
  navDocuments: '\u6587\u6863\u5e93',
  navWorkers: '\u5de5\u4f5c Agent',
  navExport: '\u5bfc\u51fa',
  navTools: '\u5de5\u5177\u6a21\u5757',
  navRuns: '\u8fd0\u884c\u65e5\u5fd7',
  navSettings: '\u8bbe\u7f6e',
  navReadme: 'README',
  readmeTitle: '\u9879\u76ee\u8bf4\u660e',
  readmeHint: '\u4ece\u5b8c\u6574\u8bbe\u8ba1\u6587\u6863\u63d0\u70bc\u7684\u4f7f\u7528\u3001Agent \u534f\u4f5c\u4e0e\u4ea7\u7269\u89c4\u8303\u3002',
  copyMarkdown: '\u590d\u5236 Markdown',
  openFile: '\u6253\u5f00\u6587\u4ef6',
  readmeLoading: '\u6b63\u5728\u8bfb\u53d6 README...',
  overviewTitle: '\u661f\u7b3a\u5df2\u5c31\u7eea',
  overviewHint: '\u540c\u6b65\u6536\u85cf\u5939\u540e\uff0cagent \u53ef\u901a\u8fc7 API \u9886\u53d6\u4efb\u52a1\uff0c\u5e76\u8bf7\u6c42\u5e94\u7528\u4ee3\u4e3a\u6267\u884c\u5de5\u5177\u3002',
  metricCollections: '\u6536\u85cf\u5939',
  metricTasks: '\u4efb\u52a1',
  metricDone: '\u5b8c\u6210',
  metricRuns: '\u5de5\u5177\u8fd0\u884c',
  toolInterfaceStatus: '\u5de5\u5177\u63a5\u53e3\u72b6\u6001',
  toolInterfaceStatusHint: '\u542f\u52a8\u65f6\u9a8c\u8bc1\u811a\u672c\u54cd\u5e94\u4e0e\u672c\u5730\u4f9d\u8d56\u3002',
  toolOnline: '\u5728\u7ebf',
  toolDegraded: '\u90e8\u5206\u53ef\u7528',
  toolOffline: '\u79bb\u7ebf',
  toolChecking: '\u68c0\u67e5\u4e2d',
  recentStatus: '\u6700\u8fd1\u72b6\u6001',
  quickStart: '\u5feb\u901f\u4e0a\u624b',
  quickStartHint: '\u5c55\u5f00\u67e5\u770b\u5de5\u4f5c\u76ee\u6807\u3001\u534f\u4f5c\u539f\u5219\u4e0e\u5b8c\u6574 agent \u63d0\u793a\u8bcd\u3002',
  agentPromptTitle: '\u4ea4\u7ed9 Codex\u3001Claude Code \u6216\u5176\u5b83 agent',
  copyPrompt: '\u590d\u5236\u63d0\u793a\u8bcd',
  copy: '\u590d\u5236',
  waiting: '\u7b49\u5f85\u64cd\u4f5c...',
  loginTitle: 'B\u7ad9\u767b\u5f55',
  loginHint: '\u4f7f\u7528\u72ec\u7acb WebView \u767b\u5f55\uff0c\u4e0d\u590d\u7528\u73b0\u6709\u6d4f\u89c8\u5668\u3002',
  loginStatus: '\u767b\u5f55\u72b6\u6001',
  loginStatusHint: '\u5e94\u7528\u4f1a\u81ea\u52a8\u68c0\u6d4b\u767b\u5f55\u3001\u540c\u6b65\u5934\u50cf\u4e0e\u7528\u6237\u540d\uff0c\u5e76\u5bfc\u51fa cookie \u5230\u9879\u76ee\u5de5\u4f5c\u533a\u3002',
  checkLogin: '\u68c0\u6d4b\u767b\u5f55',
  savedAccount: '\u5df2\u4fdd\u5b58\u8d26\u53f7\uff08\u9009\u62e9\u5373\u5207\u6362\uff09',
  accountName: '\u8d26\u53f7',
  accountPassword: '\u5bc6\u7801',
  accountNote: '\u5907\u6ce8',
  saveAccount: '\u4fdd\u5b58',
  deleteAccount: '\u5220\u9664',
  oneClickLogin: '\u4e00\u952e\u767b\u5f55',
  smsTitle: '\u624b\u673a\u9a8c\u8bc1',
  smsWaiting: '\u7b49\u5f85\u9a8c\u8bc1\u7801',
  sendSms: '\u53d1\u9001\u9a8c\u8bc1\u7801',
  smsCode: '\u624b\u673a\u9a8c\u8bc1\u7801',
  confirmSms: '\u786e\u5b9a\u9a8c\u8bc1',
  collectionsTitle: '\u6536\u85cf\u5939',
  collectionsHint: '\u540c\u6b65\u6536\u85cf\u5939\u540e\uff0c\u5e94\u7528\u4f1a\u521b\u5efa\u4efb\u52a1\u5e93\u5b58\u548c\u9879\u76ee\u5185\u5de5\u4f5c\u533a\u3002',
  syncSettings: '\u540c\u6b65\u8bbe\u7f6e',
  loadFolders: '\u8bfb\u53d6\u6536\u85cf\u5939',
  favoriteFolder: '\u6536\u85cf\u5939',
  label: '\u6807\u8bc6',
  syncTasks: '\u540c\u6b65\u4efb\u52a1',
  readFoldersFirst: '\u8bf7\u5148\u8bfb\u53d6\u6536\u85cf\u5939',
  syncPreparing: '\u6b63\u5728\u51c6\u5907\u540c\u6b65...',
  tasksTitle: '\u4efb\u52a1',
  tasksHint: '\u67e5\u770b\u4efb\u52a1\u9886\u53d6\u3001\u5b8c\u6210\u548c\u6253\u56de\u72b6\u6001\u3002',
  taskInventory: '\u4efb\u52a1\u5e93\u5b58',
  currentInventory: '\u5f53\u524d\u5e93\u5b58',
  activeAgentTarget: 'Agent \u5f53\u524d\u5de5\u4f5c\u76ee\u6807',
  noActiveCollection: '\u5c1a\u672a\u6fc0\u6d3b\u6536\u85cf\u5939',
  activateCollection: '\u6fc0\u6d3b\u5f53\u524d\u6536\u85cf\u5939',
  videoTasks: '\u89c6\u9891\u4efb\u52a1',
  advancedFilters: '\u9ad8\u7ea7\u7b5b\u9009',
  inventoryUser: '\u7528\u6237',
  inventoryCollection: '\u6536\u85cf\u5939',
  searchTasks: '\u641c\u7d22',
  searchTasksPlaceholder: 'BV \u53f7 / UP \u4e3b / \u89c6\u9891\u6807\u9898',
  sortByFavorite: '\u6536\u85cf\u65f6\u95f4',
  newestFirst: '\u5012\u5e8f\uff08\u6700\u65b0\uff09',
  oldestFirst: '\u6b63\u5e8f\uff08\u6700\u65e9\uff09',
  favoriteDateFrom: '\u6536\u85cf\u8d77\u65e5',
  favoriteDateTo: '\u6536\u85cf\u6b62\u65e5',
  durationRange: '\u89c6\u9891\u65f6\u957f',
  selectVisible: '\u5168\u9009\u5f53\u524d',
  invertSelection: '\u53cd\u9009',
  enableSelected: '\u542f\u7528',
  disableSelected: '\u5173\u95ed',
  enabledTasks: '\u542f\u7528\u4efb\u52a1',
  claimedTasks: '\u5904\u7406\u4e2d',
  failedTasks: '\u5931\u8d25 / \u6253\u56de',
  disabledTasks: '\u5df2\u5173\u95ed',
  agentPerformance: 'Agent \u7ee9\u6548',
  workersTitle: '\u5de5\u4f5c Agent \u7ba1\u7406',
  workersHint: '\u6bcf\u4e2a\u65b0 Agent \u4f1a\u8bdd\u7531\u5e94\u7528\u5206\u914d\u72ec\u7acb Worker ID\uff0c\u7ee9\u6548\u3001\u5de5\u5177\u548c\u4efb\u52a1\u8bb0\u5f55\u5206\u5f00\u7edf\u8ba1\u3002',
  workerTotal: '\u5de5\u4f5c\u8005',
  workerActive: '\u53ef\u63a5\u5355',
  workerPaused: '\u5df2\u6682\u505c',
  workerWorking: '\u5904\u7406\u4e2d',
  workerSessions: 'Worker \u4f1a\u8bdd',
  workerSessionsHint: '\u6682\u505c\u540e\uff0c\u4e0b\u6b21\u7533\u8bf7\u4efb\u52a1\u4f1a\u6536\u5230\u7528\u6237\u6682\u505c\u4fe1\u606f\uff1b\u5df2\u9886\u53d6\u4efb\u52a1\u4ecd\u53ef\u63d0\u4ea4\u3002',
  pauseWorker: '\u6682\u505c\u5206\u914d',
  activateWorker: '\u6062\u590d\u5206\u914d',
  exportTitle: 'Markdown \u5bfc\u51fa',
  exportHint: '\u6c47\u96c6\u5df2\u5b8c\u6210\u7684\u89c6\u9891\u603b\u7ed3\uff0c\u5e76\u751f\u6210\u53ef\u76f4\u63a5\u7528\u4e8e RAG \u5efa\u5e93\u7684\u5143\u6570\u636e\u6e05\u5355\u3002',
  completedLibrary: '\u5df2\u5b8c\u6210\u6587\u6863\u5e93',
  completedLibraryHint: '\u5728\u4e0d\u540c\u7528\u6237\u548c\u6536\u85cf\u5939\u4e4b\u95f4\u9009\u62e9 Markdown\u3002',
  addToExport: '\u52a0\u5165\u5bfc\u51fa\u5217\u8868',
  exportQueue: '\u5bfc\u51fa\u5217\u8868',
  filenameMetadata: '\u6587\u4ef6\u540d\u9644\u52a0\u5143\u6570\u636e',
  videoTitle: '\u89c6\u9891\u6807\u9898',
  uploader: 'UP \u4e3b',
  publishedDate: '\u53d1\u5e03\u65e5\u671f',
  favoriteDate: '\u6536\u85cf\u65e5\u671f',
  sourceCollection: '\u6765\u81ea\u6536\u85cf\u5939',
  videoTags: '\u6807\u7b7e',
  artifactNaming: '\u4ea7\u7269\u6587\u4ef6\u540d',
  artifactNamingHint: '\u65b0\u4efb\u52a1\u63d0\u4ea4\u9a8c\u6536\u65f6\uff0c\u5e94\u7528\u4f1a\u7edf\u4e00\u6574\u7406\u89c6\u9891\u76ee\u5f55\u548c Markdown \u6587\u4ef6\u540d\u3002',
  filenamePreview: '\u793a\u4f8b',
  documentsTitle: 'Markdown \u6587\u6863\u5e93',
  documentsHint: '\u6309\u7528\u6237\u3001\u6536\u85cf\u5939\u548c\u65f6\u95f4\u8303\u56f4\u67e5\u627e\u5df2\u5b8c\u6210\u7684\u89c6\u9891\u603b\u7ed3\uff0c\u5e76\u5728\u5e94\u7528\u5185\u76f4\u63a5\u9605\u8bfb\u3002',
  documentSort: '\u6392\u5217',
  favoriteNewest: '\u6536\u85cf\u65f6\u95f4\uff1a\u6700\u65b0\u4f18\u5148',
  favoriteOldest: '\u6536\u85cf\u65f6\u95f4\uff1a\u6700\u65e9\u4f18\u5148',
  publishedNewest: '\u53d1\u5e03\u65f6\u95f4\uff1a\u6700\u65b0\u4f18\u5148',
  publishedOldest: '\u53d1\u5e03\u65f6\u95f4\uff1a\u6700\u65e9\u4f18\u5148',
  publishedDateFrom: '\u53d1\u5e03\u8d77\u65e5',
  publishedDateTo: '\u53d1\u5e03\u6b62\u65e5',
  documentList: '\u5df2\u5b8c\u6210\u6587\u6863',
  selectDocument: '\u9009\u62e9\u4e00\u7bc7\u6587\u6863',
  selectDocumentHint: '\u4ece\u5de6\u4fa7\u5217\u8868\u9009\u62e9 Markdown \u540e\u5728\u6b64\u9884\u89c8\u3002',
  chooseFolderExport: '\u9009\u62e9\u6587\u4ef6\u5939\u5e76\u5bfc\u51fa',
  clear: '\u6e05\u7a7a',
  refresh: '\u5237\u65b0',
  toolsTitle: '\u5de5\u5177\u6a21\u5757',
  toolsHint: 'agent \u5fc5\u987b\u901a\u8fc7 API \u8bf7\u6c42\u5e94\u7528\u6267\u884c\u5de5\u5177\uff1b\u8fd9\u91cc\u7ba1\u7406\u53ef\u7528\u6a21\u5757\u548c\u63d0\u793a\u8bcd\u3002',
  execTools: '\u6267\u884c\u5de5\u5177',
  runsTitle: '\u8fd0\u884c\u65e5\u5fd7',
  runsHint: '\u7531\u5e94\u7528\u4ee3 agent \u6267\u884c\u7684\u5de5\u5177\u8fdb\u7a0b\u4f1a\u8bb0\u5f55\u5728\u8fd9\u91cc\u3002',
  toolRuns: '\u5de5\u5177\u8fd0\u884c',
  apiHint: 'agent \u901a\u8fc7\u672c\u5730 API \u9886\u53d6\u4efb\u52a1\u3001\u8fd0\u884c\u5de5\u5177\u3001\u8f6e\u8be2\u65e5\u5fd7\u548c\u63d0\u4ea4\u4ea7\u7269\u3002',
  toolUsageAnalytics: '\u5de5\u5177\u8c03\u7528\u5206\u6790',
  toolUsageHint: '\u9ed8\u8ba4\u663e\u793a\u8c03\u7528\u91cf\uff0c\u5c55\u5f00\u67e5\u770b\u8017\u65f6\u3001\u6210\u529f\u7387\u4e0e\u8c03\u7528\u8005\u3002',
  apiQuickReference: 'API \u5feb\u901f\u53c2\u8003',
  settingsTitle: '\u8bbe\u7f6e',
  settingsHint: '\u4e3b\u9898\u3001\u4ea7\u7269\u547d\u540d\u3001\u8d44\u6e90\u8c03\u5ea6\u548c\u672c\u5730\u5de5\u4f5c\u533a\u3002',
  themeTitle: '\u4e3b\u9898',
  runtimeInfo: '\u8fd0\u884c\u73af\u5883',
  workspaceLibraries: 'Workspace \u5e93',
  workspaceLibrariesHint: '\u6240\u6709\u65b0\u9886\u53d6\u4efb\u52a1\u90fd\u4f7f\u7528\u9ed8\u8ba4\u5e93\u3002',
  addWorkspace: '\u6dfb\u52a0',
  setDefault: '\u8bbe\u4e3a\u9ed8\u8ba4',
  defaultWorkspace: '\u9ed8\u8ba4',
  remove: '\u79fb\u9664',
  sidebarWidth: '\u4fa7\u680f\u5bbd\u5ea6',
  sidebarHint: '\u5c55\u5f00\u65f6\u663e\u793a\u5b8c\u6574\u680f\u76ee\u540d\uff0c\u6536\u8d77\u65f6\u53ea\u4fdd\u7559\u56fe\u6807\u3002',
  toggle: '\u5207\u6362',
  noLogin: '\u672a\u767b\u5f55',
  chooseAccount: '\u9009\u62e9\u8d26\u53f7',
  syncedCollections: '\u5df2\u540c\u6b65\u6536\u85cf\u5939',
  allCollections: '\u5168\u90e8\u6536\u85cf\u5939',
  noCollections: '\u6682\u65e0\u6536\u85cf\u5939',
  noTasks: '\u6682\u65e0\u4efb\u52a1',
  noTasksHint: '\u540c\u6b65\u6536\u85cf\u5939\u540e\u4f1a\u5728\u8fd9\u91cc\u770b\u5230\u4efb\u52a1\u5e93\u5b58\u3002',
  noTools: '\u6682\u65e0\u5de5\u5177\u6a21\u5757',
  noToolsHint: '\u542f\u52a8\u65f6\u4f1a\u81ea\u52a8\u6ce8\u518c\u9ed8\u8ba4\u5de5\u5177\u3002',
  noRuns: '\u6682\u65e0\u8fd0\u884c\u8bb0\u5f55',
  noRunsHint: 'agent \u901a\u8fc7 API \u8bf7\u6c42\u5e94\u7528\u6267\u884c\u5de5\u5177\u540e\u4f1a\u51fa\u73b0\u5728\u8fd9\u91cc\u3002',
  empty: '\u7a7a',
  unknownUp: '\u672a\u77e5 UP',
  unknownDuration: '\u672a\u77e5\u65f6\u957f',
  claimer: '\u9886\u53d6\u8005',
  artifactDir: '\u5de5\u4f5c\u76ee\u5f55',
  output: '\u8f93\u51fa',
  open: '\u5f00',
  closed: '\u5173',
  agentUsage: 'Agent \u8c03\u7528\u65b9\u5f0f',
  pollStatus: '\u8f6e\u8be2\u8fd0\u884c\u72b6\u6001',
  internalCommand: '\u5e94\u7528\u5185\u90e8\u6267\u884c\u547d\u4ee4',
  agentPrompt: '\u7ed9 agent \u7684\u63d0\u793a\u8bcd',
  projects: '\u5f00\u6e90\u9879\u76ee',
  command: '\u547d\u4ee4',
  logFile: '\u65e5\u5fd7\u6587\u4ef6',
  exitCode: '\u9000\u51fa\u7801',
  started: '\u5f00\u59cb',
  finished: '\u7ed3\u675f',
  loginEndpointWaiting: '\u7b49\u5f85 B \u7ad9\u5bc6\u7801\u767b\u5f55\u8868\u5355\u52a0\u8f7d',
  loginEndpointReady: '\u5bc6\u7801\u767b\u5f55\u8868\u5355\u5df2\u5c31\u7eea',
  loginSessionKept: '\u5df2\u4fdd\u6301\u5f53\u524d B \u7ad9\u767b\u5f55\u72b6\u6001',
  toastSuccess: '\u64cd\u4f5c\u5b8c\u6210',
  toastError: '\u64cd\u4f5c\u5931\u8d25',
  toastInfo: '\u72b6\u6001\u63d0\u793a'
};

const THEMES = [
  ['night', '\u9ed1\u591c', '\u7edf\u4e00\u6df1\u8272\u5de5\u5177\u9762\u677f'],
  ['day', '\u767d\u5929', '\u6e05\u723d\u6d45\u8272\u5de5\u4f5c\u533a'],
  ['claude', 'Claude Code', '\u6696\u8272\u5b57\u4f53\u548c\u7ec8\u7aef\u611f\u6392\u7248'],
  ['bili', '\u54d4\u54e9\u54d4\u54e9\u7c89\u767d', '\u7c89\u8272\u9ad8\u4eae\u548c\u767d\u8272\u9762\u677f'],
  ['graphite', '\u77f3\u58a8', '\u4f4e\u5bf9\u6bd4\u9ed1\u7070\u914d\u8272'],
  ['midnight', '\u6df1\u84dd', '\u84dd\u9ed1\u79d1\u6280\u611f'],
  ['mint', '\u9752\u8584\u8377', '\u6e05\u51b7\u9752\u7eff\u8272\u8c03']
];

function applyI18n() {
  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = TEXT[node.dataset.i18n] || node.dataset.i18n;
  }
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) {
    node.placeholder = TEXT[node.dataset.i18nPlaceholder] || node.dataset.i18nPlaceholder;
  }
  for (const node of document.querySelectorAll('[data-i18n-title]')) {
    node.title = TEXT[node.dataset.i18nTitle] || node.dataset.i18nTitle;
  }
  eventLog.textContent = TEXT.waiting;
}

function renderThemeChoices() {
  themeChoices.innerHTML = '';
  for (const [id, name, hint] of THEMES) {
    const button = document.createElement('button');
    button.className = 'theme-card';
    button.dataset.theme = id;
    button.innerHTML = `<span class="theme-swatch theme-swatch-${id}"></span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(hint)}</small>`;
    button.addEventListener('click', (event) => transitionTheme(id, event.currentTarget, name));
    themeChoices.appendChild(button);
  }
}

async function refreshCredentials(selectedId = '') {
  const items = await window.orchestrator.listCredentials();
  credentialSelect.innerHTML = '';
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = TEXT.chooseAccount;
  credentialSelect.appendChild(empty);
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.id;
    const label = item.note ? `${item.username} / ${item.note}` : item.username;
    option.textContent = item.id === activeCredentialId ? `${label} / \u5f53\u524d` : label;
    credentialSelect.appendChild(option);
  }
  const wantedId = selectedId || activeCredentialId;
  if (wantedId && items.some((item) => item.id === wantedId)) credentialSelect.value = wantedId;
}

async function loadCredential(id) {
  if (!id) {
    credentialUsername.value = '';
    credentialPassword.value = '';
    credentialNote.value = '';
    return;
  }
  const item = await window.orchestrator.getCredential(id);
  credentialUsername.value = item.username || '';
  credentialPassword.value = item.password || '';
  credentialNote.value = item.note || '';
}

async function saveCredentialFromForm() {
  const previousId = credentialSelect.value || '';
  const item = await window.orchestrator.saveCredential({
    id: previousId,
    username: credentialUsername.value,
    password: credentialPassword.value,
    note: credentialNote.value
  });
  await refreshCredentials(item.id);
  credentialSelect.value = item.id;
  await loadCredential(item.id);
  if (previousId && previousId === activeCredentialId) {
    activeCredentialId = item.id;
    localStorage.setItem('activeCredentialId', activeCredentialId);
  }
  return item;
}

async function deleteSelectedCredential() {
  const id = credentialSelect.value;
  if (!id) return;
  await window.orchestrator.deleteCredential(id);
  if (id === activeCredentialId) {
    activeCredentialId = '';
    localStorage.removeItem('activeCredentialId');
  }
  await refreshCredentials();
  await loadCredential('');
}

async function oneClickLogin() {
  if (!loginEndpointReady) throw new Error('login form is not ready');
  const id = credentialSelect.value;
  const credential = id
    ? await window.orchestrator.getCredential(id)
    : { username: credentialUsername.value, password: credentialPassword.value };
  if (!credential.username || !credential.password) throw new Error('missing username or password');
  await ensureLoginPage();
  const result = await biliView.executeJavaScript(`
    (async () => {
      const username = ${JSON.stringify(credential.username)};
      const password = ${JSON.stringify(credential.password)};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const visible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
      };
      const compact = (value) => String(value || '').replace(/\\s+/g, '');
      const textOf = (el) => compact((el?.innerText || el?.textContent || '') + ' ' + (el?.className || '') + ' ' + (el?.ariaLabel || ''));
      const visibleText = (el) => compact(el?.innerText || el?.textContent || '');
      const isThirdParty = (el) => /\\u5fae\\u4fe1|wechat|\\u626b\\u7801|\\u4e8c\\u7ef4\\u7801|\\u0051\\u0051|\\u5fae\\u535a|\\u652f\\u4ed8\\u5b9d|\\u77ed\\u4fe1|\\u9a8c\\u8bc1\\u7801|\\u6ce8\\u518c/i.test(textOf(el));
      const hasVisiblePasswordInput = () => [...document.querySelectorAll('input[type="password"], input[name="password"]')].some(visible);
      const passwordRoot = () => document.querySelector('.login-pwd') || document.querySelector('.main__right') || document;
      const passwordModeScore = (el) => {
        const text = textOf(el);
        const label = visibleText(el);
        let score = 0;
        if (/\\u5bc6\\u7801\\u767b\\u5f55/.test(text)) score += 120;
        if (/\\u8d26\\u53f7\\u5bc6\\u7801|\\u8d26\\u53f7\\u767b\\u5f55|\\u5e10\\u53f7\\u5bc6\\u7801|\\u5e10\\u53f7\\u767b\\u5f55/.test(text)) score += 90;
        if (/\\u5bc6\\u7801/.test(text) && /\\u767b\\u5f55/.test(text)) score += 70;
        if (/password|account/i.test(text)) score += 50;
        if (/\\u77ed\\u4fe1|\\u9a8c\\u8bc1\\u7801|\\u626b\\u7801|\\u4e8c\\u7ef4\\u7801|\\u5fae\\u4fe1|wechat/i.test(label)) score -= 70;
        if (label.length > 20) score -= 35;
        if (el.matches('button, a, span, [role="tab"], [role="button"]')) score += 8;
        return score;
      };
      const clickPasswordMode = async () => {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          if (hasVisiblePasswordInput()) return true;
          const candidates = [...document.querySelectorAll('button, a, div, span, li, p, [role="tab"], [role="button"]')]
            .filter(visible)
            .map((el) => ({ el, score: passwordModeScore(el), label: visibleText(el).slice(0, 40) }))
            .filter((item) => item.score > 0)
            .sort((a, b) => b.score - a.score);
          const target = candidates[0]?.el;
          if (!target) return false;
          target.click();
          await sleep(500);
        }
        return hasVisiblePasswordInput();
      };
      const setValue = (el, value) => {
        if (!el) return false;
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        setter ? setter.call(el, value) : (el.value = value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      const switched = await clickPasswordMode();
      await sleep(250);
      const inputRoot = passwordRoot();
      const userSelectors = [
        '.login-pwd input[type="text"]',
        '.login-pwd input[type="tel"]',
        'input[name="username"]',
        'input[name="user"]',
        'input[name="loginName"]',
        'input[placeholder*="\\u8d26\\u53f7"]',
        'input[placeholder*="\\u624b\\u673a\\u53f7"]',
        'input[placeholder*="\\u90ae\\u7bb1"]',
        'input[type="tel"]',
        'input[type="text"]'
      ];
      const passSelectors = ['.login-pwd input[type="password"]', 'input[type="password"]', 'input[name="password"]'];
      const user = userSelectors.flatMap((s) => [...inputRoot.querySelectorAll(s), ...document.querySelectorAll(s)]).find(visible);
      const pass = passSelectors.flatMap((s) => [...inputRoot.querySelectorAll(s), ...document.querySelectorAll(s)]).find(visible);
      const okUser = setValue(user, username);
      const okPass = setValue(pass, password);
      await sleep(450);
      const debugClickables = [...document.querySelectorAll('button, a, span, [role="tab"], [role="button"]')]
        .filter(visible)
        .map((el) => visibleText(el).slice(0, 40))
        .filter(Boolean)
        .slice(0, 20);
      if (!okUser || !okPass) {
        return {
          okUser,
          okPass,
          switchedPasswordMode: switched,
          clicked: false,
          reason: 'password form not found; no login button clicked',
          visibleClickables: debugClickables,
          href: location.href
        };
      }
      const root = document.querySelector('.login-pwd') || pass?.closest('form, .login-pwd, .main__right, .login-pwd-wp, .login-box, .login-content, .bili-mini-login, .password-login') || document;
      const buttonPool = [...root.querySelectorAll('.btn_wp .btn_primary, .btn_primary, button[type="submit"], button, .btn, .login-btn, [role="button"]')].filter(visible);
      const loginButton = buttonPool
        .filter((el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true')
        .filter((el) => !/\\bdisabled\\b/i.test(String(el.className || '')))
        .filter((el) => !isThirdParty(el))
        .find((el) => /\\u767b\\u5f55|\\u767b \\u5f55|login|btn_primary|login-btn/i.test(textOf(el)));
      if (loginButton) loginButton.click();
      return {
        okUser,
        okPass,
        switchedPasswordMode: switched,
        clicked: Boolean(loginButton),
        clickedText: loginButton ? textOf(loginButton).slice(0, 80) : '',
        rootClass: typeof root.className === 'string' ? root.className : '',
        href: location.href
      };
    })();
  `);
  loginOutput.textContent = JSON.stringify(result, null, 2);
  return result;
}

function ensureLoginPage(forceReload = false) {
  return new Promise((resolve) => {
    const target = 'https://passport.bilibili.com/login';
    const src = biliView.getURL?.() || '';
    if (!forceReload && src.includes('passport.bilibili.com')) return resolve();
    const done = () => {
      biliView.removeEventListener('dom-ready', done);
      setTimeout(resolve, 500);
    };
    biliView.addEventListener('dom-ready', done);
    biliView.loadURL(target);
  });
}

function setLoginEndpointReady(ready, detail = '') {
  loginEndpointReady = Boolean(ready);
  if (!oneClickLoginButton) return;
  oneClickLoginButton.disabled = !loginEndpointReady;
  oneClickLoginButton.title = loginEndpointReady ? TEXT.loginEndpointReady : (detail || TEXT.loginEndpointWaiting);
}

async function detectLoginEndpoint() {
  try {
    const src = biliView.getURL?.() || '';
    if (!src.includes('passport.bilibili.com/login')) {
      setLoginEndpointReady(false, TEXT.loginEndpointWaiting);
      return false;
    }
    const result = await biliView.executeJavaScript(`
      (() => {
        const visible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
        };
        const root = document.querySelector('.login-pwd') || document.querySelector('.main__right');
        const user = root?.querySelector('input[type="text"], input[type="tel"], input[name="username"], input[name="loginName"]');
        const pass = root?.querySelector('input[type="password"], input[name="password"]');
        const button = root?.querySelector('.btn_wp .btn_primary, .btn_primary, button[type="submit"], button');
        return {
          ready: Boolean(root && visible(user) && visible(pass) && visible(button)),
          href: location.href,
          rootClass: typeof root?.className === 'string' ? root.className : '',
          buttonText: (button?.innerText || button?.textContent || '').trim(),
          buttonDisabled: Boolean(button?.disabled || button?.getAttribute('aria-disabled') === 'true')
        };
      })();
    `);
    setLoginEndpointReady(Boolean(result?.ready));
    return Boolean(result?.ready);
  } catch (error) {
    setLoginEndpointReady(false, error.message || String(error));
    return false;
  }
}

function scheduleLoginEndpointProbe(retries = 12) {
  if (loginProbeTimer) clearTimeout(loginProbeTimer);
  setLoginEndpointReady(false, TEXT.loginEndpointWaiting);
  const probe = async (remaining) => {
    const ready = await detectLoginEndpoint();
    if (ready || remaining <= 0) return;
    loginProbeTimer = setTimeout(() => probe(remaining - 1), 450);
  };
  loginProbeTimer = setTimeout(() => probe(retries), 150);
}

async function waitForLoginEndpoint(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await detectLoginEndpoint()) return true;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return false;
}

async function openLoginWorkspace() {
  if (!runtime.backendReady) return;
  if (!currentUser?.isLogin) await synchronizeLogin();
  if (currentUser?.isLogin) {
    stopLoginWatch();
    setSmsChallenge(null);
    setLoginEndpointReady(false, TEXT.loginSessionKept);
    return;
  }
  await ensureLoginPage();
  scheduleLoginEndpointProbe();
  startLoginWatch();
}

async function switchToCredential(id) {
  await loadCredential(id);
  if (!id || accountSwitchInFlight) return;
  if (currentUser?.isLogin && id === activeCredentialId) {
    showToast(TEXT.toastInfo, TEXT.loginSessionKept, 'info');
    return;
  }
  accountSwitchInFlight = true;
  credentialSelect.disabled = true;
  pendingCredentialId = id;
  try {
    showToast(TEXT.toastInfo, '\u6b63\u5728\u5207\u6362 B \u7ad9\u8d26\u53f7...', 'info');
    stopLoginWatch();
    setSmsChallenge(null);
    await window.orchestrator.prepareAccountSwitch();
    activeCredentialId = '';
    localStorage.removeItem('activeCredentialId');
    currentUser = null;
    lastLoggedInMid = '';
    profileFolders = [];
    profileFoldersUpdatedAt = 0;
    renderProfile(lastSnapshot);
    await ensureLoginPage(true);
    if (!await waitForLoginEndpoint()) throw new Error('\u672a\u68c0\u6d4b\u5230 B \u7ad9\u5bc6\u7801\u767b\u5f55\u8868\u5355');
    const result = await oneClickLogin();
    if (!result.clicked) throw new Error(result.reason || '\u672a\u80fd\u63d0\u4ea4 B \u7ad9\u767b\u5f55\u8868\u5355');
    showToast(TEXT.toastSuccess, '\u5df2\u63d0\u4ea4\u65b0\u8d26\u53f7\u767b\u5f55', 'success');
    startLoginWatch();
    setTimeout(pollLoginFlow, 800);
  } catch (error) {
    pendingCredentialId = '';
    loginOutput.textContent = error.message || String(error);
    showToast(TEXT.toastError, error.message || String(error), 'error');
  } finally {
    credentialSelect.disabled = false;
  }
}

function fitBiliWebView() {
  try {
    const url = biliView.getURL?.() || '';
    const width = biliView.getBoundingClientRect().width || 980;
    const factor = url.includes('passport.bilibili.com/login')
      ? Math.max(0.5, Math.min(0.85, width / 980))
      : 1;
    biliView.setZoomFactor?.(factor);
    if (url.includes('passport.bilibili.com/login')) {
      biliView.executeJavaScript(`
        (() => {
          let style = document.querySelector('#bili-orchestrator-fit-style');
          if (!style) {
            style = document.createElement('style');
            style.id = 'bili-orchestrator-fit-style';
            style.textContent = 'html, body { overflow-x: hidden !important; }';
            document.head.appendChild(style);
          }
        })();
      `).catch(() => {});
    }
  } catch {}
}

function showToast(title, message = '', type = 'info') {
  if (!toastViewport) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<div><strong>${escapeHtml(title)}</strong>${message ? `<span>${escapeHtml(message)}</span>` : ''}</div>`;
  toastViewport.appendChild(toast);
  const close = () => {
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 220);
  };
  setTimeout(close, type === 'error' ? 5200 : 3200);
}

function renderBootstrap(state = {}) {
  if (!bootstrapPanel) return;
  const overview = document.querySelector('#page-overview');
  const progress = Math.max(0, Math.min(1, Number(state.progress || 0)));
  const phase = state.phase || 'loading';
  if (phase === 'ready' && bootstrapDismissed) {
    bootstrapPanel.classList.add('ready');
    overview?.classList.add('startup-complete');
    startupLoader?.classList.add('complete');
    apiBadge.textContent = runtime.apiUrl || 'API ready';
    return;
  }
  if (phase !== 'ready') {
    bootstrapDismissed = false;
    if (bootstrapHideTimer) clearTimeout(bootstrapHideTimer);
    bootstrapHideTimer = null;
  }
  bootstrapPanel.classList.toggle('error', phase === 'error');
  bootstrapPanel.classList.remove('ready');
  overview?.classList.remove('startup-complete');
  bootstrapBar.style.width = `${Math.round(progress * 100)}%`;
  if (startupLoaderBar) startupLoaderBar.style.width = `${Math.max(3, Math.round(progress * 100))}%`;
  startupLoader?.classList.toggle('complete', phase === 'ready');
  startupLoader?.classList.toggle('error', phase === 'error');
  bootstrapTitle.textContent = phase === 'error'
    ? '\u540e\u7aef\u542f\u52a8\u5931\u8d25'
    : phase === 'ready'
      ? '\u540e\u7aef\u5df2\u5c31\u7eea'
      : '\u6b63\u5728\u542f\u52a8\u672c\u5730\u670d\u52a1';
  bootstrapMessage.textContent = state.message || '\u6b63\u5728\u51c6\u5907...';
  apiBadge.textContent = phase === 'ready' ? (runtime.apiUrl || 'API ready') : `${Math.round(progress * 100)}%`;
  if (phase === 'ready' && !bootstrapHideTimer) {
    const minimumVisible = Math.max(80, 180 - (Date.now() - bootstrapStartedAt));
    bootstrapHideTimer = setTimeout(() => {
      bootstrapHideTimer = null;
      bootstrapDismissed = true;
      bootstrapPanel.classList.add('ready');
      overview?.classList.add('startup-complete');
    }, minimumVisible);
  }
}

function renderToolHealth(items = toolHealth) {
  if (!toolHealthGrid || !toolHealthSummary) return;
  const knownTools = items.length ? items : [
    ['video-info', '\u89c6\u9891\u5143\u6570\u636e\u8bfb\u53d6'],
    ['material-bundle', '\u4e00\u952e\u7d20\u6750\u5305'],
    ['merged-video', '\u5408\u8f68\u89c6\u9891\u4e0b\u8f7d'],
    ['asr', '\u8bed\u97f3\u8f6c\u5b57\u5e55 ASR'],
    ['comments-top3', '\u70ed\u8bc4\u524d\u4e09\u6761'],
    ['clean-cache', '\u6e05\u7406\u89c6\u9891\u7f13\u5b58']
  ].map(([toolId, toolName], order) => ({ toolId, toolName, order, status: 'checking', message: '\u7b49\u5f85\u5e94\u7528\u68c0\u67e5' }));
  const labels = {
    online: TEXT.toolOnline,
    degraded: TEXT.toolDegraded,
    offline: TEXT.toolOffline,
    checking: TEXT.toolChecking
  };
  const sorted = [...knownTools].sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  const online = sorted.filter((item) => item.status === 'online').length;
  const responded = sorted.filter((item) => item.responded || item.status === 'online' || item.status === 'degraded').length;
  toolHealthSummary.textContent = `${online} \u5728\u7ebf / ${responded} \u5df2\u54cd\u5e94 / ${sorted.length}`;
  toolHealthGrid.innerHTML = sorted.map((item) => {
    const status = ['online', 'degraded', 'offline'].includes(item.status) ? item.status : 'checking';
    const disabled = item.enabled === false ? '<em>\u5df2\u7981\u7528</em>' : '';
    return `<div class="tool-health-item ${status}" title="${escapeHtml(item.message || '')}"><span class="tool-health-dot"></span><div><strong>${escapeHtml(item.toolName || item.toolId)}</strong><small>${escapeHtml(item.message || labels[status])}</small></div><div class="tool-health-state">${disabled}<b>${labels[status]}</b></div></div>`;
  }).join('');
}

function setSmsChallenge(next) {
  smsChallenge = next?.active ? next : null;
  smsPanel?.classList.toggle('active', Boolean(smsChallenge));
  document.querySelector('.login-layout .side-sheet')?.classList.toggle('verification-active', Boolean(smsChallenge));
  if (!smsChallenge) {
    if (smsCodeInput) smsCodeInput.value = '';
    return;
  }
  const phoneHint = String(smsChallenge.hint || '').match(/(?:\+?86[ -]?)?1\d{2}[ *-]{2,}\d{2,4}/)?.[0];
  smsStatus.textContent = phoneHint || TEXT.smsWaiting;
  sendSmsCodeButton.disabled = !smsChallenge.canSend;
  submitSmsCodeButton.disabled = !smsChallenge.canSubmit || !smsCodeInput.value.trim();
}

async function inspectSmsChallenge() {
  try {
    const result = await biliView.executeJavaScript(`
      (() => {
        const compact = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
        };
        const inputs = [...document.querySelectorAll('input')].filter(visible);
        const signature = (el) => compact([
          el.name, el.id, el.type, el.placeholder, el.autocomplete,
          el.getAttribute('aria-label'), el.className
        ].join(' '));
        const pageText = compact(document.body?.innerText || '');
        const explicit = inputs.find((el) => /\\u9a8c\\u8bc1\\u7801|sms|otp|one.?time|verify.?code/i.test(signature(el)));
        const fallback = inputs.find((el) => {
          const max = Number(el.maxLength || 0);
          return max > 0 && max <= 8 && /\\u9a8c\\u8bc1\\u7801|\\u77ed\\u4fe1\\u9a8c\\u8bc1|\\u624b\\u673a\\u9a8c\\u8bc1/.test(pageText);
        });
        const codeInput = explicit || fallback;
        if (!codeInput) return { active: false, href: location.href };
        const root = codeInput.closest('form, [role="dialog"], .dialog, .modal, .verify, .verification, .risk-container, .code-form')
          || codeInput.parentElement?.parentElement
          || document.body;
        const candidates = [...document.querySelectorAll('button, a, span, div, [role="button"]')]
          .filter(visible)
          .map((el) => ({ el, text: compact(el.innerText || el.textContent || '') }))
          .filter((item) => item.text && item.text.length <= 18);
        const send = candidates.find((item) => /^(\\u83b7\\u53d6|\\u53d1\\u9001|\\u91cd\\u65b0\\u53d1\\u9001|\\u91cd\\u65b0\\u83b7\\u53d6).{0,6}\\u9a8c\\u8bc1\\u7801$|^\\u83b7\\u53d6\\u9a8c\\u8bc1\\u7801$|^\\u53d1\\u9001\\u9a8c\\u8bc1\\u7801$/i.test(item.text));
        const scoped = [...root.querySelectorAll('button, a, span, div, [role="button"]')]
          .filter(visible)
          .map((el) => ({ el, text: compact(el.innerText || el.textContent || '') }))
          .filter((item) => item.text && item.text.length <= 12);
        const confirm = scoped.find((item) => /^(\\u786e\\u5b9a|\\u786e\\u8ba4|\\u9a8c\\u8bc1|\\u4e0b\\u4e00\\u6b65|\\u63d0\\u4ea4|\\u5b8c\\u6210|\\u767b\\u5f55)$/.test(item.text));
        const hint = compact(root.innerText || root.textContent || '').slice(0, 80);
        return {
          active: Boolean(codeInput && (send || confirm || /\\u624b\\u673a|\\u77ed\\u4fe1|\\u5b89\\u5168\\u9a8c\\u8bc1/.test(hint))),
          canSend: Boolean(send && !send.el.disabled && send.el.getAttribute('aria-disabled') !== 'true'),
          canSubmit: Boolean(confirm),
          hint,
          href: location.href
        };
      })();
    `);
    setSmsChallenge(result);
    return result;
  } catch {
    setSmsChallenge(null);
    return { active: false };
  }
}

async function performSmsAction(action, code = '') {
  return biliView.executeJavaScript(`
    (async () => {
      const action = ${JSON.stringify(action)};
      const code = ${JSON.stringify(code)};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const compact = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
      };
      const inputs = [...document.querySelectorAll('input')].filter(visible);
      const signature = (el) => compact([el.name, el.id, el.type, el.placeholder, el.autocomplete, el.getAttribute('aria-label'), el.className].join(' '));
      const pageText = compact(document.body?.innerText || '');
      const codeInput = inputs.find((el) => /\\u9a8c\\u8bc1\\u7801|sms|otp|one.?time|verify.?code/i.test(signature(el)))
        || inputs.find((el) => Number(el.maxLength || 0) > 0 && Number(el.maxLength || 0) <= 8 && /\\u9a8c\\u8bc1\\u7801/.test(pageText));
      const allActions = () => [...document.querySelectorAll('button, a, span, div, [role="button"]')]
        .filter(visible)
        .map((el) => ({ el, text: compact(el.innerText || el.textContent || '') }))
        .filter((item) => item.text && item.text.length <= 18);
      if (action === 'send') {
        const send = allActions().find((item) => /^(\\u83b7\\u53d6|\\u53d1\\u9001|\\u91cd\\u65b0\\u53d1\\u9001|\\u91cd\\u65b0\\u83b7\\u53d6).{0,6}\\u9a8c\\u8bc1\\u7801$|^\\u83b7\\u53d6\\u9a8c\\u8bc1\\u7801$|^\\u53d1\\u9001\\u9a8c\\u8bc1\\u7801$/i.test(item.text));
        if (!send) return { ok: false, reason: 'send button not found' };
        send.el.click();
        return { ok: true, action, text: send.text };
      }
      if (!codeInput) return { ok: false, reason: 'verification code input not found' };
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter ? setter.call(codeInput, code) : (codeInput.value = code);
      codeInput.dispatchEvent(new Event('input', { bubbles: true }));
      codeInput.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(350);
      const root = codeInput.closest('form, [role="dialog"], .dialog, .modal, .verify, .verification, .risk-container, .code-form')
        || codeInput.parentElement?.parentElement
        || document.body;
      const confirm = [...root.querySelectorAll('button, a, span, div, [role="button"]')]
        .filter(visible)
        .map((el) => ({ el, text: compact(el.innerText || el.textContent || '') }))
        .filter((item) => item.text && item.text.length <= 12)
        .find((item) => /^(\\u786e\\u5b9a|\\u786e\\u8ba4|\\u9a8c\\u8bc1|\\u4e0b\\u4e00\\u6b65|\\u63d0\\u4ea4|\\u5b8c\\u6210|\\u767b\\u5f55)$/.test(item.text));
      if (!confirm) return { ok: false, reason: 'confirmation button not found' };
      confirm.el.click();
      return { ok: true, action, text: confirm.text };
    })();
  `);
}

async function synchronizeLogin({ manual = false } = {}) {
  if (!runtime.backendReady || loginSyncInFlight) return currentUser;
  loginSyncInFlight = true;
  try {
    const info = await window.orchestrator.checkLogin();
    currentUser = info;
    if (info?.isLogin) {
      const mid = String(info.mid || info.id || '');
      const newlyDetected = !lastLoggedInMid || lastLoggedInMid !== mid;
      if (lastLoggedInMid && lastLoggedInMid !== mid) {
        setFolderInventory([]);
      }
      lastLoggedInMid = mid;
      if (pendingCredentialId) {
        activeCredentialId = pendingCredentialId;
        pendingCredentialId = '';
        localStorage.setItem('activeCredentialId', activeCredentialId);
        await refreshCredentials(activeCredentialId);
      }
      setSmsChallenge(null);
      stopLoginWatch();
      renderProfile(lastSnapshot);
      await refreshSnapshot();
      await refreshProfileFolders({ force: newlyDetected });
      loginOutput.textContent = JSON.stringify(info, null, 2);
      if (newlyDetected || manual) {
        showToast(TEXT.toastSuccess, `\u5df2\u767b\u5f55\uff1a${info.name || info.mid}\uff0ccookie \u5df2\u540c\u6b65`, 'success');
      }
      if ((biliView.getURL?.() || '').includes('passport.bilibili.com')) biliView.loadURL('https://www.bilibili.com');
    } else {
      setFolderInventory([]);
      if (manual) showToast(TEXT.toastInfo, '\u5c1a\u672a\u767b\u5f55', 'info');
    }
    renderProfile(lastSnapshot);
    return info;
  } catch (error) {
    if (manual) showToast(TEXT.toastError, error.message || String(error), 'error');
    return currentUser;
  } finally {
    loginSyncInFlight = false;
  }
}

async function pollLoginFlow() {
  await inspectSmsChallenge();
  await synchronizeLogin();
  if (Date.now() >= loginWatchDeadline) stopLoginWatch();
}

function startLoginWatch(durationMs = 180000) {
  loginWatchDeadline = Math.max(loginWatchDeadline, Date.now() + durationMs);
  if (loginWatchTimer) return;
  pollLoginFlow();
  loginWatchTimer = setInterval(pollLoginFlow, 4000);
}

function stopLoginWatch() {
  if (loginWatchTimer) clearInterval(loginWatchTimer);
  loginWatchTimer = null;
  loginWatchDeadline = 0;
}

function applyTheme(theme) {
  const id = THEMES.some((item) => item[0] === theme) ? theme : 'night';
  document.body.className = [...document.body.classList].filter((name) => !name.startsWith('theme-')).join(' ');
  document.body.classList.add(`theme-${id}`);
  localStorage.setItem('themeId', id);
  for (const button of document.querySelectorAll('.theme-card')) button.classList.toggle('active', button.dataset.theme === id);
}

async function transitionTheme(theme, origin, displayName = theme) {
  const current = [...document.body.classList].find((name) => name.startsWith('theme-'))?.slice(6);
  if (current === theme || themeTransitionActive) return;
  const rect = origin?.getBoundingClientRect?.() || { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  document.documentElement.style.setProperty('--theme-origin-x', `${x}px`);
  document.documentElement.style.setProperty('--theme-origin-y', `${y}px`);
  document.documentElement.style.setProperty('--theme-radius', `${Math.ceil(radius)}px`);

  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    applyTheme(theme);
    showToast(TEXT.toastSuccess, `\u5df2\u5207\u6362\u5230 ${displayName}`, 'success');
    return;
  }

  themeTransitionActive = true;
  document.documentElement.classList.add('theme-transitioning');
  try {
    const transition = document.startViewTransition(() => applyTheme(theme));
    await transition.finished;
    showToast(TEXT.toastSuccess, `\u5df2\u5207\u6362\u5230 ${displayName}`, 'success');
  } finally {
    themeTransitionActive = false;
    document.documentElement.classList.remove('theme-transitioning');
  }
}

function setPage(name) {
  navItems.forEach((item) => item.classList.toggle('active', item.dataset.page === name));
  pages.forEach((page) => page.classList.toggle('active', page.id === `page-${name}`));
  if (name === 'login') {
    openLoginWorkspace().catch((error) => showToast(TEXT.toastError, error.message || String(error), 'error'));
  }
  if (name === 'tasks') renderTaskInventory();
  if (name === 'documents') renderDocumentLibrary();
  if (name === 'collections') {
    if (profileFolders.length) populateFolderSelect(profileFolders);
    updateSyncCollectionState();
  }
  if (name === 'readme') loadReadme().catch((error) => showToast(TEXT.toastError, error.message || String(error), 'error'));
}

async function loadReadme() {
  if (readmeMarkdown) return;
  if (readmeLoadingPromise) return readmeLoadingPromise;
  readmeLoadingPromise = window.orchestrator.readReadme().then((document) => {
    readmeMarkdown = document.markdown || '';
    readmePath.textContent = document.path || '';
    readmeContent.innerHTML = document.html || `<p>${TEXT.readmeLoading}</p>`;
  }).finally(() => { readmeLoadingPromise = null; });
  return readmeLoadingPromise;
}

function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0');
}

function toggleSidebar() {
  const collapsed = !document.body.classList.contains('sidebar-collapsed');
  setSidebarCollapsed(collapsed);
  showToast(TEXT.toastInfo, collapsed ? '\u4fa7\u680f\u5df2\u6536\u8d77' : '\u4fa7\u680f\u5df2\u5c55\u5f00', 'info');
}

function log(message) {
  transientActivity = { createdAt: new Date().toISOString(), type: String(message || '') };
  renderActivityLog(lastSnapshot.activities || []);
}

async function refreshSnapshot() {
  if (snapshotPromise) return snapshotPromise;
  snapshotPromise = window.orchestrator.snapshot().then((snap) => {
    lastSnapshot = snap;
    if (snap.scheduler) runtime.scheduler = snap.scheduler;
    transientActivity = null;
    document.querySelector('#metricCollections').textContent = snap.collections.length;
    document.querySelector('#metricTasks').textContent = snap.tasks.length;
    document.querySelector('#metricDone').textContent = snap.tasks.filter((task) => task.status === 'done').length;
    document.querySelector('#metricRuns').textContent = (snap.toolRuns || []).length;
    renderProfile(snap);
    renderTaskInventory();
    renderTools(snap.tools || []);
    renderRuns(snap.toolRuns || []);
    renderWorkers(snap.analytics?.workers || []);
    renderExportPage();
    runtime.filenameMetadata = snap.settings?.filenameMetadata || runtime.filenameMetadata;
    renderFilenameMetadataSettings();
    renderDocumentLibrary();
    renderApiToolAnalytics(snap.analytics?.tools || []);
    renderWorkspaces(snap.workspaces || []);
    renderScheduler(runtime.scheduler);
    renderActivityLog(snap.activities || []);
    renderSettingsSummary();
    updatePromptTemplate();
    return snap;
  }).finally(() => {
    snapshotPromise = null;
  });
  return snapshotPromise;
}

function renderSettingsSummary() {
  const items = [
    ['Agent API', runtime.apiUrl || '\u6b63\u5728\u542f\u52a8...'],
    ['\u9ed8\u8ba4 Workspace', runtime.defaultWorkspace?.name || '-'],
    ['\u5de5\u4f5c\u533a', runtime.workspaceRoot || 'workspace'],
    ['SQLite', 'workspace/orchestrator.sqlite'],
    ['\u540e\u7aef\u72b6\u6001', runtime.backendReady ? '\u5df2\u5c31\u7eea' : '\u542f\u52a8\u4e2d'],
    ['\u5f53\u524d\u4e3b\u9898', localStorage.getItem('themeId') || 'night'],
    ['\u4fa7\u680f', document.body.classList.contains('sidebar-collapsed') ? '\u5df2\u6536\u8d77' : '\u5df2\u5c55\u5f00'],
    ['B\u7ad9\u8d26\u53f7', currentUser?.isLogin ? (currentUser.name || currentUser.mid) : TEXT.noLogin]
  ];
  settingsOutput.innerHTML = items.map(([label, value]) => `
    <div class="runtime-item">
      <span>${escapeHtml(label)}</span>
      <strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong>
    </div>
  `).join('');
}

function renderScheduler(state = runtime.scheduler) {
  if (!schedulerStatus || !cpuAsrToggle || !schedulerPoolGrid) return;
  if (!state) {
    schedulerStatus.textContent = '\u542f\u52a8\u4e2d';
    cpuAsrToggle.disabled = true;
    schedulerPoolGrid.innerHTML = '';
    return;
  }
  const queued = Number(state.totals?.queued || 0);
  const running = Number(state.totals?.running || 0);
  schedulerStatus.textContent = `${running} \u8fd0\u884c / ${queued} \u6392\u961f`;
  cpuAsrToggle.checked = Boolean(state.config?.cpuAsrEnabled);
  cpuAsrToggle.disabled = schedulerUpdateInFlight || !runtime.backendReady;
  const cpuState = state.services?.cpu?.state || 'stopped';
  cpuAsrHint.textContent = state.config?.cpuAsrEnabled
    ? `\u5df2\u5f00\u542f\uff0c\u670d\u52a1 ${cpuState}${state.services?.cpu?.pid ? ` / PID ${state.services.cpu.pid}` : ''}`
    : '\u9ed8\u8ba4\u5173\u95ed\uff0c\u4ec5\u5728\u624b\u52a8\u5f00\u542f\u540e\u52a0\u8f7d\u6a21\u578b\u3002';

  const gpu = state.gpu || {};
  const total = Number(gpu.totalMiB || 0);
  const used = Number(gpu.usedMiB || 0);
  const percent = total ? Math.max(0, Math.min(100, used / total * 100)) : 0;
  gpuMemoryLabel.textContent = gpu.name ? `GPU \u663e\u5b58 / ${gpu.name}` : 'GPU \u663e\u5b58';
  gpuMemoryValue.textContent = gpu.available
    ? `${used} / ${total} MiB\uff0c\u4fdd\u7559 ${state.config?.gpuReserveMiB || 0} MiB`
    : (gpu.error || '\u4e0d\u53ef\u7528');
  gpuMemoryBar.style.width = `${percent}%`;
  gpuMemoryBar.classList.toggle('capacity-low', gpu.available && Number(gpu.freeMiB || 0) < Number(state.config?.gpuReserveMiB || 0));

  const poolNames = { api: 'B\u7ad9 API', media: '\u4e0b\u8f7d / FFmpeg', asr: 'ASR', disk: '\u78c1\u76d8\u6e05\u7406' };
  schedulerPoolGrid.innerHTML = Object.entries(state.pools || {}).map(([id, pool]) => {
    const busy = (pool.lanes || []).filter((lane) => lane.busy).length;
    const enabled = (pool.lanes || []).filter((lane) => lane.enabled).length;
    const reason = pool.queued ? humanizeQueueReason(pool.queuedJobs?.[0]?.reason || pool.waitReason) : '';
    return `<div class="scheduler-pool-item" title="${escapeHtml(reason)}"><span>${escapeHtml(poolNames[id] || id)}</span><strong>${busy}/${enabled}</strong><em>${Number(pool.queued || 0)} \u7b49\u5f85</em></div>`;
  }).join('');
}

function humanizeQueueReason(reason) {
  const labels = {
    RESOURCE_BUSY: '\u8d44\u6e90\u6b63\u5fd9',
    RESOURCE_DISABLED: '\u8d44\u6e90\u901a\u9053\u5df2\u5173\u95ed',
    GPU_CAPACITY_WAIT: 'GPU \u663e\u5b58\u4e0d\u8db3\uff0c\u7b49\u5f85\u91ca\u653e',
    GPU_UNAVAILABLE: 'GPU \u4e0d\u53ef\u7528',
    GPU_SERVICE_UNAVAILABLE: 'GPU ASR \u670d\u52a1\u4e0d\u53ef\u7528',
    CPU_ASR_DISABLED: 'CPU ASR \u672a\u5f00\u542f',
    CPU_SERVICE_UNAVAILABLE: 'CPU ASR \u670d\u52a1\u4e0d\u53ef\u7528',
    APP_RESTART_RECOVERY: '\u5e94\u7528\u91cd\u542f\u540e\u6062\u590d\u6392\u961f'
  };
  return labels[reason] || reason || '-';
}

function renderActivityLog(activities) {
  const rows = transientActivity ? [transientActivity, ...activities] : activities;
  document.querySelector('#activityCount').textContent = String(rows.length);
  if (!rows.length) {
    eventLog.textContent = TEXT.waiting;
    return;
  }
  eventLog.textContent = rows.slice(0, 300).map((item) => {
    const time = new Date(item.createdAt || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
    const detail = [item.workerId || item.agentName, item.taskId, item.toolId, item.workspaceId].filter(Boolean).join(' / ');
    return `[${time}] ${humanizeEvent(item.type)}${detail ? `  ${detail}` : ''}`;
  }).join('\n');
}

function renderSyncProgress(event = {}) {
  if (!syncProgress) return;
  const progress = Math.max(0, Math.min(1, Number(event.progress || 0)));
  const stages = {
    fetching: '\u6b63\u5728\u8bfb\u53d6\u6536\u85cf\u89c6\u9891',
    indexing: '\u6b63\u5728\u5efa\u7acb\u4efb\u52a1\u7d22\u5f15',
    done: '\u6536\u85cf\u5939\u540c\u6b65\u5b8c\u6210',
    error: '\u6536\u85cf\u5939\u540c\u6b65\u5931\u8d25'
  };
  const count = event.total ? ` ${Number(event.loaded || 0)} / ${event.total}` : event.loaded ? ` ${event.loaded}` : '';
  syncProgress.classList.add('active');
  syncProgress.classList.toggle('complete', event.stage === 'done');
  syncProgress.classList.toggle('error', event.stage === 'error');
  syncProgressLabel.textContent = `${stages[event.stage] || TEXT.syncPreparing}${count}`;
  syncProgressPercent.textContent = `${Math.round(progress * 100)}%`;
  syncProgressBar.style.width = `${Math.round(progress * 100)}%`;
}

function humanizeEvent(type) {
  const labels = {
    'collection-synced': '\u6536\u85cf\u5939\u5df2\u540c\u6b65',
    'task-claimed': '\u4efb\u52a1\u5df2\u9886\u53d6',
    'task-completed': '\u4efb\u52a1\u5df2\u5b8c\u6210',
    'task-failed': '\u4efb\u52a1\u5904\u7406\u5931\u8d25',
    'task-rejected': '\u4ea7\u7269\u6821\u9a8c\u672a\u901a\u8fc7',
    'tasks-enabled-changed': '\u4efb\u52a1\u542f\u7528\u72b6\u6001\u5df2\u66f4\u65b0',
    'active-collection-changed': 'Agent \u5de5\u4f5c\u76ee\u6807\u5df2\u5207\u6362',
    'tool-run-started': '\u5de5\u5177\u5df2\u542f\u52a8',
    'tool-run-succeeded': '\u5de5\u5177\u6267\u884c\u6210\u529f',
    'tool-run-failed': '\u5de5\u5177\u6267\u884c\u5931\u8d25',
    'tool-run-timeout': '\u5de5\u5177\u6267\u884c\u8d85\u65f6',
    'tool-run-cancelled': '\u5de5\u5177\u6267\u884c\u5df2\u53d6\u6d88',
    'workspace-added': 'Workspace \u5e93\u5df2\u6dfb\u52a0',
    'workspace-default-changed': '\u9ed8\u8ba4 Workspace \u5df2\u5207\u6362',
    'workspace-removed': 'Workspace \u5e93\u5df2\u79fb\u9664'
  };
  return labels[type] || String(type || '\u672a\u77e5\u4e8b\u4ef6');
}

function folderIdentity(folder = {}) {
  return String(folder.mediaId || folder.id || folder.name || '');
}

function updateSyncCollectionState() {
  const button = document.querySelector('#syncCollection');
  if (button) button.disabled = collectionSyncInFlight || !folderSelect?.value;
}

function populateFolderSelect(items = profileFolders, selectedIdentity = '') {
  if (!folderSelect) return;
  const previous = String(selectedIdentity || folderSelect.value || '');
  folderSelect.innerHTML = '';
  if (!items.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = TEXT.readFoldersFirst;
    folderSelect.appendChild(option);
    updateSyncCollectionState();
    return;
  }
  for (const folder of items) {
    const option = document.createElement('option');
    option.value = folder.name;
    option.dataset.folderId = folderIdentity(folder);
    option.textContent = `${folder.name} (${Number(folder.mediaCount ?? folder.videoCount ?? 0)})`;
    folderSelect.appendChild(option);
  }
  const wanted = [...folderSelect.options].find((option) => option.value === previous || option.dataset.folderId === previous);
  folderSelect.value = wanted?.value || folderSelect.options[0]?.value || '';
  updateSyncCollectionState();
}

function setFolderInventory(items = [], selectedIdentity = '') {
  folders = Array.isArray(items) ? items : [];
  profileFolders = folders;
  profileFoldersUpdatedAt = folders.length ? Date.now() : 0;
  populateFolderSelect(folders, selectedIdentity);
  renderProfile(lastSnapshot);
}

function openCollectionFolder(item) {
  const profile = document.querySelector('#userProfile');
  profile?.classList.remove('profile-open');
  profile?.classList.add('profile-suppressed');
  setPage('collections');
  const identity = folderIdentity(item);
  const available = profileFolders.length ? profileFolders : [item];
  populateFolderSelect(available, identity);
  collectionOutput.textContent = `\u5df2\u9009\u62e9\u6536\u85cf\u5939\uff1a${item.name || identity}`;
}

function renderProfile(snap) {
  const user = currentUser?.isLogin ? currentUser : null;
  const loggedIn = Boolean(user?.isLogin);
  const profile = document.querySelector('#userProfile');
  profile?.classList.toggle('logged-in', loggedIn);
  if (!loggedIn) profile?.classList.remove('profile-open');
  userName.textContent = loggedIn ? user.name : TEXT.noLogin;
  if (user?.face) {
    userAvatar.src = user.face;
    userAvatar.style.display = 'block';
  } else {
    userAvatar.removeAttribute('src');
    userAvatar.style.display = 'none';
  }
  profileCollections.innerHTML = '';
  if (!loggedIn) {
    profileTitle.textContent = '';
    return;
  }
  const synced = (snap.collections || []).filter((item) => !user || String(item.userId || '') === String(user.mid || user.id || ''));
  const syncedByMediaId = new Map(synced.map((item) => [String(item.mediaId || ''), item]));
  const collections = (profileFolders.length
    ? profileFolders.map((folder) => {
        const local = syncedByMediaId.get(String(folder.id)) || {};
        const latest = [folder.updatedAt, local.latestFavoriteAt, local.lastSyncedAt].filter(Boolean).sort().at(-1) || '';
        return { ...local, ...folder, latestFavoriteAt: latest };
      })
    : synced.map((item) => ({ ...item, mediaCount: item.videoCount, latestFavoriteAt: item.latestFavoriteAt || item.lastSyncedAt })))
    .sort((a, b) => String(b.latestFavoriteAt || b.updatedAt || '').localeCompare(String(a.latestFavoriteAt || a.updatedAt || '')) || String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN'));
  profileTitle.textContent = `${TEXT.allCollections} · ${collections.length}`;
  if (!collections.length) {
    const empty = document.createElement('div');
    empty.className = 'popover-empty';
    empty.textContent = profileFoldersLoading ? '\u6b63\u5728\u8bfb\u53d6\u6536\u85cf\u5939...' : TEXT.noCollections;
    profileCollections.appendChild(empty);
    return;
  }
  for (const item of collections) {
    const row = document.createElement(item.id ? 'button' : 'div');
    row.className = 'popover-row';
    const count = Number(item.mediaCount ?? item.videoCount ?? 0);
    const updatedAt = item.latestFavoriteAt || item.updatedAt || item.lastSyncedAt || '';
    row.innerHTML = `<div class="popover-row-main"><strong>${escapeHtml(item.name || item.id)}</strong><span>${count} \u4e2a\u89c6\u9891</span></div><time title="${escapeHtml(formatDateTime(updatedAt, true))}">${escapeHtml(formatDateTime(updatedAt))}</time>`;
    if (item.id) {
      row.type = 'button';
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        openCollectionFolder(item);
      });
    }
    profileCollections.appendChild(row);
  }
}

async function refreshProfileFolders({ force = false } = {}) {
  if (!currentUser?.isLogin || !runtime.backendReady || profileFoldersLoading) return profileFolders;
  if (!force && profileFolders.length && Date.now() - profileFoldersUpdatedAt < 5 * 60 * 1000) return profileFolders;
  profileFoldersLoading = true;
  renderProfile(lastSnapshot);
  try {
    const nextFolders = await window.orchestrator.listFolders();
    setFolderInventory(nextFolders, folderSelect?.value);
  } catch {
    profileFoldersUpdatedAt = Date.now();
  } finally {
    profileFoldersLoading = false;
    renderProfile(lastSnapshot);
  }
  return profileFolders;
}

function renderTaskInventory() {
  syncTaskSelectors();
  const collectionId = taskCollectionSelect?.value || '';
  const collection = (lastSnapshot.collections || []).find((item) => item.id === collectionId);
  const collectionTasks = (lastSnapshot.tasks || []).filter((task) => task.collectionId === collectionId);
  if (collectionId !== lastTaskCollectionId) {
    lastTaskCollectionId = collectionId;
    resetDurationRange(collectionTasks);
    taskSelection.clear();
  }
  visibleTasks = filterTasks(collectionTasks);
  renderActiveCollection(collection);
  renderTaskAnalytics(collection, collectionTasks);
  renderTaskRows(visibleTasks);
}

function renderActiveCollection(viewedCollection) {
  const active = lastSnapshot.activeCollection;
  const label = document.querySelector('#activeCollectionLabel');
  const button = document.querySelector('#activateCollection');
  const bar = document.querySelector('.task-target-bar');
  if (label) label.textContent = active ? `${active.userName || '-'} / ${active.name}` : TEXT.noActiveCollection;
  bar?.classList.toggle('has-active-target', Boolean(active));
  const isViewedActive = Boolean(active && viewedCollection && active.id === viewedCollection.id);
  if (button) {
    button.disabled = !viewedCollection || isViewedActive;
    button.textContent = isViewedActive ? '\u5df2\u6fc0\u6d3b' : TEXT.activateCollection;
  }
}

function syncTaskSelectors() {
  if (!taskUserSelect || !taskCollectionSelect) return;
  const collections = lastSnapshot.collections || [];
  const users = new Map();
  for (const collection of collections) users.set(String(collection.userId || collection.userName), collection.userName || collection.userId || '-');
  const previousUser = taskUserSelect.value;
  taskUserSelect.innerHTML = [...users.entries()].map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join('');
  const currentUserId = String(currentUser?.mid || currentUser?.id || '');
  if ([...users.keys()].includes(previousUser)) taskUserSelect.value = previousUser;
  else if (users.has(currentUserId)) taskUserSelect.value = currentUserId;
  const selectedUser = taskUserSelect.value;
  const available = collections.filter((item) => String(item.userId || item.userName) === selectedUser);
  const previousCollection = taskCollectionSelect.value || lastTaskCollectionId;
  taskCollectionSelect.innerHTML = available.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} (${Number(item.videoCount || 0)})</option>`).join('');
  if (available.some((item) => item.id === previousCollection)) taskCollectionSelect.value = previousCollection;
}

function resetDurationRange(tasks) {
  const max = Math.max(60, ...tasks.map((task) => Number(task.duration || 0)));
  durationMin.max = String(max);
  durationMax.max = String(max);
  durationMin.value = '0';
  durationMax.value = String(max);
  updateDurationLabel();
}

function filterTasks(tasks) {
  const query = String(taskSearch?.value || '').trim().toLocaleLowerCase();
  const from = taskDateFrom?.value ? new Date(`${taskDateFrom.value}T00:00:00`).getTime() : 0;
  const to = taskDateTo?.value ? new Date(`${taskDateTo.value}T23:59:59.999`).getTime() : Number.POSITIVE_INFINITY;
  const minDuration = Number(durationMin?.value || 0);
  const maxDuration = Number(durationMax?.value || Number.MAX_SAFE_INTEGER);
  const direction = taskSort?.value === 'asc' ? 1 : -1;
  return tasks.filter((task) => {
    const haystack = `${task.bvid || ''} ${task.owner || ''} ${task.title || ''}`.toLocaleLowerCase();
    const favoriteTime = Date.parse(task.favoriteAddedAt || task.createdAt || '') || 0;
    const duration = Number(task.duration || 0);
    return (!query || haystack.includes(query)) && favoriteTime >= from && favoriteTime <= to && duration >= minDuration && duration <= maxDuration;
  }).sort((a, b) => {
    const aTime = Date.parse(a.favoriteAddedAt || a.createdAt || '') || 0;
    const bTime = Date.parse(b.favoriteAddedAt || b.createdAt || '') || 0;
    return direction * (aTime - bTime) || String(a.title || a.bvid).localeCompare(String(b.title || b.bvid), 'zh-Hans-CN');
  });
}

function renderTaskRows(tasks) {
  taskList.innerHTML = '';
  document.querySelector('#taskFilterSummary').textContent = `\u663e\u793a ${tasks.length} / ${(lastSnapshot.tasks || []).filter((task) => task.collectionId === taskCollectionSelect.value).length}`;
  document.querySelector('#taskSelectionSummary').textContent = `\u5df2\u9009 ${taskSelection.size}`;
  if (!tasks.length) return taskList.appendChild(emptyRow(TEXT.noTasks, TEXT.noTasksHint));
  for (const task of tasks) {
    const favoriteAt = task.favoriteAddedAt || task.createdAt || '';
    const enabled = task.enabled !== false;
    const selected = taskSelection.has(task.id);
    const row = settingRow({
      icon: `<input class="task-checkbox" type="checkbox" data-task-id="${escapeHtml(task.id)}" ${selected ? 'checked' : ''} aria-label="\u9009\u62e9\u4efb\u52a1" />`,
      title: task.title || task.bvid,
      subtitle: `${task.bvid}  /  ${task.owner || TEXT.unknownUp}  /  \u6536\u85cf\u4e8e ${formatDateTime(favoriteAt)}  /  ${formatSeconds(task.duration)}`,
      right: `<span class="state-tag ${enabled ? statusClass(task.status) : 'idle'}">${escapeHtml(enabled ? task.status : '\u5df2\u5173\u95ed')}</span><label class="switch task-enable" title="${enabled ? '\u5173\u95ed\u4efb\u52a1' : '\u542f\u7528\u4efb\u52a1'}"><input type="checkbox" ${enabled ? 'checked' : ''} data-task-toggle="${escapeHtml(task.id)}" /><span></span></label>`,
      detail: `<div class="detail-grid"><div><span>\u6536\u85cf\u65f6\u95f4</span><strong>${escapeHtml(formatDateTime(favoriteAt, true))}</strong></div><div><span>\u53d1\u5e03\u65f6\u95f4</span><strong>${escapeHtml(formatDateTime(task.publishedAt, true))}</strong></div><div><span>\u4efb\u52a1\u521b\u5efa</span><strong>${escapeHtml(formatDateTime(task.createdAt, true))}</strong></div><div><span>${TEXT.claimer}</span><strong title="${escapeHtml(task.claimedBy || '-')}">${escapeHtml(task.claimedBy || '-')}</strong></div><div><span>${TEXT.artifactDir}</span><strong title="${escapeHtml(task.artifactDir || '-')}">${escapeHtml(task.artifactDir || '-')}</strong></div><div><span>${TEXT.output}</span><strong title="${escapeHtml(task.outputMarkdown || '-')}">${escapeHtml(task.outputMarkdown || '-')}</strong></div></div>`
    });
    row.classList.add('task-row');
    row.classList.toggle('task-disabled', !enabled);
    row.dataset.taskId = task.id;
    row.querySelector('.task-checkbox')?.addEventListener('change', (event) => {
      if (event.target.checked) taskSelection.add(task.id);
      else taskSelection.delete(task.id);
      document.querySelector('#taskSelectionSummary').textContent = `\u5df2\u9009 ${taskSelection.size}`;
    });
    row.querySelector('[data-task-toggle]')?.addEventListener('change', async (event) => {
      const next = event.target.checked;
      event.target.disabled = true;
      try {
        await updateTaskEnabled([task.id], next);
      } catch (error) {
        event.target.checked = !next;
        showToast(TEXT.toastError, error.message || String(error), 'error');
      } finally {
        event.target.disabled = false;
      }
    });
    taskList.appendChild(row);
  }
}

function renderTaskAnalytics(collection, tasks) {
  const stats = lastSnapshot.analytics?.collections?.[collection?.id] || fallbackCollectionStats(tasks);
  const progress = Math.max(0, Math.min(1, Number(stats.progress || 0)));
  document.querySelector('#taskContextLabel').textContent = collection ? `${collection.userName || '-'} / ${collection.name}` : '-';
  document.querySelector('#taskProgressPercent').textContent = `${Math.round(progress * 100)}%`;
  document.querySelector('#taskProgressLabel').textContent = `${Number(stats.done || 0)} / ${Number(stats.enabled || 0)} \u5df2\u5b8c\u6210`;
  document.querySelector('#taskProgressBar').style.width = `${Math.round(progress * 100)}%`;
  document.querySelector('#taskMetricEnabled').textContent = String(stats.enabled || 0);
  document.querySelector('#taskMetricClaimed').textContent = String(stats.claimed || 0);
  document.querySelector('#taskMetricFailed').textContent = String(stats.failed || 0);
  document.querySelector('#taskMetricDisabled').textContent = String(stats.disabled || 0);
  renderAgentPerformance(stats.agents || []);
}

function fallbackCollectionStats(tasks) {
  const enabled = tasks.filter((task) => task.enabled !== false);
  const count = (statuses) => enabled.filter((task) => statuses.includes(task.status)).length;
  const done = count(['done']);
  return { enabled: enabled.length, disabled: tasks.length - enabled.length, done, claimed: count(['claimed']), failed: count(['failed', 'rejected']), progress: enabled.length ? done / enabled.length : 0, agents: [] };
}

function renderAgentPerformance(agents) {
  const preview = document.querySelector('#agentPerformancePreview');
  const details = document.querySelector('#agentPerformanceDetails');
  const claimed = agents.reduce((sum, agent) => sum + Number(agent.claimed || 0), 0);
  const completed = agents.reduce((sum, agent) => sum + Number(agent.completed || 0), 0);
  const failures = agents.reduce((sum, agent) => sum + Number(agent.failures || 0), 0);
  const terminal = completed + failures;
  const totalSuccess = terminal ? Math.round(completed / terminal * 100) : 0;
  preview.innerHTML = agents.length
    ? agents.slice(0, 3).map((agent) => `<span class="agent-chip"><b>${escapeHtml(agent.workerId || agent.name)}</b> ${agent.completed}/${agent.claimed}</span>`).join('')
    : '<span class="empty-inline">\u6682\u65e0\u63a5\u5355\u8bb0\u5f55\uff0c\u70b9\u51fb\u67e5\u770b\u7edf\u8ba1\u9762\u677f</span>';
  const maxCompleted = Math.max(1, ...agents.map((agent) => Number(agent.completed || 0)));
  const rows = agents.map((agent) => {
    const width = Math.max(4, Math.round(Number(agent.completed || 0) / maxCompleted * 100));
    const ratio = agent.weightedTimeRatio === null || agent.weightedTimeRatio === undefined ? '-' : `${Number(agent.weightedTimeRatio).toFixed(2)}x`;
    const success = agent.successRate === null || agent.successRate === undefined ? '-' : `${Math.round(Number(agent.successRate) * 100)}%`;
    return `<div class="agent-performance-row"><strong title="${escapeHtml(agent.workerId || agent.name)}">${escapeHtml(agent.workerId || agent.name)}<em>${escapeHtml(agent.tool || '')} / ${escapeHtml(agent.model || '')}</em></strong><div class="performance-bar"><span style="width:${width}%"></span></div><small>\u63a5 ${agent.claimed} / \u6210 ${agent.completed} / \u8017\u65f6\u6743\u91cd ${ratio} / \u6210\u529f ${success}</small></div>`;
  }).join('');
  details.innerHTML = `<div class="agent-performance-dashboard"><div class="agent-dashboard-title"><strong>Agent \u5de5\u4f5c\u603b\u89c8</strong><span>\u6240\u6709\u6570\u636e\u90fd\u6309 Worker ID \u72ec\u7acb\u7edf\u8ba1</span></div><div class="agent-dashboard-kpis"><div><span>Worker</span><strong>${agents.length}</strong></div><div><span>\u603b\u9886\u53d6</span><strong>${claimed}</strong></div><div><span>\u603b\u5b8c\u6210</span><strong>${completed}</strong></div><div><span>\u603b\u6210\u529f\u7387</span><strong>${totalSuccess}%</strong></div></div><div class="agent-dashboard-chart">${rows || '<div class="agent-empty-chart"><span></span><strong>\u5c1a\u65e0\u5de5\u4f5c\u6570\u636e</strong><p>Worker \u6ce8\u518c\u5e76\u9886\u53d6\u4efb\u52a1\u540e\uff0c\u8fd9\u91cc\u4f1a\u5c55\u793a\u6bcf\u4e2a Agent \u7684\u9886\u5355\u3001\u5b8c\u6210\u3001\u8017\u65f6\u6743\u91cd\u548c\u6210\u529f\u7387\u3002</p></div>'}</div></div>`;
}

async function updateTaskEnabled(taskIds, enabled) {
  if (!taskIds.length) return;
  const result = await window.orchestrator.setTasksEnabled({ taskIds, enabled });
  await refreshSnapshot();
  showToast(TEXT.toastSuccess, `${result.updated} \u4e2a\u4efb\u52a1\u5df2${enabled ? '\u542f\u7528' : '\u5173\u95ed'}`, 'success');
}

function updateDurationLabel() {
  let min = Number(durationMin?.value || 0);
  let max = Number(durationMax?.value || 0);
  if (min > max) [min, max] = [max, min];
  durationMin.value = String(min);
  durationMax.value = String(max);
  document.querySelector('#durationRangeLabel').textContent = `${formatDurationBound(min)} - ${formatDurationBound(max)}`;
}

function formatDurationBound(value) {
  const seconds = Math.max(0, Number(value || 0));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function renderTools(tools) {
  toolList.innerHTML = '';
  if (!tools.length) return toolList.appendChild(emptyRow(TEXT.noTools, TEXT.noToolsHint));
  for (const tool of tools) {
    const projects = (tool.projects || []).map((project) => {
      const url = project.github || project.url;
      const link = url ? `<a href="${escapeHtml(url)}" target="_blank">${escapeHtml(project.name)}</a>` : escapeHtml(project.name);
      return `<li>${link}<span>${escapeHtml(project.role || '')}</span></li>`;
    }).join('');
    const outputs = (tool.outputs || []).map((item) => `<span>${escapeHtml(item)}</span>`).join('');
    const row = settingRow({
      icon: iconTool(),
      title: tool.name,
      subtitle: tool.description,
      right: `<span class="state-text">${tool.enabled ? TEXT.open : TEXT.closed}</span><label class="switch"><input type="checkbox" ${tool.enabled ? 'checked' : ''} data-tool-id="${escapeHtml(tool.id)}" /><span></span></label>`,
      detail: `<div class="tool-detail"><div><h4>${TEXT.agentUsage}</h4><pre>POST ${escapeHtml(runtime.apiUrl || 'http://127.0.0.1:17391')}/api/tasks/&lt;taskId&gt;/tools/${escapeHtml(tool.id)}/run\n{\n  "workerId": "&lt;workerId&gt;",\n  "options": {}\n}</pre></div><div><h4>${TEXT.pollStatus}</h4><pre>GET ${escapeHtml(runtime.apiUrl || 'http://127.0.0.1:17391')}/api/tool-runs/&lt;runId&gt;?log=1</pre></div><div><h4>${TEXT.internalCommand}</h4><pre>${escapeHtml(tool.internalCommand || tool.command || '')}</pre></div><div><h4>${TEXT.agentPrompt}</h4><p>${escapeHtml(tool.agentPrompt)}</p></div><div><h4>${TEXT.output}</h4><div class="chip-row">${outputs}</div></div><div><h4>${TEXT.projects}</h4><ul class="project-list">${projects}</ul></div></div>`
    });
    row.querySelector('input[type="checkbox"]').addEventListener('change', async (event) => {
      const enabled = event.target.checked;
      event.target.disabled = true;
      try {
        await window.orchestrator.updateTool({ id: tool.id, patch: { enabled } });
        await refreshSnapshot();
        showToast(TEXT.toastSuccess, `${tool.name} ${enabled ? TEXT.open : TEXT.closed}`, 'success');
      } catch (error) {
        event.target.checked = !enabled;
        showToast(TEXT.toastError, error.message || String(error), 'error');
      } finally {
        event.target.disabled = false;
      }
    });
    toolList.appendChild(row);
  }
}

function renderRuns(runs) {
  runList.innerHTML = '';
  if (!runs.length) return runList.appendChild(emptyRow(TEXT.noRuns, TEXT.noRunsHint));
  for (const run of runs.slice(0, 200)) {
    const queueSummary = run.status === 'queued'
      ? `\u6392\u961f ${run.queuePosition || '-'} / ${run.queueLength || '-'} \u00b7 ${humanizeQueueReason(run.queueReason)}`
      : `${run.resourcePool || '-'} / ${run.resourceLane || '-'}`;
    const progressSummary = run.asrProgress
      ? `ASR ${Math.round(Number(run.asrProgress.progress || 0) * 100)}% \u00b7 ${run.asrProgress.phase || '-'} \u00b7 ${Number(run.asrProgress.audioSeconds || 0).toFixed(1)}s / ${Number(run.asrProgress.totalSeconds || 0).toFixed(1)}s`
      : queueSummary;
    runList.appendChild(settingRow({
      icon: iconRun(),
      title: `${run.toolName || run.toolId}  /  ${run.workerId || run.agentName || '-'}`,
      subtitle: `${run.taskId}  /  ${run.stage || '-'}  /  ${progressSummary}`,
      right: `<span class="state-tag ${statusClass(run.status)}">${escapeHtml(run.status)}</span>`,
      detail: `<div class="tool-detail"><div class="run-resource-grid"><div><span>\u9636\u6bb5</span><strong>${escapeHtml(run.stage || '-')}</strong></div><div><span>\u8d44\u6e90\u6c60 / \u901a\u9053</span><strong>${escapeHtml(`${run.resourcePool || '-'} / ${run.resourceLane || '-'}`)}</strong></div><div><span>\u961f\u5217\u4f4d\u7f6e</span><strong>${escapeHtml(run.queuePosition ? `${run.queuePosition} / ${run.queueLength || run.queuePosition}` : '-')}</strong></div><div><span>\u7b49\u5f85\u539f\u56e0</span><strong>${escapeHtml(run.status === 'queued' ? humanizeQueueReason(run.queueReason) : '-')}</strong></div><div><span>\u9884\u4f30\u7b49\u5f85</span><strong>${escapeHtml(run.estimatedWaitMs ? formatMilliseconds(run.estimatedWaitMs) : '-')}</strong></div><div><span>${TEXT.exitCode}</span><strong>${escapeHtml(run.exitCode ?? '-')}</strong></div></div><div><h4>${TEXT.command}</h4><pre>${escapeHtml(run.actualCommand || run.command || '')}</pre></div><div><h4>${TEXT.logFile}</h4><pre>${escapeHtml(run.logFile || '')}</pre></div><div class="detail-grid"><div><span>\u521b\u5efa</span><strong>${escapeHtml(run.createdAt || '-')}</strong></div><div><span>${TEXT.started}</span><strong>${escapeHtml(run.startedAt || '-')}</strong></div><div><span>${TEXT.finished}</span><strong>${escapeHtml(run.finishedAt || '-')}</strong></div></div>${run.error ? `<div class="run-error">${escapeHtml(run.error)}</div>` : ''}</div>`
    }));
  }
}

function renderWorkers(workers) {
  if (!workerList) return;
  const active = workers.filter((worker) => worker.status === 'active').length;
  const paused = workers.filter((worker) => worker.status === 'paused').length;
  const working = workers.filter((worker) => Number(worker.activeTasks || 0) > 0).length;
  document.querySelector('#workerMetricTotal').textContent = String(workers.length);
  document.querySelector('#workerMetricActive').textContent = String(active);
  document.querySelector('#workerMetricPaused').textContent = String(paused);
  document.querySelector('#workerMetricWorking').textContent = String(working);
  workerList.innerHTML = '';
  if (!workers.length) return workerList.appendChild(emptyRow('\u6682\u65e0 Worker \u4f1a\u8bdd', '\u65b0 Agent \u9996\u6b21\u8c03\u7528 /api/workers/register \u540e\u4f1a\u51fa\u73b0\u5728\u8fd9\u91cc\u3002'));

  const maxCompleted = Math.max(1, ...workers.map((worker) => Number(worker.completed || 0)));
  for (const worker of workers) {
    const pausedWorker = worker.status === 'paused';
    const success = worker.successRate === null || worker.successRate === undefined ? '-' : `${Math.round(worker.successRate * 100)}%`;
    const ratio = worker.weightedTimeRatio === null || worker.weightedTimeRatio === undefined ? '-' : `${Number(worker.weightedTimeRatio).toFixed(2)}x`;
    const completedWidth = Math.max(worker.completed ? 4 : 0, Math.round(Number(worker.completed || 0) / maxCompleted * 100));
    const currentTasks = (worker.currentTasks || []).length
      ? worker.currentTasks.map((task) => `<li><strong>${escapeHtml(task.title || task.bvid)}</strong><span>${escapeHtml(task.bvid)} / \u79df\u7ea6 ${escapeHtml(formatDateTime(task.leaseExpiresAt))}</span></li>`).join('')
      : '<li class="empty-inline">\u5f53\u524d\u6ca1\u6709\u5904\u7406\u4e2d\u7684\u4efb\u52a1</li>';
    const detail = `<div class="worker-detail"><div class="worker-chart-grid"><div><span>\u9886\u53d6</span><strong>${worker.claimed}</strong></div><div><span>\u5b8c\u6210</span><strong>${worker.completed}</strong></div><div><span>\u5931\u8d25/\u6253\u56de</span><strong>${worker.failures}</strong></div><div><span>\u6210\u529f\u7387</span><strong>${success}</strong></div><div><span>\u8017\u65f6/\u89c6\u9891\u65f6\u957f</span><strong>${ratio}</strong></div><div><span>\u5de5\u5177\u8c03\u7528</span><strong>${worker.toolCalls}</strong></div></div><div class="worker-completion-chart"><div><span>${escapeHtml(worker.workerId)}</span><b>${worker.completed} \u5b8c\u6210</b></div><div><span style="width:${completedWidth}%"></span></div></div><div class="detail-grid"><div><span>\u8c03\u7528\u5de5\u5177 / \u6a21\u578b</span><strong>${escapeHtml(worker.tool)} / ${escapeHtml(worker.model)}</strong></div><div><span>\u9996\u6b21\u6ce8\u518c</span><strong>${escapeHtml(formatDateTime(worker.createdAt, true))}</strong></div><div><span>\u6700\u540e\u8c03\u7528</span><strong>${escapeHtml(formatDateTime(worker.lastSeenAt, true))}</strong></div></div><div><h4>\u5f53\u524d\u4efb\u52a1</h4><ul class="worker-current-tasks">${currentTasks}</ul></div>${pausedWorker ? `<div class="worker-pause-note">${escapeHtml(worker.pauseReason || 'Paused by user.')}</div>` : ''}</div>`;
    const row = settingRow({
      icon: iconWorker(),
      title: worker.sessionLabel ? `${worker.workerId} / ${worker.sessionLabel}` : worker.workerId,
      subtitle: `${worker.tool} / ${worker.model} / \u9886 ${worker.claimed} / \u6210 ${worker.completed} / \u5de5\u5177 ${worker.toolCalls}`,
      right: `<span class="state-tag ${pausedWorker ? 'bad' : worker.activeTasks ? 'run' : 'ok'}">${pausedWorker ? '\u5df2\u6682\u505c' : worker.activeTasks ? '\u5de5\u4f5c\u4e2d' : '\u53ef\u63a5\u5355'}</span><button class="secondary-button compact-button worker-state-button ${pausedWorker ? '' : 'danger-button'}">${pausedWorker ? TEXT.activateWorker : TEXT.pauseWorker}</button>`,
      detail
    });
    row.classList.add('worker-row');
    row.querySelector('.worker-state-button')?.addEventListener('click', async (event) => {
      event.stopPropagation();
      event.currentTarget.disabled = true;
      try {
        await window.orchestrator.updateWorker({ workerId: worker.workerId, patch: { status: pausedWorker ? 'active' : 'paused', pauseReason: pausedWorker ? '' : '\u6765\u81ea\u7528\u6237\u7684\u4fe1\u606f\uff0c\u4f60\u9700\u8981\u6682\u505c\u5de5\u4f5c' } });
        await refreshSnapshot();
        showToast(TEXT.toastSuccess, pausedWorker ? '\u5df2\u6062\u590d Agent \u4efb\u52a1\u5206\u914d' : '\u5df2\u6682\u505c Agent \u7684\u4e0b\u6b21\u4efb\u52a1\u5206\u914d', 'success');
      } catch (error) {
        showToast(TEXT.toastError, error.message || String(error), 'error');
      } finally {
        event.currentTarget.disabled = false;
      }
    });
    workerList.appendChild(row);
  }
}

function renderFilenameMetadataSettings() {
  const choices = document.querySelector('#filenameMetadataChoices');
  if (!choices) return;
  const defaults = { bvid: true, title: true, owner: true, publishedAt: true, favoriteAddedAt: true, collection: true, tags: true };
  const settings = { ...defaults, ...(runtime.filenameMetadata || lastSnapshot.settings?.filenameMetadata || {}) };
  for (const input of choices.querySelectorAll('[data-filename-meta]')) input.checked = settings[input.dataset.filenameMeta] !== false;
  const sample = [];
  if (settings.bvid) sample.push('[BV-BV1xx411c7mD]');
  if (settings.title) sample.push('[\u6807\u9898-AI \u89c6\u9891\u603b\u7ed3\u793a\u4f8b]');
  if (settings.owner) sample.push('[UP-ExampleUP]');
  if (settings.publishedAt) sample.push('[\u53d1\u5e03\u65e5-20260710]');
  if (settings.favoriteAddedAt) sample.push('[\u6536\u85cf\u65e5-20260711]');
  if (settings.collection) sample.push('[\u6765\u81ea\u6536\u85cf\u5939-AIcode]');
  if (settings.tags) sample.push('[\u6807\u7b7e-AI+\u5de5\u7a0b]');
  const preview = `${sample.join('') || 'video-summary'}.md`;
  document.querySelector('#filenamePreview').textContent = preview;
  document.querySelector('#filenamePreview').title = preview;
}

function collectFilenameMetadataSettings() {
  return Object.fromEntries([...document.querySelectorAll('[data-filename-meta]')].map((input) => [input.dataset.filenameMeta, input.checked]));
}

function renderDocumentLibrary() {
  if (!documentList || !documentPreview) return;
  syncDocumentSelectors();
  const userId = documentUserSelect?.value || '';
  const collectionId = documentCollectionSelect?.value || '';
  const source = completedDocuments().filter(({ task, collection }) => {
    if (String(collection.userId || collection.userName) !== userId) return false;
    return !collectionId || task.collectionId === collectionId;
  }).map((item) => item.task);
  const context = `${userId}:${collectionId}`;
  if (context !== lastDocumentContext) {
    lastDocumentContext = context;
    resetDocumentDurationRange(source);
  }
  visibleDocuments = filterDocuments(source);
  document.querySelector('#documentResultSummary').textContent = `${visibleDocuments.length} \u7bc7`;
  document.querySelector('#documentListCount').textContent = `${visibleDocuments.length} / ${source.length}`;
  renderDocumentList();
  if (!visibleDocuments.some((task) => task.id === selectedDocumentId)) {
    selectedDocumentId = '';
    clearDocumentPreview();
    if (visibleDocuments[0] && document.querySelector('#page-documents')?.classList.contains('active')) selectDocument(visibleDocuments[0].id);
  }
}

function completedDocuments() {
  const collections = new Map((lastSnapshot.collections || []).map((collection) => [collection.id, collection]));
  return (lastSnapshot.tasks || [])
    .filter((task) => task.status === 'done' && task.outputMarkdown)
    .map((task) => ({ task, collection: collections.get(task.collectionId) }))
    .filter((item) => item.collection);
}

function syncDocumentSelectors() {
  if (!documentUserSelect || !documentCollectionSelect) return;
  const documents = completedDocuments();
  const users = new Map(documents.map(({ collection }) => [String(collection.userId || collection.userName), collection.userName || collection.userId || '-']));
  const previousUser = documentUserSelect.value;
  documentUserSelect.innerHTML = [...users.entries()].map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join('');
  if (users.has(previousUser)) documentUserSelect.value = previousUser;
  else {
    const currentUserId = String(currentUser?.mid || currentUser?.id || '');
    if (users.has(currentUserId)) documentUserSelect.value = currentUserId;
  }
  const userId = documentUserSelect.value;
  const available = [...new Map(documents
    .filter(({ collection }) => String(collection.userId || collection.userName) === userId)
    .map(({ collection }) => [collection.id, collection])).values()];
  const previousCollection = documentCollectionSelect.value;
  documentCollectionSelect.innerHTML = `<option value="">${TEXT.allCollections}</option>${available.map((collection) => `<option value="${escapeHtml(collection.id)}">${escapeHtml(collection.name)}</option>`).join('')}`;
  if (available.some((collection) => collection.id === previousCollection)) documentCollectionSelect.value = previousCollection;
}

function resetDocumentDurationRange(tasks) {
  if (!documentDurationMin || !documentDurationMax) return;
  const maximum = Math.max(60, ...tasks.map((task) => Number(task.duration || 0)));
  documentDurationMin.max = String(maximum);
  documentDurationMax.max = String(maximum);
  documentDurationMin.value = '0';
  documentDurationMax.value = String(maximum);
  updateDocumentDurationLabel();
}

function updateDocumentDurationLabel() {
  if (!documentDurationMin || !documentDurationMax) return;
  let minimum = Number(documentDurationMin.value || 0);
  let maximum = Number(documentDurationMax.value || 0);
  if (minimum > maximum) [minimum, maximum] = [maximum, minimum];
  documentDurationMin.value = String(minimum);
  documentDurationMax.value = String(maximum);
  document.querySelector('#documentDurationLabel').textContent = `${formatDurationBound(minimum)} - ${formatDurationBound(maximum)}`;
}

function filterDocuments(tasks) {
  const query = String(documentSearch?.value || '').trim().toLocaleLowerCase();
  const favoriteFrom = dateBoundary(documentFavoriteFrom?.value, false);
  const favoriteTo = dateBoundary(documentFavoriteTo?.value, true);
  const publishedFrom = dateBoundary(documentPublishedFrom?.value, false);
  const publishedTo = dateBoundary(documentPublishedTo?.value, true);
  const minimum = Number(documentDurationMin?.value || 0);
  const maximum = Number(documentDurationMax?.value || Number.MAX_SAFE_INTEGER);
  const [field, directionName] = String(documentSort?.value || 'favorite-desc').split('-');
  const direction = directionName === 'asc' ? 1 : -1;
  return tasks.filter((task) => {
    const haystack = `${task.bvid || ''} ${task.owner || ''} ${task.title || ''}`.toLocaleLowerCase();
    const favoriteTime = Date.parse(task.favoriteAddedAt || task.createdAt || '') || 0;
    const publishedTime = Date.parse(task.publishedAt || '') || 0;
    const duration = Number(task.duration || 0);
    return (!query || haystack.includes(query))
      && favoriteTime >= favoriteFrom && favoriteTime <= favoriteTo
      && publishedTime >= publishedFrom && publishedTime <= publishedTo
      && duration >= minimum && duration <= maximum;
  }).sort((left, right) => {
    const leftTime = Date.parse(field === 'published' ? left.publishedAt : (left.favoriteAddedAt || left.createdAt || '')) || 0;
    const rightTime = Date.parse(field === 'published' ? right.publishedAt : (right.favoriteAddedAt || right.createdAt || '')) || 0;
    return direction * (leftTime - rightTime) || String(left.title || left.bvid).localeCompare(String(right.title || right.bvid), 'zh-Hans-CN');
  });
}

function dateBoundary(value, endOfDay) {
  if (!value) return endOfDay ? Number.POSITIVE_INFINITY : 0;
  return new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00'}`).getTime();
}

function renderDocumentList() {
  documentList.innerHTML = '';
  if (!visibleDocuments.length) {
    documentList.innerHTML = '<div class="export-empty">\u5f53\u524d\u7b5b\u9009\u8303\u56f4\u5185\u6ca1\u6709\u5df2\u5b8c\u6210\u7684 Markdown\u3002</div>';
    return;
  }
  for (const task of visibleDocuments) {
    const row = document.createElement('button');
    row.className = `document-row${task.id === selectedDocumentId ? ' active' : ''}`;
    row.type = 'button';
    row.dataset.documentId = task.id;
    row.innerHTML = `${task.cover ? `<img src="${escapeHtml(task.cover)}" alt="" loading="lazy" />` : '<span class="document-cover-placeholder"></span>'}<span class="document-row-copy"><strong>${escapeHtml(task.title || task.bvid)}</strong><small>${escapeHtml(task.bvid)} / ${escapeHtml(task.owner || TEXT.unknownUp)} / ${escapeHtml(formatSeconds(task.duration))}</small><em>\u6536\u85cf ${escapeHtml(formatDateTime(task.favoriteAddedAt))} / \u53d1\u5e03 ${escapeHtml(formatDateTime(task.publishedAt))}</em></span>`;
    row.addEventListener('click', () => selectDocument(task.id));
    documentList.appendChild(row);
  }
}

async function selectDocument(taskId) {
  selectedDocumentId = taskId;
  renderDocumentList();
  const task = (lastSnapshot.tasks || []).find((item) => item.id === taskId);
  const request = ++documentPreviewRequest;
  document.querySelector('#documentPreviewTitle').textContent = task?.title || task?.bvid || TEXT.selectDocument;
  document.querySelector('#documentPreviewMeta').textContent = '\u6b63\u5728\u8bfb\u53d6 Markdown...';
  document.querySelector('#documentPreviewPath').textContent = task?.outputMarkdown || '';
  document.querySelector('#openDocumentFile').disabled = true;
  documentPreview.innerHTML = '<div class="document-preview-loading"><span></span><strong>\u6b63\u5728\u6e32\u67d3\u6587\u6863</strong></div>';
  try {
    const result = await window.orchestrator.readDocument(taskId);
    if (request !== documentPreviewRequest || selectedDocumentId !== taskId) return;
    documentPreview.innerHTML = result.html || '<p>Markdown \u5185\u5bb9\u4e3a\u7a7a\u3002</p>';
    await renderDocumentMermaid(documentPreview);
    if (request !== documentPreviewRequest || selectedDocumentId !== taskId) return;
    documentPreview.scrollTop = 0;
    document.querySelector('#documentPreviewTitle').textContent = result.task?.title || result.task?.bvid || TEXT.selectDocument;
    document.querySelector('#documentPreviewMeta').textContent = `${result.task?.bvid || '-'} / ${result.task?.owner || TEXT.unknownUp} / ${formatSeconds(result.task?.duration)}`;
    document.querySelector('#documentPreviewPath').textContent = result.path || '';
    document.querySelector('#openDocumentFile').disabled = false;
  } catch (error) {
    if (request !== documentPreviewRequest) return;
    documentPreview.innerHTML = `<div class="document-preview-empty"><strong>\u6587\u6863\u8bfb\u53d6\u5931\u8d25</strong><span>${escapeHtml(error.message || String(error))}</span></div>`;
    showToast(TEXT.toastError, error.message || String(error), 'error');
  }
}

function clearDocumentPreview() {
  documentPreviewRequest += 1;
  document.querySelector('#documentPreviewTitle').textContent = TEXT.selectDocument;
  document.querySelector('#documentPreviewMeta').textContent = '';
  document.querySelector('#documentPreviewPath').textContent = '';
  document.querySelector('#openDocumentFile').disabled = true;
  documentPreview.innerHTML = `<div class="document-preview-empty"><strong>${TEXT.selectDocument}</strong><span>${TEXT.selectDocumentHint}</span></div>`;
}

async function renderDocumentMermaid(root) {
  const blocks = [...root.querySelectorAll('pre > code.language-mermaid')];
  if (!blocks.length) return;
  if (!window.mermaid) {
    for (const block of blocks) block.parentElement.classList.add('mermaid-unavailable');
    return;
  }
  const lightTheme = document.body.classList.contains('theme-day') || document.body.classList.contains('theme-bili') || document.body.classList.contains('theme-mint');
  window.mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: lightTheme ? 'default' : 'dark',
    fontFamily: getComputedStyle(document.body).getPropertyValue('--font-ui').trim() || 'sans-serif'
  });
  for (const [index, block] of blocks.entries()) {
    const source = block.textContent || '';
    const container = document.createElement('div');
    container.className = 'mermaid-diagram';
    let renderedDiagram = false;
    try {
      const rendered = await window.mermaid.render(`star-note-mermaid-${Date.now()}-${index}`, source);
      container.innerHTML = rendered.svg;
      rendered.bindFunctions?.(container);
      renderedDiagram = true;
    } catch (error) {
      container.classList.add('mermaid-error');
      container.innerHTML = `<strong>Mermaid \u6e32\u67d3\u5931\u8d25</strong><span>${escapeHtml(error.message || String(error))}</span><pre><code>${escapeHtml(source)}</code></pre>`;
    }
    block.parentElement.replaceWith(container);
    if (renderedDiagram) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      fitMermaidSvg(container);
    }
  }
}

function fitMermaidSvg(container) {
  const svg = container.querySelector('svg');
  const content = svg?.querySelector('g');
  if (!svg || !content) return;
  try {
    const box = content.getBBox();
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) return;
    const padding = 28;
    svg.setAttribute('viewBox', `${box.x - padding} ${box.y - padding} ${box.width + padding * 2} ${box.height + padding * 2}`);
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.style.maxWidth = 'none';
    svg.style.width = '100%';
    const availableWidth = Math.max(320, container.clientWidth - 28);
    const fittedHeight = Math.max(240, Math.min(620, availableWidth * (box.height + padding * 2) / (box.width + padding * 2)));
    svg.style.height = `${Math.round(fittedHeight)}px`;
  } catch {
    // Keep Mermaid's own dimensions when this diagram type does not expose a measurable SVG group.
  }
}

function renderExportPage() {
  if (!exportSourceList || !exportQueueList) return;
  syncExportSelectors();
  const userId = document.querySelector('#exportUserSelect')?.value || '';
  const collectionId = document.querySelector('#exportCollectionSelect')?.value || '';
  const query = String(document.querySelector('#exportSearch')?.value || '').trim().toLocaleLowerCase();
  visibleExportTasks = (lastSnapshot.tasks || []).filter((task) => {
    if (task.status !== 'done' || !task.outputMarkdown) return false;
    const collection = (lastSnapshot.collections || []).find((item) => item.id === task.collectionId);
    if (!collection || String(collection.userId || collection.userName) !== userId) return false;
    if (collectionId && task.collectionId !== collectionId) return false;
    const haystack = `${task.bvid || ''} ${task.owner || ''} ${task.title || ''}`.toLocaleLowerCase();
    return !query || haystack.includes(query);
  });
  renderExportSource();
  renderExportQueue();
}

function syncExportSelectors() {
  const userSelect = document.querySelector('#exportUserSelect');
  const collectionSelect = document.querySelector('#exportCollectionSelect');
  if (!userSelect || !collectionSelect) return;
  const completedCollectionIds = new Set((lastSnapshot.tasks || []).filter((task) => task.status === 'done' && task.outputMarkdown).map((task) => task.collectionId));
  const collections = (lastSnapshot.collections || []).filter((collection) => completedCollectionIds.has(collection.id));
  const users = new Map(collections.map((collection) => [String(collection.userId || collection.userName), collection.userName || collection.userId || '-']));
  const previousUser = userSelect.value;
  userSelect.innerHTML = [...users.entries()].map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join('');
  if (users.has(previousUser)) userSelect.value = previousUser;
  const userId = userSelect.value;
  const previousCollection = collectionSelect.value;
  const available = collections.filter((collection) => String(collection.userId || collection.userName) === userId);
  collectionSelect.innerHTML = `<option value="">\u5168\u90e8\u6536\u85cf\u5939</option>${available.map((collection) => `<option value="${escapeHtml(collection.id)}">${escapeHtml(collection.name)}</option>`).join('')}`;
  if (available.some((collection) => collection.id === previousCollection)) collectionSelect.value = previousCollection;
}

function renderExportSource() {
  exportSourceList.innerHTML = '';
  document.querySelector('#exportSourceSummary').textContent = `\u663e\u793a ${visibleExportTasks.length} / \u5df2\u9009 ${exportSourceSelection.size}`;
  if (!visibleExportTasks.length) {
    exportSourceList.innerHTML = '<div class="export-empty">\u5f53\u524d\u8303\u56f4\u6ca1\u6709\u5df2\u5b8c\u6210\u7684 Markdown\u3002</div>';
    return;
  }
  for (const task of visibleExportTasks) {
    const row = document.createElement('label');
    row.className = 'export-task-row';
    row.innerHTML = `<input class="app-checkbox" type="checkbox" ${exportSourceSelection.has(task.id) ? 'checked' : ''} /><span><strong>${escapeHtml(task.title || task.bvid)}</strong><small>${escapeHtml(task.bvid)} / ${escapeHtml(task.owner || TEXT.unknownUp)} / ${escapeHtml(formatDateTime(task.completedAt || task.updatedAt))}</small></span>`;
    row.querySelector('input').addEventListener('change', (event) => {
      if (event.target.checked) exportSourceSelection.add(task.id);
      else exportSourceSelection.delete(task.id);
      document.querySelector('#exportSourceSummary').textContent = `\u663e\u793a ${visibleExportTasks.length} / \u5df2\u9009 ${exportSourceSelection.size}`;
    });
    exportSourceList.appendChild(row);
  }
}

function renderExportQueue() {
  exportQueueList.innerHTML = '';
  document.querySelector('#exportQueueSummary').textContent = `${exportQueue.size} \u4e2a Markdown`;
  document.querySelector('#runMarkdownExport').disabled = exportQueue.size === 0;
  if (!exportQueue.size) {
    exportQueueList.innerHTML = '<div class="export-empty">\u4ece\u5de6\u4fa7\u5c06\u5df2\u5b8c\u6210\u6587\u6863\u52a0\u5165\u5bfc\u51fa\u5217\u8868\u3002</div>';
    return;
  }
  for (const taskId of exportQueue) {
    const task = (lastSnapshot.tasks || []).find((item) => item.id === taskId);
    if (!task) continue;
    const row = document.createElement('div');
    row.className = 'export-queue-row';
    row.innerHTML = `<div><strong>${escapeHtml(task.title || task.bvid)}</strong><span>${escapeHtml(task.bvid)} / ${escapeHtml(task.owner || TEXT.unknownUp)}</span></div><button class="icon-action danger" title="\u4ece\u5217\u8868\u79fb\u9664" aria-label="\u4ece\u5217\u8868\u79fb\u9664"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
    row.querySelector('button').addEventListener('click', () => { exportQueue.delete(taskId); renderExportQueue(); });
    exportQueueList.appendChild(row);
  }
}

function renderApiToolAnalytics(stats) {
  if (!apiToolAnalytics) return;
  apiToolAnalytics.innerHTML = '';
  if (!stats.length) return apiToolAnalytics.appendChild(emptyRow(TEXT.noRuns, TEXT.noRunsHint));
  const maxCalls = Math.max(1, ...stats.map((item) => Number(item.calls || 0)));
  for (const item of stats) {
    const width = Math.max(item.calls ? 5 : 0, Math.round(Number(item.calls || 0) / maxCalls * 100));
    const success = item.successRate === null || item.successRate === undefined ? '-' : `${Math.round(Number(item.successRate) * 100)}%`;
    const agentRows = (item.byAgent || []).length
      ? item.byAgent.map((agent) => `<div class="agent-call-row"><span>${escapeHtml(agent.workerId || agent.agentName)}</span><b>${agent.calls}</b></div>`).join('')
      : '<span class="empty-inline">\u6682\u65e0\u8c03\u7528\u8005</span>';
    const row = settingRow({
      icon: iconTool(),
      title: item.toolName || item.toolId,
      subtitle: `${item.calls} \u6b21\u8c03\u7528 / ${item.callers} \u4e2a\u8c03\u7528\u8005 / \u5e73\u5747 ${formatMilliseconds(item.averageDurationMs)}`,
      right: `<div class="usage-preview"><span style="width:${width}%"></span></div><strong class="usage-count">${item.calls}</strong>`,
      detail: `<div class="tool-analytics-detail"><div class="analytics-kpis"><div><span>\u6210\u529f</span><strong>${item.succeeded}</strong></div><div><span>\u5931\u8d25</span><strong>${item.failed}</strong></div><div><span>\u6392\u961f\u4e2d</span><strong>${item.queued || 0}</strong></div><div><span>\u8fd0\u884c\u4e2d</span><strong>${item.running}</strong></div><div><span>\u6210\u529f\u7387</span><strong>${success}</strong></div><div><span>\u5e73\u5747\u8017\u65f6</span><strong>${formatMilliseconds(item.averageDurationMs)}</strong></div></div><div class="agent-call-list"><h4>\u6bcf\u4e2a\u8c03\u7528\u8005\u7684\u8c03\u7528\u6b21\u6570</h4>${agentRows}</div></div>`
    });
    row.classList.add('analytics-row');
    apiToolAnalytics.appendChild(row);
  }
}

function renderWorkspaces(workspaces) {
  if (!workspaceList) return;
  workspaceList.innerHTML = '';
  for (const workspace of workspaces) {
    const row = document.createElement('div');
    row.className = `workspace-row${workspace.isDefault ? ' active' : ''}`;
    row.innerHTML = `<div class="workspace-main"><strong>${escapeHtml(workspace.name)}</strong><span title="${escapeHtml(workspace.root)}">${escapeHtml(workspace.root)}</span></div><div class="workspace-actions">${workspace.isDefault ? `<span class="state-tag ok">${TEXT.defaultWorkspace}</span>` : `<button class="secondary-button compact-button" data-default-workspace="${escapeHtml(workspace.id)}">${TEXT.setDefault}</button><button class="icon-action danger" data-remove-workspace="${escapeHtml(workspace.id)}" title="${TEXT.remove}" aria-label="${TEXT.remove}"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M8 7l1 13h6l1-13M10 11v5M14 11v5"/></svg></button>`}</div>`;
    row.querySelector('[data-default-workspace]')?.addEventListener('click', async () => {
      try {
        const selected = await window.orchestrator.setDefaultWorkspace(workspace.id);
        runtime.defaultWorkspace = selected;
        runtime.workspaceRoot = selected.root;
        await refreshSnapshot();
        showToast(TEXT.toastSuccess, `\u9ed8\u8ba4 Workspace \u5df2\u5207\u6362\u4e3a ${selected.name}`, 'success');
      } catch (error) {
        showToast(TEXT.toastError, error.message || String(error), 'error');
      }
    });
    row.querySelector('[data-remove-workspace]')?.addEventListener('click', async () => {
      try {
        await window.orchestrator.removeWorkspace(workspace.id);
        await refreshSnapshot();
        showToast(TEXT.toastSuccess, '\u5de5\u4f5c\u5e93\u5df2\u4ece\u5217\u8868\u79fb\u9664\uff0c\u78c1\u76d8\u6587\u4ef6\u672a\u5220\u9664', 'success');
      } catch (error) {
        showToast(TEXT.toastError, error.message || String(error), 'error');
      }
    });
    workspaceList.appendChild(row);
  }
}

function formatMilliseconds(value) {
  const ms = Number(value || 0);
  if (!ms) return '0s';
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}min`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function settingRow({ icon, title, subtitle, right, detail }) {
  const row = document.createElement('div');
  row.className = `setting-row${detail ? ' has-detail' : ''}`;
  const expand = detail
    ? `<button type="button" class="row-expand" title="\u5c55\u5f00\u8be6\u60c5" aria-label="\u5c55\u5f00\u8be6\u60c5" aria-expanded="false"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>`
    : '';
  row.innerHTML = `<div class="row-icon">${icon}</div><div class="row-main"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(subtitle || '')}</p>${detail ? `<div class="row-detail">${detail}</div>` : ''}</div><div class="row-right">${right || ''}${expand}</div>`;
  const expandButton = row.querySelector('.row-expand');
  const setExpanded = (expanded) => {
    row.classList.toggle('expanded', expanded);
    expandButton.setAttribute('aria-expanded', String(expanded));
    expandButton.title = expanded ? '\u6536\u8d77\u8be6\u60c5' : '\u5c55\u5f00\u8be6\u60c5';
    expandButton.setAttribute('aria-label', expandButton.title);
  };
  const toggleExpanded = () => setExpanded(!row.classList.contains('expanded'));
  expandButton?.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleExpanded();
  });
  if (detail) {
    for (const target of row.querySelectorAll('.row-main > h3, .row-main > p')) target.addEventListener('click', toggleExpanded);
  }
  return row;
}

function emptyRow(title, subtitle) {
  return settingRow({ icon: iconList(), title, subtitle, right: `<span class="state-text">${TEXT.empty}</span>` });
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function statusClass(status) {
  if (['done', 'succeeded'].includes(status)) return 'ok';
  if (['running', 'claimed'].includes(status)) return 'run';
  if (status === 'queued') return 'queue';
  if (['failed', 'rejected', 'timeout'].includes(status)) return 'bad';
  return 'idle';
}

function formatSeconds(value) {
  const seconds = Number(value || 0);
  if (!seconds) return TEXT.unknownDuration;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDateTime(value, withSeconds = false) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: withSeconds ? '2-digit' : undefined,
    hour12: false
  }).format(date).replaceAll('/', '-');
}

function iconList() { return '<svg viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>'; }
function iconTool() { return '<svg viewBox="0 0 24 24"><path d="M14.7 6.3a4 4 0 0 0-5 5L4 17v3h3l5.7-5.7a4 4 0 0 0 5-5l-2.4 2.4-3-3z"/></svg>'; }
function iconRun() { return '<svg viewBox="0 0 24 24"><path d="M5 4l14 8-14 8z"/></svg>'; }
function iconWorker() { return '<svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M18 8h4M20 6v4"/></svg>'; }

navItems.forEach((item) => item.addEventListener('click', () => setPage(item.dataset.page)));
document.querySelector('#userProfile')?.addEventListener('click', () => {
  if (!currentUser?.isLogin) setPage('login');
});
document.querySelector('#userProfile')?.addEventListener('mouseenter', (event) => {
  if (profileCloseTimer) clearTimeout(profileCloseTimer);
  if (!currentUser?.isLogin) return;
  event.currentTarget.classList.remove('profile-suppressed');
  event.currentTarget.classList.add('profile-open');
  refreshProfileFolders();
});
document.querySelector('#userProfile')?.addEventListener('mouseleave', (event) => {
  const profile = event.currentTarget;
  profileCloseTimer = setTimeout(() => profile.classList.remove('profile-open', 'profile-suppressed'), 320);
});
document.querySelector('#sidebarToggle')?.addEventListener('click', toggleSidebar);
document.querySelector('#sidebarToggleInSettings')?.addEventListener('click', toggleSidebar);

cpuAsrToggle?.addEventListener('change', async (event) => {
  const enabled = event.target.checked;
  schedulerUpdateInFlight = true;
  renderScheduler(runtime.scheduler);
  try {
    const state = await window.orchestrator.updateScheduler({ cpuAsrEnabled: enabled });
    runtime.scheduler = state;
    renderScheduler(state);
    renderSettingsSummary();
    showToast(TEXT.toastSuccess, enabled ? 'CPU ASR \u670d\u52a1\u5df2\u5f00\u542f' : 'CPU ASR \u670d\u52a1\u5df2\u5173\u95ed', 'success');
  } catch (error) {
    event.target.checked = !enabled;
    showToast(TEXT.toastError, error.message || String(error), 'error');
  } finally {
    schedulerUpdateInFlight = false;
    renderScheduler(runtime.scheduler);
  }
});
document.querySelector('#winMin')?.addEventListener('click', () => window.orchestrator.minimizeWindow());
document.querySelector('#winMax')?.addEventListener('click', () => window.orchestrator.toggleMaximizeWindow());
document.querySelector('#winClose')?.addEventListener('click', () => window.orchestrator.closeWindow());
taskUserSelect?.addEventListener('change', () => {
  lastTaskCollectionId = '';
  renderTaskInventory();
  updatePromptTemplate();
});
taskCollectionSelect?.addEventListener('change', () => {
  lastTaskCollectionId = '';
  renderTaskInventory();
  updatePromptTemplate();
});
document.querySelector('#activateCollection')?.addEventListener('click', async () => {
  const collectionId = taskCollectionSelect?.value;
  if (!collectionId) return;
  try {
    const collection = await window.orchestrator.setActiveCollection(collectionId);
    lastSnapshot.activeCollection = collection;
    renderTaskInventory();
    updatePromptTemplate();
    showToast(TEXT.toastSuccess, `Agent \u5de5\u4f5c\u76ee\u6807\u5df2\u5207\u6362\uff1a${collection.userName || '-'} / ${collection.name}`, 'success');
  } catch (error) {
    showToast(TEXT.toastError, error.message || String(error), 'error');
  }
});
document.querySelector('#taskFilterToggle')?.addEventListener('click', (event) => {
  const button = event.currentTarget;
  const panel = document.querySelector('#taskAdvancedFilters');
  const open = !panel.classList.contains('open');
  panel.classList.toggle('open', open);
  button.classList.toggle('active', open);
  button.setAttribute('aria-expanded', String(open));
});
for (const control of [taskSearch, taskSort, taskDateFrom, taskDateTo]) {
  control?.addEventListener(control === taskSearch ? 'input' : 'change', renderTaskInventory);
}
for (const control of [durationMin, durationMax]) {
  control?.addEventListener('input', () => {
    updateDurationLabel();
    renderTaskInventory();
  });
}
document.querySelector('#selectVisibleTasks')?.addEventListener('click', () => {
  for (const task of visibleTasks) taskSelection.add(task.id);
  renderTaskRows(visibleTasks);
});
document.querySelector('#invertVisibleTasks')?.addEventListener('click', () => {
  for (const task of visibleTasks) {
    if (taskSelection.has(task.id)) taskSelection.delete(task.id);
    else taskSelection.add(task.id);
  }
  renderTaskRows(visibleTasks);
});
document.querySelector('#enableSelectedTasks')?.addEventListener('click', () => updateTaskEnabled([...taskSelection], true).catch((error) => showToast(TEXT.toastError, error.message || String(error), 'error')));
document.querySelector('#disableSelectedTasks')?.addEventListener('click', () => updateTaskEnabled([...taskSelection], false).catch((error) => showToast(TEXT.toastError, error.message || String(error), 'error')));
const agentPerformanceSummary = document.querySelector('.agent-summary');
const agentPerformancePanel = document.querySelector('#agentPerformanceDetails');
function setAgentPerformanceOpen(open) {
  agentPerformancePanel?.classList.toggle('open', Boolean(open));
  agentPerformanceSummary?.setAttribute('aria-expanded', String(Boolean(open)));
}
agentPerformanceSummary?.addEventListener('click', () => setAgentPerformanceOpen(!agentPerformancePanel?.classList.contains('open')));
agentPerformanceSummary?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  setAgentPerformanceOpen(!agentPerformancePanel?.classList.contains('open'));
});
document.addEventListener('pointerdown', (event) => {
  if (!agentPerformancePanel?.classList.contains('open')) return;
  if (agentPerformancePanel.contains(event.target) || agentPerformanceSummary?.contains(event.target)) return;
  setAgentPerformanceOpen(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setAgentPerformanceOpen(false);
});
document.querySelector('#refreshWorkers')?.addEventListener('click', () => refreshSnapshot().then(() => showToast(TEXT.toastSuccess, 'Worker \u5217\u8868\u5df2\u5237\u65b0', 'success')).catch((error) => showToast(TEXT.toastError, error.message || String(error), 'error')));
document.querySelector('#filenameMetadataChoices')?.addEventListener('change', () => {
  const next = collectFilenameMetadataSettings();
  runtime.filenameMetadata = next;
  renderFilenameMetadataSettings();
  if (filenameSettingsSaveTimer) clearTimeout(filenameSettingsSaveTimer);
  filenameSettingsSaveTimer = setTimeout(async () => {
    try {
      runtime.filenameMetadata = await window.orchestrator.updateFilenameMetadata(next);
      renderFilenameMetadataSettings();
      showToast(TEXT.toastSuccess, '\u4ea7\u7269\u6587\u4ef6\u540d\u89c4\u5219\u5df2\u4fdd\u5b58', 'success');
    } catch (error) {
      showToast(TEXT.toastError, error.message || String(error), 'error');
    }
  }, 260);
});
for (const control of [documentUserSelect, documentCollectionSelect]) {
  control?.addEventListener('change', () => {
    lastDocumentContext = '';
    renderDocumentLibrary();
  });
}
for (const control of [documentSort, documentFavoriteFrom, documentFavoriteTo, documentPublishedFrom, documentPublishedTo]) {
  control?.addEventListener('change', renderDocumentLibrary);
}
documentSearch?.addEventListener('input', renderDocumentLibrary);
for (const control of [documentDurationMin, documentDurationMax]) {
  control?.addEventListener('input', () => {
    updateDocumentDurationLabel();
    renderDocumentLibrary();
  });
}
document.querySelector('#documentFilterToggle')?.addEventListener('click', (event) => {
  const panel = document.querySelector('#documentAdvancedFilters');
  const open = !panel.classList.contains('open');
  panel.classList.toggle('open', open);
  event.currentTarget.classList.toggle('active', open);
  event.currentTarget.setAttribute('aria-expanded', String(open));
});
document.querySelector('#openDocumentFile')?.addEventListener('click', async () => {
  if (!selectedDocumentId) return;
  try {
    await window.orchestrator.openDocument(selectedDocumentId);
  } catch (error) {
    showToast(TEXT.toastError, error.message || String(error), 'error');
  }
});
documentPreview?.addEventListener('click', (event) => {
  const anchor = event.target.closest('a');
  if (!anchor) return;
  const href = anchor.href || '';
  if (!/^https?:/i.test(href)) return;
  event.preventDefault();
  window.orchestrator.openExternal(href).catch((error) => showToast(TEXT.toastError, error.message || String(error), 'error'));
});
for (const control of [document.querySelector('#exportUserSelect'), document.querySelector('#exportCollectionSelect')]) {
  control?.addEventListener('change', () => {
    exportSourceSelection.clear();
    renderExportPage();
  });
}
document.querySelector('#exportSearch')?.addEventListener('input', renderExportPage);
document.querySelector('#selectAllExportSource')?.addEventListener('click', () => {
  for (const task of visibleExportTasks) exportSourceSelection.add(task.id);
  renderExportSource();
});
document.querySelector('#invertExportSource')?.addEventListener('click', () => {
  for (const task of visibleExportTasks) {
    if (exportSourceSelection.has(task.id)) exportSourceSelection.delete(task.id);
    else exportSourceSelection.add(task.id);
  }
  renderExportSource();
});
document.querySelector('#addExportSelection')?.addEventListener('click', () => {
  for (const taskId of exportSourceSelection) exportQueue.add(taskId);
  renderExportQueue();
  showToast(TEXT.toastSuccess, `\u5df2\u52a0\u5165 ${exportSourceSelection.size} \u4e2a Markdown`, 'success');
});
document.querySelector('#clearExportQueue')?.addEventListener('click', () => { exportQueue.clear(); renderExportQueue(); });
document.querySelector('#runMarkdownExport')?.addEventListener('click', async (event) => {
  event.currentTarget.disabled = true;
  try {
    const result = await window.orchestrator.exportMarkdown({
      taskIds: [...exportQueue],
      filenameMetadata: {
        bvid: document.querySelector('#exportMetaBvid').checked,
        title: document.querySelector('#exportMetaTitle').checked,
        owner: document.querySelector('#exportMetaOwner').checked,
        collection: document.querySelector('#exportMetaCollection').checked,
        publishedAt: document.querySelector('#exportMetaPublished').checked,
        favoriteAddedAt: document.querySelector('#exportMetaFavorite').checked,
        tags: document.querySelector('#exportMetaTags').checked
      }
    });
    if (result.canceled) return;
    showToast(TEXT.toastSuccess, `\u5df2\u5bfc\u51fa ${result.exported.length} \u4e2a Markdown\uff0cmanifest \u5df2\u751f\u6210`, 'success');
  } catch (error) {
    showToast(TEXT.toastError, error.message || String(error), 'error');
  } finally {
    event.currentTarget.disabled = exportQueue.size === 0;
  }
});
document.querySelector('#copyAgentPrompt')?.addEventListener('click', async () => {
  await window.orchestrator.copyText(agentPromptTemplate?.textContent || '');
  showToast(TEXT.toastSuccess, '\u5df2\u590d\u5236 agent \u5de5\u4f5c\u63d0\u793a\u8bcd', 'success');
});
document.querySelector('#copyApiDocs')?.addEventListener('click', async () => {
  await window.orchestrator.copyText(apiDocs?.textContent || '');
  showToast(TEXT.toastSuccess, 'API \u53c2\u8003\u5df2\u590d\u5236', 'success');
});
document.querySelector('#copyReadme')?.addEventListener('click', async () => {
  await loadReadme();
  await window.orchestrator.copyText(readmeMarkdown);
  showToast(TEXT.toastSuccess, 'README Markdown \u5df2\u590d\u5236', 'success');
});
document.querySelector('#openReadme')?.addEventListener('click', async () => {
  try {
    await window.orchestrator.openReadme();
    showToast(TEXT.toastSuccess, 'README.md \u5df2\u6253\u5f00', 'success');
  } catch (error) {
    showToast(TEXT.toastError, error.message || String(error), 'error');
  }
});
readmeContent?.addEventListener('click', (event) => {
  const link = event.target.closest('a');
  if (!link) return;
  const href = link.getAttribute('href') || '';
  if (!href || href.startsWith('#')) return;
  event.preventDefault();
  const action = /^https?:\/\//i.test(href)
    ? window.orchestrator.openExternal(href)
    : window.orchestrator.openProjectPath(href);
  action.catch((error) => showToast(TEXT.toastError, error.message || String(error), 'error'));
});
document.querySelector('#addWorkspace')?.addEventListener('click', async () => {
  try {
    const result = await window.orchestrator.addWorkspace({});
    if (result.canceled) return;
    await refreshSnapshot();
    showToast(TEXT.toastSuccess, `Workspace \u5e93\u5df2\u6dfb\u52a0\uff1a${result.workspace.name}`, 'success');
  } catch (error) {
    showToast(TEXT.toastError, error.message || String(error), 'error');
  }
});
credentialSelect?.addEventListener('change', () => switchToCredential(credentialSelect.value));
biliView?.addEventListener('did-start-loading', () => setLoginEndpointReady(false, TEXT.loginEndpointWaiting));
for (const eventName of ['dom-ready', 'did-finish-load', 'did-navigate', 'did-navigate-in-page']) {
  biliView?.addEventListener(eventName, () => {
    fitBiliWebView();
    if (currentUser?.isLogin) {
      setLoginEndpointReady(false, TEXT.loginSessionKept);
      return;
    }
    scheduleLoginEndpointProbe();
    setTimeout(inspectSmsChallenge, 400);
    const url = biliView.getURL?.() || '';
    if (url.includes('passport.bilibili.com') || url.includes('account.bilibili.com')) startLoginWatch();
  });
}
window.addEventListener('resize', fitBiliWebView);
smsCodeInput?.addEventListener('input', () => {
  submitSmsCodeButton.disabled = !smsChallenge?.canSubmit || !smsCodeInput.value.trim();
});
document.querySelector('#refreshSmsState')?.addEventListener('click', async () => {
  const state = await inspectSmsChallenge();
  showToast(TEXT.toastInfo, state.active ? '\u5df2\u68c0\u6d4b\u5230\u624b\u673a\u9a8c\u8bc1\u754c\u9762' : '\u5f53\u524d\u672a\u68c0\u6d4b\u5230\u624b\u673a\u9a8c\u8bc1\u754c\u9762', 'info');
});
sendSmsCodeButton?.addEventListener('click', async () => {
  sendSmsCodeButton.disabled = true;
  try {
    const result = await performSmsAction('send');
    if (!result.ok) throw new Error(result.reason || 'send failed');
    showToast(TEXT.toastSuccess, '\u5df2\u8bf7\u6c42\u53d1\u9001\u624b\u673a\u9a8c\u8bc1\u7801', 'success');
    setTimeout(inspectSmsChallenge, 700);
  } catch (error) {
    showToast(TEXT.toastError, error.message || String(error), 'error');
  } finally {
    sendSmsCodeButton.disabled = !smsChallenge?.canSend;
  }
});
submitSmsCodeButton?.addEventListener('click', async () => {
  const code = smsCodeInput.value.trim();
  if (!code) return showToast(TEXT.toastInfo, '\u8bf7\u8f93\u5165\u624b\u673a\u9a8c\u8bc1\u7801', 'info');
  submitSmsCodeButton.disabled = true;
  try {
    const result = await performSmsAction('submit', code);
    if (!result.ok) throw new Error(result.reason || 'verification failed');
    showToast(TEXT.toastSuccess, '\u5df2\u63d0\u4ea4\u624b\u673a\u9a8c\u8bc1\u7801', 'success');
    startLoginWatch();
    setTimeout(pollLoginFlow, 900);
  } catch (error) {
    showToast(TEXT.toastError, error.message || String(error), 'error');
  } finally {
    submitSmsCodeButton.disabled = !smsChallenge?.canSubmit || !smsCodeInput.value.trim();
  }
});
document.querySelector('#saveCredential')?.addEventListener('click', async () => {
  try {
    const item = await saveCredentialFromForm();
    showToast(TEXT.toastSuccess, `${item.username} \u5df2\u4fdd\u5b58`, 'success');
  } catch (error) {
    loginOutput.textContent = error.message || String(error);
    showToast(TEXT.toastError, error.message || String(error), 'error');
  }
});
document.querySelector('#deleteCredential')?.addEventListener('click', async () => {
  try {
    await deleteSelectedCredential();
    showToast(TEXT.toastSuccess, '\u8d26\u53f7\u5df2\u5220\u9664', 'success');
  } catch (error) {
    loginOutput.textContent = error.message || String(error);
    showToast(TEXT.toastError, error.message || String(error), 'error');
  }
});
oneClickLoginButton?.addEventListener('click', async () => {
  try {
    pendingCredentialId = credentialSelect.value || '';
    const result = await oneClickLogin();
    showToast(TEXT.toastInfo, result.clicked ? '\u5df2\u63d0\u4ea4\u767b\u5f55\u8868\u5355' : '\u5df2\u586b\u5199\u767b\u5f55\u8868\u5355\uff0c\u672a\u627e\u5230\u53ef\u70b9\u51fb\u6309\u94ae', result.clicked ? 'success' : 'info');
    startLoginWatch();
    setTimeout(pollLoginFlow, 800);
  } catch (error) {
    pendingCredentialId = '';
    loginOutput.textContent = error.message || String(error);
    showToast(TEXT.toastError, error.message || String(error), 'error');
  }
});

document.querySelector('#checkLogin').addEventListener('click', async () => {
  await synchronizeLogin({ manual: true });
});

document.querySelector('#loadFolders').addEventListener('click', async () => {
  try {
    collectionOutput.textContent = '\u6b63\u5728\u8bfb\u53d6\u6536\u85cf\u5939...';
    const nextFolders = await window.orchestrator.listFolders();
    setFolderInventory(nextFolders, folderSelect.value);
    collectionOutput.textContent = `\u8bfb\u53d6\u5230 ${folders.length} \u4e2a\u6536\u85cf\u5939\u3002`;
    showToast(TEXT.toastSuccess, `\u8bfb\u53d6\u5230 ${folders.length} \u4e2a\u6536\u85cf\u5939`, 'success');
  } catch (error) {
    setFolderInventory([]);
    collectionOutput.textContent = error.message || String(error);
    showToast(TEXT.toastError, error.message || String(error), 'error');
  }
});

document.querySelector('#syncCollection').addEventListener('click', async () => {
  if (!folderSelect.value) return;
  collectionSyncInFlight = true;
  updateSyncCollectionState();
  try {
    const collectionName = folderSelect.value;
    const label = labelInput.value.trim() || 'bili';
    renderSyncProgress({ stage: 'fetching', progress: 0, loaded: 0 });
    collectionOutput.textContent = `\u6b63\u5728\u540c\u6b65 ${collectionName}...`;
    const result = await window.orchestrator.syncCollection({ collectionName, label });
    collectionOutput.textContent = JSON.stringify(result, null, 2);
    await refreshSnapshot();
    await refreshProfileFolders({ force: true });
    showToast(TEXT.toastSuccess, `\u5df2\u540c\u6b65 ${collectionName || '-'}\uff1a${result.count || result.tasks || result.taskCount || 0} \u4e2a\u4efb\u52a1`, 'success');
  } catch (error) {
    renderSyncProgress({ stage: 'error', progress: 1 });
    collectionOutput.textContent = error.message || String(error);
    showToast(TEXT.toastError, error.message || String(error), 'error');
  } finally {
    collectionSyncInFlight = false;
    updateSyncCollectionState();
  }
});
folderSelect?.addEventListener('change', updateSyncCollectionState);

document.querySelector('#refreshTasks')?.addEventListener('click', async () => {
  try {
    await refreshSnapshot();
    showToast(TEXT.toastSuccess, '\u4efb\u52a1\u5df2\u5237\u65b0', 'success');
  } catch (error) {
    showToast(TEXT.toastError, error.message || String(error), 'error');
  }
});
document.querySelector('#refreshTools')?.addEventListener('click', async () => {
  try {
    await refreshSnapshot();
    showToast(TEXT.toastSuccess, '\u5de5\u5177\u5df2\u5237\u65b0', 'success');
  } catch (error) {
    showToast(TEXT.toastError, error.message || String(error), 'error');
  }
});
document.querySelector('#refreshRuns')?.addEventListener('click', async () => {
  try {
    await refreshSnapshot();
    showToast(TEXT.toastSuccess, '\u8fd0\u884c\u65e5\u5fd7\u5df2\u5237\u65b0', 'success');
  } catch (error) {
    showToast(TEXT.toastError, error.message || String(error), 'error');
  }
});

async function handleRuntime(data = {}) {
  runtime = { ...runtime, ...data };
  renderFilenameMetadataSettings();
  renderScheduler(runtime.scheduler);
  renderSettingsSummary();
  if (Array.isArray(data.toolHealth)) {
    toolHealth = data.toolHealth;
    renderToolHealth(toolHealth);
  }
  if (Object.prototype.hasOwnProperty.call(data, 'currentUser')) currentUser = data.currentUser;
  if (currentUser?.isLogin) {
    lastLoggedInMid = String(currentUser.mid || currentUser.id || '');
    renderProfile(lastSnapshot);
  }
  renderBootstrap(data.bootstrap || runtime.bootstrap || {});
  apiBadge.textContent = data.backendReady ? (data.apiUrl || 'API ready') : `${Math.round(Number(data.bootstrap?.progress || 0) * 100)}%`;
  apiDocs.textContent = buildApiDocs(data.apiUrl || 'http://127.0.0.1:17391');
  updatePromptTemplate();
  if (!data.backendReady) return;
  if (!backendSnapshotLoaded) {
    backendSnapshotLoaded = true;
    refreshSnapshot().catch((error) => {
      backendSnapshotLoaded = false;
      showToast(TEXT.toastError, error.message || String(error), 'error');
    });
    refreshCredentials(credentialSelect.value).catch(() => {});
    if (!initialLoginCheckDone) {
      initialLoginCheckDone = true;
      setTimeout(() => synchronizeLogin(), 0);
    }
  }
}

window.orchestrator.onRuntime(handleRuntime);
window.orchestrator.onBootstrap((state) => {
  runtime.bootstrap = state;
  runtime.backendReady = state.phase === 'ready';
  renderBootstrap(state);
});

window.orchestrator.onEvent((event) => {
  if (event.type === 'collection-sync-progress') {
    renderSyncProgress(event);
    return;
  }
  log(event.type || JSON.stringify(event));
  if (snapshotRefreshTimer) clearTimeout(snapshotRefreshTimer);
  snapshotRefreshTimer = setTimeout(() => refreshSnapshot(), 90);
});

window.orchestrator.getRuntime().then(handleRuntime).catch((error) => {
  renderBootstrap({ phase: 'error', progress: 1, message: error.message || String(error) });
});

applyI18n();
renderThemeChoices();
applyTheme(localStorage.getItem('themeId') || 'night');
setSidebarCollapsed(localStorage.getItem('sidebarCollapsed') === '1');
setLoginEndpointReady(false, TEXT.loginEndpointWaiting);
setSmsChallenge(null);
renderToolHealth();
renderBootstrap({ phase: 'starting', progress: 0.04, message: '\u6b63\u5728\u521d\u59cb\u5316\u5e94\u7528...' });

function updatePromptTemplate() {
  if (!agentPromptTemplate) return;
  const apiUrl = runtime.apiUrl || 'http://127.0.0.1:17391';
  agentPromptTemplate.textContent = `\u4f60\u6b63\u5728\u53c2\u4e0e\u300c\u661f\u7b3a BiliNote\u300d\u7684\u591a Agent \u89c6\u9891\u77e5\u8bc6\u6574\u7406\u5de5\u4f5c\u3002

\u3010\u6574\u4f53\u76ee\u6807\u3011
\u7528\u6237\u7684 Bilibili \u6536\u85cf\u5939\u4e2d\u957f\u671f\u7d2f\u79ef\u4e86 AI \u65b0\u95fb\u3001\u6280\u672f\u4ecb\u7ecd\u3001\u5de5\u7a0b\u7ecf\u9a8c\u548c\u5176\u5b83\u503c\u5f97\u4fdd\u7559\u7684\u89c6\u9891\u3002\u6211\u4eec\u8981\u628a\u8fd9\u4e9b\u89c6\u9891\u8f6c\u6362\u4e3a\u53ef\u68c0\u7d22\u3001\u53ef\u8df3\u8f6c\u65f6\u95f4\u8f74\u3001\u56fe\u6587\u5e76\u8302\u3001\u4fe1\u606f\u5b8c\u6574\u7684 Markdown \u77e5\u8bc6\u6587\u6863\uff0c\u4ee5\u540e\u53ef\u7ee7\u7eed\u6784\u5efa\u4e2a\u4eba RAG \u77e5\u8bc6\u5e93\u3002\u6587\u6863\u4e0d\u662f\u53ea\u5199\u51e0\u53e5\u6458\u8981\uff0c\u800c\u662f\u5728\u4e0d\u6b6a\u66f2\u539f\u610f\u7684\u524d\u63d0\u4e0b\uff0c\u8ba9\u8bfb\u8005\u53ef\u4ee5\u7528\u8f83\u5c11\u65f6\u95f4\u5b8c\u6574\u638c\u63e1\u89c6\u9891\u7684\u4e8b\u5b9e\u3001\u65b9\u6cd5\u3001\u8bba\u636e\u3001\u64cd\u4f5c\u7ec6\u8282\u548c\u5c40\u9650\u3002

\u3010\u534f\u4f5c\u8bbe\u8ba1\u3011
- \u684c\u9762\u5e94\u7528\u662f\u4efb\u52a1\u3001\u79df\u7ea6\u3001\u5de5\u5177\u3001\u5de5\u4f5c\u76ee\u5f55\u548c\u4ea7\u7269\u72b6\u6001\u7684\u552f\u4e00\u771f\u5b9e\u6765\u6e90\u3002
- \u6bcf\u4e2a\u65b0 Agent \u6216\u65e0\u4e0a\u4e0b\u6587\u8bb0\u5fc6\u7684\u65b0\u4f1a\u8bdd\uff0c\u90fd\u5fc5\u987b\u5148\u5411\u5e94\u7528\u6ce8\u518c\u81ea\u5df1\u4f7f\u7528\u7684\u8c03\u7528\u5de5\u5177\u548c\u6a21\u578b\uff0c\u7531\u5e94\u7528\u751f\u6210 Worker ID\u3002\u4e0d\u8981\u81ea\u884c\u8d77 ID \u6216\u590d\u7528\u5176\u5b83\u4f1a\u8bdd\u7684 ID\u3002
- \u6ce8\u518c\u540e\u8981\u5728\u5f53\u524d\u4f1a\u8bdd\u4e2d\u59a5\u5584\u4fdd\u5b58 Worker ID\uff0c\u540e\u7eed\u9886\u5355\u3001\u5fc3\u8df3\u3001\u5de5\u5177\u8c03\u7528\u3001\u53d6\u6d88\u3001\u63d0\u4ea4\u548c\u5931\u8d25\u4e0a\u62a5\u90fd\u5fc5\u987b\u643a\u5e26 workerId\u3002
- \u7528\u6237\u4f1a\u5148\u5728\u684c\u9762\u5e94\u7528\u7684\u4efb\u52a1\u9875\u9009\u62e9\u5e76\u6fc0\u6d3b\u4e00\u4e2a\u6536\u85cf\u5939\uff1b\u4f60\u4e0d\u9700\u8981\u8ba9\u7528\u6237\u53e6\u884c\u63d0\u4f9b\u4efb\u4f55\u76ee\u6807\u53c2\u6570\u3002
- \u6bcf\u4e2a Agent \u4e00\u6b21\u53ea\u9886\u53d6\u4e00\u4e2a\u89c6\u9891\uff0c\u5176\u5b83 Agent \u4e0d\u91cd\u590d\u5904\u7406\u5df2\u9886\u53d6\u4efb\u52a1\u3002
- \u4f60\u53ea\u80fd\u5728 claim \u8fd4\u56de\u7684 artifactDir \u4e2d\u521b\u5efa\u8be5\u89c6\u9891\u7684\u4ea7\u7269\uff0c\u4e0d\u8981\u7f16\u8f91 SQLite\u3001\u7d22\u5f15\u3001workspace \u914d\u7f6e\u6216\u5176\u5b83\u4efb\u52a1\u76ee\u5f55\u3002
- \u6240\u6709\u5a92\u4f53\u5de5\u5177\u5fc5\u987b\u901a\u8fc7\u684c\u9762\u5e94\u7528 API \u8c03\u7528\uff0c\u4e0d\u8981\u76f4\u63a5\u8fd0\u884c\u9879\u76ee\u5185\u90e8\u811a\u672c\u3002

\u5e94\u7528 API\uff1a${apiUrl}

\u3010\u5de5\u4f5c\u6d41\u7a0b\u3011
1. \u9996\u5148 GET ${apiUrl}/api/manifest \u83b7\u53d6\u5f53\u524d\u7248\u672c\u7684\u5168\u90e8\u53ef\u7528\u63a5\u53e3\u3001\u53c2\u6570\u3001\u5de5\u5177\u548c\u534f\u4f5c\u89c4\u8303\u3002
2. \u65b0\u4f1a\u8bdd POST ${apiUrl}/api/workers/register\uff0cbody \u4e3a {"tool":"<codex/claude-code/\u5176\u5b83\u8c03\u7528\u7aef>","model":"<\u5b9e\u9645\u6a21\u578b\u540d>","sessionLabel":"<\u53ef\u9009\u5907\u6ce8>"}\u3002\u4fdd\u5b58\u5e94\u7528\u8fd4\u56de\u7684 workerId\uff0c\u4e0d\u8981\u81ea\u884c\u751f\u6210\u3002
3. \u6ce8\u518c\u540e\u53ef GET ${apiUrl}/api/manifest?workerId=<workerId> \u83b7\u53d6\u5e26\u5f53\u524d Worker \u72b6\u6001\u7684\u7edf\u4e00\u63a5\u53e3\u6e05\u5355\u3002
4. GET ${apiUrl}/api/active-collection \u786e\u8ba4\u684c\u9762\u5e94\u7528\u5df2\u6fc0\u6d3b\u7684\u6536\u85cf\u5939\u3002\u5982\u679c\u8fd4\u56de NO_ACTIVE_COLLECTION\uff0c\u8bf7\u7528\u6237\u5148\u5728\u5e94\u7528\u91cc\u6fc0\u6d3b\u76ee\u6807\u3002
5. POST ${apiUrl}/api/tasks/claim\uff0cbody \u4e3a {"workerId":"<workerId>"}\u3002\u8fd4\u56de NO_TASK \u65f6\u6b63\u5e38\u7ed3\u675f\uff1b\u8fd4\u56de WORKER_PAUSED \u65f6\uff0c\u9075\u5faa\u300c\u6765\u81ea\u7528\u6237\u7684\u4fe1\u606f\uff0c\u4f60\u9700\u8981\u6682\u505c\u5de5\u4f5c\u300d\uff0c\u4e0d\u518d\u7ee7\u7eed\u7533\u8bf7\u65b0\u4efb\u52a1\u3002
6. \u9605\u8bfb claim \u8fd4\u56de\u7684\u89c6\u9891\u4fe1\u606f\u3001requirements\u3001tools\u3001artifactDir \u548c leaseExpiresAt\u3002\u5de5\u5177\u6392\u961f/\u8fd0\u884c\u671f\u95f4\u5e94\u7528\u4f1a\u81ea\u52a8\u4fdd\u62a4\u79df\u7ea6\uff1b\u5176\u5b83\u957f\u65f6\u5de5\u4f5c\u4ecd\u8981\u6bcf 15 \u5206\u949f\u5185 POST /api/tasks/<taskId>/heartbeat\uff0cbody \u5e26 workerId\u3002
7. \u901a\u8fc7 POST /api/tasks/<taskId>/tools/material-bundle/run \u51c6\u5907\u7d20\u6750\uff0cbody \u5305\u542b workerId \u548c options\u3002\u63a5\u53e3\u4f1a\u7acb\u5373\u8fd4\u56de HTTP 202\uff1bqueued \u662f\u6b63\u5e38\u72b6\u6001\uff0c\u6309 queuePosition\u3001queueReason\u3001estimatedWaitMs \u7b49\u5f85\uff0c\u4e0d\u8981\u91cd\u590d\u63d0\u4ea4\u540c\u4e00\u5de5\u5177\u3002\u7528 GET /api/tool-runs/<runId>?log=1 \u8ddf\u8e2a\u5230\u7ec8\u6001\uff1b\u5931\u8d25\u65f6\u9605\u8bfb\u65e5\u5fd7\u518d\u62c6\u5206\u8c03\u7528\u5176\u5b83\u5de5\u5177\u3002
8. \u65e0\u8bba B \u7ad9\u662f\u5426\u63d0\u4f9b\u5b57\u5e55\uff0c\u90fd\u5fc5\u987b\u8fd0\u884c\u4e00\u6b21 ASR\uff0c\u5e76\u6bd4\u5bf9\u5b8c\u6574\u6027\u3001\u65f6\u95f4\u8f74\u3001\u4e13\u6709\u540d\u8bcd\u548c\u8bed\u4e49\u3002\u65e0\u6cd5\u5224\u65ad\u65f6\u7528\u5173\u952e\u5e27\u548c\u591a\u6a21\u6001\u80fd\u529b\u6838\u5bf9\u3002
9. \u9009\u62e9\u6709\u4fe1\u606f\u91cf\u7684\u5173\u952e\u5e27\uff0c\u4f8b\u5982\u67b6\u6784\u56fe\u3001\u64cd\u4f5c\u754c\u9762\u3001\u6570\u636e\u56fe\u8868\u3001\u4ee3\u7801\u6216\u7ed3\u679c\uff0c\u4e0d\u8981\u653e\u7f6e\u91cd\u590d\u3001\u6a21\u7cca\u6216\u65e0\u610f\u4e49\u622a\u56fe\u3002
10. GET ${apiUrl}/api/templates/video-summary \u53d6\u5f97\u53c2\u8003 Markdown \u6a21\u677f\u3002\u5c3d\u91cf\u9075\u5faa\u6a21\u677f\u7ed3\u6784\uff0c\u4f46\u6839\u636e\u89c6\u9891\u5185\u5bb9\u5408\u7406\u589e\u51cf\u4e8c\u7ea7/\u4e09\u7ea7\u7ae0\u8282\u3002
11. Markdown \u5f00\u5934\u5fc5\u987b\u6309\u300c\u5c0f\u7ed3 -> \u601d\u7ef4\u5bfc\u56fe -> \u76ee\u5f55\u300d\u6392\u5217\uff1b\u601d\u7ef4\u5bfc\u56fe\u4f7f\u7528\u53ef\u6e32\u67d3\u7684 Mermaid fenced code block\u3002\u6b63\u6587\u8981\u4fe1\u606f\u5b8c\u6574\uff0c\u4fdd\u7559\u4e8b\u5b9e\u3001\u6b65\u9aa4\u3001\u4ee3\u7801/\u53c2\u6570\u3001\u6848\u4f8b\u3001\u56e0\u679c\u3001\u524d\u63d0\u4e0e\u5c40\u9650\u3002
12. \u5b9e\u8d28\u7ae0\u8282\u9644 Bilibili \u65f6\u95f4\u8f74\u8d85\u94fe\u63a5\uff1b\u5206 P \u89c6\u9891\u6807\u660e\u6240\u5c5e P\u3002\u6587\u6863\u8fd8\u8981\u6709\u5143\u6570\u636e\u3001\u5173\u952e\u5e27\u3001\u5b57\u5e55\u6bd4\u5bf9\u3001\u70ed\u8bc4\u524d\u4e09\u6761\u5206\u6790\u548c\u5904\u7406\u8bb0\u5f55\uff0c\u7981\u6b62\u5e7b\u89c9\u8865\u5168\u3002
13. \u786e\u8ba4 Markdown\u3001info.json\u3001\u56fe\u7247\u548c\u8f85\u52a9\u4ea7\u7269\u5b8c\u6574\u540e\uff0c\u901a\u8fc7 clean-cache \u5220\u9664\u4e34\u65f6\u97f3\u89c6\u9891\uff0c\u4e0d\u8981\u5220\u9664\u6700\u7ec8\u6587\u6863\u3001\u56fe\u7247\u3001\u5b57\u5e55\u3001\u8bc4\u8bba\u6216\u5143\u6570\u636e\u3002
14. POST /api/tasks/<taskId>/submit \u63d0\u4ea4\uff0cbody \u5fc5\u987b\u5e26 workerId \u548c\u4ea7\u7269\u8def\u5f84\u3002\u88ab\u6253\u56de\u65f6\u6309 errors \u4fee\u590d\u5e76\u91cd\u65b0\u63d0\u4ea4\uff1b\u786e\u5b9e\u65e0\u6cd5\u5b8c\u6210\u65f6 POST /api/tasks/<taskId>/fail\uff0cbody \u5e26 workerId \u548c\u53ef\u64cd\u4f5c\u7684 reason\u3002`;
}

function buildApiDocs(apiUrl) {
  return `Base URL: ${apiUrl}\n\n1. Discover the complete protocol\nGET ${apiUrl}/api/manifest\n\n2. Register this fresh agent session\nPOST ${apiUrl}/api/workers/register\n{\n  "tool": "codex",\n  "model": "<actual-model>",\n  "sessionLabel": "optional note"\n}\n\nSave the returned workerId. Do not invent one.\n\n3. Read the desktop-selected target\nGET ${apiUrl}/api/active-collection\n\n4. Claim one task\nPOST ${apiUrl}/api/tasks/claim\n{\n  "workerId": "<workerId>"\n}\n\n5. Run an app-managed tool\nPOST ${apiUrl}/api/tasks/<taskId>/tools/material-bundle/run\n{\n  "workerId": "<workerId>",\n  "options": {\n    "frames": 12,\n    "commentLimit": 3,\n    "timeoutMs": 7200000\n  }\n}\n\nThe app returns HTTP 202. queued is normal; do not submit a duplicate run.\n\n6. Poll until a terminal status\nGET ${apiUrl}/api/tool-runs/<runId>?log=1\n\nInspect queuePosition, queueReason, estimatedWaitMs, resourcePool, resourceLane, and stage.\nResource overview: GET ${apiUrl}/api/scheduler\n\n7. Read the Markdown template\nGET ${apiUrl}/api/templates/video-summary\n\n8. Heartbeat, submit, or fail\nPOST ${apiUrl}/api/tasks/<taskId>/heartbeat\nPOST ${apiUrl}/api/tasks/<taskId>/submit\nPOST ${apiUrl}/api/tasks/<taskId>/fail\n\nEvery state-changing request includes workerId. Active tool runs protect the task lease. A paused worker receives WORKER_PAUSED and must stop requesting new work.`;
}
