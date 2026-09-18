/**
 * Close-scope lens diff-floor: a diff under the changed-line floor that
 * touches no sensitive path skips lens materialization. Fail-open — every
 * degraded input (unknown count, unreadable manifest, floor `0`) means "do
 * not skip". Sensitive classes come from the same selector as review depth,
 * so the two never disagree. Total; no I/O beyond the injected git spawn.
 */

import { gitSpawn } from '../git-utils.js';
import { readNumstatRows } from '../orchestration/diff-magnitude.js';
import { selectSensitivePathClasses } from './selector.js';

/** Measured: zero-yield closes clustered well under this size. */
export const DEFAULT_LENS_DIFF_FLOOR = 40;

/**
 * Whole-diff additions + deletions (no companion exemption: the question is
 * "is this diff small"). Shares the numstat parse with the light path's
 * backstop. `null` on any git failure; binary rows count 0.
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
 * Skip only when the floor is enabled, the count is known and below it, and
 * no sensitive-path class matches; every other state names its reason.
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
    return verdict(false, 'sensitive-classes-unknown');
  }
  const matched = Array.isArray(classes) ? classes : [];
  if (matched.length > 0) {
    return verdict(false, 'sensitive-path-hit', matched);
  }
  return verdict(true, 'below-floor');
}
