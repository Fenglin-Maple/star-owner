function promoteMindMap(markdown) {
  const source = String(markdown || '');
  const headings = [...source.matchAll(/^##\s+(.+?)\s*$/gm)];
  if (!headings.length) return source;

  const prefix = source.slice(0, headings[0].index);
  const sections = headings.map((match, index) => ({
    title: match[1].trim(),
    content: source.slice(match.index, headings[index + 1]?.index ?? source.length).trimEnd()
  }));
  const mindMapIndex = sections.findIndex((section) => section.title === '思维导图');
  const contentsIndex = sections.findIndex((section) => section.title === '目录');
  if (mindMapIndex < 0 || contentsIndex < 0 || mindMapIndex < contentsIndex) return source;

  const [mindMap] = sections.splice(mindMapIndex, 1);
  const nextContentsIndex = sections.findIndex((section) => section.title === '目录');
  sections.splice(nextContentsIndex, 0, mindMap);
  return `${prefix}${sections.map((section) => section.content).join('\n\n')}\n`;
}

function wrapMarkdownTables(renderer, className = 'rag-table-wrap') {
  renderer.renderer.rules.table_open = () => `<div class="${className}"><table>\n`;
  renderer.renderer.rules.table_close = () => '</table></div>\n';
  return renderer;
}

module.exports = { promoteMindMap, wrapMarkdownTables };
