const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GitRuntime, gitAuthorizationHeader, normalizeGitAuthor, normalizeGitRemote, normalizeSparsePaths, parseCredential } = require('../src/core/git-runtime');

(async () => {
  const root = path.resolve(__dirname, '..');
  const runtime = new GitRuntime({ projectRoot: root });
  const poisonRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'star-owner-git-poison-'));
  const poisonHome = path.join(poisonRoot, 'home');
  const poisonConfig = path.join(poisonHome, '.gitconfig');
  runtime.gitHome = path.join(poisonRoot, 'runtime-home');
  runtime.credentialStorePath = path.join(runtime.gitHome, '.gcm', 'dpapi_store');
  fs.mkdirSync(poisonHome, { recursive: true });
  fs.writeFileSync(poisonConfig, '[user]\n\tname = Global Poison\n[credential]\n\thelper = poison-helper\n', 'utf8');
  try {
    const result = await runtime.run(['config', '--list'], {
      env: {
        PATH: path.join(poisonRoot, 'global-bin'),
        Path: path.join(poisonRoot, 'shadow-bin'),
        HOME: poisonHome,
        USERPROFILE: poisonHome,
        GIT_CONFIG_GLOBAL: poisonConfig,
        GIT_CONFIG_SYSTEM: poisonConfig
      }
    });
    assert(!/Global Poison|poison-helper/i.test(result.stdout), '内置 Git 读取了用户全局 Git 配置');
    assert(runtime.state().path.toLowerCase().startsWith(path.join(root, 'runtime', 'git').toLowerCase()), 'Git 路径不是项目 runtime/git');
    assert.strictEqual(runtime.state().credentialScope, 'application-dpapi', '内置 GitHub 凭据没有声明应用私有 DPAPI 范围');
    const described = await runtime.describe();
    assert(described.available && /git version/i.test(described.version), '项目内置 Git 健康检查失败');
    const canceled = new AbortController();
    canceled.abort();
    await assert.rejects(() => runtime.run(['--version'], { signal: canceled.signal }), /abort|中止/i, '内置 Git 没有响应上传取消信号');
    assert(/^Authorization: Basic [A-Za-z0-9+/=]+$/.test(gitAuthorizationHeader('test-token')), 'GitHub Git 推送没有使用 Basic 认证头');
    assert.strictEqual(normalizeGitRemote('https://github.com/Fenglin-Maple/Blibili-Markdowns.git'), normalizeGitRemote('https://github.com/fenglin-maple/Blibili-Markdowns/'), '仓库主人提交没有识别同一远程仓库');
    assert.deepStrictEqual(normalizeGitAuthor({ name: 'alice', email: '123456+alice@users.noreply.github.com' }), { name: 'alice', email: '123456+alice@users.noreply.github.com' }, '共享提交没有保留实际 GitHub 贡献者作者');
    assert.strictEqual(normalizeGitAuthor({ name: 'bad\nname', email: 'unsafe' }).name, 'Star Owner', '共享提交作者校验允许了换行注入');
    assert.deepStrictEqual(parseCredential('protocol=https\nhost=github.com\nusername=alice\npassword=token\n'), { protocol: 'https', host: 'github.com', username: 'alice', password: 'token' }, 'Git Credential Manager 输出解析错误');
    const isolatedEnv = require('../src/core/git-runtime').createGitEnvironment({ source: { GCM_CREDENTIAL_STORE: 'wincredman', GCM_DPAPI_STORE_PATH: path.join(poisonRoot, 'global-store') }, projectRoot: root, gitRoot: path.join(root, 'runtime', 'git'), gitHome: runtime.gitHome });
    assert.strictEqual(isolatedEnv.GCM_CREDENTIAL_STORE, 'dpapi', '内置 Git 错误使用了 Windows 全局凭据库');
    assert.strictEqual(path.resolve(isolatedEnv.GCM_DPAPI_STORE_PATH), path.resolve(runtime.credentialStorePath), '内置 GitHub 凭据没有存入应用私有目录');
    fs.mkdirSync(runtime.credentialStorePath, { recursive: true });
    fs.writeFileSync(path.join(runtime.credentialStorePath, 'test-entry'), 'encrypted-placeholder', 'utf8');
    const cleared = runtime.clearCredentialStore();
    assert.strictEqual(cleared.scope, 'application-dpapi', '凭据清理越过了应用私有范围');
    assert(!fs.existsSync(runtime.credentialStorePath), '应用私有 GitHub 凭据目录没有被清理');
    const originalRun = runtime.run.bind(runtime);
    const originalAssertAvailable = runtime.assertAvailable.bind(runtime);
    let clonedCheckout = '';
    const checkoutProgress = [];
    const checkoutCalls = [];
    runtime.assertAvailable = async () => ({ available: true });
    runtime.run = async (args) => {
      checkoutCalls.push(args);
      if (args.includes('clone')) {
        assert(args.includes('core.longpaths=true'), '只读共享仓库快照没有开启 Windows 长路径支持');
        clonedCheckout = args.at(-1);
        fs.mkdirSync(path.join(clonedCheckout, '123', 'bilibili', 'col-test', 'doc-test'), { recursive: true });
        fs.writeFileSync(path.join(clonedCheckout, '123', 'bilibili', 'col-test', 'doc-test', 'summary.md'), '# snapshot\n', 'utf8');
      }
      return { stdout: '', stderr: '' };
    };
    const sparsePath = '123/bilibili/col-test/doc-test';
    const snapshotValue = await runtime.withReadOnlyCheckout({ repository: { owner: 'owner', name: 'repository', branch: 'main' }, paths: [sparsePath], expectedBytes: 1024, onProgress: (event) => checkoutProgress.push(event) }, async ({ root: checkout }) => {
      assert(fs.existsSync(path.join(checkout, '123', 'bilibili', 'col-test', 'doc-test', 'summary.md')), '只读 Git 快照回调无法读取下载文件');
      return 'snapshot-ok';
    });
    assert.strictEqual(snapshotValue, 'snapshot-ok', '只读 Git 快照没有返回回调结果');
    assert(checkoutProgress.some((event) => event.stage === 'git-download') && checkoutProgress.some((event) => event.stage === 'git-ready'), '只读 Git 快照没有报告下载进度');
    const cloneCall = checkoutCalls.find((args) => args.includes('clone'));
    assert(cloneCall.includes('--filter=blob:none') && cloneCall.includes('--sparse') && cloneCall.includes('--no-checkout'), '只读共享仓库没有使用 partial/sparse clone');
    assert(checkoutCalls.some((args) => args[0] === 'sparse-checkout' && args[1] === 'set' && args.includes(sparsePath)), '只读共享仓库没有限制到选中文档目录');
    assert(clonedCheckout && !fs.existsSync(clonedCheckout), '只读 Git 快照完成后没有清理临时目录');
    assert.deepStrictEqual(normalizeSparsePaths([sparsePath, sparsePath]), [sparsePath], '稀疏下载路径没有去重');
    await assert.rejects(() => runtime.withReadOnlyCheckout({ repository: { owner: 'owner', name: 'repository', branch: 'main' }, paths: [sparsePath], expectedBytes: 3 * 1024 * 1024 * 1024 }, async () => {}), (error) => error.code === 'SHARED_GIT_CAPACITY_SELECTION');
    runtime.run = async (args) => {
      if (!args.includes('clone')) return { stdout: '', stderr: '' };
      clonedCheckout = args.at(-1);
      throw new Error('simulated clone failure');
    };
    await assert.rejects(() => runtime.withReadOnlyCheckout({ repository: { owner: 'owner', name: 'repository', branch: 'main' } }, async () => {}), (error) => error.code === 'SHARED_GIT_CHECKOUT_FAILED');
    assert(clonedCheckout && !fs.existsSync(clonedCheckout), '只读 Git 快照失败后没有清理临时目录');
    runtime.run = originalRun;
    runtime.assertAvailable = originalAssertAvailable;
    assert.throws(() => new GitRuntime({ projectRoot: root, gitPath: path.join(root, 'node_modules', '.bin', 'git.exe') }), /runtime\\git|外部 Git/);
    console.log('git runtime isolation test passed');
  } finally {
    fs.rmSync(poisonRoot, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
