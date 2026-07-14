const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { favoriteStatus } = require('./collection-state');
const { detectRasterImage } = require('./image-clipboard');
const { assertInside } = require('./workspace');

const MAX_MARKDOWN_BYTES = 16 * 1024 * 1024;
const MAX_ASSET_BYTES = 15 * 1024 * 1024;
const MAX_SEARCH_BYTES = 128 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = 100;

class KnowledgeApi {
  constructor({ store }) {
    this.store = store;
    this.cache = new Map();
  }

  manifest(baseUrl) {
    const base = String(baseUrl || '').replace(/\/$/, '');
    return {
      product: '星藏家',
      protocolVersion: '3.0',
      mode: 'knowledge-read-only',
      baseUrl: base,
      access: {
        binding: '127.0.0.1 only',
        scope: 'all completed Markdown documents',
        authentication: 'none for local callers',
        videoWorkflowApi: false,
        readOnly: true
      },
      errors: {
        format: { error: 'human-readable message', code: 'stable-machine-code' },
        legacyVideoWorkflow: { status: 410, code: 'EXTERNAL_VIDEO_WORKFLOW_DISABLED' },
        missingDocument: { status: 404, code: 'KNOWLEDGE_DOCUMENT_NOT_FOUND' },
        invalidManagedArtifact: { status: 409, code: 'KNOWLEDGE_ARTIFACT_INVALID' }
      },
      recommendedFlow: [
        'Read this manifest first.',
        'List the catalog or paginated document directory and filter by user, collection, BV, title, owner, tag, or date metadata.',
        'Read one selected document in bounded line pages. Follow nextStartLine until null when the complete source is required.',
        'List document assets before requesting an image. Asset identifiers are opaque and document-scoped.',
        'Use search only as a convenience index. Treat exact Markdown reads as the source of truth and cite document title, BV, and collection.'
      ],
      endpoints: [
        { method: 'GET', path: '/api/manifest', purpose: 'Return this complete read-only knowledge protocol.' },
        { method: 'GET', path: '/api/knowledge/catalog', purpose: 'Return users, collections, document counts, dates, and catalog totals.' },
        { method: 'GET', path: '/api/knowledge/documents?offset=0&limit=100', purpose: 'Return a paginated document directory and metadata.', filters: ['userId', 'collectionId', 'bvid', 'title', 'owner', 'tag', 'publishedFrom', 'publishedTo', 'favoriteFrom', 'favoriteTo', 'sort'] },
        { method: 'GET', path: '/api/knowledge/documents/<documentId>', purpose: 'Return one document metadata record and related endpoint URLs.' },
        { method: 'GET', path: '/api/knowledge/documents/<documentId>/content?startLine=1&lineCount=400', purpose: 'Read exact raw Markdown by 1-based line pages.' },
        { method: 'GET', path: '/api/knowledge/documents/<documentId>/assets', purpose: 'List validated local raster assets for the document.' },
        { method: 'GET', path: '/api/knowledge/documents/<documentId>/assets/<assetId>', purpose: 'Read one validated raster asset as binary image data.' },
        { method: 'GET', path: '/api/knowledge/search?q=<query>&limit=20', purpose: 'Search metadata and Markdown content with bounded scanning.', filters: ['userId', 'collectionId', 'bvid', 'tag'] }
      ],
      catalogUrl: `${base}/api/knowledge/catalog`,
      documentsUrl: `${base}/api/knowledge/documents`,
      searchUrl: `${base}/api/knowledge/search?q=<query>`
    };
  }

  catalog(baseUrl) {
    const documents = this.records(baseUrl);
    const users = new Map();
    const collections = new Map();
    for (const document of documents) {
      const userKey = String(document.user.id || document.user.name || 'unknown-user');
      if (!users.has(userKey)) users.set(userKey, { ...document.user, documentCount: 0, collectionCount: 0, latestCompletedAt: '' });
      const user = users.get(userKey);
      user.documentCount += 1;
      user.latestCompletedAt = latestIso(user.latestCompletedAt, document.completedAt);
      if (!collections.has(document.collection.id)) {
        collections.set(document.collection.id, {
          ...document.collection,
          user: document.user,
          documentCount: 0,
          latestCompletedAt: '',
          latestPublishedAt: '',
          latestFavoriteAddedAt: ''
        });
        user.collectionCount += 1;
      }
      const collection = collections.get(document.collection.id);
      collection.documentCount += 1;
      collection.latestCompletedAt = latestIso(collection.latestCompletedAt, document.completedAt);
      collection.latestPublishedAt = latestIso(collection.latestPublishedAt, document.publishedAt);
      collection.latestFavoriteAddedAt = latestIso(collection.latestFavoriteAddedAt, document.favoriteAddedAt);
    }
    return {
      scope: 'all-completed-documents',
      generatedAt: new Date().toISOString(),
      totals: { users: users.size, collections: collections.size, documents: documents.length },
      users: [...users.values()].sort(byName),
      collections: [...collections.values()].sort(byName),
      documentsUrl: `${baseUrl}/api/knowledge/documents`
    };
  }

