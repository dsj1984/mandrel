/**
 * Pure helpers for the per-file coverage baseline gate.
 *
 * The gate replaces c8's global `lines/branches/functions` thresholds
 * with per-file floors recorded in `baselines/coverage.json`, mirroring
 * how `baselines/maintainability.json` tracks per-file MI scores.
 *
 * Scoring inputs:
 *   - `coverage/coverage-final.json` written by `c8 report` (every file
 *     c8 instrumented during the run, regardless of include/exclude).
 *   - `.c8rc.cjs` `include` / `exclude` globs — applied here so the
 *     baseline only records the same scope `c8 report --include=…` prints.
 *
 * Imported by `update-coverage-baseline.js` (writes the baseline) and
 * `check-coverage-baseline.js` (compares current → baseline). Kept pure
 * so the regression-comparison logic is unit-testable without spawning
 * the full coverage pipeline.
 */

import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';

export const COVERAGE_FINAL_PATH = 'coverage/coverage-final.json';
export const COVERAGE_BASELINE_PATH = 'baselines/coverage.json';
// Absolute floating-point tolerance (percentage points). Values in the
// baseline are stored to two decimals, so anything below 0.01 is noise.
export const COVERAGE_TOLERANCE = 0.01;

function toForwardSlash(p) {
  return p.replace(/\\/g, '/');
}

/**
 * Build a (file → bool) predicate from c8 `include` / `exclude` glob
 * arrays. Mirrors c8's own scope rule: a file is in scope when at least
 * one `include` matches AND no `exclude` matches. Uses picomatch with
 * c8's defaults (`dot: true` so dotfiles like `.agents/...` match).
 */
export function buildScopePredicate({ include = [], exclude = [] } = {}) {
  const inc =
    include.length === 0 ? () => true : picomatch(include, { dot: true });
  const exc =
    exclude.length === 0 ? () => false : picomatch(exclude, { dot: true });
  return (relPath) => {
    const norm = toForwardSlash(relPath);
    return inc(norm) && !exc(norm);
  };
}

/**
 * Given one entry from `coverage-final.json` (the per-file istanbul
 * record), compute `{ lines, branches, functions }` percentages.
 *
 * Definitions match what `c8 check-coverage` enforces:
 *   - lines:     covered statements   / total statements
 *   - branches:  covered branch arms  / total branch arms (b is a map of arrays)
 *   - functions: covered functions    / total functions
 *
 * Returns `null` for any axis that has no denominators (a file with
 * zero functions has no defined function-coverage). The caller should
 * treat `null` axes as a no-op when comparing.
 */
export function scoreEntry(entry) {
  const sMap = entry?.s ?? {};
  const bMap = entry?.b ?? {};
  const fMap = entry?.f ?? {};

  let lT = 0;
  let lC = 0;
  for (const v of Object.values(sMap)) {
    lT += 1;
    if (v > 0) lC += 1;
  }
  let bT = 0;
  let bC = 0;
  for (const arr of Object.values(bMap)) {
    if (!Array.isArray(arr)) continue;
    for (const v of arr) {
      bT += 1;
      if (v > 0) bC += 1;
    }
  }
  let fT = 0;
  let fC = 0;
  for (const v of Object.values(fMap)) {
    fT += 1;
    if (v > 0) fC += 1;
  }
  const pct = (c, t) => (t === 0 ? null : Number(((100 * c) / t).toFixed(2)));
  return { lines: pct(lC, lT), branches: pct(bC, bT), functions: pct(fC, fT) };
}

/**
 * Convert the raw `coverage-final.json` payload into a `{ relPath →
 * {lines, branches, functions} }` map, dropping any entry that fails
 * the c8 scope predicate. `cwd` is the repo root; entry keys in
 * coverage-final.json are absolute paths and need relativising to
 * match the baseline file's stable, repo-relative keys.
 */
