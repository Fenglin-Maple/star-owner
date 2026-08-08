// PR #4 两条 UI 调整的验证脚本（不 commit，仅验证）
// 1) 真实 DependencyManager.state()（darwin 平台）确认 packages 携带 installHint、assetName 为空
// 2) 用与 renderer 完全一致的分支逻辑模拟渲染决策（darwin 降级 / win32 不变）
// 3) 静态断言：改动确实存在于源码中，且 win32 分支文案/逻辑保留
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DependencyManager } = require('../src/core/dependency-manager');

const ROOT = path.join(__dirname, '..');

function createStore() {
  const settings = new Map();
  return {
    get: (scope, id) => settings.get(`${scope}:${id}`) || null,
    set: (scope, id, value) => settings.set(`${scope}:${id}`, value),
    save: () => {},
    commit: () => {}
  };
}

// ---- renderer 决策逻辑（与 ai.js / outside.js 中提交的代码逐字对应） ----

function renderDependenciesButton(item) {
  const installHint = String(item.installHint || '').trim();
  if (installHint) {
    // macOS 本地配置模式：assetName 为空、无 Release 资产可下载 → 降级禁用 + installHint 指引
    return { disabled: true, label: item.available ? '本地已安装' : '需本地安装', title: installHint, cls: 'primary-button compact-button' };
  }
  const pausable = ['resolving', 'downloading'].includes(item.status);
  const paused = item.status === 'paused';
  const busy = ['pausing', 'cancelling', 'importing', 'verifying', 'waiting-install', 'installing'].includes(item.status);
  return {
    disabled: busy,
    label: pausable ? '暂停' : (paused ? '继续下载' : (item.available ? '重新下载' : '下载')),
    title: '',
    cls: `${pausable || paused ? 'secondary-button' : 'primary-button'} compact-button`
  };
}

function promptModalMode(packages, missingRequired) {
  const missing = (packages || []).filter((item) => missingRequired.includes(item.id));
  const allHinted = missing.length > 0 && missing.every((item) => String(item.installHint || '').trim());
  return allHinted
    ? { mode: 'hint', downloadDisabled: true, label: '暂不支持自动下载' }
    : { mode: 'release', downloadDisabled: false, label: '同意并开始下载' };
}

function sharedGitAvailable(sharedData) {
  return !sharedData.git || sharedData.git.available !== false;
}

function sharedUploadDisabled(sharedData, selectedCount, maximum, uploading) {
  return !sharedGitAvailable(sharedData) || !selectedCount || selectedCount > maximum || Boolean(uploading);
}

function guardSharedLogin(sharedData, notify) {
  if (!sharedGitAvailable(sharedData)) {
    notify('GitHub 浏览器登录不可用', 'macOS 暂不支持内置 Git', 'error');
    return false;
  }
  return true;
}

function guardSharedUpload(sharedData, notify) {
  if (!sharedGitAvailable(sharedData)) {
    notify('无法创建共享 PR', 'macOS 暂不支持内置 Git', 'error');
    return false;
  }
  return true;
}