  listDocuments(params, baseUrl) {
    const offset = boundedInteger(params.get('offset'), 0, 1_000_000, 0);
    const limit = boundedInteger(params.get('limit'), 1, 500, DEFAULT_PAGE_SIZE);
    const all = this.filterRecords(this.records(baseUrl), params);
    const documents = all.slice(offset, offset + limit);
    return {
      scope: 'all-completed-documents',
      total: all.length,
      offset,
      limit,
      nextOffset: offset + documents.length < all.length ? offset + documents.length : null,
      documents
    };
  }

  document(documentId, baseUrl) {
    const task = this.requireTask(documentId);
    return this.record(task, baseUrl, true);
  }

  readContent(documentId, params, baseUrl) {
    const task = this.requireTask(documentId);
    const source = this.readMarkdown(task);
    const requestedStartLine = positiveInteger(params.get('startLine'), 1);
    if (requestedStartLine > source.lines.length + 1) throw knowledgeError(416, 'KNOWLEDGE_LINE_RANGE_INVALID', `startLine exceeds the document range of ${source.lines.length} lines.`);
    const startLine = requestedStartLine;
    const lineCount = boundedInteger(params.get('lineCount'), 1, 1000, 400);
    const startIndex = startLine - 1;
    const selected = source.lines.slice(startIndex, startIndex + lineCount);
    const nextStartLine = startIndex + selected.length < source.lines.length ? startIndex + selected.length + 1 : null;
    return {
      document: this.record(task, baseUrl, false),
      format: 'text/markdown; charset=utf-8',
      exactSource: true,
      startLine,
      endLine: selected.length ? startLine + selected.length - 1 : startLine - 1,
      lineCount: selected.length,
      totalLines: source.lines.length,
      nextStartLine,
      sha256: source.sha256,
      content: selected.join('\n')
    };
  }

  listAssets(documentId, baseUrl) {
    const task = this.requireTask(documentId);
    return {
      document: this.record(task, baseUrl, false),
      assets: this.assets(task, baseUrl)
    };
  }

