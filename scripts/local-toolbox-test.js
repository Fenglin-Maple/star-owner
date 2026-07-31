const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { LocalToolboxManager } = require('../src/core/local-toolbox-manager');
const { runFfmpeg } = require('../src/core/local-media-runtime');
const { RagAssistant } = require('../src/core/rag-assistant');
const { Store } = require('../src/core/store');
const { ToolRunner } = require('../src/core/tool-runner');
const { VideoCacheManager } = require('../src/core/video-cache-manager');

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

(async () => {
  const root = path.join(__dirname, '..', '.cache', 'local-toolbox-test');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  try {
    const store = await Store.open(path.join(root, 'test.sqlite'));
    const workspace = store.addWorkspace({ name: 'Local toolbox test', root: path.join(root, 'workspace') });
    store.setDefaultWorkspace(workspace.id);
    const runner = new FakeUtilityRunner();
    const videoCache = new VideoCacheManager({ store, toolRunner: runner, bili: null });
    const manager = new LocalToolboxManager({ store, toolRunner: runner, videoCacheManager: videoCache });
    manager.initialize();

    const mediaRoot = path.join(root, 'media');
    fs.mkdirSync(mediaRoot, { recursive: true });
    const sourceVideo = path.join(mediaRoot, '竖屏测试.mp4');
    await createTestVideo(sourceVideo);

    const subtitleSelection = await manager.inspectSubtitleDirectory(mediaRoot);
    const subtitleJob = manager.startSubtitleJob(subtitleSelection.id, ['srt', 'vtt', 'lrc', 'txt', 'json']);
    const subtitleResult = await waitForJob(manager, store, subtitleJob.id);
    assert.equal(subtitleResult.status, 'completed');
    for (const extension of ['srt', 'vtt', 'lrc', 'txt', 'json']) {
      const output = path.join(mediaRoot, `竖屏测试.asr.${extension}`);
      assert(fs.existsSync(output), `missing ${extension} subtitle output`);
    }
    assert(runner.pools.includes('media') && runner.pools.includes('asr'), 'subtitle generation bypassed the shared media or ASR resource pool');

    const videoSelection = await manager.inspectVideoSelection([sourceVideo]);
    const videoPreview = manager.previewVideoImport(videoSelection.id, { collectionName: '本地导入测试' });
    assert.equal(videoPreview.files.length, 1);
    const videoJob = manager.startVideoImport(videoSelection.id, { collectionName: '本地导入测试', choices: {} });
    const videoResult = await waitForJob(manager, store, videoJob.id, 30000);
    assert.equal(videoResult.status, 'completed');
    const collection = store.getCollectionById(videoJob.collectionId);
    const record = store.listVideoCaches({ collectionId: collection.id })[0];
    const task = store.getTask(record.taskId);
    assert(record.localImported && record.sourceType === 'local-video' && record.orientation === 'portrait', 'local video metadata was not persisted');
    assert(task.status === 'pending' && task.reuseCachedMedia && task.cachedVideoFile === record.videoFile, 'local video was not exposed as an Agent task');
    assert(fs.existsSync(sourceVideo), 'source video was moved or deleted');
    assert(fs.statSync(record.videoFile).size <= 50 * 1024 * 1024, 'short imported video exceeded the 50 MiB budget');
    assert.equal(JSON.parse(fs.readFileSync(record.metadataFile, 'utf8')).sourceType, 'local-video');

    store.upsertTask({ ...task, status: 'claimed', workId: 'work-active', claimedBy: 'agent-active' });
    const skippedJob = manager.startVideoImport(videoSelection.id, { collectionId: collection.id, choices: { [videoSelection.files[0].id]: 'skip' } });
    const skipped = await waitForJob(manager, store, skippedJob.id);
    assert.equal(skipped.items[0].status, 'skipped', 'skip choice was blocked by an active Agent task');
    assert.throws(() => manager.startVideoImport(videoSelection.id, { collectionId: collection.id, choices: { [videoSelection.files[0].id]: 'overwrite' } }), /正在被 Agent 处理/);
    store.upsertTask({ ...store.getTask(task.id), status: 'pending', workId: '', claimedBy: '' });

    const oldInfo = fs.readFileSync(record.metadataFile);
    const oldVideoSize = fs.statSync(record.videoFile).size;
    const originalTransaction = store.transaction.bind(store);
    store.transaction = () => { throw new Error('simulated database commit failure'); };
    const rollbackJob = manager.startVideoImport(videoSelection.id, { collectionId: collection.id, choices: { [videoSelection.files[0].id]: 'overwrite' } });
    const rollbackResult = await waitForJob(manager, store, rollbackJob.id, 30000);
    store.transaction = originalTransaction;
    assert.equal(rollbackResult.status, 'failed');
    assert(fs.readFileSync(record.metadataFile).equals(oldInfo) && fs.statSync(record.videoFile).size === oldVideoSize, 'failed overwrite did not restore the previous cache files');

    await verifyLocalAgentSkipsBilibili(task, record, collection);

    const documentRoot = path.join(root, 'documents');
    const documentFiles = await createDocumentFixtures(documentRoot);
    const documentSelection = manager.inspectDocumentSelection(documentFiles);
    const documentJob = manager.startDocumentImport(documentSelection.id, { collectionName: '本地资料库', choices: {} });
    const documentResult = await waitForJob(manager, store, documentJob.id, 30000);
    assert.equal(documentResult.status, 'completed');
    const documentCollection = store.getCollectionById(documentJob.collectionId);
    const documentTasks = store.listTasks({ collectionId: documentCollection.id });
    assert.equal(documentTasks.length, documentFiles.length, `not every supported document was imported: ${documentResult.items.map((item) => `${item.name}=${item.status}${item.error ? `(${item.error})` : ''}`).join(', ')}`);
    assert(documentTasks.every((item) => item.status === 'done' && fs.existsSync(item.outputMarkdown)), 'imported documents were not immediately knowledge eligible');
    const markdownTask = documentTasks.find((item) => item.originalFileName === 'guide.md');
    const spreadsheetTask = documentTasks.find((item) => item.originalFileName === 'sheet.xlsx');
    assert(/assets\/image\.png/.test(fs.readFileSync(markdownTask.outputMarkdown, 'utf8')), 'Markdown image dependency was not rewritten into managed assets');
    assert(/工作簿内嵌图片/.test(fs.readFileSync(spreadsheetTask.outputMarkdown, 'utf8')), 'spreadsheet embedded image was not indexed');
    const rag = new RagAssistant({ store, workspaceRoot: workspace.root, encryptSecret: (value) => value, decryptSecret: (value) => value, emit: () => {} });
    const catalog = rag.knowledgeCatalog().find((item) => item.id === documentCollection.id);
    assert(catalog?.kindInfo?.code === 'multimodal-document' && catalog.documentCount === documentFiles.length, 'RAG catalog did not expose the multimodal collection type');
    assert(rag.knowledgeDocumentImages(markdownTask).length === 1, 'RAG could not read the imported Markdown image');
    const spreadsheetImages = rag.knowledgeDocumentImages(spreadsheetTask);
    assert(spreadsheetImages.length === 1, `RAG could not read the imported spreadsheet image: ${fs.readFileSync(spreadsheetTask.outputMarkdown, 'utf8')}`);

    const documentPreview = manager.previewDocumentImport(documentSelection.id, { collectionId: documentCollection.id });
    assert(documentPreview.files.every((item) => item.existing), 'document collision preview did not detect same-name same-format files');
    const skipChoices = Object.fromEntries(documentSelection.files.map((item) => [item.id, 'skip']));
    const skippedDocumentsJob = manager.startDocumentImport(documentSelection.id, { collectionId: documentCollection.id, choices: skipChoices });
    const skippedDocuments = await waitForJob(manager, store, skippedDocumentsJob.id);
    assert(skippedDocuments.items.every((item) => item.status === 'skipped') && store.listTasks({ collectionId: documentCollection.id }).length === documentFiles.length, 'document skip policy changed existing knowledge records');

    const blockedRunner = new BlockingUtilityRunner();
    const interruptedManager = new LocalToolboxManager({ store, toolRunner: blockedRunner, videoCacheManager: videoCache });
    const interruptedSelection = await interruptedManager.inspectVideoSelection([sourceVideo]);
    const interruptedJob = interruptedManager.startVideoImport(interruptedSelection.id, { collectionName: '中断回滚测试', choices: {} });
    await waitUntil(() => interruptedManager.running.has(interruptedJob.id));
    interruptedManager.cancel(interruptedJob.id);
    const interrupted = await waitForJob(interruptedManager, store, interruptedJob.id);
    assert.equal(interrupted.status, 'cancelled');
    assert(interrupted.items.every((item) => item.status === 'cancelled'), 'unfinished items retained a running state after cancellation');
    assert.equal(store.listVideoCaches({ collectionId: interruptedJob.collectionId }).length, 0, 'cancelled current item left a cache record behind');
    assert(fs.existsSync(sourceVideo), 'cancellation removed the original local video');

    store.set('localToolJobs', 'startup-interrupted-fixture', {
      id: 'startup-interrupted-fixture', status: 'running', items: [
        { id: 'done', status: 'completed', phase: 'done' },
        { id: 'active', status: 'running', phase: 'running' }
      ], createdAt: new Date().toISOString()
    });
    store.commit();
    const recoveryManager = new LocalToolboxManager({ store, toolRunner: runner, videoCacheManager: videoCache });
    recoveryManager.initialize();
    const recovered = store.get('localToolJobs', 'startup-interrupted-fixture');
    assert(recovered.status === 'interrupted' && recovered.items[0].status === 'completed' && recovered.items[1].status === 'interrupted', 'startup recovery did not preserve completed items and roll back unfinished items');

    manager.shutdown();
    console.log('local toolbox integration test passed');
  } finally {
    if (process.env.KEEP_LOCAL_TOOLBOX_TEST_CACHE !== '1') fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

class FakeUtilityRunner {
  constructor() { this.pools = []; }

  scheduleUtilityStage(options) {
    this.pools.push(options.pool);
    let cancelled = false;
    let rejectPromise = null;
    const promise = new Promise((resolve, reject) => {
      rejectPromise = reject;
      setImmediate(async () => {
        if (cancelled) return;
        try {
          options.onStart?.({ pool: options.pool, lane: `${options.pool}-test` });
          resolve(await options.execute({ id: `${options.pool}-test` }));
        } catch (error) { reject(error); }
      });
    });
    return {
      id: options.id,
      promise,
      cancel: () => {
        if (cancelled) return false;
        cancelled = true;
        options.cancel?.();
        const error = new Error('cancelled');
        error.code = 'SCHEDULER_CANCELLED';
        rejectPromise(error);
        return true;
      }
    };
  }

  transcribePreparedAudio(options) {
    this.pools.push('asr');
    let settled = false;
    let rejectPromise = null;
    const promise = new Promise((resolve, reject) => {
      rejectPromise = reject;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        fs.mkdirSync(options.outputDir, { recursive: true });
        const payload = { language: 'zh', segments: [{ start: 0.2, end: 1.2, text: '本地字幕测试' }] };
        fs.writeFileSync(path.join(options.outputDir, 'asr-result.json'), JSON.stringify(payload), 'utf8');
        options.onProgress?.({ progress: 1, audioSeconds: 1.2, totalSeconds: 1.2 });
        resolve(payload);
      }, 20);
      options.signal?.addEventListener?.('abort', () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        const error = new Error('cancelled');
        error.code = 'SCHEDULER_CANCELLED';
        reject(error);
      }, { once: true });
    });
    return {
      id: options.id,
      promise,
      cancel: () => {
        if (settled) return false;
        settled = true;
        const error = new Error('cancelled');
        error.code = 'SCHEDULER_CANCELLED';
        rejectPromise(error);
        return true;
      }
    };
  }
}

