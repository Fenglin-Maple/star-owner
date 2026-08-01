const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');
const mammoth = require('mammoth');
const { nodeChildProcessSpec, resolveSystemExecutable } = require('./child-process-io');
const { assertInside, assertSafeWindowsPath, ensureDir, safeName } = require('./workspace');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.xml', '.yaml', '.yml', '.log', '.ini', '.toml', '.html', '.htm']);
const DOCUMENT_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...TEXT_EXTENSIONS, '.pdf', '.docx', '.pptx', '.xlsx', '.xlsm']);
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_TEXT_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_OFFICE_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_TEXT_CHARACTERS = 8 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 5000;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_OFFICE_ENTRY_BYTES = 96 * 1024 * 1024;
const MAX_OFFICE_XML_BYTES = 32 * 1024 * 1024;
const MAX_OFFICE_MEDIA_BYTES = 64 * 1024 * 1024;
const MAX_OFFICE_MEDIA_FILES = 500;
const MAX_SPREADSHEET_ROWS = 100000;
const MAX_SPREADSHEET_CELLS_PER_ROW = 10000;
const MAX_CELL_CHARACTERS = 10000;
const MAX_SHARED_STRING_ENTRIES = 200000;
const MAX_SHARED_STRING_CHARACTERS = 8 * 1024 * 1024;
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
  if (kind === 'text' && stat.size > MAX_TEXT_SOURCE_BYTES) throw unsupportedDocumentError(source, '文本文件超过 64 MiB 导入上限');
  if (['word', 'powerpoint', 'excel'].includes(kind) && stat.size > MAX_OFFICE_SOURCE_BYTES) throw unsupportedDocumentError(source, 'Office 文件超过 128 MiB 导入上限');
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
  assertDocumentNotCancelled(metadata.signal);
  const root = ensureDir(artifactDir);
  const originalDir = ensureDir(path.join(root, 'original'));
  const assetsDir = ensureDir(path.join(root, 'assets'));
  const originalName = safeName(source.name, `source${source.extension}`, 120);
  const originalFile = assertSafeWindowsPath(path.join(originalDir, originalName), '本地文档原件路径');
  fs.copyFileSync(source.path, originalFile);
  const importedAt = metadata.importedAt || new Date().toISOString();
  assertDocumentNotCancelled(metadata.signal);
  const extraction = await extractDocument(source, assetsDir, metadata.signal);
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

async function extractDocument(source, assetsDir, signal) {
  assertDocumentNotCancelled(signal);
  if (source.kind === 'image') {
    validateImageSignature(source.path, source.extension);
    const target = copyAsset(source.path, assetsDir, source.name);
    return { markdown: `## 图片原图\n\n![${source.title}](assets/${encodeURIComponent(path.basename(target))})`, assets: [target], warnings: [] };
  }
  if (source.kind === 'markdown') return importMarkdown(source.path, assetsDir, signal);
  if (source.kind === 'text') {
    const markdown = readTextFile(source.path);
    assertDocumentNotCancelled(signal);
    return { markdown, assets: [], warnings: [] };
  }
  if (source.kind === 'pdf') {
    const result = await parsePdf(source.path, signal);
    return { markdown: `## PDF 文本\n\n${result.text || ''}`, assets: [], warnings: result.text ? [] : ['PDF 中没有提取到文本，可能是扫描件。'] };
  }
  if (source.kind === 'word') return importWord(source.path, assetsDir, signal);
  if (source.kind === 'powerpoint') return importPowerPoint(source.path, assetsDir, signal);
  return importSpreadsheet(source.path, assetsDir, signal);
}

async function importWord(file, assetsDir, signal) {
  await loadOfficeZip(file, signal);
  const assets = [];
  let imageIndex = 0;
  const result = await mammoth.convertToMarkdown({ path: file }, {
    convertImage: mammoth.images.imgElement(async (image) => {
      assertDocumentNotCancelled(signal);
      const extension = imageExtensionFromContentType(image.contentType);
      const target = path.join(assetsDir, `word-image-${String(++imageIndex).padStart(3, '0')}${extension}`);
      const buffer = await image.read();
      validateImageSignatureBuffer(buffer, extension);
      fs.writeFileSync(target, buffer);
      assets.push(target);
      return { src: `assets/${path.basename(target)}` };
    })
  });
  assertDocumentNotCancelled(signal);
  return {
    markdown: `## Word 文档内容\n\n${result.value || ''}`,
    assets,
    warnings: (result.messages || []).map((item) => String(item.message || item)).slice(0, 50)
  };
}

