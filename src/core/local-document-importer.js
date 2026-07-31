const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');
const mammoth = require('mammoth');
const { nodeChildProcessSpec } = require('./child-process-io');
const { assertInside, assertSafeWindowsPath, ensureDir, safeName } = require('./workspace');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.xml', '.yaml', '.yml', '.log', '.ini', '.toml', '.html', '.htm']);
const DOCUMENT_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...TEXT_EXTENSIONS, '.pdf', '.docx', '.pptx', '.xlsx', '.xlsm']);
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_TEXT_CHARACTERS = 8 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 5000;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const xmlParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, trimValues: false });

function documentKind(file) {
  const extension = path.extname(String(file || '')).toLowerCase();
  if (!DOCUMENT_EXTENSIONS.has(extension)) return '';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (['.md', '.markdown'].includes(extension)) return 'markdown';
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  if (extension === '.pdf') return 'pdf';
  if (extension === '.docx') return 'word';
  if (extension === '.pptx') return 'powerpoint';
  return 'excel';
}

function inspectDocument(file) {
  const source = path.resolve(String(file || ''));
  const kind = documentKind(source);
  if (!kind) throw unsupportedDocumentError(source);
  const stat = fs.statSync(source);
  if (!stat.isFile()) throw unsupportedDocumentError(source, '所选路径不是普通文件');
  if (stat.size > MAX_SOURCE_BYTES) throw unsupportedDocumentError(source, '文件超过 256 MiB 导入上限');
  return {
    path: source,
    name: path.basename(source),
    title: path.basename(source, path.extname(source)),
    extension: path.extname(source).toLowerCase(),
    kind,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString()
  };
}

