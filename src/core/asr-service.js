const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { PROJECT_ROOT } = require('./workspace');

class AsrService {
  constructor({ id, device, computeType, model = 'medium', onEvent, onLog }) {
    this.id = id;
    this.device = device;
    this.computeType = computeType;
    this.model = model;
    this.onEvent = onEvent || (() => {});
    this.onLog = onLog || (() => {});
    this.child = null;
    this.ready = false;
    this.startPromise = null;
    this.pending = new Map();
    this.currentRequestId = '';
    this.lastError = '';
    this.startedAt = '';
    this.readyAt = '';
    this.loadMs = 0;
    this.consecutiveFailures = 0;
    this.restartNotBefore = 0;
    this.intentionalStop = false;
    this.lastExitCode = null;
  }

  async start() {
    if (this.ready && this.child) return this.status();
    if (this.startPromise) return this.startPromise;
    const retryAfterMs = Math.max(0, this.restartNotBefore - Date.now());
    if (retryAfterMs > 0) {
      const error = new Error(`${this.lastError || 'ASR service failed.'} Retry in ${Math.ceil(retryAfterMs / 1000)}s.`);
      error.retryAfterMs = retryAfterMs;
      return Promise.reject(error);
    }
    this.startPromise = this.spawnService().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  spawnService() {
    const python = findRuntimePython();
    const script = path.join(PROJECT_ROOT, 'tools', 'faster-whisper-service.py');
    if (!fs.existsSync(python)) return Promise.reject(new Error(`ASR Python is missing: ${python}`));
    if (!fs.existsSync(script)) return Promise.reject(new Error(`ASR service is missing: ${script}`));
    this.startedAt = new Date().toISOString();
    this.lastError = '';
    this.intentionalStop = false;

    return new Promise((resolve, reject) => {
      let settled = false;
      const child = spawn(python, [script, '--device', this.device, '--compute-type', this.computeType, '--model', this.model], {
        cwd: PROJECT_ROOT,
        windowsHide: true,
        env: serviceEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe']
      });
      this.child = child;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.lastError = 'ASR service startup timed out.';
        child.kill('SIGTERM');
        reject(new Error(this.lastError));
      }, 120000);

      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        let message;
        try { message = JSON.parse(line); } catch { this.onLog(this.id, line); return; }
        if (message.event === 'ready') {
          this.ready = true;
          this.readyAt = new Date().toISOString();
          this.loadMs = Number(message.loadMs || 0);
          this.consecutiveFailures = 0;
          this.restartNotBefore = 0;
          this.lastExitCode = null;
          this.lastError = '';
          this.onEvent({ type: 'asr-service-ready', serviceId: this.id, device: this.device, loadMs: this.loadMs });
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            resolve(this.status());
          }
          return;
        }
        if (message.event === 'fatal') {
          this.lastError = message.error || 'ASR service failed.';
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error(this.lastError));
          }
          return;
        }
        const requestId = String(message.id || '');
        const pending = this.pending.get(requestId);
        if (!pending) return;
        if (message.event === 'progress') {
          pending.onProgress?.(message);
          this.onEvent({ type: 'asr-progress', serviceId: this.id, device: this.device, ...message });
          return;
        }
        this.pending.delete(requestId);
        this.currentRequestId = '';
        message.ok ? pending.resolve(message) : pending.reject(new Error(message.error || 'ASR request failed.'));
      });
      child.stderr.on('data', (chunk) => {
        const message = String(chunk).trim();
        if (message && !this.ready) this.lastError = message.slice(-2000);
        this.onLog(this.id, String(chunk));
      });
      child.on('error', (error) => {
        this.lastError = error.message;
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
      });
      child.on('close', (code, signal) => {
        clearTimeout(timeout);
        this.ready = false;
        this.child = null;
        const intentionallyStopped = this.intentionalStop;
        this.intentionalStop = false;
        this.lastExitCode = code;
        const error = new Error(this.lastError || `ASR service exited: code=${code} signal=${signal || ''}`);
        if (!intentionallyStopped && code !== 0) {
          this.lastError = error.message;
          this.consecutiveFailures += 1;
          const delay = Math.min(60000, 5000 * (2 ** Math.min(4, this.consecutiveFailures - 1)));
          this.restartNotBefore = Date.now() + delay;
        }
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        this.currentRequestId = '';
        this.onEvent({
          type: 'asr-service-stopped',
          serviceId: this.id,
          device: this.device,
          exitCode: code,
          signal: signal || '',
          error: this.lastError,
          retryAfterMs: Math.max(0, this.restartNotBefore - Date.now())
        });
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
    });
  }

  async request(payload, { onProgress } = {}) {
    await this.start();
    const requestId = String(payload.id);
    if (!requestId) throw new Error('ASR request id is required.');
    if (this.currentRequestId) throw new Error(`${this.id} is already processing ${this.currentRequestId}`);
    this.currentRequestId = requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, onProgress });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        this.pending.delete(requestId);
        this.currentRequestId = '';
        reject(error);
      });
    });
  }

  cancel(requestId) {
    if (!this.child || this.currentRequestId !== String(requestId)) return false;
    this.lastError = `ASR request cancelled: ${requestId}`;
    this.intentionalStop = true;
    this.child.kill('SIGTERM');
    return true;
  }

  stop() {
    if (!this.child) return;
    this.intentionalStop = true;
    try { this.child.stdin.write(`${JSON.stringify({ id: `shutdown-${Date.now()}`, action: 'shutdown' })}\n`); } catch {}
    const child = this.child;
    setTimeout(() => { if (this.child === child) child.kill('SIGTERM'); }, 1500);
  }

  status() {
    return {
      id: this.id,
      device: this.device,
      computeType: this.computeType,
      model: this.model,
      state: this.ready ? (this.currentRequestId ? 'busy' : 'ready') : (this.child ? 'starting' : 'stopped'),
      currentRequestId: this.currentRequestId,
      pid: this.child?.pid || null,
      startedAt: this.startedAt,
      readyAt: this.readyAt,
      loadMs: this.loadMs,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
      restartAfter: this.restartNotBefore ? new Date(this.restartNotBefore).toISOString() : '',
      lastExitCode: this.lastExitCode
    };
  }
}

function findRuntimePython() {
  const root = path.join(PROJECT_ROOT, 'runtime', 'python');
  if (!fs.existsSync(root)) return '';
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    const executable = path.join(root, item.name, process.platform === 'win32' ? 'python.exe' : 'bin/python');
    if (fs.existsSync(executable)) return executable;
  }
  return '';
}

function serviceEnvironment() {
  const venv = path.join(PROJECT_ROOT, 'runtime', 'faster-whisper');
  const vcRuntime = path.join(PROJECT_ROOT, 'runtime', 'vc-runtime');
  const sitePackages = process.platform === 'win32'
    ? path.join(venv, 'Lib', 'site-packages')
    : path.join(venv, 'lib', 'python3', 'site-packages');
  return {
    ...process.env,
    VIRTUAL_ENV: venv,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONPATH: [sitePackages, process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter),
    PATH: [vcRuntime, path.join(venv, process.platform === 'win32' ? 'Scripts' : 'bin'), process.env.PATH || ''].filter((item) => item && fs.existsSync(item)).join(path.delimiter)
  };
}

module.exports = { AsrService };
