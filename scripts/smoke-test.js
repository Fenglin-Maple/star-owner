const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { initWorkspace, WORKSPACE_ROOT } = require('../src/core/workspace');
const { Store } = require('../src/core/store');
const { ToolRunner } = require('../src/core/tool-runner');
const { buildAnalytics } = require('../src/core/analytics');
const { ApiServer } = require('../src/core/api-server');
const { applySubmissionArtifactPlan, finalizeSubmissionArtifacts, recoverPendingSubmissionFinalizations, stageSubmissionFinalization } = require('../src/core/submission-artifacts');
const { videoArtifactName } = require('../src/core/workspace');
const { assessSubtitle } = require('../tools/video-tool');
const { validateSubmission } = require('../src/core/validation');
const { promoteMindMap } = require('../src/core/markdown');
const { DependencyManager } = require('../src/core/dependency-manager');
const { ensurePortableDesktopShortcut } = require('../src/core/desktop-shortcut');
const { repairPortablePythonHome } = require('../src/core/portable-runtime');
const { inspectVideoSupport, unsupportedBilibiliUrlReason } = require('../src/core/video-support');

(async () => {
  verifyRendererContracts();
  if (assessSubtitle([], 120).reason !== 'SUBTITLE_EMPTY') throw new Error('empty subtitle validation failed');
  if (assessSubtitle([{ from: 0, to: 9 }], 120).reason !== 'SUBTITLE_COVERAGE_TOO_LOW') throw new Error('subtitle coverage validation failed');
  if (assessSubtitle([{ from: 0, to: 60 }, { from: 60, to: 120 }, { from: 120, to: 300 }], 120).reason !== 'SUBTITLE_DURATION_MISMATCH') throw new Error('subtitle duration validation failed');
  if (!assessSubtitle([{ from: 0, to: 10 }, { from: 10, to: 20 }, { from: 20, to: 60 }], 120).valid) throw new Error('valid subtitle was rejected');
  if (!inspectVideoSupport({ bvid: 'BV1234567890', pages: [{ page: 1 }] }).supported) throw new Error('ordinary single-part video was rejected');
  const multiPartSupport = inspectVideoSupport({ bvid: 'BV1234567890', pages: [{ page: 1 }, { page: 2 }] });
  if (multiPartSupport.supported || multiPartSupport.kind !== 'multi-part' || multiPartSupport.pageCount !== 2) throw new Error('multi-part video was not blocked');
  if (!unsupportedBilibiliUrlReason('https://www.bilibili.com/bangumi/play/ep123456')) throw new Error('Bilibili PGC episode URL was not blocked');
  const legacyMarkdown = '# Title\n\n## 小结\n\nSummary\n\n## 目录\n\nContents\n\n## 正文\n\nBody\n\n## 思维导图\n\n```mermaid\nmindmap\n  root((Test))\n```\n\n## 处理记录\n\nDone\n';
  const promotedMarkdown = promoteMindMap(legacyMarkdown);
  if (!(promotedMarkdown.indexOf('## 小结') < promotedMarkdown.indexOf('## 思维导图') && promotedMarkdown.indexOf('## 思维导图') < promotedMarkdown.indexOf('## 目录'))) throw new Error('legacy mind-map promotion failed');
  if (!promotedMarkdown.includes('## 正文\n\nBody') || !promotedMarkdown.includes('```mermaid\nmindmap')) throw new Error('mind-map promotion damaged Markdown sections');

  initWorkspace();
  const dbFile = path.join(WORKSPACE_ROOT, 'smoke-orchestrator.sqlite');
  fs.rmSync(dbFile, { force: true });
  fs.rmSync(`${dbFile}.bak`, { force: true });
  fs.rmSync(`${dbFile}.tmp`, { force: true });

  const store = await Store.open(dbFile);
  const dependencyRoot = path.join(WORKSPACE_ROOT, 'smoke-dependency-root');
  fs.rmSync(dependencyRoot, { recursive: true, force: true });
  fs.mkdirSync(dependencyRoot, { recursive: true });
  const portableFixture = path.join(dependencyRoot, 'portable-runtime');
  const portablePythonHome = path.join(portableFixture, 'runtime', 'python', 'cpython-test');
  const portableConfig = path.join(portableFixture, 'runtime', 'faster-whisper', 'pyvenv.cfg');
  const portablePython = path.join(portablePythonHome, process.platform === 'win32' ? 'python.exe' : 'bin/python');
  fs.mkdirSync(path.dirname(portablePython), { recursive: true });
  fs.mkdirSync(path.dirname(portableConfig), { recursive: true });
  fs.writeFileSync(portablePython, 'fixture');
  fs.writeFileSync(portableConfig, 'home = D:\\old-machine\\python\nversion_info = 3.12.13\n');
  const portableRepair = repairPortablePythonHome(portableFixture);
  if (!portableRepair.changed || !fs.readFileSync(portableConfig, 'utf8').includes(`home = ${portablePythonHome}`)) throw new Error('portable Python home repair failed');
  if (repairPortablePythonHome(portableFixture).changed) throw new Error('portable Python home repair was not idempotent');
  const shortcutFixture = path.join(dependencyRoot, 'shortcut-fixture');
  const shortcutDesktop = path.join(shortcutFixture, 'desktop');
  fs.mkdirSync(path.join(shortcutFixture, 'assets'), { recursive: true });
  fs.mkdirSync(shortcutDesktop, { recursive: true });
  fs.writeFileSync(path.join(shortcutFixture, 'portable-manifest.json'), '{}');
  fs.writeFileSync(path.join(shortcutFixture, 'electron.exe'), 'fixture');
  fs.writeFileSync(path.join(shortcutFixture, 'assets', 'star-note.ico'), 'fixture');
  const shortcutSettings = new Map();
  const shortcutStore = {
    get: (scope, id) => shortcutSettings.get(`${scope}:${id}`) || null,
    set: (scope, id, value) => shortcutSettings.set(`${scope}:${id}`, value),
    save: () => {}
  };
  const shortcutWrites = [];
  const shortcutResult = ensurePortableDesktopShortcut({
    projectRoot: shortcutFixture,
    desktopPath: shortcutDesktop,
    executablePath: path.join(shortcutFixture, 'electron.exe'),
    version: '9.9.9',
    store: shortcutStore,
    writeShortcutLink: (...args) => { shortcutWrites.push(args); return true; },
    platform: 'win32'
  });
  if (shortcutResult.status !== 'created' || shortcutWrites.length !== 1 || shortcutWrites[0][1] !== 'create' || !shortcutWrites[0][2].args.includes(shortcutFixture)) throw new Error('portable desktop shortcut creation failed');
  if (ensurePortableDesktopShortcut({ projectRoot: shortcutFixture, desktopPath: shortcutDesktop, executablePath: path.join(shortcutFixture, 'electron.exe'), version: '9.9.9', store: shortcutStore, writeShortcutLink: () => { throw new Error('duplicate shortcut write'); }, platform: 'win32' }).reason !== 'already-completed') throw new Error('portable desktop shortcut first-run guard failed');
  const dependencyManager = new DependencyManager({ store, projectRoot: dependencyRoot, version: '9.9.9' });
  const missingDependencies = dependencyManager.state();
  if (missingDependencies.ready || !missingDependencies.needsPrompt || !missingDependencies.missingRequired.includes('runtime-base') || !missingDependencies.missingRequired.includes('model-small') || !missingDependencies.missingRequired.includes('model-medium')) throw new Error('dependency availability detection failed');
  dependencyManager.acknowledgePrompt(false);
  if (dependencyManager.state().needsPrompt) throw new Error('dependency first-run acknowledgement failed');
  const originalDownloadNow = dependencyManager.downloadNow.bind(dependencyManager);
  let duplicateDownloadCalls = 0;
  dependencyManager.downloadNow = async (id) => { duplicateDownloadCalls += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return { id }; };
  const duplicateDownloads = [dependencyManager.download('model-small'), dependencyManager.download('model-small')];
  if (duplicateDownloads[0] !== duplicateDownloads[1]) throw new Error('duplicate dependency requests did not share one pending operation');
  await Promise.all(duplicateDownloads);
  if (duplicateDownloadCalls !== 1) throw new Error('duplicate dependency request downloaded the same package more than once');
  dependencyManager.downloadNow = originalDownloadNow;
  const originalFetch = global.fetch;
  const dependencyRequests = [];
  global.fetch = async (url) => {
    dependencyRequests.push(String(url));
    if (String(url).includes('/releases?per_page=10')) {
      return new Response(JSON.stringify([{ id: 998, tag_name: 'v9.9.8', assets: [{ name: 'Star-Owner-v9.9.8-model-small.zip', browser_download_url: 'https://example.test/model-small.zip', size: 123 }] }]), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 999, tag_name: 'v9.9.9', assets: [{ name: 'Star-Owner-v9.9.9-win-x64-core.zip', browser_download_url: 'https://example.test/core.zip', size: 456 }] }), { status: 200 });
  };
  try {
    const modelDefinition = dependencyManager.definitions().find((item) => item.id === 'model-small');
    const resolvedHistoricalModel = await dependencyManager.resolveReleaseAsset(modelDefinition);
    if (resolvedHistoricalModel.asset.name !== 'Star-Owner-v9.9.8-model-small.zip' || !dependencyRequests.some((url) => url.includes('/releases?per_page=10'))) throw new Error('dependency resolver did not fall back from a current code-only release to a recent model asset');
  } finally {
    global.fetch = originalFetch;
  }
  const runtimeDefinition = dependencyManager.definitions().find((item) => item.id === 'runtime-base');
  const archiveSource = path.join(dependencyRoot, 'archive-source');
  const portableRoot = path.join(archiveSource, 'Star-Owner-v0.3.0-win-x64-core');
  fs.mkdirSync(path.join(portableRoot, 'runtime', 'python', 'cpython-3.12.13-windows-x86_64-none'), { recursive: true });
  fs.mkdirSync(path.join(portableRoot, 'runtime', 'faster-whisper', 'Lib', 'site-packages', 'faster_whisper'), { recursive: true });
  fs.mkdirSync(path.join(portableRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(portableRoot, 'runtime', 'python', 'cpython-3.12.13-windows-x86_64-none', 'python.exe'), 'test runtime');
  fs.writeFileSync(path.join(portableRoot, 'runtime', 'faster-whisper', 'Lib', 'site-packages', 'faster_whisper', '__init__.py'), 'test runtime');
  fs.writeFileSync(path.join(portableRoot, 'src', 'must-not-extract.txt'), 'application source');
  const legacyArchive = path.join(dependencyRoot, 'legacy-core.zip');
  createArchive(legacyArchive, archiveSource, path.basename(portableRoot));
  let rejectedCoreAsRuntime = false;
  try { await dependencyManager.extractArchive(legacyArchive, runtimeDefinition, false); } catch { rejectedCoreAsRuntime = true; }
  if (!rejectedCoreAsRuntime) throw new Error('ordinary dependency extraction accepted non-runtime core paths');
  await dependencyManager.extractArchive(legacyArchive, runtimeDefinition, true);
  if (!fs.existsSync(path.join(dependencyRoot, runtimeDefinition.probes[0])) || !fs.existsSync(path.join(dependencyRoot, runtimeDefinition.probes[1]))) throw new Error('legacy core runtime fallback extraction failed');
  const interruptedTarget = path.join(dependencyRoot, 'runtime', 'models', 'small');
  const interruptedBackup = path.join(dependencyRoot, 'runtime', '.install-backup-model-small-test', 'runtime', 'models', 'small');
  const interruptedStaging = path.join(dependencyRoot, 'runtime', '.install-staging-model-small-test');
  fs.mkdirSync(interruptedTarget, { recursive: true });
  fs.mkdirSync(interruptedBackup, { recursive: true });
  fs.mkdirSync(interruptedStaging, { recursive: true });
  fs.writeFileSync(path.join(interruptedTarget, 'model.bin'), 'incomplete-new-model');
  fs.writeFileSync(path.join(interruptedBackup, 'model.bin'), 'known-good-old-model');
  fs.writeFileSync(path.join(dependencyRoot, 'runtime', '.install-transaction.json'), JSON.stringify({
    id: 'model-small',
    stagingRoot: interruptedStaging,
    backupRoot: path.join(dependencyRoot, 'runtime', '.install-backup-model-small-test'),
    entries: [{ target: interruptedTarget, backup: interruptedBackup, hadOriginal: true }]
  }));
  new DependencyManager({ store, projectRoot: dependencyRoot, version: '9.9.9' });
  if (fs.readFileSync(path.join(interruptedTarget, 'model.bin'), 'utf8') !== 'known-good-old-model' || fs.existsSync(path.join(dependencyRoot, 'runtime', '.install-transaction.json'))) {
    throw new Error('interrupted dependency installation did not roll back to the previous runtime');
  }
  const corruptJournal = path.join(dependencyRoot, 'runtime', '.install-transaction.json');
  fs.writeFileSync(corruptJournal, '{not valid json', 'utf8');
  const recoveredFromCorruption = new DependencyManager({ store, projectRoot: dependencyRoot, version: '9.9.9' });
  if (!recoveredFromCorruption.state().recovery?.warning || fs.existsSync(corruptJournal)) throw new Error('corrupt dependency recovery journal still blocked startup');
  if (!listCorruptJournals(dependencyRoot).length) throw new Error('corrupt dependency recovery journal was not quarantined');
  if (fs.existsSync(path.join(dependencyRoot, 'src', 'must-not-extract.txt'))) throw new Error('legacy core fallback extracted application files');
  const defaultFilenameMetadata = store.getFilenameMetadata();
  if (Object.values(defaultFilenameMetadata).some((enabled) => enabled !== true)) throw new Error('filename metadata defaults failed');
  store.setFilenameMetadata({ tags: false, title: false });
  if (store.getFilenameMetadata().tags !== false || store.getFilenameMetadata().title !== false || store.getFilenameMetadata().bvid !== true) throw new Error('filename metadata persistence failed');
  store.setFilenameMetadata(defaultFilenameMetadata);
  const artifactName = videoArtifactName({ bvid: 'BVTEST', title: 'Title', owner: 'UP', publishedAt: '2026-01-02T00:00:00Z', favoriteAddedAt: '2026-02-03T00:00:00Z', tags: ['AI', 'Code'] }, { name: 'Collection' });
  if (!artifactName.includes('[BV-BVTEST]') || !artifactName.includes('[\u53d1\u5e03\u65e5-20260102]') || !artifactName.includes('[\u6536\u85cf\u65e5-20260203]') || !artifactName.includes('[\u6807\u7b7e-AI+Code]')) throw new Error('artifact metadata naming failed');
  store.upsertUser({ id: 'u1', name: 'smoke-user', mid: '1' });
  store.upsertCollection({ id: 'c1', name: 'AIcode', userId: 'u1' });
  store.upsertTask({ id: 'c1:BVTEST', collectionId: 'c1', bvid: 'BVTEST', status: 'pending', createdAt: new Date().toISOString() });
  store.upsertTask({ id: 'c1:BVOLD', collectionId: 'c1', bvid: 'BVOLD', title: 'Old favorite', status: 'pending', favoriteAddedAt: '2025-01-01T00:00:00.000Z', createdAt: '2025-01-01T00:00:00.000Z' });
  store.upsertTask({ id: 'c1:BVNEW', collectionId: 'c1', bvid: 'BVNEW', title: 'New favorite', status: 'pending', favoriteAddedAt: '2999-01-01T00:00:00.000Z', createdAt: '2999-01-01T00:00:00.000Z' });
  store.commit();

  const task = store.getTask('c1:BVTEST');
  if (!task || task.status !== 'pending') throw new Error('store smoke failed');
  if (store.listTasks({ collectionId: 'c1' })[0]?.id !== 'c1:BVNEW') throw new Error('favorite-date task sorting failed');
  store.updateTasksEnabled(['c1:BVOLD'], false);
  if (store.getTask('c1:BVOLD')?.enabled !== false) throw new Error('task enable state failed');

  const defaultWorkspace = store.getDefaultWorkspace();
  if (!defaultWorkspace?.isDefault) throw new Error('default workspace initialization failed');
  const extraRoot = path.join(WORKSPACE_ROOT, 'smoke-library');
  const extraWorkspace = store.addWorkspace({ name: 'Smoke library', root: extraRoot });
  store.setDefaultWorkspace(extraWorkspace.id);
  if (store.getDefaultWorkspace()?.id !== extraWorkspace.id) throw new Error('workspace selection failed');

  store.upsertCollection({ id: 'c2', name: 'Claim smoke', userId: 'u1', userName: 'smoke-user', cookieFile: path.join(WORKSPACE_ROOT, 'private-cookie.txt') });
  store.upsertTask({ id: 'c2:BVDISABLED', collectionId: 'c2', bvid: 'BVDISABLED', title: 'Disabled', status: 'pending', enabled: false, favoriteAddedAt: '2999-01-01T00:00:00.000Z' });
  store.upsertTask({ id: 'c2:BVENABLED', collectionId: 'c2', bvid: 'BVENABLED', title: 'Enabled', status: 'pending', enabled: true, favoriteAddedAt: '2025-01-01T00:00:00.000Z', cookieFile: path.join(WORKSPACE_ROOT, 'private-task-cookie.txt') });
  store.commit();
  const healthRunner = new ToolRunner({ store });
  if (healthRunner.config.asrModel !== 'medium') throw new Error('medium ASR model must be the default');
  const canonicalArgs = healthRunner.buildArgs({
    task: { bvid: 'BVTEST', url: 'bilibili://video/123' },
    action: 'info',
    collection: {},
    artifactDir: WORKSPACE_ROOT,
    options: {}
  });
  if (!canonicalArgs.includes('BVTEST') || canonicalArgs.includes('bilibili://video/123')) throw new Error('tool target must prefer bvid over app-deep-link URL');
  const toolHealth = await healthRunner.probeTools(store.listTools());
  if (toolHealth.length !== store.listTools().length || toolHealth.some((item) => !item.responded)) throw new Error('tool interface health probe failed');
  const registration = { workerId: store.registerWorker({ tool: 'star-owner-internal', model: 'smoke-model', sessionLabel: 'smoke internal worker', metadata: { internalAgent: true } }).id };
  const knowledgeCollection = {
    id: 'knowledge-smoke',
    mediaId: 'knowledge-smoke',
    name: 'Knowledge smoke',
    sourceName: 'Knowledge smoke',
    userId: 'u1',
    userName: 'smoke-user',
    syncReady: true,
    syncState: 'ready'
  };
  const knowledgeArtifact = path.join(extraRoot, 'smoke-user', 'Knowledge smoke', 'BVKNOWLEDGE1');
  const knowledgeMarkdown = path.join(knowledgeArtifact, 'summary.md');
  const knowledgeImage = path.join(knowledgeArtifact, 'cover.png');
  fs.mkdirSync(knowledgeArtifact, { recursive: true });
  fs.writeFileSync(knowledgeMarkdown, '# Knowledge smoke\n\nExact raw knowledge line.\n\nSecond page content.\n', 'utf8');
  fs.writeFileSync(knowledgeImage, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  store.upsertCollection(knowledgeCollection);
  store.upsertTask({
    id: 'knowledge-smoke:BVKNOWLEDGE1',
    collectionId: knowledgeCollection.id,
    bvid: 'BVKNOWLEDGE1',
    title: 'Knowledge smoke document',
    owner: 'Smoke UP',
    tags: ['AI', 'Smoke'],
    status: 'done',
    enabled: true,
    artifactDir: knowledgeArtifact,
    outputMarkdown: knowledgeMarkdown,
    coverFile: knowledgeImage,
    allowedRoot: extraRoot,
    workspaceRoot: extraRoot,
    publishedAt: '2026-07-01T01:00:00.000Z',
    favoriteAddedAt: '2026-07-02T02:00:00.000Z',
    completedAt: '2026-07-03T03:00:00.000Z',
    createdAt: '2026-07-02T02:00:00.000Z'
  });
  store.commit();

  const api = new ApiServer({ store });
  await api.start(0);
  try {
    const manifestResponse = await fetch(api.url() + '/api/manifest');
    const manifest = await manifestResponse.json();
    if (!manifestResponse.ok || manifest.protocolVersion !== '3.0' || manifest.mode !== 'knowledge-read-only' || manifest.access?.videoWorkflowApi !== false || !Array.isArray(manifest.endpoints)) throw new Error('read-only knowledge manifest failed');

    const catalogResponse = await fetch(api.url() + '/api/knowledge/catalog');
    const catalog = await catalogResponse.json();
    if (!catalogResponse.ok || !catalog.collections.some((item) => item.id === knowledgeCollection.id && item.documentCount === 1)) throw new Error('knowledge catalog omitted a completed collection');

    const documentsResponse = await fetch(api.url() + '/api/knowledge/documents?collectionId=' + encodeURIComponent(knowledgeCollection.id) + '&limit=1');
    const documents = await documentsResponse.json();
    const document = documents.documents?.[0];
    if (!documentsResponse.ok || documents.total !== 1 || document?.bvid !== 'BVKNOWLEDGE1' || document.publishedAt !== '2026-07-01T01:00:00.000Z' || document.favoriteAddedAt !== '2026-07-02T02:00:00.000Z') throw new Error('knowledge document directory or date metadata failed');
    const serializedDirectory = JSON.stringify(documents);
    if (serializedDirectory.includes(extraRoot) || serializedDirectory.includes('cookieFile') || serializedDirectory.includes('outputMarkdown')) throw new Error('knowledge directory exposed local paths or private fields');

    const contentResponse = await fetch(api.url() + '/api/knowledge/documents/' + encodeURIComponent(document.id) + '/content?startLine=1&lineCount=2');
    const content = await contentResponse.json();
    if (!contentResponse.ok || content.exactSource !== true || content.content !== '# Knowledge smoke\n' || content.nextStartLine !== 3) throw new Error('exact Markdown line paging failed');
    const secondContent = await (await fetch(api.url() + '/api/knowledge/documents/' + encodeURIComponent(document.id) + '/content?startLine=' + content.nextStartLine + '&lineCount=20')).json();
    if (!secondContent.content.includes('Exact raw knowledge line.') || secondContent.nextStartLine !== null) throw new Error('knowledge Markdown continuation failed');

    const assetsResponse = await fetch(api.url() + '/api/knowledge/documents/' + encodeURIComponent(document.id) + '/assets');
    const assets = await assetsResponse.json();
    if (!assetsResponse.ok || assets.assets.length !== 1 || assets.assets[0].mimeType !== 'image/png') throw new Error('knowledge asset listing failed');
    const imageResponse = await fetch(assets.assets[0].url);
    if (!imageResponse.ok || imageResponse.headers.get('content-type') !== 'image/png' || !(await imageResponse.arrayBuffer()).byteLength) throw new Error('knowledge image read failed');

    const searchResponse = await fetch(api.url() + '/api/knowledge/search?q=' + encodeURIComponent('raw knowledge') + '&collectionId=' + encodeURIComponent(knowledgeCollection.id));
    const search = await searchResponse.json();
    if (!searchResponse.ok || search.results?.[0]?.id !== document.id || search.scannedDocuments !== 1) throw new Error('knowledge search failed');

    for (const endpoint of ['/api/workers/register', '/api/tasks/claim', '/api/tools', '/api/tool-runs/run-1']) {
      const response = await fetch(api.url() + endpoint, { method: endpoint.endsWith('register') || endpoint.endsWith('claim') ? 'POST' : 'GET' });
      const payload = await response.json();
      if (response.status !== 410 || payload.code !== 'EXTERNAL_VIDEO_WORKFLOW_DISABLED') throw new Error('legacy external video endpoint remained active: ' + endpoint);
    }
  } finally {
    api.stop();
  }
  store.setDefaultWorkspace(defaultWorkspace.id);
  store.removeWorkspace(extraWorkspace.id);

  store.recordTaskEvent('c1:BVTEST', 'claimed', { workerId: registration.workerId });
  store.recordTaskEvent('c1:BVTEST', 'completed', { workerId: registration.workerId, processingSeconds: 60, videoDuration: 120 });
  store.recordTaskEvent('removed-history', 'claimed', { collectionId: 'c1', workerId: 'historical-worker' });
  store.recordTaskEvent('removed-history', 'completed', { collectionId: 'c1', workerId: 'historical-worker', processingSeconds: 30, videoDuration: 60 });
  const stats = buildAnalytics(store).collections.c1;
  const registeredStats = stats.agents.find((item) => item.workerId === registration.workerId);
  if (registeredStats?.weightedTimeRatio !== 0.5) throw new Error('per-worker weighted analytics failed');
  if (!stats.agents.some((item) => item.workerId === 'historical-worker' && item.completed === 1 && item.weightedTimeRatio === 0.5)) throw new Error('removed task history disappeared from collection analytics');

  const tools = store.listTools();
  if (!tools.some((tool) => tool.id === 'asr' && tool.enabled)) throw new Error('tool registry smoke failed');
  store.createToolRun({
    id: 'run1',
    taskId: 'c1:BVTEST',
    toolId: 'video-info',
    status: 'running',
    createdAt: new Date().toISOString()
  });
  store.updateToolRun('run1', { status: 'succeeded', exitCode: 0 });
  if (store.getToolRun('run1')?.status !== 'succeeded') throw new Error('tool run smoke failed');

  const artifactDir = path.join(WORKSPACE_ROOT, 'smoke-artifact');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'cache.mp4'), 'temporary media');
  fs.writeFileSync(path.join(artifactDir, 'summary.md'), '# keep');
  const namingRoot = path.join(WORKSPACE_ROOT, 'smoke-naming-root');
  const namingDraft = path.join(namingRoot, 'draft');
  fs.mkdirSync(path.join(namingDraft, 'frames'), { recursive: true });
  fs.writeFileSync(path.join(namingDraft, 'draft.md'), '# summary');
  fs.writeFileSync(path.join(namingDraft, 'info.json'), JSON.stringify({ tags: ['AI'] }));
  fs.writeFileSync(path.join(namingDraft, 'frames', 'frame.jpg'), 'frame');
  const finalized = finalizeSubmissionArtifacts({
    task: { bvid: 'BVFINAL', title: 'Final title', owner: 'UP', publishedAt: '2026-01-02T00:00:00Z', favoriteAddedAt: '2026-02-03T00:00:00Z', tags: ['AI'], allowedRoot: namingRoot },
    collection: { name: 'Collection' },
    validation: { artifactDir: namingDraft, markdownFile: path.join(namingDraft, 'draft.md'), metadataFile: path.join(namingDraft, 'info.json') },
    filenameMetadata: defaultFilenameMetadata
  });
  if (!fs.existsSync(finalized.markdownFile) || !fs.existsSync(finalized.metadataFile) || !fs.existsSync(path.join(finalized.artifactDir, 'frames', 'frame.jpg'))) throw new Error('artifact finalization lost files');
  if (path.basename(finalized.markdownFile, '.md') !== path.basename(finalized.artifactDir)) throw new Error('artifact directory and Markdown names diverged');
  const crashRoot = path.join(WORKSPACE_ROOT, 'smoke-finalization-recovery');
  const crashDraft = path.join(crashRoot, 'draft');
  fs.mkdirSync(crashDraft, { recursive: true });
  const crashMarkdown = path.join(crashDraft, 'draft.md');
  const crashMetadata = path.join(crashDraft, 'info.json');
  fs.writeFileSync(crashMarkdown, '# recoverable completion');
  fs.writeFileSync(crashMetadata, '{}');
  const crashTask = { id: 'crash-final-task', collectionId: 'c1', bvid: 'BVCRASH00001', title: 'Crash recovery', owner: 'UP', status: 'claimed', workId: 'work-crash-final', claimedBy: registration.workerId, claimedAt: new Date().toISOString(), allowedRoot: crashRoot, artifactDir: crashDraft };
  store.upsertTask(crashTask);
  store.commit();
  const crashTime = new Date().toISOString();
  const stagedFinalization = stageSubmissionFinalization({
    store,
    task: crashTask,
    collection: { id: 'c1', name: 'Collection' },
    validation: { artifactDir: crashDraft, markdownFile: crashMarkdown, metadataFile: crashMetadata },
    filenameMetadata: defaultFilenameMetadata,
    completedTask: { ...crashTask, status: 'done', workId: '', completedAt: crashTime, updatedAt: crashTime },
    event: { id: 'submission-completed:work-crash-final', taskId: crashTask.id, type: 'completed', createdAt: crashTime, collectionId: 'c1', workerId: registration.workerId, workId: 'work-crash-final' }
  });
  applySubmissionArtifactPlan(stagedFinalization.plan);
  if (!store.get('submissionFinalizations', stagedFinalization.id) || store.getTask(crashTask.id)?.status !== 'claimed') throw new Error('submission recovery fixture did not preserve the crash window');
  const recoveredFinalizations = recoverPendingSubmissionFinalizations(store);
  const recoveredTask = store.getTask(crashTask.id);
  if (!recoveredFinalizations[0]?.ok || recoveredTask?.status !== 'done' || !fs.existsSync(recoveredTask.outputMarkdown) || store.get('submissionFinalizations', stagedFinalization.id)) {
    throw new Error('crash-safe submission finalization did not recover file and database state');
  }
  const validationRoot = path.join(WORKSPACE_ROOT, 'smoke-validation-root');
  fs.mkdirSync(validationRoot, { recursive: true });
  const metadataFile = path.join(validationRoot, 'info.json');
  const validMarkdown = path.join(validationRoot, 'valid.md');
  const invalidMarkdown = path.join(validationRoot, 'invalid.md');
  const opening = '## 小结\n\nSummary\n\n## 思维导图\n\n```mermaid\nmindmap\n  root((Test))\n```\n\n## 目录\n\n- Contents\n\n## 正文\n\n### Test [00:01](https://www.bilibili.com/video/BV1234567890?t=1)\n\n## 字幕比对\n\nASR 选择说明\n\n## 评论分析\n\nNone\n\n## 处理记录\n\nDone\n';
  fs.mkdirSync(path.join(validationRoot, 'asr'), { recursive: true });
  fs.writeFileSync(path.join(validationRoot, 'asr', 'transcript.srt'), '1\n00:00:01,000 --> 00:00:02,000\nTest sentence.\n');
  fs.writeFileSync(path.join(validationRoot, 'asr', 'asr-transcript.txt'), '[00:00:01,000 --> 00:00:02,000] Test sentence.\n');
  fs.writeFileSync(path.join(validationRoot, 'asr', 'asr-result.json'), JSON.stringify({ segments: [{ id: 0, start: 1, end: 2, text: 'Test sentence.' }] }));
  fs.writeFileSync(metadataFile, '{}');
  fs.writeFileSync(validMarkdown, opening);
  fs.writeFileSync(invalidMarkdown, opening.replace('## 思维导图\n\n```mermaid\nmindmap\n  root((Test))\n```\n\n## 目录', '## 目录\n\n## 思维导图\n\nNo diagram'));
  const validationTask = { allowedRoot: validationRoot, artifactDir: validationRoot };
  if (!validateSubmission(validationTask, { artifactDir: validationRoot, markdownFile: validMarkdown, metadataFile }).ok) throw new Error('valid Mermaid opening was rejected');
  if (validateSubmission(validationTask, { artifactDir: validationRoot, markdownFile: invalidMarkdown, metadataFile }).ok) throw new Error('invalid Mermaid opening was accepted');
  const recoveryArtifactDir = path.join(WORKSPACE_ROOT, 'smoke-recovery-artifact');
  fs.mkdirSync(recoveryArtifactDir, { recursive: true });
  fs.writeFileSync(path.join(recoveryArtifactDir, 'recover.mp4'), 'recover me');
  store.createToolRun({
    id: 'recovery-run',
    taskId: 'c1:BVTEST',
    collectionId: 'c1',
    toolId: 'clean-cache',
    toolName: '清理视频缓存',
    action: 'clean-cache',
    workerId: registration.workerId,
    status: 'queued',
    artifactDir: recoveryArtifactDir,
    logFile: path.join(recoveryArtifactDir, 'recovery.log'),
    options: {},
    timeoutMs: 60000,
    createdAt: new Date().toISOString()
  });
  const runner = new ToolRunner({ store });
  await runner.initialize({ startGpuService: false });
  if (runner.getState().config.cpuAsrEnabled !== false || runner.getState().services.cpu.state !== 'stopped') {
    throw new Error('CPU ASR must remain disabled and unloaded by default');
  }
  await waitForRun(store, 'recovery-run');
  if (store.getToolRun('recovery-run')?.status !== 'succeeded' || fs.existsSync(path.join(recoveryArtifactDir, 'recover.mp4'))) {
    throw new Error('persisted queued run recovery failed');
  }
  const cleanTool = store.get('tools', 'clean-cache');
  const run = runner.start({
    task: {
      id: 'c1:BVTEST',
      bvid: 'BVTEST',
      status: 'claimed',
      allowedRoot: WORKSPACE_ROOT,
      artifactDir
    },
    tool: cleanTool,
    collection: {},
    workerId: registration.workerId
  });
  await waitForRun(store, run.id);
  if (store.getToolRun(run.id)?.status !== 'succeeded') throw new Error('tool runner execution smoke failed');
  if (fs.existsSync(path.join(artifactDir, 'cache.mp4'))) throw new Error('clean-cache did not remove media cache');
  if (!fs.existsSync(path.join(artifactDir, 'summary.md'))) throw new Error('clean-cache removed non-cache artifact');
  runner.shutdown();

  fs.rmSync(artifactDir, { recursive: true, force: true });
  fs.rmSync(namingRoot, { recursive: true, force: true });
  fs.rmSync(validationRoot, { recursive: true, force: true });
  fs.rmSync(recoveryArtifactDir, { recursive: true, force: true });
  fs.rmSync(extraRoot, { recursive: true, force: true });
  fs.rmSync(dependencyRoot, { recursive: true, force: true });
  store.db.close();
  fs.rmSync(dbFile, { force: true });
  console.log('smoke ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

function waitForRun(store, runId) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const run = store.getToolRun(runId);
      if (run && ['succeeded', 'failed', 'cancelled', 'timeout'].includes(run.status)) {
        clearInterval(timer);
        resolve(run);
      } else if (Date.now() - started > 10000) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for tool run: ${runId}`));
      }
    }, 100);
  });
}

function createArchive(archive, sourceRoot, item) {
  const result = spawnSync('tar.exe', ['-a', '-c', '-f', archive, '-C', sourceRoot, item], { windowsHide: true, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not create dependency fixture: ${result.stderr || result.stdout}`);
}