  readAsset(documentId, assetId) {
    const task = this.requireTask(documentId);
    const root = this.artifactRoot(task);
    let relative;
    try { relative = Buffer.from(String(assetId || ''), 'base64url').toString('utf8'); }
    catch { throw knowledgeError(400, 'KNOWLEDGE_ASSET_ID_INVALID', 'Invalid asset identifier.'); }
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..') || assetIdFor(relative) !== String(assetId || '')) {
      throw knowledgeError(400, 'KNOWLEDGE_ASSET_ID_INVALID', 'Invalid asset identifier.');
    }
    const file = this.validateAsset(root, path.resolve(root, relative));
    try {
      return {
        buffer: fs.readFileSync(file.path),
        mimeType: file.mimeType,
        filename: path.basename(file.path),
        etag: `"${crypto.createHash('sha256').update(`${file.stat.size}:${file.stat.mtimeMs}:${relative}`).digest('hex')}"`
      };
    } catch {
      throw knowledgeError(404, 'KNOWLEDGE_ASSET_NOT_FOUND', 'Knowledge asset disappeared before it could be read. Refresh the asset list.');
    }
  }

  search(params, baseUrl) {
    const query = String(params.get('q') || '').trim();
    if (!query) throw knowledgeError(400, 'KNOWLEDGE_QUERY_REQUIRED', 'q is required.');
    const limit = boundedInteger(params.get('limit'), 1, 100, 20);
    const terms = queryTerms(query);
    if (!terms.length) throw knowledgeError(400, 'KNOWLEDGE_QUERY_INVALID', 'q must contain at least one letter, number, or CJK character.');
    const candidates = this.filterRecords(this.records(baseUrl), params, { ignoreTextFilters: true });
    const results = [];
    let scannedBytes = 0;
    let scannedDocuments = 0;
    let skippedDocuments = 0;
    let partial = false;
    for (const metadata of candidates) {
      let source;
      try { source = this.readMarkdown(this.requireTask(metadata.id)); }
      catch { skippedDocuments += 1; continue; }
      if (scannedBytes + source.bytes > MAX_SEARCH_BYTES) { partial = true; break; }
      scannedBytes += source.bytes;
      scannedDocuments += 1;
      const metadataText = `${metadata.title} ${metadata.bvid} ${metadata.owner} ${metadata.collection.name} ${(metadata.tags || []).join(' ')}`.toLocaleLowerCase();
      const body = source.text.toLocaleLowerCase();
      const metadataHits = terms.reduce((sum, term) => sum + countOccurrences(metadataText, term) * 8, 0);
      const bodyHits = terms.reduce((sum, term) => sum + Math.min(30, countOccurrences(body, term)), 0);
      const score = metadataHits + bodyHits;
      if (!score) continue;
      results.push({ ...metadata, score, snippet: matchedSnippet(source.text, terms) });
    }
    results.sort((left, right) => right.score - left.score || String(right.completedAt || '').localeCompare(String(left.completedAt || '')));
    return { query, totalMatches: results.length, limit, candidateDocuments: candidates.length, scannedDocuments, skippedDocuments, scannedBytes, partial, partialReason: partial ? `Search scan reached the ${MAX_SEARCH_BYTES / 1024 / 1024} MiB safety budget. Use catalog filters or exact document reads for the remaining corpus.` : '', results: results.slice(0, limit) };
  }

  filterRecords(records, params, options = {}) {
    const textFilters = options.ignoreTextFilters ? {} : {
      title: String(params.get('title') || '').trim().toLocaleLowerCase(),
      owner: String(params.get('owner') || '').trim().toLocaleLowerCase()
    };
    const exact = {
      userId: String(params.get('userId') || ''),
      collectionId: String(params.get('collectionId') || ''),
      bvid: String(params.get('bvid') || '').toLocaleLowerCase(),
      tag: String(params.get('tag') || '').toLocaleLowerCase()
    };
    const publishedFrom = dateBound(params.get('publishedFrom'), false, 'publishedFrom');
    const publishedTo = dateBound(params.get('publishedTo'), true, 'publishedTo');
    const favoriteFrom = dateBound(params.get('favoriteFrom'), false, 'favoriteFrom');
    const favoriteTo = dateBound(params.get('favoriteTo'), true, 'favoriteTo');
    if (publishedFrom > publishedTo || favoriteFrom > favoriteTo) throw knowledgeError(400, 'KNOWLEDGE_DATE_RANGE_INVALID', 'A date range start cannot be later than its end.');
    const filtered = records.filter((item) => (
      (!exact.userId || item.user.id === exact.userId)
      && (!exact.collectionId || item.collection.id === exact.collectionId)
      && (!exact.bvid || item.bvid.toLocaleLowerCase() === exact.bvid)
      && (!exact.tag || (item.tags || []).some((tag) => String(tag).toLocaleLowerCase().includes(exact.tag)))
      && (!textFilters.title || item.title.toLocaleLowerCase().includes(textFilters.title))
      && (!textFilters.owner || item.owner.toLocaleLowerCase().includes(textFilters.owner))
      && dateWithin(item.publishedAt, publishedFrom, publishedTo)
      && dateWithin(item.favoriteAddedAt, favoriteFrom, favoriteTo)
    ));
    const [field, direction = 'desc'] = String(params.get('sort') || 'completed-desc').split('-');
    const key = field === 'published' ? 'publishedAt' : field === 'favorite' ? 'favoriteAddedAt' : 'completedAt';
    const multiplier = direction === 'asc' ? 1 : -1;
    return filtered.sort((left, right) => multiplier * ((Date.parse(left[key] || '') || 0) - (Date.parse(right[key] || '') || 0)) || left.title.localeCompare(right.title, 'zh-Hans-CN'));
  }

  records(baseUrl) {
    return this.store.listTasks().filter((task) => this.isCompleted(task)).map((task) => this.record(task, baseUrl, false));
  }

  record(task, baseUrl, includeStats) {
    const collection = this.store.getCollectionById(task.collectionId) || {};
    const user = this.store.get('users', String(collection.userId || '')) || {};
    const status = favoriteStatus(task, collection);
    const metadata = {
      id: task.id,
      bvid: String(task.bvid || ''),
      title: String(task.title || task.bvid || '未命名视频'),
      owner: String(task.owner || ''),
      url: task.bvid ? `https://www.bilibili.com/video/${task.bvid}` : String(task.url || ''),
      duration: Number(task.duration || 0),
      tags: Array.isArray(task.tags) ? task.tags : [],
      publishedAt: task.publishedAt || '',
      favoriteAddedAt: task.favoriteAddedAt || '',
      completedAt: task.completedAt || '',
      favoriteMembership: status,
      singleTask: task.singleTask === true,
      user: { id: String(collection.userId || user.id || ''), name: String(collection.userName || user.name || '') },
      collection: { id: String(collection.id || task.collectionId || ''), name: String(collection.name || ''), internal: collection.internal === true, deletedOnBilibili: collection.biliDeleted === true },
      endpoints: {
        metadata: `${baseUrl}/api/knowledge/documents/${encodeURIComponent(task.id)}`,
        content: `${baseUrl}/api/knowledge/documents/${encodeURIComponent(task.id)}/content`,
        assets: `${baseUrl}/api/knowledge/documents/${encodeURIComponent(task.id)}/assets`
      }
    };
    if (!includeStats) return metadata;
    const source = this.readMarkdown(task);
    return { ...metadata, markdown: { bytes: source.bytes, lines: source.lines.length, sha256: source.sha256, modifiedAt: source.modifiedAt }, assetCount: this.assets(task, baseUrl).length };
  }

  requireTask(documentId) {
    const task = this.store.getTask(String(documentId || ''));
    if (!task || !this.isCompleted(task)) throw knowledgeError(404, 'KNOWLEDGE_DOCUMENT_NOT_FOUND', `Knowledge document not found: ${documentId}`);
    return task;
  }

  isCompleted(task) {
    return task?.status === 'done' && Boolean(task.outputMarkdown) && fs.existsSync(task.outputMarkdown);
  }

  readMarkdown(task) {
    const file = this.validateMarkdown(task);
    const stat = fs.statSync(file);
    const key = `${stat.size}:${stat.mtimeMs}`;
    const cached = this.cache.get(task.id);
    if (cached?.key === key) return cached.value;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch { throw knowledgeError(409, 'KNOWLEDGE_DOCUMENT_INVALID', 'The Markdown source became unreadable. Refresh the document directory.'); }
    const value = { text, lines: text.split(/\r?\n/), bytes: stat.size, modifiedAt: stat.mtime.toISOString(), sha256: crypto.createHash('sha256').update(text).digest('hex') };
    this.cache.set(task.id, { key, value });
    return value;
  }

  validateMarkdown(task) {
    const root = this.artifactRoot(task);
    try {
      const candidate = assertInside(root, task.outputMarkdown);
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) throw knowledgeError(409, 'KNOWLEDGE_DOCUMENT_INVALID', 'The Markdown source is not a regular managed file.');
      const real = fs.realpathSync(candidate);
      assertInside(fs.realpathSync(root), real);
      if (stat.size > MAX_MARKDOWN_BYTES) throw knowledgeError(413, 'KNOWLEDGE_DOCUMENT_TOO_LARGE', 'The Markdown source exceeds the 16 MiB read limit.');
      return real;
    } catch (error) {
      if (error?.code?.startsWith?.('KNOWLEDGE_')) throw error;
      throw knowledgeError(409, 'KNOWLEDGE_DOCUMENT_INVALID', 'The Markdown source is missing, unreadable, or outside its managed artifact directory.');
    }
  }

  artifactRoot(task) {
    try {
      const root = path.resolve(task.artifactDir || path.dirname(task.outputMarkdown || '.'));
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw knowledgeError(409, 'KNOWLEDGE_ARTIFACT_MISSING', 'The document artifact directory is missing.');
      const realRoot = fs.realpathSync(root);
      const managed = (this.store.listWorkspaces?.() || []).some((workspace) => {
        try { assertInside(fs.realpathSync(path.resolve(workspace.root)), realRoot); return true; }
        catch { return false; }
      });
      if (!managed) throw knowledgeError(409, 'KNOWLEDGE_ARTIFACT_INVALID', 'The document is not inside a registered Workspace library.');
      return realRoot;
    } catch (error) {
      if (error?.code?.startsWith?.('KNOWLEDGE_')) throw error;
      throw knowledgeError(409, 'KNOWLEDGE_ARTIFACT_INVALID', 'The managed artifact directory is missing, unreadable, or invalid.');
    }
  }

  assets(task, baseUrl) {
    const root = this.artifactRoot(task);
    const files = [];
    try { walkFiles(root, root, files, 300); }
    catch { return []; }
    return files.map((file) => {
      try { return this.validateAsset(root, file); } catch { return null; }
    }).filter(Boolean).map(({ path: file, stat, mimeType }) => {
      const relativePath = path.relative(root, file).split(path.sep).join('/');
      const id = assetIdFor(relativePath);
      return { id, relativePath, filename: path.basename(file), mimeType, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), url: `${baseUrl}/api/knowledge/documents/${encodeURIComponent(task.id)}/assets/${encodeURIComponent(id)}` };
    });
  }

  validateAsset(root, candidate) {
    let fd;
    try {
      const resolved = assertInside(root, candidate);
      const stat = fs.lstatSync(resolved);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_ASSET_BYTES) throw knowledgeError(404, 'KNOWLEDGE_ASSET_NOT_FOUND', 'Knowledge asset not found.');
      const real = fs.realpathSync(resolved);
      assertInside(fs.realpathSync(root), real);
      fd = fs.openSync(real, 'r');
      const header = Buffer.alloc(Math.min(64, stat.size));
      fs.readSync(fd, header, 0, header.length, 0);
      const mimeType = detectRasterImage(header);
      if (!mimeType) throw knowledgeError(415, 'KNOWLEDGE_ASSET_UNSUPPORTED', 'Only validated PNG, JPEG, GIF, WebP, or AVIF assets are exposed.');
      return { path: real, stat, mimeType };
    } catch (error) {
      if (error?.code?.startsWith?.('KNOWLEDGE_')) throw error;
      throw knowledgeError(404, 'KNOWLEDGE_ASSET_NOT_FOUND', 'Knowledge asset not found or unreadable.');
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    }
  }
}