async function importDocument(sourceFile, artifactDir, metadata = {}) {
  const source = inspectDocument(sourceFile);
  const root = ensureDir(artifactDir);
  const originalDir = ensureDir(path.join(root, 'original'));
  const assetsDir = ensureDir(path.join(root, 'assets'));
  const originalName = safeName(source.name, `source${source.extension}`, 120);
  const originalFile = assertSafeWindowsPath(path.join(originalDir, originalName), '本地文档原件路径');
  fs.copyFileSync(source.path, originalFile);
  const importedAt = metadata.importedAt || new Date().toISOString();
  const extraction = await extractDocument(source, assetsDir);
  const body = truncateText(String(extraction.markdown || '').trim());
  const front = [
    `# ${source.title}`,
    '',
    `- 来源类型：本地多模态文档`,
    `- 原始文件：${source.name}`,
    `- 文件格式：${source.extension.slice(1).toUpperCase()}`,
    `- 导入时间：${importedAt}`,
    `- 原件位置：[打开原始文件](original/${encodeURIComponent(originalName)})`,
    '',
    '---',
    ''
  ].join('\n');
  const markdownFile = path.join(root, 'document.md');
  fs.writeFileSync(markdownFile, `${front}${body || '_没有提取到可检索文本；原始文件仍已保留。_'}\n`, 'utf8');
  const info = {
    schemaVersion: 1,
    sourceType: 'local-document',
    originalFileName: source.name,
    originalExtension: source.extension,
    documentKind: source.kind,
    sourceSize: source.size,
    sourceModifiedAt: source.modifiedAt,
    importedAt,
    outputMarkdown: path.basename(markdownFile),
    originalFile: path.relative(root, originalFile).split(path.sep).join('/'),
    assets: extraction.assets.map((file) => path.relative(root, file).split(path.sep).join('/')),
    warnings: extraction.warnings
  };
  const metadataFile = path.join(root, 'info.json');
  fs.writeFileSync(metadataFile, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
  return { source, markdownFile, metadataFile, originalFile, assets: extraction.assets, warnings: extraction.warnings };
}

async function extractDocument(source, assetsDir) {
  if (source.kind === 'image') {
    validateImageSignature(source.path, source.extension);
    const target = copyAsset(source.path, assetsDir, source.name);
    return { markdown: `## 图片原图\n\n![${source.title}](assets/${encodeURIComponent(path.basename(target))})`, assets: [target], warnings: [] };
  }
  if (source.kind === 'markdown') return importMarkdown(source.path, assetsDir);
  if (source.kind === 'text') return { markdown: readTextFile(source.path), assets: [], warnings: [] };
  if (source.kind === 'pdf') {
    const result = await parsePdf(source.path);
    return { markdown: `## PDF 文本\n\n${result.text || ''}`, assets: [], warnings: result.text ? [] : ['PDF 中没有提取到文本，可能是扫描件。'] };
  }
  if (source.kind === 'word') return importWord(source.path, assetsDir);
  if (source.kind === 'powerpoint') return importPowerPoint(source.path, assetsDir);
  return importSpreadsheet(source.path, assetsDir);
}

async function importWord(file, assetsDir) {
  const assets = [];
  let imageIndex = 0;
  const result = await mammoth.convertToMarkdown({ path: file }, {
    convertImage: mammoth.images.imgElement(async (image) => {
      const extension = imageExtensionFromContentType(image.contentType);
      const target = path.join(assetsDir, `word-image-${String(++imageIndex).padStart(3, '0')}${extension}`);
      const buffer = await image.read();
      validateImageSignatureBuffer(buffer, extension);
      fs.writeFileSync(target, buffer);
      assets.push(target);
      return { src: `assets/${path.basename(target)}` };
    })
  });
  return {
    markdown: `## Word 文档内容\n\n${result.value || ''}`,
    assets,
    warnings: (result.messages || []).map((item) => String(item.message || item)).slice(0, 50)
  };
}

async function importPowerPoint(file, assetsDir) {
  const zip = await loadOfficeZip(file);
  const slideFiles = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).sort(naturalCompare);
  const sections = [];
  for (const [index, name] of slideFiles.entries()) {
    const xml = await zip.file(name).async('string');
    const values = collectXmlText(xmlParser.parse(xml)).map(cleanText).filter(Boolean);
    sections.push(`## 幻灯片 ${index + 1}\n\n${values.length ? values.join('\n\n') : '_这一页没有可提取文字。_'}`);
  }
  const assets = await copyZipMedia(zip, /^ppt\/media\//i, assetsDir, 'slide');
  const gallery = assets.length
    ? `\n\n## 演示文稿内嵌图片\n\n${assets.map((item, index) => `![PPT 图片 ${index + 1}](assets/${encodeURIComponent(path.basename(item))})`).join('\n\n')}`
    : '';
  return { markdown: `${sections.join('\n\n')}${gallery}`, assets, warnings: slideFiles.length ? [] : ['PPTX 中没有找到幻灯片 XML。'] };
}

async function importSpreadsheet(file, assetsDir) {
  const zip = await loadOfficeZip(file);
  const shared = await readSharedStrings(zip);
  const sheetFiles = Object.keys(zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)).sort(naturalCompare);
  const sections = [];
  for (const [index, name] of sheetFiles.entries()) {
    const xml = await zip.file(name).async('string');
    const parsed = xmlParser.parse(xml);
    const rows = arrayOf(parsed?.worksheet?.sheetData?.row);
    const lines = rows.map((row) => arrayOf(row.c).map((cell) => spreadsheetCellValue(cell, shared)).join('\t')).filter((line) => line.trim());
    sections.push(`## 工作表 ${index + 1}\n\n\`\`\`tsv\n${lines.join('\n')}\n\`\`\``);
  }
  const assets = await copyZipMedia(zip, /^xl\/media\//i, assetsDir, 'sheet');
  const gallery = assets.length
    ? `\n\n## 工作簿内嵌图片\n\n${assets.map((item, index) => `![Excel 图片 ${index + 1}](assets/${encodeURIComponent(path.basename(item))})`).join('\n\n')}`
    : '';
  return { markdown: `${sections.join('\n\n')}${gallery}`, assets, warnings: sheetFiles.length ? [] : ['工作簿中没有找到可读取的工作表。'] };
}

async function parsePdf(file) {
  return new Promise((resolve, reject) => {
    const node = nodeChildProcessSpec();
    const child = spawn(node.executable, [path.join(__dirname, 'local-pdf-process.js'), file], {
      cwd: path.resolve(__dirname, '..', '..'),
      env: node.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      error ? reject(error) : resolve(value);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-12 * 1024 * 1024); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-16000); });
    child.once('error', (cause) => {
      const error = new Error(`PDF 文本解析失败：${cause.message || String(cause)}`);
      error.code = 'LOCAL_PDF_PARSE_FAILED';
      error.cause = cause;
      finish(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        const error = new Error(`PDF 文本解析失败：${stderr.trim().slice(-4000) || `解析进程退出码 ${code}`}`);
        error.code = 'LOCAL_PDF_PARSE_FAILED';
        return finish(error);
      }
      try { finish(null, JSON.parse(stdout)); }
      catch (cause) {
        const error = new Error(`PDF 文本解析结果无效：${cause.message || String(cause)}`);
        error.code = 'LOCAL_PDF_PARSE_FAILED';
        finish(error);
      }
    });
    const timer = setTimeout(() => {
      const error = new Error('PDF 文本解析超过 120 秒，已停止该文件导入。');
      error.code = 'LOCAL_PDF_PARSE_TIMEOUT';
      finish(error);
    }, 120000);
    timer.unref?.();
  });
}

