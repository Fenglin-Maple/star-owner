const TEMPLATE_SCHEMA_VERSION = 1;

function sharedRepositoryTemplate({ owner, name, branch = 'main' }) {
  const fullName = `${owner}/${name}`;
  const defaultBranch = String(branch || 'main');
  return [
    textFile('README.md', `# ${name}

Before merging any contribution, the required GitHub status check \`validate-shared-docs\` must pass. The repository owner should keep this check required on the default branch.

这是由“星藏家”初始化的 B站视频总结共享仓库。仓库只接收已经完成的 B站视频 Markdown 总结、必要的脱敏元数据和 Markdown 引用的图片资源，不接收原始视频、音频、Cookie、API Key、ASR 缓存或应用数据库。

## 使用方式

1. 在“星藏家 → B站之外 → GitHub 文档共享”中把本仓库设为当前共享仓库。
2. 仓库主人通过应用创建临时分支和 Pull Request；其他贡献者通过应用创建 Fork、分支和 Pull Request。
3. Pull Request 会由 GitHub Actions 检查目录结构、文件类型和必要元数据。
4. 合并到 \`${defaultBranch}\` 后，GitHub Actions 会更新 \`catalog.json\`。

根目录的 \`_star-owner-repository.json\` 是应用识别共享仓库的规范标记，不应删除或改为其它仓库身份。\`catalog.json\` 由 GitHub Actions 串行维护，并包含挂载前容量检查需要的文件数量与总字节数字段。

## 目录结构

\`<github-numeric-id>/<bilibili|single|multipart>/col-<source-hash>/doc-<stable-id>/\`

同一个 BVID 的不同总结可以共存。请勿提交原始媒体、密钥、数据库或系统绝对路径。

仓库：${fullName}
`),
    textFile('_star-owner-repository.json', `${JSON.stringify({
      schemaVersion: TEMPLATE_SCHEMA_VERSION,
      type: 'star-owner-shared-knowledge',
      repository: fullName,
      defaultBranch,
      capabilities: ['bilibili-summary', 'single-video-summary', 'multipart-summary', 'catalog-v1']
    }, null, 2)}\n`),
    textFile('.gitattributes', '* text=auto eol=lf\n*.png binary\n*.jpg binary\n*.jpeg binary\n*.webp binary\n*.gif binary\n'),
    textFile('.gitignore', 'node_modules/\n.DS_Store\nThumbs.db\n*.sqlite\n*.db\n*.mp4\n*.mkv\n*.webm\n*.mp3\n*.wav\n*.flac\n'),
    textFile('CONTRIBUTING.md', `# 贡献说明

请通过“星藏家”的 GitHub 文档共享工具创建 Pull Request，不要手工伪造贡献者目录或稳定文档 ID。

- 只允许提交已完成的 B站视频总结产物。
- 路径必须位于贡献者自己的 GitHub 数字 ID 目录。
- 禁止原始媒体、Cookie、Token、API Key、数据库和绝对路径。
- Markdown 图片必须位于同一文档目录并使用相对路径。
- 相同 BVID 的不同贡献者、收藏夹、模型或提示词总结可以共存。
`),
    textFile('SECURITY.md', `# 安全说明

本仓库不应包含 Cookie、Token、API Key、应用数据库、用户系统路径或原始音视频。发现敏感内容时，请立即关闭相关 Pull Request；已经合并的内容应由仓库维护者删除并轮换可能泄露的凭据。
`),
    textFile('.github/CODEOWNERS', `* @${owner}\n`),
    textFile('.github/pull_request_template.md', `## 星藏家共享文档

- Required check before merge: \`validate-shared-docs\` must be green.

- [ ] 只包含已完成的 B站视频总结、必要元数据和 Markdown 图片
- [ ] 不包含原始音视频、Cookie、Token、API Key、数据库或绝对路径
- [ ] 文档路径位于提交者自己的 GitHub 数字 ID 目录

请等待自动校验通过后再由维护者审核合并。
`),
    textFile('.github/workflows/validate-shared-docs.yml', `name: Validate shared documents

on:
  pull_request:
    branches: [${JSON.stringify(defaultBranch)}]
  push:
    branches: [${JSON.stringify(defaultBranch)}]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  validate:
    name: validate-shared-docs
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: node scripts/validate-shared-docs.mjs
`),
    textFile('.github/workflows/build-catalog.yml', `name: Build shared catalog

on:
  push:
    branches: [${JSON.stringify(defaultBranch)}]
    paths-ignore:
      - catalog.json
  workflow_dispatch:

permissions:
  contents: write

jobs:
  catalog:
    name: build-shared-catalog
    runs-on: ubuntu-latest
    concurrency:
      group: star-owner-catalog-${owner}-${name}
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: node scripts/validate-shared-docs.mjs
      - run: node scripts/build-catalog.mjs
      - name: Commit catalog with retry
        run: |
          git config user.name "star-owner-catalog[bot]"
          git config user.email "star-owner-catalog[bot]@users.noreply.github.com"
          for attempt in 1 2 3; do
            git fetch origin ${JSON.stringify(defaultBranch)}
            git reset --hard origin/${JSON.stringify(defaultBranch)}
            node scripts/validate-shared-docs.mjs
            node scripts/build-catalog.mjs
            if git diff --quiet -- catalog.json; then
              echo "catalog.json is already current"
              exit 0
            fi
            git add catalog.json
            git commit -m "chore: rebuild shared catalog"
            if git push origin HEAD:${JSON.stringify(defaultBranch)}; then exit 0; fi
            echo "catalog push attempt \${attempt} lost a race; retrying"
          done
          echo "catalog push failed after retries"
          exit 1
`),
    textFile('scripts/validate-shared-docs.mjs', VALIDATOR_SCRIPT),
    textFile('scripts/build-catalog.mjs', CATALOG_SCRIPT),
    textFile('catalog.json', `${JSON.stringify({ schemaVersion: 1, generatedAt: '', total: 0, documents: [] }, null, 2)}\n`)
  ];
}

