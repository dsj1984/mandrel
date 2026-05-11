/**
 * lib/audit-suite/frontmatter-lint.js — model-hint frontmatter linter.
 *
 * Lives next to `frontmatter.js` but stays in its own module so adding
 * the lint doesn't drag the summary helper's maintainability score
 * down. Pure: no IO, no provider calls, safe to unit-test in isolation.
 *
 * Story #1324, Epic #1185 — Dispatch performance pass.
 */

import { extractFrontmatter } from './frontmatter.js';

/** Allowed values for `recommendedModel` and `dispatchModel`. */
export const ALLOWED_MODEL_HINTS = Object.freeze(['haiku', 'sonnet', 'opus']);

const MODEL_HINT_FIELDS = Object.freeze(['recommendedModel', 'dispatchModel']);

/**
 * Pure: lint a frontmatter map (or raw workflow content) for model-hint
 * correctness. Unset fields pass. Set fields must use one of the
 * allowed enum values; arbitrary strings are rejected with a clear
 * enum-violation error.
 *
 * @param {string | Record<string, string>} input
 * @returns {{ ok: boolean, errors: Array<{ field: string, value: string, message: string }> }}
 */
export function validateFrontmatter(input) {
  const fm = typeof input === 'string' ? extractFrontmatter(input) : input;
  const errors = MODEL_HINT_FIELDS.filter((f) => f in fm)
    .filter((f) => !ALLOWED_MODEL_HINTS.includes(fm[f]))
    .map((field) => ({
      field,
      value: fm[field],
      message: `Invalid ${field}: "${fm[field]}". Expected one of ${ALLOWED_MODEL_HINTS.join(', ')}.`,
    }));
  return { ok: errors.length === 0, errors };
}
