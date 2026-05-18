/**
 * filters.js — pure branch-filter helpers for git-cleanup (Story #2466).
 *
 * Exports `buildGlobFilter`, `computeProtectedSet`, and
 * `computeProtectedReason` — extracted verbatim from `git-cleanup.js`
 * so the named-export contract stays byte-identical.
 *
 * @module lib/orchestration/git-cleanup/phases/filters
 */

import picomatch from 'picomatch';

/**
 * Pure: build a `(branch) => boolean` filter from include/exclude globs.
 */
export function buildGlobFilter({ include = [], exclude = [] } = {}) {
  const includeMatch = include.length > 0 ? picomatch(include) : () => true;
  const excludeMatch = exclude.length > 0 ? picomatch(exclude) : () => false;
  return (branch) => includeMatch(branch) && !excludeMatch(branch);
}

/**
 * Pure: compute the protected-branch skip set.
 */
export function computeProtectedSet({ baseBranch, currentBranch, configured }) {
  const set = new Set();
  if (baseBranch) set.add(baseBranch);
  if (currentBranch) set.add(currentBranch);
  for (const name of configured ?? []) {
    if (name) set.add(name);
  }
  return set;
}

/**
 * Pure: classify why a branch is protected. Returns `null` when the
 * branch is NOT protected, otherwise one of:
 *
 *   - `'protected'`    — base branch or in `branch.protectedBranches`.
 *   - `'current-head'` — current HEAD (and not also base / configured).
 *
 * The `'current-head'` reason is split out so `renderDryRun` can emit a
 * remediation hint distinct from the generic `'protected'` line.
 */
export function computeProtectedReason({
  baseBranch,
  currentBranch,
  configured,
  branch,
}) {
  if (!branch) return null;
  if (baseBranch && branch === baseBranch) return 'protected';
  if (Array.isArray(configured) && configured.includes(branch))
    return 'protected';
  if (currentBranch && branch === currentBranch) return 'current-head';
  return null;
}