function textFile(relative, content) {
  return { relative, buffer: Buffer.from(String(content).replace(/\r\n/g, '\n'), 'utf8') };
}

const VALIDATOR_SCRIPT = `import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const metadataName = '_star-owner-document.json';
const namespaces = new Set(['bilibili', 'single', 'multipart']);
const allowedExtensions = new Set(['.md', '.json', '.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif']);
const forbiddenNames = /(?:cookie|secret|api[-_]?key|token|credential|database|sqlite|session)/i;
const infrastructureFiles = new Set([
  'README.md', '_star-owner-repository.json', '.gitattributes', '.gitignore', 'CONTRIBUTING.md', 'SECURITY.md', 'catalog.json',
  '.github/CODEOWNERS', '.github/pull_request_template.md', '.github/workflows/validate-shared-docs.yml', '.github/workflows/build-catalog.yml',
  'scripts/validate-shared-docs.mjs', 'scripts/build-catalog.mjs'
]);
const errors = [];

function fail(message) { errors.push(message); }
function relative(file) { return path.relative(root, file).split(path.sep).join('/'); }
function walk(directory) {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) { fail('禁止符号链接：' + relative(file)); continue; }
    if (entry.isDirectory()) output.push(...walk(file));
    else if (entry.isFile()) output.push(file);
  }
  return output;
}
function safeRelative(value) {
  const normalized = String(value || '').replaceAll('\\\\', '/');
  return Boolean(normalized) && !normalized.startsWith('/') && !normalized.split('/').some((part) => !part || part === '.' || part === '..');
}
function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function pullRequestChanges() {
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request' || !process.env.GITHUB_EVENT_PATH) return { files: [], actorId: '' };
  try {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const baseSha = String(event.pull_request?.base?.sha || '');
    const actorId = String(event.pull_request?.user?.id || '');
    if (!/^\\d+$/.test(actorId)) throw new Error('Pull Request 事件缺少真实提交者 GitHub 数字 ID');
    if (!/^[a-f0-9]{40}$/i.test(baseSha)) throw new Error('缺少 Pull Request base SHA');
    const output = execFileSync('git', ['diff', '--name-only', baseSha + '...HEAD'], { cwd: root, encoding: 'utf8' });
    return { files: output.split(/\\r?\\n/).map((item) => item.trim()).filter(Boolean), actorId };
  } catch (error) {
    fail('无法核对 Pull Request 变更目录：' + error.message);
    return { files: [], actorId: '' };
  }
}

const allFiles = walk(root);
const metadataFiles = allFiles.filter((file) => path.basename(file) === metadataName);
const declaredByRoot = new Map();
for (const metadataFile of metadataFiles) {
  const metadataPath = relative(metadataFile);
  const segments = metadataPath.split('/');
  if (segments.length !== 5 || segments[4] !== metadataName) { fail(metadataPath + ': 文档必须位于标准五层目录'); continue; }
  const [contributor, namespace, collection, document] = segments;
  if (!/^\\d+$/.test(contributor)) fail(metadataPath + ': 顶层贡献者目录必须是 GitHub 数字 ID');
  if (!namespaces.has(namespace)) fail(metadataPath + ': 不支持的来源命名空间 ' + namespace);
  if (!/^col-[a-f0-9]{24}$/.test(collection)) fail(metadataPath + ': 收藏夹来源 ID 格式错误');
  if (!/^doc-[a-f0-9]{24}$/.test(document)) fail(metadataPath + ': 文档 ID 格式错误');
  let metadata;
  try { metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8')); } catch (error) { fail(metadataPath + ': JSON 无法解析 (' + error.message + ')'); continue; }
  if (metadata.sourceType !== 'bilibili-video-summary') fail(metadataPath + ': sourceType 必须是 bilibili-video-summary');
  if (String(metadata.documentId || '') !== document) fail(metadataPath + ': documentId 与目录不一致');
  if (String(metadata.contributorGithubId || '') !== contributor) fail(metadataPath + ': contributorGithubId 与目录不一致');
  if (!/^BV[0-9A-Za-z]{10}$/i.test(String(metadata.bvid || ''))) fail(metadataPath + ': BVID 格式错误');
  const expectedType = namespace === 'multipart' ? 'multipart-parent' : 'single-video';
  if (metadata.documentType !== expectedType) fail(metadataPath + ': documentType 应为 ' + expectedType);
  const schemaVersion = Number(metadata.schemaVersion || 0);
  const files = Array.isArray(metadata.files) ? metadata.files : [];
  const declared = new Set([metadataName]);
  if (!files.length) fail(metadataPath + ': files 不能为空');
  for (const item of files) {
    const itemPath = String(item || '').replaceAll('\\\\', '/');
    if (!safeRelative(itemPath) || forbiddenNames.test(itemPath)) { fail(metadataPath + ': 文件路径不安全 ' + itemPath); continue; }
    declared.add(itemPath);
    if (!allowedExtensions.has(path.extname(itemPath).toLowerCase())) fail(metadataPath + ': 不允许的文件类型 ' + itemPath);
    const target = path.resolve(path.dirname(metadataFile), itemPath);
    const documentRoot = path.resolve(path.dirname(metadataFile));
    if (!target.startsWith(documentRoot + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) fail(metadataPath + ': 缺少资源 ' + itemPath);
    if (fs.existsSync(target) && fs.statSync(target).size > 25 * 1024 * 1024) fail(metadataPath + ': 单文件超过 25 MiB ' + itemPath);
  }
  const canonicalMarkdown = namespace === 'multipart' ? 'index.md' : 'summary.md';
  const entryMarkdown = String(metadata.entryMarkdown || canonicalMarkdown).replaceAll('\\\\', '/');
  const documentRoot = path.resolve(path.dirname(metadataFile));
  if (!safeRelative(entryMarkdown) || !/\.md$/i.test(entryMarkdown)) fail(metadataPath + ': 入口 Markdown 路径不安全');
  if (schemaVersion >= 3 && entryMarkdown !== canonicalMarkdown) fail(metadataPath + ': schema v3 入口 Markdown 必须是 ' + canonicalMarkdown);
  if (!files.includes(entryMarkdown)) fail(metadataPath + ': 缺少入口 Markdown ' + entryMarkdown);
  if (schemaVersion >= 3) {
    for (const item of files) {
      const itemPath = String(item || '').replaceAll('\\\\', '/');
      const extension = path.extname(itemPath).toLowerCase();
      const allowedMarkdown = namespace === 'multipart'
        ? itemPath === 'index.md' || /^parts\\/cid-[A-Za-z0-9._-]+\\/summary\\.md$/.test(itemPath)
        : itemPath === 'summary.md';
      if (extension === '.md' && !allowedMarkdown) fail(metadataPath + ': schema v3 不允许过程 Markdown ' + itemPath);
      if (extension !== '.md' && !new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif']).has(extension)) fail(metadataPath + ': schema v3 不允许过程缓存 ' + itemPath);
    }
  }
  const entryFile = path.resolve(path.dirname(metadataFile), entryMarkdown);
  const contentHash = String(metadata.contentSha256 || '');
  if (schemaVersion >= 3 && !/^[a-f0-9]{64}$/i.test(contentHash)) fail(metadataPath + ': 缺少有效的入口 Markdown SHA-256');
  if (entryFile.startsWith(documentRoot + path.sep) && fs.existsSync(entryFile) && /^[a-f0-9]{64}$/i.test(contentHash) && sha256File(entryFile) !== contentHash.toLowerCase()) {
    fail(metadataPath + ': 入口 Markdown SHA-256 不匹配');
  }
  for (const [itemPath, expectedHash] of Object.entries(metadata.markdownSha256 || {})) {
    if (!safeRelative(itemPath) || !files.includes(itemPath)) { fail(metadataPath + ': Markdown 哈希声明路径无效 ' + itemPath); continue; }
    const target = path.resolve(path.dirname(metadataFile), itemPath);
    if (!target.startsWith(documentRoot + path.sep) || !fs.existsSync(target) || !/^[a-f0-9]{64}$/i.test(String(expectedHash)) || sha256File(target) !== String(expectedHash).toLowerCase()) fail(metadataPath + ': Markdown SHA-256 不匹配 ' + itemPath);
  }
  for (const [itemPath, expectedHash] of Object.entries(metadata.assetSha256 || {})) {
    if (!safeRelative(itemPath) || !files.includes(itemPath)) { fail(metadataPath + ': 资源哈希声明路径无效 ' + itemPath); continue; }
    const target = path.resolve(path.dirname(metadataFile), itemPath);
    if (!target.startsWith(documentRoot + path.sep) || !fs.existsSync(target) || !/^[a-f0-9]{64}$/i.test(String(expectedHash)) || sha256File(target) !== String(expectedHash).toLowerCase()) fail(metadataPath + ': 资源 SHA-256 不匹配 ' + itemPath);
  }
  declaredByRoot.set(segments.slice(0, 4).join('/'), declared);
}

for (const file of allFiles) {
  const name = relative(file);
  if (forbiddenNames.test(name) || /\\.(mp4|mkv|webm|mp3|wav|flac|sqlite|db)$/i.test(name)) fail('禁止提交敏感或原始媒体文件：' + name);
  if (infrastructureFiles.has(name)) continue;
  const parts = name.split('/');
  const documentRoot = parts.slice(0, 4).join('/');
  const declared = declaredByRoot.get(documentRoot);
  const documentRelative = parts.slice(4).join('/');
  if (!declared) fail('文件不在标准文档目录或仓库配置白名单中：' + name);
  else if (!declared.has(documentRelative)) fail('文档包含未在元数据 files 中声明的文件：' + name);
}

const pullRequest = pullRequestChanges();
for (const changed of pullRequest.files) {
  const normalized = String(changed).replaceAll('\\\\', '/');
  if (infrastructureFiles.has(normalized)) { fail('Pull Request 不允许修改仓库配置文件：' + normalized); continue; }
  const segments = normalized.split('/');
  if (segments.length < 5 || !/^\\d+$/.test(segments[0]) || !namespaces.has(segments[1]) || !/^col-[a-f0-9]{24}$/.test(segments[2]) || !/^doc-[a-f0-9]{24}$/.test(segments[3])) {
    fail('Pull Request 文件不在标准贡献目录：' + normalized);
    continue;
  }
  if (pullRequest.actorId && segments[0] !== pullRequest.actorId) fail('Pull Request 只能修改当前 GitHub 账户自己的数字 ID 目录：' + normalized);
}

if (errors.length) { console.error(errors.map((item) => '- ' + item).join('\\n')); process.exit(1); }
console.log('shared document validation passed (' + metadataFiles.length + ' document(s))');
`;

