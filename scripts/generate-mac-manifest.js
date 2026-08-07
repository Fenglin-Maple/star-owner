/**
 * 生成 macOS 本地配置模式的依赖安装清单（runtime/.dependency-manifests/<id>.json）。
 *
 * 背景：上游 SECURITY.md 要求依赖可用性必须同时满足 probes 存在 + 托管 manifest
 * （含 package ID、dependency release、asset name、verified SHA-256、probe contract）。
 * macOS 分支（MLX Whisper + 本地 Python，不经 GitHub Release 安装）由本脚本对本地
 * 实际文件内容计算 SHA-256 并落盘清单；应用侧 packageHealth 每次启动读取清单并
 * 重算内容校验和比对，缺失/畸形/不匹配的清单一律视为不可用。
 *
 * 运行：npm run manifest:mac
 */
const fs = require('fs');
const path = require('path');
const { DependencyManager, contentChecksumForProbes } = require('../src/core/dependency-manager');

const packageJson = require('../package.json');
const version = packageJson.version;
// 与 src/main.js 保持一致：依赖发布版本取 dependencyReleaseVersion，缺省回退到应用版本。
const dependencyVersion = packageJson.dependencyReleaseVersion || version;

const projectRoot = process.cwd();
const dm = new DependencyManager({
  store: { get: () => ({}), set: () => {}, list: () => [] },
  projectRoot,
  version,
  dependencyVersion
});

let failed = false;
for (const definition of dm.definitions()) {
  const missingProbes = definition.probes.filter((probe) => !fs.existsSync(path.join(projectRoot, probe)));
  if (missingProbes.length) {
    console.error(`[跳过] ${definition.id}：缺少探针 ${missingProbes.join(', ')}，未生成清单。`);
    failed = true;
    continue;
  }
  const checksum = contentChecksumForProbes(projectRoot, definition.probes);
  const manifest = {
    schemaVersion: 1, // DEPENDENCY_MANIFEST_SCHEMA
    packageId: definition.id,
    dependencyReleaseVersion: dependencyVersion,
    assetName: definition.assetName,
    checksum,
    probes: [...definition.probes]
  };
  const file = dm.packageManifestPath(definition);
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  // 自断言：读回落盘清单，确认 probes 与包定义精确一致、checksum 为合法 64 位 hex。
  const written = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (JSON.stringify(written.probes) !== JSON.stringify(definition.probes)) {
    console.error(`[失败] ${definition.id}：清单 probes 与包定义不一致。`);
    process.exit(1);
  }
  if (!/^[0-9a-f]{64}$/.test(String(written.checksum || '').toLowerCase())) {
    console.error(`[失败] ${definition.id}：清单 checksum 非法。`);
    process.exit(1);
  }
  console.log(`[生成] ${definition.id}  checksum ${checksum.slice(0, 12)}  → ${path.relative(projectRoot, file)}`);
}

if (failed) {
  console.error('存在缺少探针的依赖包，请先补齐本地运行时后重新运行 npm run manifest:mac。');
  process.exit(1);
}
console.log('已完成，可重新打开应用。');
