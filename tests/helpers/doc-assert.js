/**
 * tests/helpers/doc-assert.js — line-wrap-independent assertions over
 * markdown prose.
 *
 * ## Why
 *
 * The workflow-doc tests assert that a shipped `.md` says a thing — for
 * example that `deliver.md` matches "derived level", any run of characters,
 * then "review depth".
 *
 * That reads as a claim about **content**, but it is silently a claim about
 * **layout**: the docs are hard-wrapped at ~80 columns, so the moment a
 * paragraph re-flows and puts "review" at the end of one line and "depth" at
 * the start of the next, the literal space in the pattern stops matching and a
 * correct edit goes red. The remedy the failure suggests — move a word to the
 * previous line — protects nothing and teaches nothing.
 *
 * The workaround had already leaked into the suite by hand, inconsistently:
 * patterns that spell the gap as an explicit whitespace class ("never the
 * authoring", `\s*\n?\s*`, "transcript") instead of a plain space. Each of
 * those is one author remembering the trap; every plain-spaced pattern next to
 * them is one who did not, and is waiting to fire on the next doc trim.
 *
 * Negative assertions carry the same bug pointing the other way, which is
 * worse: `assert.doesNotMatch(md, /git merge --no-ff/)` is a guard against a
 * forbidden phrase creeping back, and it **misses** an occurrence that happens
 * to straddle a wrap. Normalising makes those guards strictly stronger.
 *
 * ## What this does
 *
 * Match against a copy of the source whose whitespace runs are collapsed to
 * single spaces, so a pattern can be written the way the sentence reads. And
 * fail with the pattern and a short message rather than `assert.match`'s
 * whole-file dump — an 8KB blob in the terminal buries the one line that
 * matters.
 *
 * ## When NOT to use it
 *
 * Whenever the whitespace **is** the assertion: fenced code blocks, indented
 * command examples, table column layout, or a heading that must sit at the
 * start of a line. Normalising flattens exactly the structure those tests
 * exist to pin. Keep plain `assert.match` there — this helper is for prose.
 */

import { AssertionError } from 'node:assert';
import { readFileSync } from 'node:fs';

/**
 * Collapse every whitespace run (including newlines) to a single space and
 * trim the ends, so a pattern written as one sentence matches prose however
 * the markdown happens to be wrapped.
 *
 * @param {string} source Raw document text.
 * @returns {string}
 */
export function normalizeProse(source) {
  return String(source ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Read a doc from disk. Convenience so a call site needs one import. */
export function readDoc(filePath) {
  return readFileSync(filePath, 'utf8');
}

/**
 * Short, quotable context for a failure message — never the whole document.
 *
 * @param {string} normalized
 * @param {RegExp} pattern
 * @returns {string}
 */
function contextFor(normalized, pattern) {
  // For a negative assertion the match is what the caller needs to see; for a
  // positive one there is nothing to show, so report the size instead so a
  // truncated/empty read is distinguishable from a genuine content gap.
  const hit = normalized.match(pattern);
  return hit
    ? `matched: "${hit[0].slice(0, 160)}"`
    : `(searched ${normalized.length} chars of normalized prose)`;
}

/**
 * Assert that `source` contains `pattern`, ignoring how it is line-wrapped.
 *
 * Signature-compatible with `assert.match`, so migrating a call site is a
 * rename.
 *
 * @param {string} source Raw document text.
 * @param {RegExp} pattern Written as the sentence reads — plain spaces.
 * @param {string} [message] What the document is supposed to be saying, and
 *   why it matters. Shown verbatim on failure.
 */
export function assertDocMentions(source, pattern, message) {
  const normalized = normalizeProse(source);
  if (pattern.test(normalized)) return;
  throw new AssertionError({
    message: `${message ?? 'document is missing required content'}\n  expected to find: ${pattern}\n  ${contextFor(normalized, pattern)}`,
    operator: 'assertDocMentions',
    stackStartFn: assertDocMentions,
  });
}

/**
 * Assert that `source` does NOT contain `pattern`, ignoring line wrapping —
 * so a forbidden phrase cannot hide by straddling a line break.
 *
 * Signature-compatible with `assert.doesNotMatch`, so migrating a call site is
 * a rename.
 *
 * @param {string} source Raw document text.
 * @param {RegExp} pattern The phrase that must not appear.
 * @param {string} [message] Why the phrase is forbidden.
 */
export function assertDocOmits(source, pattern, message) {
  const normalized = normalizeProse(source);
  if (!pattern.test(normalized)) return;
  throw new AssertionError({
    message: `${message ?? 'document contains forbidden content'}\n  expected NOT to find: ${pattern}\n  ${contextFor(normalized, pattern)}`,
    operator: 'assertDocOmits',
    stackStartFn: assertDocOmits,
  });
}
