/**
 * lib/audit-suite/frontmatter-lint.js — workflow frontmatter linter.
 *
 * Lives next to `frontmatter.js` but stays in its own module so adding
 * lints doesn't drag the summary helper's maintainability score down.
 * Pure: no IO, no provider calls, safe to unit-test in isolation.
 *
 * Story #1324, Epic #1185 — Dispatch performance pass.
 *
 * Story #2824, Epic #2815 — Model-hint frontmatter was removed from
 * every workflow and from the validator's field list. The function is
 * retained as a no-op safety net so callers (and any future frontmatter
 * lints) keep a stable entry point.
 */

import { extractFrontmatter } from './frontmatter.js';

/**
 * Pure: lint a frontmatter map (or raw workflow content). Currently a
 * no-op — no frontmatter fields are validated after the model-hint
 * removal. The signature is preserved so future field-level lints can
 * slot in without churning callers.
 *
 * @param {string | Record<string, string>} input
 * @returns {{ ok: boolean, errors: Array<{ field: string, value: string, message: string }> }}
 */
export function validateFrontmatter(input) {
  // Extract so callers still pay the same "is this parseable?" cost as
  // before; we just have no field-level rules to enforce right now.
  if (typeof input === 'string') extractFrontmatter(input);
  return { ok: true, errors: [] };
}