async function importMarkdown(file, assetsDir) {
  const sourceRoot = path.dirname(file);
  const assets = [];
  const warnings = [];
  let markdown = readTextFile(file);
  markdown = markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (whole, alt, rawTarget) => {
    const copied = copyMarkdownImage(rawTarget, sourceRoot, assetsDir, assets, warnings);
    return copied ? `![${alt}](${copied})` : whole;
  });
  const referenceIds = new Set();
  markdown.replace(/!\[([^\]]*)\]\[([^\]]*)\]/g, (_whole, alt, id) => {
    referenceIds.add(String(id || alt || '').trim().toLowerCase());
    return _whole;
  });
  markdown = markdown.replace(/^(\s*\[([^\]]+)\]:\s*)(<[^>\r\n]+>|[^\s]+)([^\r\n]*)$/gm, (whole, prefix, id, rawTarget, suffix) => {
    if (!referenceIds.has(String(id || '').trim().toLowerCase())) return whole;
    const copied = copyMarkdownImage(rawTarget, sourceRoot, assetsDir, assets, warnings);
    return copied ? `${prefix}${copied}${suffix || ''}` : whole;
  });
  return { markdown, assets, warnings };
}

function copyMarkdownImage(rawTarget, sourceRoot, assetsDir, assets, warnings) {
  const targetValue = String(rawTarget || '').trim().replace(/^<|>$/g, '').split(/\s+["']/)[0];
  const localTarget = targetValue.split(/[?#]/, 1)[0];
  if (!localTarget || /^(?:https?:|data:|star-rag-image:)/i.test(localTarget)) return '';
  try {
    const decoded = decodeURIComponent(localTarget.replace(/\\/g, '/'));
    const sourceImage = assertInside(sourceRoot, path.resolve(sourceRoot, decoded));
    if (!fs.existsSync(sourceImage) || !fs.statSync(sourceImage).isFile() || !IMAGE_EXTENSIONS.has(path.extname(sourceImage).toLowerCase())) return '';
    validateImageSignature(sourceImage, path.extname(sourceImage).toLowerCase());
    const copied = copyAsset(sourceImage, assetsDir, path.basename(sourceImage));
    assets.push(copied);
    return `assets/${encodeURIComponent(path.basename(copied))}`;
  } catch (error) {
    warnings.push(`未复制图片 ${targetValue}：${error.message || String(error)}`);
    return '';
  }
}

async function loadOfficeZip(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file), { checkCRC32: true, createFolders: false });
  const entries = Object.values(zip.files).filter((item) => !item.dir);
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error(`Office 文档包含过多条目（${entries.length}/${MAX_ZIP_ENTRIES}）。`);
  const expanded = entries.reduce((sum, item) => sum + Number(item?._data?.uncompressedSize || 0), 0);
  if (expanded > MAX_EXPANDED_BYTES) throw new Error('Office 文档解压后超过 512 MiB 安全上限。');
  return zip;
}

async function copyZipMedia(zip, pattern, assetsDir, prefix) {
  const assets = [];
  const files = Object.keys(zip.files).filter((name) => pattern.test(name) && !zip.files[name].dir).sort(naturalCompare);
  for (const [index, name] of files.entries()) {
    const extension = path.extname(name).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension)) continue;
    const target = uniqueAssetPath(assetsDir, `${prefix}-image-${String(index + 1).padStart(3, '0')}${extension}`);
    const buffer = await zip.file(name).async('nodebuffer');
    validateImageSignatureBuffer(buffer, extension);
    fs.writeFileSync(target, buffer);
    assets.push(target);
  }
  return assets;
}