class BlockingUtilityRunner {
  scheduleUtilityStage(options) {
    let rejectPromise;
    let cancelled = false;
    const promise = new Promise((_resolve, reject) => { rejectPromise = reject; });
    return {
      id: options.id,
      promise,
      cancel: () => {
        if (cancelled) return false;
        cancelled = true;
        options.cancel?.();
        const error = new Error('cancelled');
        error.code = 'SCHEDULER_CANCELLED';
        rejectPromise(error);
        return true;
      }
    };
  }
}

async function createTestVideo(target) {
  await runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x4f7cff:s=360x640:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', target
  ], { timeoutMs: 120000 });
}

async function createDocumentFixtures(root) {
  fs.mkdirSync(root, { recursive: true });
  const image = path.join(root, 'image.png');
  fs.writeFileSync(image, PNG);
  const markdown = path.join(root, 'guide.md');
  fs.writeFileSync(markdown, '# 本地指南\n\n![依赖图片][hero]\n\n[hero]: image.png\n', 'utf8');
  const text = path.join(root, 'notes.txt');
  fs.writeFileSync(text, '本地文本知识库。', 'utf8');
  const pdf = path.join(root, 'sample.pdf');
  fs.writeFileSync(pdf, makePdf('Local PDF knowledge'));
  const docx = path.join(root, 'word.docx');
  await writeZip(docx, {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Word 本地知识</w:t></w:r></w:p></w:body></w:document>'
  });
  const pptx = path.join(root, 'slides.pptx');
  await writeZip(pptx, {
    'ppt/slides/slide1.xml': '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><a:t>PPT 本地知识</a:t></p:cSld></p:sld>',
    'ppt/media/image1.png': PNG
  });
  const xlsx = path.join(root, 'sheet.xlsx');
  await writeZip(xlsx, {
    'xl/sharedStrings.xml': '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Excel 本地知识</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>',
    'xl/media/image1.png': PNG
  });
  return [image, markdown, text, pdf, docx, pptx, xlsx];
}

