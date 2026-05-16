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
import { write, writeFile } from './baselines/writer.js';

export const COVERAGE_FINAL_PATH = 'coverage/coverage-final.json';
export const COVERAGE_BASELINE_PATH = 'baselines/coverage.json';
// Absolute floating-point tolerance (percentage points). Values in the
// baseline are stored to two decimals, so anything below 0.01 is noise.
export const COVERAGE_TOLERANCE = 0.01;
// Noise headroom (in instrumentation events) granted to small-denominator
// files. A file with N branches has a per-event resolution of 100/N% — one
// branch flipping covered↔uncovered between runs is the natural noise floor
// under non-deterministic Windows/Node 22 V8 instrumentation. We absorb up
// to one event of slack per axis. Anything beyond one event is real signal.
export const NOISE_EVENT_HEADROOM = 1.0;

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
  return {
    lines: pct(lC, lT),
    branches: pct(bC, bT),
    functions: pct(fC, fT),
    denominators: { lines: lT, branches: bT, functions: fT },
  };
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
 *
 * Story #1737: the per-file gate now reads `coveragePath` from
 * `delivery.quality.gates.coverage` instead of the hardcoded
 * `coverage/coverage-final.json`. Callers pass the resolved path via
 * `opts.coveragePath`; the legacy default is preserved for tests that
 * still spin up a tmp tree without a config.
 */
export function readCoverageFinal(cwd, opts = {}, fsImpl) {
  const resolvedFs = fsImpl ?? fs;
  const coveragePath =
    typeof opts === 'string'
      ? opts
      : (opts?.coveragePath ?? COVERAGE_FINAL_PATH);
  const abs = path.isAbsolute(coveragePath)
    ? coveragePath
    : path.resolve(cwd, coveragePath);
  if (!resolvedFs.existsSync(abs)) {
    throw new Error(
      `coverage-final.json not found at ${abs}. Run \`npm run test:coverage\` first.`,
    );
  }
  return JSON.parse(resolvedFs.readFileSync(abs, 'utf8'));
}

/**
 * Read the baseline. Returns `null` (not `{}`) when the file is
 * missing so the checker can distinguish "no baseline yet" (warn +
 * pass) from "baseline exists but is empty" (treat every in-scope
 * file as new = fail).
 */
function isEnvelopeShape(parsed) {
  return (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    Array.isArray(parsed.rows) &&
    typeof parsed.$schema === 'string'
  );
}

function projectEnvelopeToFlat(envelope) {
  const out = {};
  for (const row of envelope.rows) {
    if (!row || typeof row.path !== 'string') continue;
    out[row.path] = {
      lines: row.lines,
      branches: row.branches,
      functions: row.functions,
    };
  }
  return out;
}

function normaliseParsedBaseline(parsed) {
  // Story #1891: the writer ships envelope-shape baselines
  // (`$schema`, `kernelVersion`, `generatedAt`, `rollup`, `rows`). The
  // legacy reader contract returns a flat `{ file: { lines, branches,
  // functions } }` map, so we project rows back to that shape for
  // backwards-compatible consumers (Story #1892 migrates them off the
  // flat shape).
  return isEnvelopeShape(parsed) ? projectEnvelopeToFlat(parsed) : parsed;
}

export function readBaseline(cwd, fsImpl = fs) {
  const abs = path.resolve(cwd, COVERAGE_BASELINE_PATH);
  if (!fsImpl.existsSync(abs)) return null;
  return normaliseParsedBaseline(JSON.parse(fsImpl.readFileSync(abs, 'utf8')));
}

function projectFlatToRows(baseline) {
  return Object.entries(baseline ?? {}).map(([file, scores]) => {
    const { denominators: _ignored, ...rest } = scores ?? {};
    return {
      path: file,
      lines: rest.lines ?? 0,
      branches: rest.branches ?? 0,
      functions: rest.functions ?? 0,
    };
  });
}

