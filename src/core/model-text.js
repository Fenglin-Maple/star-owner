const LEADING_MODEL_FORMATTING = /^(\s*)(?:[\u200b-\u200d\u2060\ufeff])+/u;

// Some OpenAI-compatible gateways prefix generated text with invisible formatting characters.
// Keep the cleanup limited to the output boundary so content inside the answer is preserved.
function stripLeadingModelFormatting(value) {
  let text = String(value ?? '');
  let previous = '';
  while (text !== previous) {
    previous = text;
    text = text.replace(LEADING_MODEL_FORMATTING, '$1');
  }
  return text;
}

module.exports = { stripLeadingModelFormatting };