function listCorruptJournals(root) {
  const runtime = path.join(root, 'runtime');
  return fs.existsSync(runtime) ? fs.readdirSync(runtime).filter((name) => name.startsWith('.install-transaction.corrupt-')) : [];
}

function verifyRendererContracts() {
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  if (!index.includes('id="singleDuplicateModal"') || !index.includes('id="documentDeleteModal"') || !index.includes('id="documentContextMenu"')) {
    throw new Error('single-video/document lifecycle dialogs are missing from the renderer');
  }
  if (!index.includes('data-nav-group="settings"') || !index.includes('data-page="workers"') || !index.includes('data-page="agent-tool-status"')) {
    throw new Error('status pages are not available from the Settings submenu');
  }
  if (!index.includes('id="syncSummary"') || !index.includes('id="taskStatusFilters"') || !index.includes('data-task-status="disabled"')) {
    throw new Error('collection sync counts or task status filters are missing from the renderer');
  }
  if (!app.includes('function renderSyncSummary') || !app.includes('function taskStateGroup') || !app.includes("taskStatusFilter === 'all'")) {
    throw new Error('collection/task status summaries are not wired into renderer filtering');
  }
  if (!index.includes('id="firstRunGuide"') || !index.includes('data-navigate-page="ai-models"') || !index.includes('data-navigate-page="internal-agents"')) {
    throw new Error('the startup first-run journey or its navigation targets are missing');
  }
  if (!app.includes('/api/health') || !app.includes('favorite-desc') || !app.includes('lineCount 单次支持 1～1000 行')) {
    throw new Error('the external knowledge Agent prompt is missing health, sorting, or exact-content guidance');
  }
  if (!app.includes("new CustomEvent('star:page-changed'") || !fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'ai.js'), 'utf8').includes("window.addEventListener('star:page-changed'")) {
    throw new Error('page navigation does not refresh AI state consistently across sidebar and onboarding entry points');
  }
  if (index.includes('id="labelInput"') || app.includes('labelInput')) throw new Error('obsolete collection label input is still exposed');
  if (!preload.includes("ipcRenderer.invoke('documents:delete'") || !preload.includes("ipcRenderer.invoke('internal-agent:single-inspect'")) {
    throw new Error('document deletion or single-video inspection is missing from the preload bridge');
  }
}