function writeEnvelopeViaFsImpl(abs, envelope, fsImpl) {
  fsImpl.mkdirSync(path.dirname(abs), { recursive: true });
  const canonical = {
    $schema: envelope.$schema,
    kernelVersion: envelope.kernelVersion,
    generatedAt: envelope.generatedAt,
    rollup: envelope.rollup,
    rows: envelope.rows,
  };
  fsImpl.writeFileSync(abs, `${JSON.stringify(canonical, null, 2)}\n`);
}

function dispatchEnvelopeWrite(abs, envelope, fsImpl) {
  // Honour the injected fsImpl seam for tests that pass `memfs` or a spy —
  // fall through to the writer's atomic write when `fsImpl === fs`.
  return fsImpl === fs
    ? writeFile(abs, envelope)
    : writeEnvelopeViaFsImpl(abs, envelope, fsImpl);
}

// Story #1974 — read prior envelope rows[] for epsilon + scope merge.
// Returns `null` on read or parse failure (regression-fail-safe).
function readPriorRows(abs, fsImpl) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(abs, 'utf8'));
    return Array.isArray(parsed?.rows) ? parsed.rows : null;
  } catch {
    return null;
  }
}

export function writeBaseline(cwd, baseline, fsImpl = fs, opts = {}) {
  const abs = path.resolve(cwd, COVERAGE_BASELINE_PATH);
  // Story #1891: route through the shared baseline writer (envelope shape).
  // Story #1974: optional `opts.scope` / `opts.epsilon` thread through so
  // manual refreshes can opt in to diff-scoped writes + epsilon
  // stabilization; absent both, behaviour is identical to pre-#1974.
  const prior =
    opts.prior !== undefined ? opts.prior : readPriorRows(abs, fsImpl);
  const envelope = write({
    kind: 'coverage',
    rows: projectFlatToRows(baseline),
    prior: prior ?? undefined,
    epsilon: prior && opts.epsilon !== undefined ? opts.epsilon : undefined,
    scope: opts.scope,
  });
  dispatchEnvelopeWrite(abs, envelope, fsImpl);
  return abs;
}

/**
 * Compute the per-axis tolerance (in percentage points) for a file.
 *
 * Small-denominator files (a handful of branches, statements, or functions)
 * are dominated by single-instrumentation-event noise: one branch flipping
 * covered↔uncovered between Windows/Node 22 CI runs is worth `100/N`
 * percentage points. We absorb up to `NOISE_EVENT_HEADROOM` events of slack
 * — anything beyond that is real signal. Large files retain the strict
 * `COVERAGE_TOLERANCE` floor (essentially zero) because their per-event
 * resolution is already sub-percent.
 *
 * Exported for tests.
 */
export function axisToleranceFor(
  denominator,
  baseTolerance = COVERAGE_TOLERANCE,
) {
  if (!Number.isFinite(denominator) || denominator <= 0) return baseTolerance;
  const eventResolution = 100 / denominator;
  return Math.max(baseTolerance, eventResolution * NOISE_EVENT_HEADROOM);
}

/**
 * Compare current per-file scores to the baseline and classify each
 * file. The classification feeds the CLI's exit-code decision and the
 * human-readable summary.
 *
 *   regressions  — file in both, any axis dropped > per-axis tolerance.
 *                  Per-axis tolerance is denominator-aware: a file with
 *                  N branches gets up to 100/N percentage points of slack
 *                  (one instrumentation event), so single-event Node 22
 *                  CI flap on tiny files no longer trips the gate.
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
    const denominators = scores?.denominators ?? {};
    for (const axis of /** @type {const} */ ([
      'lines',
      'branches',
      'functions',
    ])) {
      const c = scores[axis];
      const b = base[axis];
      if (c === null || c === undefined) continue;
      if (b === null || b === undefined) continue;
      const axisTol = axisToleranceFor(denominators[axis], tolerance);
      if (c < b - axisTol)
        drops.push({
          axis,
          current: c,
          baseline: b,
          drop: b - c,
          tolerance: axisTol,
        });
      else if (c > b + axisTol) anyImprovement = true;
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