export function scoreCoverageFinal({ raw, cwd, scope }) {
  const inScope = scope ?? buildScopePredicate({});
  const out = {};
  for (const [absPath, entry] of Object.entries(raw ?? {})) {
    const rel = toForwardSlash(path.relative(cwd, absPath));
    if (!inScope(rel)) continue;
    out[rel] = scoreEntry(entry);
  }
  return out;
}

/**
 * Read + parse `coverage-final.json`. Throws a helpful error when the
 * file is missing — that's the operator-facing signal that they need
 * to run `npm run test:coverage` first.
 */
export function readCoverageFinal(cwd, fsImpl = fs) {
  const abs = path.resolve(cwd, COVERAGE_FINAL_PATH);
  if (!fsImpl.existsSync(abs)) {
    throw new Error(
      `coverage-final.json not found at ${abs}. Run \`npm run test:coverage\` first.`,
    );
  }
  return JSON.parse(fsImpl.readFileSync(abs, 'utf8'));
}

/**
 * Read the baseline. Returns `null` (not `{}`) when the file is
 * missing so the checker can distinguish "no baseline yet" (warn +
 * pass) from "baseline exists but is empty" (treat every in-scope
 * file as new = fail).
 */
export function readBaseline(cwd, fsImpl = fs) {
  const abs = path.resolve(cwd, COVERAGE_BASELINE_PATH);
  if (!fsImpl.existsSync(abs)) return null;
  return JSON.parse(fsImpl.readFileSync(abs, 'utf8'));
}

export function writeBaseline(cwd, baseline, fsImpl = fs) {
  const abs = path.resolve(cwd, COVERAGE_BASELINE_PATH);
  fsImpl.mkdirSync(path.dirname(abs), { recursive: true });
  // Sorted keys keep diffs stable run-to-run.
  const sorted = Object.fromEntries(
    Object.entries(baseline).sort(([a], [b]) => a.localeCompare(b)),
  );
  fsImpl.writeFileSync(abs, `${JSON.stringify(sorted, null, 2)}\n`);
  return abs;
}

/**
 * Compare current per-file scores to the baseline and classify each
 * file. The classification feeds the CLI's exit-code decision and the
 * human-readable summary.
 *
 *   regressions  — file in both, any axis dropped > tolerance.
 *   newFiles     — file in current, missing from baseline. The CLI
 *                  treats this as a hard failure ("run coverage:update")
 *                  because a brand-new untested CLI shell would
 *                  otherwise sail through with 0% coverage.
 *   removedFiles — file in baseline, missing from current. Usually
 *                  benign (file deleted or renamed); the CLI reports
 *                  but does not fail on these.
 *   improvements — file in both, every axis ≥ baseline + tolerance on
 *                  the axes both records have. Reported for visibility
 *                  so operators know when to ratchet.
 */
export function compareScores(
  current,
  baseline,
  tolerance = COVERAGE_TOLERANCE,
) {
  const regressions = [];
  const newFiles = [];
  const improvements = [];
  const removedFiles = [];

  for (const [file, scores] of Object.entries(current)) {
    const base = baseline[file];
    if (base === undefined) {
      newFiles.push({ file, current: scores });
      continue;
    }
    const drops = [];
    let anyImprovement = false;
    for (const axis of /** @type {const} */ ([
      'lines',
      'branches',
      'functions',
    ])) {
      const c = scores[axis];
      const b = base[axis];
      if (c === null || c === undefined) continue;
      if (b === null || b === undefined) continue;
      if (c < b - tolerance)
        drops.push({ axis, current: c, baseline: b, drop: b - c });
      else if (c > b + tolerance) anyImprovement = true;
    }
    if (drops.length > 0) {
      regressions.push({ file, drops });
    } else if (anyImprovement) {
      improvements.push({ file });
    }
  }
  for (const file of Object.keys(baseline)) {
    if (current[file] === undefined) removedFiles.push({ file });
  }

  return { regressions, newFiles, improvements, removedFiles };
}