(async () => {
  // ---------- 1) 真实主进程状态（本机即 darwin） ----------
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'star-owner-pr4-ui-'));
  const manager = new DependencyManager({ store: createStore(), projectRoot: root, version: '9.9.9', dependencyVersion: '9.9.9' });
  const state = manager.state();
  assert.strictEqual(process.platform, 'darwin', '验证环境应为 darwin');
  for (const pkg of state.packages) {
    assert.strictEqual(pkg.assetName, '', `darwin 包 ${pkg.id} 的 assetName 应为空`);
    assert(String(pkg.installHint || '').includes('npm run setup:mac'), `darwin 包 ${pkg.id} 应携带 installHint 并引导 setup:mac`);
  }
  console.log(`[1] 真实 DependencyManager.state() 输出：${state.packages.length} 个 darwin 包均 assetName='' 且 installHint 引导 npm run setup:mac ✔`);

  // ---------- 2) 渲染决策模拟 ----------
  const darwinMissing = state.packages.find((p) => p.id === 'runtime-base');
  const darwinAvailable = state.packages.find((p) => p.required === false) || { ...darwinMissing, available: true };
  const win32Base = { id: 'runtime-base', name: '媒体与 ASR 基础运行时', assetName: 'Star-Owner-v9.9.9-runtime-win-x64.zip', installHint: '', status: 'missing', available: false };

  // A. 依赖面板下载按钮
  let btn = renderDependenciesButton(darwinMissing);
  assert(btn.disabled === true && btn.label === '需本地安装' && btn.title.includes('npm run setup:mac'), 'darwin 缺失包下载按钮应禁用并展示 installHint');
  btn = renderDependenciesButton({ ...darwinMissing, available: true });
  assert(btn.disabled === true && btn.label === '本地已安装', 'darwin 已装包下载按钮仍应禁用（无 Release 资产）');
  btn = renderDependenciesButton(win32Base);
  assert(btn.disabled === false && btn.label === '下载' && btn.title === '', 'win32 缺失包下载按钮应保持可点「下载」');
  btn = renderDependenciesButton({ ...win32Base, status: 'downloading', progress: 0.5 });
  assert(btn.disabled === false && btn.label === '暂停' && btn.cls.startsWith('secondary-button'), 'win32 下载中应显示「暂停」');
  btn = renderDependenciesButton({ ...win32Base, status: 'paused' });
  assert(btn.label === '继续下载', 'win32 暂停态应显示「继续下载」');
  btn = renderDependenciesButton({ ...win32Base, available: true });
  assert(btn.label === '重新下载', 'win32 已装包应显示「重新下载」');
  console.log('[2A] 依赖面板下载按钮：darwin 禁用+指引 / win32 全部原行为 ✔');

  // B. 首次启动提示弹窗
  let modal = promptModalMode(state.packages, state.missingRequired);
  assert(modal.mode === 'hint' && modal.downloadDisabled && modal.label === '暂不支持自动下载', 'darwin 缺失必需项时弹窗应禁用自动下载');
  const win32State = { packages: [win32Base], missingRequired: ['runtime-base'] };
  modal = promptModalMode(win32State.packages, win32State.missingRequired);
  assert(modal.mode === 'release' && !modal.downloadDisabled && modal.label === '同意并开始下载', 'win32 弹窗应保持「同意并开始下载」');
  const mixed = { packages: [win32Base, { ...darwinMissing, id: 'model-small' }], missingRequired: ['runtime-base', 'model-small'] };
  modal = promptModalMode(mixed.packages, mixed.missingRequired);
  assert(modal.mode === 'release' && !modal.downloadDisabled, '部分包有 installHint、部分没有时应保持 Release 下载模式（不应误伤 win32）');
  console.log('[2B] 依赖提示弹窗：darwin 降级 / win32 保持 ✔');

  // C. Git 能力边界
  const darwinShared = { git: { available: false, path: '.../runtime/git/cmd/git.exe', version: '' } };
  const win32Shared = { git: { available: true, version: 'git version 2.x' } };
  const legacyShared = { repository: null, authenticated: false }; // 无 git 字段
  assert(sharedGitAvailable(darwinShared) === false, 'darwin git.available=false 应判定不可用');
  assert(sharedGitAvailable(win32Shared) === true && sharedGitAvailable(legacyShared) === true, 'win32 / 无字段时均应保持可用');
  assert(sharedUploadDisabled(darwinShared, 3, 1000, false) === true, 'darwin 创建 Fork/PR 按钮应禁用');
  assert(sharedUploadDisabled(win32Shared, 3, 1000, false) === false && sharedUploadDisabled(win32Shared, 0, 1000, false) === true, 'win32 仅受原条件约束');
  const notices = [];
  const spy = (t, d) => notices.push(`${t}:${d}`);
  assert(guardSharedLogin(darwinShared, spy) === false && notices.length === 1 && notices[0].startsWith('GitHub 浏览器登录不可用'), 'darwin 浏览器登录应被拦截并提示原因');
  assert(guardSharedLogin(win32Shared, spy) === true && notices.length === 1, 'win32 浏览器登录不应被拦截');
  assert(guardSharedUpload(darwinShared, spy) === false && notices[1].startsWith('无法创建共享 PR'), 'darwin 创建 Fork/PR 应被拦截并提示原因');
  assert(guardSharedUpload(win32Shared, spy) === true, 'win32 创建 Fork/PR 不应被拦截');
  console.log('[2C] Git 能力边界：darwin 禁用+原因 / win32 与无字段旧状态零影响 ✔');

  // ---------- 3) 静态断言：改动存在于源码，且 win32 分支保留 ----------
  const aiJs = fs.readFileSync(path.join(ROOT, 'src/renderer/ai.js'), 'utf8');
  const outsideJs = fs.readFileSync(path.join(ROOT, 'src/renderer/outside.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  const aiCss = fs.readFileSync(path.join(ROOT, 'src/renderer/ai.css'), 'utf8');
  const outsideCss = fs.readFileSync(path.join(ROOT, 'src/renderer/outside.css'), 'utf8');

  assert(aiJs.includes('if (installHint) {'), 'ai.js 应包含 installHint 降级分支');
  assert(aiJs.includes('class="dependency-install-hint"'), 'ai.js 行模板应渲染 installHint 指引元素');
  assert(aiJs.includes('dependencyPromptModeText'), 'ai.js 应驱动弹窗文案元素');
  assert(aiJs.includes('allHinted'), 'ai.js 弹窗应包含 allHinted 判定');
  assert(aiJs.includes("dependencyAcknowledge({ download: false })"), 'ai.js 弹窗点击应含 macOS 守卫');
  assert(aiJs.includes("const actionLabel = pausable ? '暂停' : (paused ? '继续下载' : (item.available ? '重新下载' : '下载'));"), 'ai.js win32 下载按钮原逻辑应保留');

  assert(outsideJs.includes('function sharedGitAvailable()'), 'outside.js 应包含 sharedGitAvailable');
  assert(outsideJs.includes('function sharedGitUnavailableReason()'), 'outside.js 应包含中文原因提示');
  assert(outsideJs.includes('elements.sharedLogin.disabled = !gitAvailable'), 'outside.js 应禁用浏览器登录按钮');
  assert(outsideJs.includes('elements.sharedUpload.disabled = !gitAvailable'), 'outside.js 应禁用创建 Fork/PR 按钮');
  assert(outsideJs.includes('if (!sharedGitAvailable()) {'), 'outside.js 两个操作入口应含守卫');
  assert(outsideJs.includes('!selectedItems.length || selectedItems.length > maximum || Boolean(sharedData.upload)'), 'outside.js 原上传禁用条件应完整保留');
  assert(outsideJs.includes("'未授权时可读取公开目录'"), 'outside.js 原角色文案应保留');

  assert(indexHtml.includes('id="dependencyPromptMode"') && indexHtml.includes('id="dependencyPromptModeText"'), 'index.html 弹窗文案应可被 renderer 改写');
  assert(indexHtml.includes('id="sharedGitStatus"'), 'index.html 应包含 Git 不可用原因横幅');
  assert(indexHtml.includes('同意并开始下载'), 'index.html 默认弹窗按钮文案应保留（win32）');
  assert(aiCss.includes('.dependency-main .dependency-install-hint'), 'ai.css 应包含安装指引样式');
  assert(outsideCss.includes('.shared-git-status'), 'outside.css 应包含 Git 原因横幅样式');
  console.log('[3] 源码静态断言：改动存在、win32 分支文案与条件原样保留 ✔');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('\n全部验证通过 ✔');
})().catch((error) => { console.error('验证失败：', error.message); process.exit(1); });