async function writeZip(target, entries) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  fs.writeFileSync(target, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

function makePdf(text) {
  const escaped = String(text).replace(/[()\\]/g, '\\$&');
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const eol = '\r\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>${eol}stream${eol}${stream}${eol}endstream`
  ];
  let output = `%PDF-1.4${eol}%\xE2\xE3\xCF\xD3${eol}`;
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output, 'binary'));
    output += `${index + 1} 0 obj${eol}${object}${eol}endobj${eol}`;
  });
  const xref = Buffer.byteLength(output, 'binary');
  output += `xref${eol}0 ${objects.length + 1}${eol}0000000000 65535 f${eol}`;
  output += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n${eol}`).join('');
  output += `trailer${eol}<< /Size ${objects.length + 1} /Root 1 0 R >>${eol}startxref${eol}${xref}${eol}%%EOF${eol}`;
  return Buffer.from(output, 'binary');
}

async function verifyLocalAgentSkipsBilibili(task, record, collection) {
  const runner = Object.create(ToolRunner.prototype);
  let apiStages = 0;
  let mediaStages = 0;
  let asrStages = 0;
  runner.buildArgs = () => [];
  runner.appendLog = () => {};
  runner.runScheduledStage = async () => { apiStages += 1; };
  runner.runCommandStage = async (_state, pool) => { assert.equal(pool, 'media'); mediaStages += 1; };
  runner.runAsrStage = async () => { asrStages += 1; };
  runner.finalizeBundleManifest = () => {};
  await runner.executeBundle({ warnings: [] }, { id: 'local-agent-run', artifactDir: record.artifactDir, options: {} }, { ...task, localImported: true, sourceType: 'local-video' }, { action: 'bundle' }, collection);
  assert.equal(apiStages, 0, 'local imported video attempted a Bilibili API stage');
  assert.equal(mediaStages, 1);
  assert.equal(asrStages, 1);
}

async function waitForJob(manager, store, id, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = store.get('localToolJobs', id);
    if (job && TERMINAL.has(job.status) && !manager.running.has(id)) return job;
    await delay(25);
  }
  throw new Error(`timed out waiting for local toolbox job ${id}`);
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('timed out waiting for condition');
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