async function readSharedStrings(zip) {
  const file = zip.file('xl/sharedStrings.xml');
  if (!file) return [];
  const parsed = xmlParser.parse(await file.async('string'));
  return arrayOf(parsed?.sst?.si).map((item) => collectXmlText(item).join(''));
}

function spreadsheetCellValue(cell, shared) {
  const type = cell?.['@_t'] || '';
  if (type === 'inlineStr') return collectXmlText(cell?.is).join('');
  const raw = cell?.v === undefined ? '' : String(cell.v);
  if (type === 's') return shared[Number(raw)] || '';
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  return raw;
}

function collectXmlText(value, output = []) {
  if (value === null || value === undefined) return output;
  if (typeof value === 'string' || typeof value === 'number') return output;
  if (Array.isArray(value)) {
    for (const item of value) collectXmlText(item, output);
    return output;
  }
  if (typeof value === 'object') {
    if (value.t !== undefined) {
      for (const item of arrayOf(value.t)) output.push(typeof item === 'object' ? String(item['#text'] || '') : String(item));
    }
    for (const [key, child] of Object.entries(value)) if (!['t', '#text'].includes(key) && !key.startsWith('@_')) collectXmlText(child, output);
  }
  return output;
}

function copyAsset(source, assetsDir, wantedName) {
  const extension = path.extname(wantedName).toLowerCase();
  const name = safeName(path.basename(wantedName, extension), 'asset', 80) + extension;
  const target = uniqueAssetPath(assetsDir, name);
  fs.copyFileSync(source, target);
  return target;
}

function uniqueAssetPath(directory, name) {
  const extension = path.extname(name);
  const base = path.basename(name, extension);
  let index = 1;
  let target = assertSafeWindowsPath(path.join(directory, name), '文档图片资源路径');
  while (fs.existsSync(target)) target = assertSafeWindowsPath(path.join(directory, `${base}-${++index}${extension}`), '文档图片资源路径');
  return target;
}

function validateImageSignature(file, extension) {
  validateImageSignatureBuffer(fs.readFileSync(file), extension);
}

function validateImageSignatureBuffer(buffer, extension) {
  const ext = String(extension || '').toLowerCase();
  const ok = (ext === '.png' && buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    || (['.jpg', '.jpeg'].includes(ext) && buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8)
    || (ext === '.gif' && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii')))
    || (ext === '.webp' && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP')
    || (ext === '.bmp' && buffer.subarray(0, 2).toString('ascii') === 'BM');
  if (!ok) throw new Error(`图片内容与扩展名不匹配：${ext || '未知格式'}`);
}

function imageExtensionFromContentType(value) {
  const type = String(value || '').toLowerCase();
  if (type.includes('png')) return '.png';
  if (type.includes('gif')) return '.gif';
  if (type.includes('webp')) return '.webp';
  if (type.includes('bmp')) return '.bmp';
  return '.jpg';
}

function truncateText(value) {
  const text = String(value || '');
  if (text.length <= MAX_TEXT_CHARACTERS) return text;
  return `${text.slice(0, MAX_TEXT_CHARACTERS)}\n\n> 文档内容超过索引上限，后续内容未写入检索 Markdown；原始文件已完整保留。`;
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function readTextFile(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) return buffer.subarray(3).toString('utf8');
  if (buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  if (buffer.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { return new TextDecoder('gb18030').decode(buffer); }
}

function arrayOf(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function naturalCompare(left, right) {
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
}

function unsupportedDocumentError(file, reason = '不支持该文档格式') {
  const error = new Error(`${path.basename(file || '') || '文件'}：${reason}。支持图片、PDF、DOCX、PPTX、XLSX/XLSM、Markdown 和常见文本格式。`);
  error.code = 'UNSUPPORTED_LOCAL_DOCUMENT';
  return error;
}

function stableDocumentId(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 20);
}

module.exports = {
  DOCUMENT_EXTENSIONS,
  IMAGE_EXTENSIONS,
  documentKind,
  importDocument,
  inspectDocument,
  stableDocumentId
};