function walkFiles(root, directory, target, limit) {
  if (target.length >= limit) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (target.length >= limit) break;
    if (entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name);
    assertInside(root, file);
    if (entry.isDirectory()) walkFiles(root, file, target, limit);
    else if (entry.isFile()) target.push(file);
  }
}

function assetIdFor(relativePath) { return Buffer.from(String(relativePath || ''), 'utf8').toString('base64url'); }
function boundedInteger(value, min, max, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback; }
function positiveInteger(value, fallback) { const number = Number(value); return Number.isFinite(number) && number >= 1 ? Math.floor(number) : fallback; }
function latestIso(left, right) { return String(right || '').localeCompare(String(left || '')) > 0 ? String(right || '') : String(left || ''); }
function byName(left, right) { return String(left.name || left.id || '').localeCompare(String(right.name || right.id || ''), 'zh-Hans-CN'); }
function dateBound(value, end, name) { if (!value) return end ? Number.POSITIVE_INFINITY : 0; const parsed = Date.parse(`${value}${/^\d{4}-\d{2}-\d{2}$/.test(value) ? (end ? 'T23:59:59.999' : 'T00:00:00') : ''}`); if (!Number.isFinite(parsed)) throw knowledgeError(400, 'KNOWLEDGE_DATE_FILTER_INVALID', `${name} is not a valid date.`); return parsed; }
function dateWithin(value, from, to) { if (!value) return from === 0 && to === Number.POSITIVE_INFINITY; const time = Date.parse(value); return Number.isFinite(time) && time >= from && time <= to; }
function queryTerms(query) { const lower = String(query || '').toLocaleLowerCase(); const latin = lower.match(/[a-z0-9_+#.-]+/g) || []; const cjk = (lower.match(/[\u3040-\u30ff\u3400-\u9fff]+/g) || []).flatMap((word) => word.length <= 2 ? [word] : Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2))); return [...new Set([...latin, ...cjk])].slice(0, 40); }
function countOccurrences(text, term) { let count = 0; let index = 0; while (term && (index = text.indexOf(term, index)) >= 0) { count += 1; index += term.length; } return count; }
function matchedSnippet(text, terms) { const lower = text.toLocaleLowerCase(); const positions = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0); const center = positions.length ? Math.min(...positions) : 0; const start = Math.max(0, center - 220); const end = Math.min(text.length, start + 700); return `${start ? '...' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '...' : ''}`; }
function knowledgeError(statusCode, code, message) { const error = new Error(message); error.statusCode = statusCode; error.code = code; return error; }

module.exports = { KnowledgeApi, MAX_ASSET_BYTES, MAX_MARKDOWN_BYTES, MAX_SEARCH_BYTES, assetIdFor };
