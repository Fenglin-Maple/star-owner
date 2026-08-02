const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const { ensureDir, assertInside } = require('./workspace');

const execFileAsync = promisify(execFile);

class GitRuntime {
  constructor({ projectRoot, gitPath = '' } = {}) {
    this.projectRoot = path.resolve(projectRoot || path.join(__dirname, '..', '..'));
    this.gitPath = path.resolve(gitPath || path.join(this.projectRoot, 'runtime', 'git', 'cmd', 'git.exe'));
    this.gitRoot = path.resolve(this.gitPath, '..', '..');
    const bundledRoot = path.resolve(this.projectRoot, 'runtime', 'git');
    if (this.gitRoot.toLowerCase() !== bundledRoot.toLowerCase()) throw new Error('共享功能只能使用项目 runtime/git 中的 Git，拒绝外部 Git 路径。');
    this.gitHome = path.join(this.projectRoot, '.cache', 'shared-git', 'home');
    this.credentialStorePath = path.join(this.gitHome, '.gcm', 'dpapi_store');
  }

  state() {
    return {
      available: fs.existsSync(this.gitPath),
      path: this.gitPath,
      runtimeRoot: this.gitRoot,
      isolated: true,
      credentialScope: 'application-dpapi',
      version: ''
    };
  }

  async describe() {
    const current = this.state();
    if (!current.available) return current;
    try {
      const result = await this.run(['--version']);
      return { ...current, version: result.stdout.trim() };
    } catch (error) {
      return { ...current, available: false, error: sanitizeGitError(error) };
    }
  }

  async assertAvailable() {
    const status = await this.describe();
    if (!status.available) {
      const error = new Error('项目内置 Git 环境不可用，共享上传已停止。请重新下载包含 runtime/git 的完整核心包。');
      error.code = 'SHARED_GIT_UNAVAILABLE';
      throw error;
    }
    return status;
  }