async function importPowerPoint(file, assetsDir, signal) {
  const zip = await loadOfficeZip(file, signal);
  const slideFiles = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).sort(naturalCompare);
  const sections = [];
  const outputBudget = { characters: 0 };
  let outputTruncated = false;
  for (const [index, name] of slideFiles.entries()) {
    assertDocumentNotCancelled(signal);
    const xml = await readZipText(zip, name, MAX_OFFICE_XML_BYTES, 'PPTX 幻灯片 XML', signal);
    const values = collectXmlText(xmlParser.parse(xml), [], MAX_TEXT_CHARACTERS).map(cleanText).filter(Boolean);
    outputTruncated = !appendBoundedSection(sections, `## 幻灯片 ${index + 1}\n\n${values.length ? values.join('\n\n') : '_这一页没有可提取文字。_'}`, outputBudget);
    if (outputTruncated) break;
  }
  const assets = await copyZipMedia(zip, /^ppt\/media\//i, assetsDir, 'slide', signal);
  const gallery = assets.length
    ? `\n\n## 演示文稿内嵌图片\n\n${assets.map((item, index) => `![PPT 图片 ${index + 1}](assets/${encodeURIComponent(path.basename(item))})`).join('\n\n')}`
    : '';
  return { markdown: `${sections.join('\n\n')}${gallery}`, assets, warnings: [...(slideFiles.length ? [] : ['PPTX 中没有找到幻灯片 XML。']), ...(outputTruncated ? ['PPTX 文本超过索引上限，后续幻灯片未写入索引。'] : [])] };
}

async function importSpreadsheet(file, assetsDir, signal) {
  const zip = await loadOfficeZip(file, signal);
  const sharedResult = await readSharedStrings(zip, signal);
  const shared = sharedResult.values;
  const sheetFiles = Object.keys(zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)).sort(naturalCompare);
  const sections = [];
  const outputBudget = { characters: 0 };
  let outputTruncated = false;
  let rowsTruncated = false;
  let cellsTruncated = false;
  for (const [index, name] of sheetFiles.entries()) {
    assertDocumentNotCancelled(signal);
    const xml = await readZipText(zip, name, MAX_OFFICE_XML_BYTES, 'Excel 工作表 XML', signal);
    const parsed = xmlParser.parse(xml);
    const allRows = arrayOf(parsed?.worksheet?.sheetData?.row);
    const rows = allRows.slice(0, MAX_SPREADSHEET_ROWS);
    if (rows.length < allRows.length) rowsTruncated = true;
    const lines = [];
    for (const row of rows) {
      assertDocumentNotCancelled(signal);
      const allCells = arrayOf(row.c);
      const cells = allCells.slice(0, MAX_SPREADSHEET_CELLS_PER_ROW);
      if (cells.length < allCells.length) cellsTruncated = true;
      const line = cells.map((cell) => spreadsheetCellValue(cell, shared, () => { cellsTruncated = true; })).join('\t');
      if (line.trim()) lines.push(line);
    }
    outputTruncated = !appendBoundedSection(sections, `## 工作表 ${index + 1}\n\n\`\`\`tsv\n${lines.join('\n')}\n\`\`\``, outputBudget);
    if (outputTruncated) break;
  }
  const assets = await copyZipMedia(zip, /^xl\/media\//i, assetsDir, 'sheet', signal);
  const gallery = assets.length
    ? `\n\n## 工作簿内嵌图片\n\n${assets.map((item, index) => `![Excel 图片 ${index + 1}](assets/${encodeURIComponent(path.basename(item))})`).join('\n\n')}`
    : '';
  const warnings = [...(sheetFiles.length ? [] : ['工作簿中没有找到可读取的工作表。'])];
  if (rowsTruncated) warnings.push('工作簿包含超过单表读取上限的行，后续行未写入索引。');
  if (cellsTruncated) warnings.push('工作簿包含超过单行读取上限的单元格或超长单元格，部分内容未写入索引。');
  if (sharedResult.truncated) warnings.push('工作簿共享字符串超过读取上限，部分单元格文本未写入索引。');
  if (outputTruncated) warnings.push('Excel 文本超过索引上限，后续工作表未写入索引。');
  return { markdown: `${sections.join('\n\n')}${gallery}`, assets, warnings };
}

