/**
 * Pure frontmatter + workflow-summary helpers; keep free of cross-module
 * imports.
 */

// RegExp constructors, not literals: typhonjs-escomplex crashes on
// `RegExpLiteral` and scores the file MI=0.
// biome-ignore-start lint/complexity/useRegexLiterals: typhonjs-escomplex MI workaround
const FRONTMATTER_RE = new RegExp(String.raw`^---\r?\n([\s\S]*?)\r?\n---\r?\n`);
const NEWLINE_SPLIT_RE = new RegExp(String.raw`\r?\n`);
const SENTENCE_RE = new RegExp(String.raw`[^.!?\n]+[.!?]+`, 'g');
// biome-ignore-end lint/complexity/useRegexLiterals: typhonjs-escomplex MI workaround

const SUMMARY_MAX_SENTENCES = 3;
const SUMMARY_MAX_CHARS = 280;

/**
 * Flat key→value map; quotes unwrapped, `:`-less lines skipped.
 *
 * @param {string} content
 * @returns {Record<string, string>}
 */
export function extractFrontmatter(content) {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return {};
  const fm = {};
  for (const line of match[1].split(NEWLINE_SPLIT_RE)) {
    const eq = line.indexOf(':');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fm[key] = value;
  }
  return fm;
}

/**
 * @param {string} text
 * @returns {string}
 */
export function clampSummary(text) {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const sentences = trimmed.match(SENTENCE_RE);
  let result = sentences
    ? sentences.slice(0, SUMMARY_MAX_SENTENCES).join(' ').trim()
    : trimmed;
  if (result.length > SUMMARY_MAX_CHARS) {
    result = `${result.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
  }
  return result;
}
