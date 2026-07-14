const http = require('http');
const { KnowledgeApi } = require('./knowledge-api');
const { isAllowedApiOrigin } = require('./network-policy');

const DISABLED_VIDEO_PREFIXES = [
  '/api/workers',
  '/api/tasks',
  '/api/tools',
  '/api/tool-runs',
  '/api/collections',
  '/api/active-collection',
  '/api/templates/video-summary',
  '/api/scheduler',
  '/api/stats',
  '/api/tool-health'
];

class ApiServer {
  constructor({ store }) {
    this.knowledgeApi = new KnowledgeApi({ store });
    this.server = null;
    this.port = 0;
  }

  async start(preferredPort = 17391) {
    if (this.server) return this.url();
    this.server = http.createServer((req, res) => {
      Promise.resolve(this.route(req, res)).catch((error) => this.sendError(res, error));
    });
    this.server.requestTimeout = 30000;
    this.server.headersTimeout = 15000;
    this.server.keepAliveTimeout = 5000;
    this.server.maxHeadersCount = 100;
    await listenLocal(this.server, preferredPort);
    this.port = Number(this.server.address()?.port || 0);
    return this.url();
  }

  stop() {
    if (!this.server) return;
    this.server.close();
    this.server = null;
    this.port = 0;
  }

  url() {
    return `http://127.0.0.1:${this.port}`;
  }

  async route(req, res) {
    const url = parseRequestUrl(req.url, this.url());
    if (!isAllowedApiOrigin(req.headers.origin, this.url())) {
      throw apiError(403, 'API_ORIGIN_FORBIDDEN', 'Browser cross-origin access to the local knowledge API is forbidden.');
    }
    if (req.method === 'OPTIONS') return this.json(res, { ok: true, readOnly: true });

    if (isDisabledVideoWorkflowPath(url.pathname)) throw disabledVideoWorkflowError();
    if (req.method !== 'GET') throw apiError(405, 'METHOD_NOT_ALLOWED', 'The external knowledge API is read-only and accepts GET requests only.');

    if (['/api', '/api/manifest', '/api/knowledge', '/api/knowledge/manifest'].includes(url.pathname)) {
      return this.json(res, this.knowledgeApi.manifest(this.url()));
    }
    if (url.pathname === '/api/health') {
      return this.json(res, { ok: true, mode: 'knowledge-read-only', protocolVersion: '3.0', url: this.url() });
    }
    if (url.pathname === '/api/knowledge/catalog') {
      return this.json(res, this.knowledgeApi.catalog(this.url()));
    }
    if (url.pathname === '/api/knowledge/documents') {
      return this.json(res, this.knowledgeApi.listDocuments(url.searchParams, this.url()));
    }
    if (url.pathname === '/api/knowledge/search') {
      return this.json(res, this.knowledgeApi.search(url.searchParams, this.url()));
    }

    const assetMatch = url.pathname.match(/^\/api\/knowledge\/documents\/([^/]+)\/assets\/([^/]+)$/);
    if (assetMatch) {
      const documentId = decodePathPart(assetMatch[1]);
      const assetId = decodePathPart(assetMatch[2]);
      return this.sendAsset(req, res, this.knowledgeApi.readAsset(documentId, assetId));
    }

    const documentMatch = url.pathname.match(/^\/api\/knowledge\/documents\/([^/]+)(?:\/(content|assets))?$/);
    if (documentMatch) {
      const documentId = decodePathPart(documentMatch[1]);
      const action = documentMatch[2] || '';
      if (action === 'content') return this.json(res, this.knowledgeApi.readContent(documentId, url.searchParams, this.url()));
      if (action === 'assets') return this.json(res, this.knowledgeApi.listAssets(documentId, this.url()));
      return this.json(res, this.knowledgeApi.document(documentId, this.url()));
    }

    throw apiError(404, 'API_NOT_FOUND', 'Knowledge API endpoint not found. Read GET /api/manifest for the current protocol.');
  }

  sendAsset(req, res, asset) {
    if (String(req.headers['if-none-match'] || '') === asset.etag) {
      res.writeHead(304, securityHeaders({ etag: asset.etag, 'cache-control': 'private, max-age=60' }));
      res.end();
      return;
    }
    res.writeHead(200, securityHeaders({
      'content-type': asset.mimeType,
      'content-length': asset.buffer.length,
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
      'cache-control': 'private, max-age=60',
      etag: asset.etag
    }));
    res.end(asset.buffer);
  }

  json(res, value, status = 200) {
    if (res.headersSent || res.destroyed) return;
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    res.writeHead(status, securityHeaders({
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store'
    }));
    res.end(body);
  }

  sendError(res, error) {
    if (res.headersSent || res.destroyed) {
      if (!res.destroyed) res.destroy();
      return;
    }
    const status = boundedStatus(error?.statusCode);
    this.json(res, {
      error: String(error?.publicMessage || error?.message || 'Knowledge API request failed.'),
      code: String(error?.code || 'KNOWLEDGE_API_ERROR')
    }, status);
  }
}

function listenLocal(server, preferredPort) {
  const port = Number.isInteger(Number(preferredPort)) && Number(preferredPort) >= 0 ? Number(preferredPort) : 17391;
  return new Promise((resolve, reject) => {
    const listen = (targetPort, fallbackAllowed) => {
      const onError = (error) => {
        server.removeListener('listening', onListening);
        if (fallbackAllowed && error?.code === 'EADDRINUSE') return listen(0, false);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(targetPort, '127.0.0.1');
    };
    listen(port, port !== 0);
  });
}

function parseRequestUrl(value, baseUrl) {
  try { return new URL(value || '/', baseUrl); }
  catch { throw apiError(400, 'REQUEST_URL_INVALID', 'Malformed request URL.'); }
}

function decodePathPart(value) {
  try { return decodeURIComponent(String(value || '')); }
  catch { throw apiError(400, 'REQUEST_PATH_INVALID', 'Malformed encoded path parameter.'); }
}

function isDisabledVideoWorkflowPath(pathname) {
  return DISABLED_VIDEO_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function disabledVideoWorkflowError() {
  return apiError(
    410,
    'EXTERNAL_VIDEO_WORKFLOW_DISABLED',
    'External Agent video-summary task, Worker, tool-execution, and submission APIs are disabled. Use the desktop application for video workflows or GET /api/manifest for read-only knowledge access.'
  );
}

function apiError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function boundedStatus(value) {
  const status = Number(value || 500);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

function securityHeaders(extra = {}) {
  return { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...extra };
}

module.exports = { ApiServer, DISABLED_VIDEO_PREFIXES, disabledVideoWorkflowError, isDisabledVideoWorkflowPath };