  async run(args, options = {}) {
    const env = createGitEnvironment({
      source: process.env,
      overrides: options.env,
      projectRoot: this.projectRoot,
      gitRoot: this.gitRoot,
      gitHome: this.gitHome
    });
    const result = await execFileAsync(this.gitPath, args, {
      cwd: options.cwd || this.projectRoot,
      env,
      windowsHide: true,
      timeout: Number(options.timeoutMs || 10 * 60 * 1000),
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
      signal: options.signal || undefined
    });
    return { stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
  }

  async withReadOnlyCheckout({ repository, token = '', signal = null, onProgress = null } = {}, callback) {
    if (typeof callback !== 'function') throw new Error('只读 Git 快照缺少处理回调。');
    const owner = String(repository?.owner || '').trim();
    const name = String(repository?.name || '').trim();
    const branch = String(repository?.branch || 'main').trim();
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw new Error('GitHub 共享仓库信息不完整，无法下载只读快照。');
    if (!branch || branch.length > 120 || /(?:\.\.|[~^:?*\[\\\s]|^\/|\/$|\.lock$|\/\.)/.test(branch)) throw new Error('共享仓库分支名称不安全。');
    const report = (stage, progress, message) => { if (typeof onProgress === 'function') onProgress({ stage, progress, message }); };
    let checkout = '';
    let checkoutReady = false;
    try {
      await this.assertAvailable();
      throwIfAborted(signal);
      const workRoot = ensureDir(path.join(this.projectRoot, '.cache', 'shared-git'));
      checkout = fs.mkdtempSync(path.join(workRoot, 'download-'));
      const remoteUrl = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}.git`;
      const gitEnv = String(token || '').trim()
        ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: gitAuthorizationHeader(token) }
        : {};
      report('git-download', 0.04, `正在一次性下载 ${owner}/${name} 的最新只读快照...`);
      await this.run(['-c', 'core.longpaths=true', 'clone', '--depth', '1', '--single-branch', '--no-tags', '--branch', branch, remoteUrl, checkout], {
        cwd: workRoot,
        env: gitEnv,
        signal,
        timeoutMs: 30 * 60 * 1000
      });
      checkoutReady = true;
      report('git-ready', 1, '共享仓库只读快照已下载，正在从本地批量导入所需文档...');
      return await callback({ root: checkout, repository: { owner, name, branch } });
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        const canceled = new Error('项目内置 Git 下载已中止。');
        canceled.name = 'AbortError';
        canceled.code = 'ABORT_ERR';
        throw canceled;
      }
      if (checkoutReady) throw error;
      const wrapped = new Error(`项目内置 Git 下载共享仓库失败：${sanitizeGitError(error)}`);
      wrapped.code = 'SHARED_GIT_CHECKOUT_FAILED';
      throw wrapped;
    } finally {
      if (checkout) await removeCheckout(checkout);
    }
  }

  async commitAndPush({ upstream, fork, baseBranch = 'main', branch, token, files, replaceRoots = [], message, author = null, signal = null, onProgress = null }) {
    await this.assertAvailable();
    if (!upstream?.owner || !upstream?.name || !fork?.owner || !fork?.name) throw new Error('GitHub 共享仓库信息不完整，无法提交。');
    if (!/^[A-Za-z0-9._/-]{1,120}$/.test(String(branch || ''))) throw new Error('共享分支名称不安全。');
    const workRoot = ensureDir(path.join(this.projectRoot, '.cache', 'shared-git'));
    const checkout = fs.mkdtempSync(path.join(workRoot, 'upload-'));
    const remoteUrl = `https://github.com/${encodeURIComponent(upstream.owner)}/${encodeURIComponent(upstream.name)}.git`;
    const forkUrl = `https://github.com/${encodeURIComponent(fork.owner)}/${encodeURIComponent(fork.name)}.git`;
    const gitEnv = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: gitAuthorizationHeader(token)
    };
    const report = (stage, progress, messageText) => { if (typeof onProgress === 'function') onProgress({ stage, progress, message: messageText }); };
    try {
      throwIfAborted(signal);
      report('git-clone', 0.02, '正在读取目标仓库 main 分支...');
      await this.run(['clone', '--depth', '1', '--single-branch', '--branch', String(baseBranch), remoteUrl, checkout], { cwd: workRoot, env: gitEnv, signal });
      report('git-branch', 0.16, '正在创建临时共享分支...');
      await this.run(['checkout', '-b', String(branch)], { cwd: checkout, env: gitEnv, signal });
      for (const root of [...new Set((replaceRoots || []).map(normalizeRelative))]) {
        throwIfAborted(signal);
        const target = assertInside(checkout, path.join(checkout, root));
        if (target !== checkout) fs.rmSync(target, { recursive: true, force: true });
      }
      const written = [];
      const uploadFiles = files || [];
      for (let index = 0; index < uploadFiles.length; index += 1) {
        throwIfAborted(signal);
        const file = uploadFiles[index];
        const relative = normalizeRelative(file.relative);
        const destination = assertInside(checkout, path.join(checkout, relative));
        ensureDir(path.dirname(destination));
        if (file.sourcePath) {
          const source = path.resolve(file.sourcePath);
          const stat = fs.statSync(source);
          if (!stat.isFile()) throw new Error(`共享源文件不是普通文件：${relative}`);
          fs.copyFileSync(source, destination);
        } else {
          fs.writeFileSync(destination, Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer || ''));
        }
        written.push(relative);
        if (index === uploadFiles.length - 1 || index % 10 === 0) report('git-copy', 0.18 + ((index + 1) / Math.max(1, uploadFiles.length)) * 0.5, `正在整理共享文件 ${index + 1} / ${uploadFiles.length}...`);
      }
      if (!written.length) throw new Error('没有可提交的共享文件。');
      report('git-index', 0.7, '正在建立 Git 提交索引...');
      await this.run(['add', '--all'], { cwd: checkout, env: gitEnv, signal });
      const status = await this.run(['status', '--porcelain'], { cwd: checkout, env: gitEnv, signal });
      if (!status.stdout.trim()) {
        const error = new Error('选中的共享文档与仓库当前内容相同，没有需要提交的变更。');
        error.code = 'SHARED_GIT_NO_CHANGES';
        throw error;
      }
      const commitAuthor = normalizeGitAuthor(author);
      report('git-commit', 0.78, '正在创建 Git 提交...');
      await this.run(['-c', `user.name=${commitAuthor.name}`, '-c', `user.email=${commitAuthor.email}`, 'commit', '-m', String(message || 'docs: update shared knowledge')], { cwd: checkout, env: gitEnv, signal });
      const sameRepository = normalizeGitRemote(remoteUrl) === normalizeGitRemote(forkUrl);
      const targetRemote = sameRepository ? 'origin' : 'fork';
      if (!sameRepository) await this.run(['remote', 'add', targetRemote, forkUrl], { cwd: checkout, env: gitEnv, signal });
      report('git-push', 0.84, '正在推送共享分支到 GitHub...');
      await this.run(['push', targetRemote, `HEAD:refs/heads/${String(branch)}`], { cwd: checkout, env: gitEnv, signal, timeoutMs: 30 * 60 * 1000 });
      report('git-pushed', 1, '共享分支已推送。');
      return { branch: String(branch), files: written };
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        const canceled = new Error('项目内置 Git 操作已中止。');
        canceled.name = 'AbortError';
        canceled.code = 'ABORT_ERR';
        throw canceled;
      }
      throw new Error(`项目内置 Git 提交共享文档失败：${sanitizeGitError(error)}`);
    } finally {
      await removeCheckout(checkout);
    }
  }

  async browserLogin() {
    await this.assertAvailable();
    const credentialManager = this.credentialManagerPath();
    if (!fs.existsSync(credentialManager)) throw new Error('项目内置 Git 缺少 Git Credential Manager，无法启动浏览器授权。');
    await this.runCredentialManager(['github', 'login', '--browser', '--force'], { interactive: true, timeoutMs: 10 * 60 * 1000 });
    const credential = await this.readCredential();
    if (!credential.password) throw new Error('浏览器授权完成，但没有从项目内置 Git 凭据环境读取到 GitHub 凭据。');
    return credential;
  }

  clearCredentialStore() {
    const storePath = assertInside(this.gitHome, this.credentialStorePath);
    fs.rmSync(storePath, { recursive: true, force: true });
    return { cleared: true, scope: 'application-dpapi', path: storePath };
  }

  credentialManagerPath() {
    return path.join(this.gitRoot, 'mingw64', 'bin', process.platform === 'win32' ? 'git-credential-manager.exe' : 'git-credential-manager');
  }

  async runCredentialManager(args, { interactive = false, timeoutMs = 10 * 60 * 1000 } = {}) {
    const env = createGitEnvironment({ source: process.env, projectRoot: this.projectRoot, gitRoot: this.gitRoot, gitHome: this.gitHome });
    env.GCM_INTERACTIVE = interactive ? 'Always' : 'Never';
    env.GCM_GUI_PROMPT = interactive ? '1' : '0';
    const helper = this.credentialManagerPath();
    const result = await execFileAsync(helper, args, { cwd: this.projectRoot, env, windowsHide: true, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
    return { stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
  }

  async readCredential() {
    const env = createGitEnvironment({ source: process.env, projectRoot: this.projectRoot, gitRoot: this.gitRoot, gitHome: this.gitHome });
    env.GCM_INTERACTIVE = 'Never';
    env.GCM_GUI_PROMPT = '0';
    const helper = this.credentialManagerPath();
    return new Promise((resolve, reject) => {
      const child = spawn(helper, ['get'], { cwd: this.projectRoot, env, windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code !== 0) return reject(new Error(`读取项目内置 GitHub 凭据失败：${sanitizeGitError({ stderr })}`));
        resolve(parseCredential(stdout));
      });
      child.stdin.end('protocol=https\nhost=github.com\n\n');
    });
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('操作已中止。');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  throw error;
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'ABORTED';
}

async function removeCheckout(directory) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      if (!fs.existsSync(directory)) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
  }
}