const CATALOG_SCRIPT = `import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const metadataName = '_star-owner-document.json';
function relative(file) { return path.relative(root, file).split(path.sep).join('/'); }
function walk(directory) {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...walk(file));
    else if (entry.isFile() && entry.name === metadataName) output.push(file);
  }
  return output;
}
const documents = walk(root).map((file) => {
  const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
  const metadataPath = relative(file);
  return {
    documentId: String(metadata.documentId || ''), documentType: String(metadata.documentType || ''), sourceType: String(metadata.sourceType || ''), bvid: String(metadata.bvid || ''),
    title: String(metadata.title || ''), owner: String(metadata.owner || ''), collectionName: String(metadata.collectionName || ''),
    userName: String(metadata.userName || ''), bilibiliUid: String(metadata.bilibiliUid || ''), remoteCollectionId: String(metadata.remoteCollectionId || ''),
    sourceCollectionKind: String(metadata.sourceCollectionKind || ''), contributorGithubId: String(metadata.contributorGithubId || metadataPath.split('/')[0] || ''),
    contributorGithubLogin: String(metadata.contributorGithubLogin || ''), entryMarkdown: String(metadata.entryMarkdown || ''),
    totalBytes: Number(metadata.totalBytes || 0), fileCount: Array.isArray(metadata.files) ? metadata.files.length : 0,
    contentSha256: String(metadata.contentSha256 || ''), completedAt: String(metadata.completedAt || ''), uploadedAt: String(metadata.uploadedAt || ''),
    updatedAt: String(metadata.updatedAt || metadata.uploadedAt || ''), metadataPath,
    documentRoot: metadataPath.slice(0, -metadataName.length)
  };
}).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.metadataPath.localeCompare(b.metadataPath));
const generatedAt = documents.reduce((latest, item) => item.updatedAt > latest ? item.updatedAt : latest, '');
const output = JSON.stringify({ schemaVersion: 1, generatedAt, total: documents.length, documents }, null, 2) + '\\n';
fs.writeFileSync(path.join(root, 'catalog.json'), output, 'utf8');
console.log(\`shared catalog written (${'${documents.length}'} document(s))\`);
`;

module.exports = { TEMPLATE_SCHEMA_VERSION, sharedRepositoryTemplate };
