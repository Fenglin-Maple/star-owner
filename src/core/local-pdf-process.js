const fs = require('fs');
const pdf = require('pdf-parse');

const MAX_PDF_TEXT_CHARACTERS = 8 * 1024 * 1024;
const file = process.argv[2];

Promise.resolve()
  .then(async () => {
    if (!file) throw new Error('PDF 文件路径缺失。');
    const result = await pdf(fs.readFileSync(file));
    return {
      text: String(result.text || '').slice(0, MAX_PDF_TEXT_CHARACTERS),
      numpages: Number(result.numpages || 0),
      info: result.info || null
    };
  })
  .then((result) => process.stdout.write(JSON.stringify(result)))
  .catch((error) => {
    process.stderr.write(error.message || String(error));
    process.exitCode = 1;
  });
