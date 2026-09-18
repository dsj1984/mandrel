/**
 * pinned-identifier-lint.js — advisory lint flagging `acceptance[]` items that
 * name an internal symbol. Acceptance is binding while `changes[]` is only a
 * sketch the deliverer may rename, so a pinned symbol breaks under a legal
 * refactor. Findings are warnings only. Pure, synchronous, no I/O.
 *
 * @module lib/orchestration/pinned-identifier-lint
 */

/**
 * A code span containing any of these names a path/glob, dotted key or
 * filename, label, kebab token or flag, command, or field reference — never a
 * source identifier.
 */
const NON_IDENTIFIER_MARKERS = /[/.:\-\s[\]]/;

/** A bare source identifier, with an optional call suffix stripped. */
const BARE_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * UPPER_SNAKE is exempt: env vars and constants share the shape, and warning
 * on every `DATABASE_URL` costs more than it catches.
 */
const UPPER_SNAKE_RE = /^[A-Z0-9_$]+$/;

/** A case transition separates an identifier from a quoted prose word. */
const CASE_TRANSITION_RE = /[a-z][A-Z]/;

const MESSAGE_HEAD = 'Acceptance item pins the internal identifier(s) ';
const MESSAGE_TAIL =
  '; `changes[]` is an advisory sketch the deliverer may reshape, so assert ' +
  'the observable behaviour instead of the symbol that implements it.';

/**
 * @param {string} item
 * @returns {string[]}
 */
function codeSpans(item) {
  return [...String(item ?? '').matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
}

/**
 * Conservative: a false positive costs a dismissable warning, while flagging
 * paths or commands would train authors to ignore the lint.
 *
 * @param {string} span
 * @returns {boolean}
 */
function isPinnedIdentifier(span) {
  const token = span.trim().replace(/\(\s*\)$/, '');
  return (
    !NON_IDENTIFIER_MARKERS.test(token) &&
    BARE_IDENTIFIER_RE.test(token) &&
    !UPPER_SNAKE_RE.test(token) &&
    CASE_TRANSITION_RE.test(token)
  );
}

/**
 * Top-level `acceptance[]` wins (it is synced into the body only at
 * assembly); the parsed body covers an inline draft.
 *
 * @param {object} story The raw draft ticket.
 * @param {object} body Its parsed body.
 * @returns {string[]}
 */
function resolveAcceptance(story, body) {
  if (Array.isArray(story?.acceptance)) return story.acceptance;
  return Array.isArray(body?.acceptance) ? body.acceptance : [];
}

/**
 * One finding per offending acceptance item.
 *
 * @param {object} story The raw draft ticket.
 * @param {object} body Its parsed body.
 * @param {string} slug
 * @param {(text: string) => string} excerpt Evidence truncator shared with
 *   the sibling lints.
 * @returns {Array<{ kind: 'pinned-identifier', slug: string, evidence: string, message: string }>}
 */
export function findPinnedIdentifiers(story, body, slug, excerpt) {
  const acceptance = resolveAcceptance(story, body);
  const findings = [];
  for (const item of acceptance) {
    const pinned = codeSpans(item).filter(isPinnedIdentifier);
    if (pinned.length === 0) continue;
    const named = pinned.map((name) => `\`${name}\``).join(', ');
    findings.push({
      kind: 'pinned-identifier',
      slug,
      evidence: excerpt(String(item ?? '')),
      message: `${MESSAGE_HEAD}${named}${MESSAGE_TAIL}`,
    });
  }
  return findings;
}
