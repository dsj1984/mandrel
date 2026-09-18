/**
 * footer-block.js — the Story body's `---` footer grammar, shared by the body
 * parser and the dispatch-edge parser so they cannot disagree. Dependency
 * edges are declared only by an exact line in the footer; an unanchored body
 * scan turned any sentence mentioning a blocker into a real dispatch gate.
 *
 * @module lib/story-body/footer-block
 */

// Anchored at both ends: `Blocked by: #N` or `blocked by #N once X` declare
// nothing.
const FOOTER_BLOCKED_BY_LINE_RE = /^blocked by\s+(#\d+)$/i;

const FOOTER_RULE_RE = /^---\s*$/;

const FOOTER_KEY_RE = /^(parent:|Epic:|blocked by)/im;

/**
 * A `---` counts only when later lines start with a footer key, so a mid-body
 * thematic break is not mistaken for the footer.
 *
 * @param {string} line
 * @param {string[]} lines
 * @param {number} index
 * @returns {boolean}
 */
export function isFooterSeparator(line, lines, index) {
  if (!FOOTER_RULE_RE.test(line)) return false;
  return FOOTER_KEY_RE.test(lines.slice(index + 1).join('\n'));
}

/**
 * @param {string} body
 * @returns {string} everything after the footer separator, or ''.
 */
function extractFooterBlock(body) {
  if (!body) return '';
  const lines = String(body).split('\n');
  const start = lines.findIndex((line, i) => isFooterSeparator(line, lines, i));
  return start === -1 ? '' : lines.slice(start + 1).join('\n');
}

/**
 * @param {string} footerBlock
 * @returns {string[]} `"#N"` refs, as `depends_on` round-trips them.
 */
export function parseFooterBlockedByRefs(footerBlock) {
  if (!footerBlock) return [];
  return String(footerBlock)
    .split('\n')
    .map((line) => line.trim().match(FOOTER_BLOCKED_BY_LINE_RE)?.[1])
    .filter((ref) => typeof ref === 'string');
}

/**
 * @param {string} body
 * @returns {number[]} deduped blocker issue numbers.
 */
export function parseFooterBlockedByIds(body) {
  const ids = parseFooterBlockedByRefs(extractFooterBlock(body)).map((ref) =>
    Number.parseInt(ref.slice(1), 10),
  );
  return [...new Set(ids)];
}
