/**
 * lib/audit-suite/frontmatter.js — Markdown frontmatter + summary helpers.
 *
 * Extracted from `.agents/scripts/run-audit-suite.js` (Story #963, Epic #946).
 * Pure module — no IO, no provider calls, safe to unit-test in isolation.
 *
 * The functions here are the parsing seam used by the audit suite to derive
 * a 1–3-sentence summary from a workflow's `description` frontmatter field
 * (falling back to its first prose paragraph). Keep them tiny and free of
 * cross-module imports so the audit-suite entry-point stays orchestration-only.
 */

// All RegExp instances are built via the constructor (rather than literal
// `/.../`) so the maintainability engine's AST walker (typhonjs-escomplex) can
// score this file. The walker has a long-standing bug where it crashes on
// RegExp literals via `RegExpLiteral`, returning MI=0 — see the parse-time
// fallback in lib/maintainability-engine.js#calculateForSource.
// biome-ignore-start lint/complexity/useRegexLiterals: typhonjs-escomplex MI workaround
const FRONTMATTER_RE = new RegExp(String.raw`^---\r?\n([\s\S]*?)\r?\n---\r?\n`);
const NEWLINE_SPLIT_RE = new RegExp(String.raw`\r?\n`);
const PARAGRAPH_SPLIT_RE = new RegExp(String.raw`\r?\n\s*\r?\n`);
const COLLAPSE_WS_RE = new RegExp(String.raw`\s+`, 'g');
const SENTENCE_RE = new RegExp(String.raw`[^.!?\n]+[.!?]+`, 'g');
// biome-ignore-end lint/complexity/useRegexLiterals: typhonjs-escomplex MI workaround

const SUMMARY_MAX_SENTENCES = 3;
const SUMMARY_MAX_CHARS = 280;

/**
 * Pure: parse a workflow's leading `---` frontmatter block into a flat
 * key→value map. Quoted values are unwrapped; entries without a `:` separator
 * are skipped. Returns `{}` when no frontmatter is present.
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
 * Pure: find the first prose paragraph after the frontmatter block, skipping
 * headings and `---` rules. Whitespace inside the paragraph is collapsed to
 * single spaces. Returns `''` when the body is empty / heading-only.
 *
 * @param {string} content
 * @returns {string}
 */
export function firstProseParagraph(content) {
  const stripped = content.replace(FRONTMATTER_RE, '');
  for (const block of stripped.split(PARAGRAPH_SPLIT_RE)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('---')) continue;
    return trimmed.replace(COLLAPSE_WS_RE, ' ');
  }
  return '';
}

/**
 * Pure: trim a candidate summary to at most three sentences and 280 chars.
 * Sentences are matched by `[^.!?\n]+[.!?]+`; bare paragraphs that contain no
 * terminator are returned verbatim (subject to the char clamp). The 280-char
 * trim appends an ellipsis to signal truncation to readers.
 *
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

/**
 * Pure: derive a 1–3-sentence summary from a workflow's frontmatter
 * `description` field, falling back to the first prose paragraph.
 *
 * @param {string} content
 * @returns {string}
 */
export function summarizeWorkflow(content) {
  const fm = extractFrontmatter(content);
  const candidate = fm.description?.trim() || firstProseParagraph(content);
  return clampSummary(candidate);
}
