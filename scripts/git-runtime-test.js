const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GitRuntime } = require('../src/core/git-runtime');

(async () => {
  const root = path.resolve(__dirname, '..');
  const runtime = new GitRuntime({ projectRoot: root });
  const poisonRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'star-owner-git-poison-'));
  const poisonHome = path.join(poisonRoot, 'home');
  const poisonConfig = path.join(poisonHome, '.gitconfig');
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
    const described = await runtime.describe();
    assert(described.available && /git version/i.test(described.version), '项目内置 Git 健康检查失败');
    assert.throws(() => new GitRuntime({ projectRoot: root, gitPath: path.join(root, 'node_modules', '.bin', 'git.exe') }), /runtime\\git|外部 Git/);
    console.log('git runtime isolation test passed');
  } finally {
    fs.rmSync(poisonRoot, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
