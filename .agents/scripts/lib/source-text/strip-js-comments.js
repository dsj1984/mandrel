// .agents/scripts/lib/source-text/strip-js-comments.js
/**
 * The one string-literal-aware JS comment stripper, for guards that grep for
 * a pattern in real code (so a guard's own rationale cannot satisfy it).
 *
 * Every comment character except newlines becomes a space, so line, column
 * and byte offsets all survive. Literals pass through verbatim, honouring
 * escapes. An unterminated comment or literal runs to end of input rather
 * than throwing — files may be mid-edit. Builtins only, so it runs before a
 * consumer's install.
 */

/**
 * @param {string} text
 * @returns {string}
 */
function blank(text) {
  return text.replace(/[^\n]/g, ' ');
}

/**
 * @param {string} text
 * @param {number} start - index of the opening quote
 * @returns {number} index just past the literal, or end of input.
 */
function endOfLiteral(text, start) {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i += 1;
  }
  return text.length;
}

/**
 * @param {string} source - JavaScript source text. Nullish is treated as empty.
 * @returns {string} the source with every comment body blanked to whitespace
 */
export function stripJsComments(source) {
  const text = String(source ?? '');
  let out = '';
  let i = 0;

  while (i < text.length) {
    const two = text.slice(i, i + 2);

    if (two === '//') {
      const newline = text.indexOf('\n', i);
      const stop = newline === -1 ? text.length : newline;
      out += blank(text.slice(i, stop));
      i = stop;
      continue;
    }

    if (two === '/*') {
      const close = text.indexOf('*/', i + 2);
      const stop = close === -1 ? text.length : close + 2;
      out += blank(text.slice(i, stop));
      i = stop;
      continue;
    }

    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const stop = endOfLiteral(text, i);
      out += text.slice(i, stop);
      i = stop;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}