function normalizeRelative(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('共享文件路径不安全。');
  return normalized;
}

function sanitizeGitError(error) {
  const message = String(error?.stderr || error?.message || error || '').replace(/Authorization:\s*(?:Bearer|Basic)\s+\S+/gi, 'Authorization: [redacted]');
  return message.slice(0, 800) || '未知 Git 错误';
}

function gitAuthorizationHeader(token) {
  const value = String(token || '').trim();
  if (!value) throw new Error('GitHub Token 不能为空。');
  const encoded = Buffer.from(`x-access-token:${value}`, 'utf8').toString('base64');
  return `Authorization: Basic ${encoded}`;
}

function parseCredential(output) {
  const result = {};
  for (const line of String(output || '').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

function normalizeGitRemote(value) {
  return String(value || '').trim().replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
}

function normalizeGitAuthor(author) {
  const name = String(author?.name || '').trim();
  const email = String(author?.email || '').trim();
  if (/^[^\u0000-\u001f\u007f]{1,80}$/.test(name) && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(email)) return { name, email };
  return { name: 'Star Owner', email: 'star-owner-noreply@users.noreply.github.com' };
}

function createGitEnvironment({ source = process.env, overrides = {}, projectRoot, gitRoot, gitHome } = {}) {
  const base = source || {};
  const env = {};
  const blocked = new Set([
    'path', 'home', 'userprofile', 'homedrive', 'homepath', 'xdg_config_home', 'git_config_global', 'git_config_system',
    'git_config_nosystem', 'git_dir', 'git_work_tree', 'git_index_file', 'git_object_directory', 'git_alternates',
    'git_askpass', 'git_ssh', 'git_ssh_command', 'ssh_auth_sock', 'ssh_agent_pid', 'ssh_askpass', 'gcm_interactive',
    'gcm_credential_provider', 'gcm_credential_store', 'gcm_dpapi_store_path', 'gcm_plaintext_store_path',
    'git_credential_helper', 'git_trace', 'git_trace_packet', 'git_curl_verbose'
  ]);
  for (const [key, value] of Object.entries(base)) {
    const lower = String(key).toLowerCase();
    if (blocked.has(lower) || lower.startsWith('git_config_') || lower === 'node_options') continue;
    env[key] = value;
  }

  const root = path.resolve(projectRoot || process.cwd());
  const resolvedGitRoot = path.resolve(gitRoot || path.join(root, 'runtime', 'git'));
  const resolvedHome = ensureDir(path.resolve(gitHome || path.join(root, '.cache', 'shared-git', 'home')));
  const emptyConfig = path.join(resolvedHome, 'empty.gitconfig');
  if (!fs.existsSync(emptyConfig)) fs.writeFileSync(emptyConfig, '# Project-local Git configuration intentionally starts empty.\n', 'utf8');

  const pathEntries = [
    path.join(resolvedGitRoot, 'cmd'),
    path.join(resolvedGitRoot, 'mingw64', 'bin'),
    path.join(resolvedGitRoot, 'mingw64', 'libexec', 'git-core')
  ];
  const systemRoot = base.SystemRoot || base.WINDIR || env.SystemRoot || env.WINDIR || '';
  if (process.platform === 'win32' && systemRoot) pathEntries.push(path.join(systemRoot, 'System32'));
  env.PATH = [...new Set(pathEntries.filter((item) => fs.existsSync(item)).map((item) => path.resolve(item)))].join(path.delimiter);
  env.GIT_EXEC_PATH = path.join(resolvedGitRoot, 'mingw64', 'libexec', 'git-core');
  env.GIT_CONFIG_GLOBAL = emptyConfig;
  env.GIT_CONFIG_SYSTEM = emptyConfig;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'Never';
  env.GCM_CREDENTIAL_STORE = 'dpapi';
  env.GCM_DPAPI_STORE_PATH = path.join(resolvedHome, '.gcm', 'dpapi_store');
  env.HOME = resolvedHome;
  env.USERPROFILE = resolvedHome;
  env.XDG_CONFIG_HOME = resolvedHome;
  if (process.platform === 'win32') {
    env.HOMEDRIVE = path.parse(resolvedHome).root.replace(/\\+$/, '');
    env.HOMEPATH = resolvedHome.slice(path.parse(resolvedHome).root.length) || '\\';
  }

  // Only the ephemeral config entries deliberately supplied by the caller are allowed.
  const optionEntries = Object.entries(overrides || {}).filter(([key]) => /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/i.test(key));
  for (const [key, value] of optionEntries) env[key] = value;
  return env;
}

module.exports = { GitRuntime, createGitEnvironment, gitAuthorizationHeader, normalizeGitAuthor, normalizeGitRemote, normalizeRelative, parseCredential, sanitizeGitError };
