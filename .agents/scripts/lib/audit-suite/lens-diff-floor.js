/**
 * lib/audit-suite/lens-diff-floor.js — the close-scope lens diff-floor
 * (Story #4699).
 *
 * ## Why this exists
 *
 * The Story-scope local-lens pass materialized ~28 KB of lens prompts per
 * close while sampled closes yielded almost zero findings — and none above
 * Suggestion severity. The cheapest correct response is a deterministic
 * floor: a *small* diff that touches *no* sensitive path earns no lens
 * materialization at all. The floor is measured in **changed lines**
 * (additions + deletions across the diff); the floor is the fixed
 * {@link DEFAULT_LENS_DIFF_FLOOR} (Story #5382 folded the never-set
 * `delivery.review.lensDiffFloor` key), and a caller-injected `0` disables
 * the skip entirely.
 *
 * ## Fail-open contract
 *
 * The skip only fires on positive evidence that the diff is small and
 * non-sensitive. Every degraded input — an unknown line count, an
 * unreadable manifest, a disabled floor — resolves to "do not skip", so a
 * measurement failure can never buy a change less review. Sensitive-path
 * hits are matched with the same `sensitivePaths` classes the review-depth
 * derivation reads (`selectSensitivePathClasses`), so the floor and the
 * depth tiering can never disagree about what "sensitive" means.
 *
 * All exports are total: no throws, no I/O beyond the injected git spawn in
 * {@link countChangedLines}.
 */

import { gitSpawn } from '../git-utils.js';
import { readNumstatRows } from '../orchestration/diff-magnitude.js';
import { selectSensitivePathClasses } from './selector.js';

/**
 * Default changed-line floor below which a non-sensitive diff skips lens
 * materialization. Chosen from the measured distribution (Story #4699): the
 * sampled zero-yield closes clustered well under this size.
 */
export const DEFAULT_LENS_DIFF_FLOOR = 40;

/**
 * Count the changed lines (additions + deletions) in the
 * `baseRef...headRef` diff via `git diff --numstat`.
 *
 * The read and the parse are shared with the light path's magnitude backstop
 * ({@link module:lib/orchestration/diff-magnitude.readNumstatRows}) so the two
 * cannot disagree about how a diff is measured. This one keeps a whole-diff
 * total: the lens floor asks "is this diff small", not "is its implementation
 * half small", so it deliberately does **not** apply the companion exemption.
 *
 * Total — never throws. Returns `null` (the neutral "count unknown" signal
 * the floor fails open on) for any git failure or unparseable output, and
 * `0` for a genuinely empty diff. Binary rows (`-\t-\tpath`) contribute 0
 * text lines but do not poison the parse.
 *
 * @param {{
 *   baseRef: string,
 *   headRef: string,
 *   cwd?: string,
 *   gitSpawnFn?: typeof gitSpawn,
 * }} args
 * @returns {number|null}
 */
export function countChangedLines({
  baseRef,
  headRef,
  cwd = process.cwd(),
  gitSpawnFn = gitSpawn,
} = {}) {
  const rows = readNumstatRows({ baseRef, headRef, cwd, gitSpawnFn });
  if (rows === null) return null;
  return rows.reduce((total, row) => total + row.additions + row.deletions, 0);
}

/**
 * Decide whether the close-scope lens pass should skip materialization for
 * this diff. Skips **only** when all of the following hold:
 *
 *   1. The floor is enabled (`floor > 0`).
 *   2. The changed-line count is *known* and strictly below the floor.
 *   3. The changed-file set intersects **zero** registered sensitive-path
 *      classes (`audit-rules.json#sensitivePaths`).
 *
 * Every other state — floor disabled, unknown count, at-or-above floor, a
 * sensitive-path hit — resolves to `skip: false` with a named reason, so
 * the verdict is auditable in the findings-yield ledger.
 *
 * Pure and total: never throws (a throwing sensitive-path matcher degrades
 * to "not skippable").
 *
 * @param {{
 *   changedFiles?: string[]|null,
 *   changedLineCount?: number|null,
 *   floor?: number,
 *   injectedRules?: object,
 *   selectSensitivePathClassesFn?: typeof selectSensitivePathClasses,
 * }} [input]
 * @returns {{
 *   skip: boolean,
 *   reason: 'floor-disabled'|'line-count-unknown'|'at-or-above-floor'|'sensitive-classes-unknown'|'sensitive-path-hit'|'below-floor',
 *   floor: number,
 *   changedLineCount: number|null,
 *   sensitiveClasses: string[],
 * }}
 */
export function evaluateLensDiffFloor(input = {}) {
  const floorRaw = input.floor;
  const floor =
    typeof floorRaw === 'number' && Number.isInteger(floorRaw) && floorRaw >= 0
      ? floorRaw
      : DEFAULT_LENS_DIFF_FLOOR;
  const count =
    typeof input.changedLineCount === 'number' &&
    Number.isFinite(input.changedLineCount) &&
    input.changedLineCount >= 0
      ? Math.floor(input.changedLineCount)
      : null;
  const verdict = (skip, reason, sensitiveClasses = []) => ({
    skip,
    reason,
    floor,
    changedLineCount: count,
    sensitiveClasses,
  });

  if (floor <= 0) return verdict(false, 'floor-disabled');
  if (count === null) return verdict(false, 'line-count-unknown');
  if (count >= floor) return verdict(false, 'at-or-above-floor');

  const select =
    input.selectSensitivePathClassesFn ?? selectSensitivePathClasses;
  let classes;
  try {
    classes = select({
      changedFiles: Array.isArray(input.changedFiles) ? input.changedFiles : [],
      injectedRules: input.injectedRules,
    });
  } catch {
    // An unreadable manifest is not evidence the change is safe to skip.
    return verdict(false, 'sensitive-classes-unknown');
  }
  const matched = Array.isArray(classes) ? classes : [];
  if (matched.length > 0) {
    return verdict(false, 'sensitive-path-hit', matched);
  }
  return verdict(true, 'below-floor');
}