async function parsePdf(file, signal) {
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
    let timer = null;
    const onAbort = () => finish(abortDocumentError());
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      terminateChildProcess(child);
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
    timer = setTimeout(() => {
      const error = new Error('PDF 文本解析超过 120 秒，已停止该文件导入。');
      error.code = 'LOCAL_PDF_PARSE_TIMEOUT';
      finish(error);
    }, 120000);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function importMarkdown(file, assetsDir, signal) {
  assertDocumentNotCancelled(signal);
  const sourceRoot = path.dirname(file);
  const assets = [];
  const warnings = [];
  let markdown = readTextFile(file);
  assertDocumentNotCancelled(signal);
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

async function loadOfficeZip(file, signal) {
  assertDocumentNotCancelled(signal);
  const zip = await JSZip.loadAsync(fs.readFileSync(file), { checkCRC32: false, createFolders: false });
  const entries = Object.values(zip.files).filter((item) => !item.dir);
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error(`Office 文档包含过多条目（${entries.length}/${MAX_ZIP_ENTRIES}）。`);
  let expanded = 0;
  let mediaFiles = 0;
  for (const entry of entries) {
    assertDocumentNotCancelled(signal);
    const size = zipEntryUncompressedSize(entry);
    const name = String(entry.name || '');
    const isXml = /\.xml$/i.test(name);
    const isMedia = /^(?:word|ppt|xl)\/media\//i.test(name);
    const perEntryLimit = isXml ? MAX_OFFICE_XML_BYTES : (isMedia ? MAX_OFFICE_MEDIA_BYTES : MAX_OFFICE_ENTRY_BYTES);
    if (isMedia) mediaFiles += 1;
    if (size > perEntryLimit) throw new Error(`Office 文档条目过大：${name}（上限 ${Math.round(perEntryLimit / 1024 / 1024)} MiB）。`);
    expanded += size;
    if (!Number.isSafeInteger(expanded) || expanded > MAX_EXPANDED_BYTES) throw new Error('Office 文档解压后超过 512 MiB 安全上限。');
  }
  if (mediaFiles > MAX_OFFICE_MEDIA_FILES) throw new Error(`Office 文档包含过多媒体文件（${mediaFiles}/${MAX_OFFICE_MEDIA_FILES}）。`);
  return zip;
}

async function copyZipMedia(zip, pattern, assetsDir, prefix, signal) {
  const assets = [];
  const files = Object.keys(zip.files).filter((name) => pattern.test(name) && !zip.files[name].dir).sort(naturalCompare);
  for (const [index, name] of files.entries()) {
    assertDocumentNotCancelled(signal);
    const extension = path.extname(name).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension)) continue;
    const entry = zip.files[name];
    const declaredSize = zipEntryUncompressedSize(entry);
    if (declaredSize > MAX_OFFICE_MEDIA_BYTES) throw new Error(`Office 媒体条目过大：${name}（上限 ${Math.round(MAX_OFFICE_MEDIA_BYTES / 1024 / 1024)} MiB）。`);
    const target = uniqueAssetPath(assetsDir, `${prefix}-image-${String(index + 1).padStart(3, '0')}${extension}`);
    const buffer = await entry.async('nodebuffer');
    assertDocumentNotCancelled(signal);
    if (buffer.length > MAX_OFFICE_MEDIA_BYTES) throw new Error(`Office 媒体条目过大：${name}。`);
    validateImageSignatureBuffer(buffer, extension);
    fs.writeFileSync(target, buffer);
    assets.push(target);
  }
  return assets;
}

async function readSharedStrings(zip, signal) {
  const file = zip.file('xl/sharedStrings.xml');
  if (!file) return { values: [], truncated: false };
  const xml = await readZipText(zip, 'xl/sharedStrings.xml', MAX_OFFICE_XML_BYTES, 'Excel 共享字符串 XML', signal);
  const parsed = xmlParser.parse(xml);
  const values = [];
  let characters = 0;
  let truncated = false;
  for (const item of arrayOf(parsed?.sst?.si)) {
    assertDocumentNotCancelled(signal);
    if (values.length >= MAX_SHARED_STRING_ENTRIES || characters >= MAX_SHARED_STRING_CHARACTERS) {
      truncated = true;
      break;
    }
    const text = collectXmlText(item, [], MAX_CELL_CHARACTERS).join('');
    const remaining = MAX_SHARED_STRING_CHARACTERS - characters;
    const value = text.slice(0, remaining);
    if (value.length < text.length) truncated = true;
    values.push(value);
    characters += value.length;
  }
  if (values.length < arrayOf(parsed?.sst?.si).length) truncated = true;
  return { values, truncated };
}

