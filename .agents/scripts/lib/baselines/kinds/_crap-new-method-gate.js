/** The gate `compareCrap` applies to a method with no baseline row. A leaf. */

import picomatch from 'picomatch';
import { canonicalizeBaselinePath } from '../path-canon.js';

/**
 * Files whose every measured method is at 0% coverage (no test loads them).
 * `coverage: null` rows do not vote: unmeasured is not zero.
 *
 * @param {Array<{file: string, coverage?: number|null}>} currentRows
 * @returns {Set<string>}
 */
export function deriveUncoveredFiles(currentRows) {
  const allZeroByFile = new Map();
  for (const row of currentRows ?? []) {
    if (typeof row?.coverage !== 'number') continue;
    const soFar = allZeroByFile.get(row.file);
    allZeroByFile.set(row.file, (soFar ?? true) && row.coverage === 0);
  }
  const uncovered = new Set();
  for (const [file, allZero] of allZeroByFile) {
    if (allZero) uncovered.add(file);
  }
  return uncovered;
}

/**
 * The score a new method meets the ceiling with: measured CRAP, or complexity
 * `c` alone in a wholly uncovered file listed in `untestableWiringGlobs`. At
 * zero coverage CRAP is `c² + c`, which caps untestable wiring (argv, spawn,
 * `main()`) at `c ≈ 5`. Gate-only: the persisted row keeps the measured CRAP.
 *
 * @param {{file: string, crap: number, cyclomatic?: number}} row
 * @param {Set<string>} uncoveredFiles
 * @param {string[]} [untestableWiringGlobs]
 * @returns {number}
 */
export function newMethodGateScore(
  row,
  uncoveredFiles,
  untestableWiringGlobs = [],
) {
  const relieved =
    uncoveredFiles.has(row.file) &&
    isUntestableWiring(row.file, untestableWiringGlobs);
  return relieved ? complexityScore(row) : row.crap;
}

function complexityScore(row) {
  return Number.isFinite(row.cyclomatic) ? row.cyclomatic : row.crap;
}

function isUntestableWiring(file, globs) {
  return globs.length > 0 && matchesAny(file, globs);
}

function matchesAny(file, globs) {
  return picomatch.isMatch(canonicalizeBaselinePath(file), globs, {
    dot: true,
  });
}

/**
 * `gateScore` is set only when it differs from `crap`, so the printer names
 * the number that actually failed.
 *
 * @param {object} row
 * @param {number} ceiling
 * @param {number} gateScore
 * @returns {object}
 */
export function buildNewViolation(row, ceiling, gateScore) {
  return {
    ...row,
    kind: 'new',
    baseline: null,
    ceiling,
    ...(gateScore === row.crap ? {} : { gateScore }),
  };
}

/**
 * @param {{crap: number, gateScore?: number}} v
 * @returns {string}
 */
export function formatNewViolationMeasure(v) {
  if (v.gateScore === undefined) return `crap=${v.crap.toFixed(2)}`;
  return `complexity=${v.gateScore} (file has no coverage; crap=${v.crap.toFixed(2)})`;
}