function spreadsheetCellValue(cell, shared, onTruncated) {
  const type = cell?.['@_t'] || '';
  if (type === 'inlineStr') return boundedCellValue(collectXmlText(cell?.is, [], MAX_CELL_CHARACTERS).join(''), onTruncated);
  const raw = cell?.v === undefined ? '' : String(cell.v);
  if (type === 's') return boundedCellValue(shared[Number(raw)] || '', onTruncated);
  if (type === 'b') return '1' === raw ? 'TRUE' : 'FALSE';
  return boundedCellValue(raw, onTruncated);
}

function collectXmlText(value, output = [], maximumCharacters = MAX_TEXT_CHARACTERS) {
  if (!Object.prototype.hasOwnProperty.call(output, '_characters')) Object.defineProperty(output, '_characters', { value: 0, writable: true });
  if (value === null || value === undefined) return output;
  if (typeof value === 'string' || typeof value === 'number') {
    appendXmlText(output, String(value), maximumCharacters);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectXmlText(item, output, maximumCharacters);
      if (output._characters >= maximumCharacters) break;
    }
    return output;
  }
  if (typeof value === 'object') {
    if (value.t !== undefined) {
      for (const item of arrayOf(value.t)) {
        appendXmlText(output, typeof item === 'object' ? String(item['#text'] || '') : String(item), maximumCharacters);
        if (output._characters >= maximumCharacters) break;
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (output._characters >= maximumCharacters) break;
      if (!['t', '#text'].includes(key) && !key.startsWith('@_')) collectXmlText(child, output, maximumCharacters);
    }
  }
  return output;
}

function appendXmlText(output, value, maximumCharacters) {
  const remaining = Math.max(0, maximumCharacters - output._characters);
  if (!remaining) return;
  const text = String(value || '').slice(0, remaining);
  if (text) output.push(text);
  output._characters += text.length;
}

function boundedCellValue(value, onTruncated) {
  const text = String(value || '');
  if (text.length <= MAX_CELL_CHARACTERS) return text;
  onTruncated?.();
  return text.slice(0, MAX_CELL_CHARACTERS);
}

async function readZipText(zip, name, maximumBytes, label, signal) {
  assertDocumentNotCancelled(signal);
  const entry = zip.file(name);
  if (!entry) throw new Error(`${label}缺失：${name}。`);
  const declaredSize = zipEntryUncompressedSize(entry);
  if (declaredSize > maximumBytes) throw new Error(`${label}超过 ${Math.round(maximumBytes / 1024 / 1024)} MiB 上限：${name}。`);
  const buffer = await entry.async('nodebuffer');
  assertDocumentNotCancelled(signal);
  if (buffer.length > maximumBytes) throw new Error(`${label}超过 ${Math.round(maximumBytes / 1024 / 1024)} MiB 上限：${name}。`);
  return buffer.toString('utf8');
}

function appendBoundedSection(sections, section, budget, maximumCharacters = MAX_TEXT_CHARACTERS) {
  const text = String(section || '');
  const remaining = Math.max(0, maximumCharacters - Number(budget.characters || 0));
  if (text.length <= remaining) {
    sections.push(text);
    budget.characters = Number(budget.characters || 0) + text.length;
    return true;
  }
  const notice = '\n\n> 文档内容超过索引上限，后续内容未写入检索 Markdown；原始文件已完整保留。';
  const available = Math.max(0, remaining - notice.length);
  if (available > 0) sections.push(`${text.slice(0, available)}${notice}`);
  budget.characters = maximumCharacters;
  return false;
}

function zipEntryUncompressedSize(entry) {
  const size = Number(entry?._data?.uncompressedSize);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Office 文档条目缺少有效解压大小信息：${entry?.name || '未知条目'}。`);
  return size;
}

function assertDocumentNotCancelled(signal) {
  if (signal?.aborted) throw abortDocumentError();
}

function abortDocumentError() {
  const error = new Error('本地文档导入已取消。');
  error.code = 'LOCAL_DOCUMENT_CANCELLED';
  return error;
}

function terminateChildProcess(child) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') {
    const taskkill = resolveSystemExecutable('taskkill.exe');
    if (taskkill) {
      try {
        const result = spawnSync(taskkill, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
        if (result.status === 0) return;
      } catch {}
    }
  }
  try { child.kill(process.platform === 'win32' ? undefined : 'SIGTERM'); } catch {}
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
