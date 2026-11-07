/**
 * Per-kind module for the CRAP baseline. In-memory row shape:
 * `{ path, method, crap }`; on disk the rows are grouped by path (see
 * `_crap-codec.js`). `startLine` lives on scan rows only.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COVERAGE_CAPTURE_DEFAULTS } from '../../config/gates/coverage.schema.js';
import { deriveFixGuidance } from '../../crap-engine.js';
import { methodStem } from '../../crap-method-identity.js';
import { resolveEscomplexVersion } from '../../crap-utils.js';
import { Logger } from '../../Logger.js';
import { resolveTsTranspilerVersion } from '../../transpile.js';
import {
  kernelDriftAxis,
  missingBaselineAxis,
  reduceCompatAxes,
} from '../envelope.js';
import { canonicalise } from '../path-canon.js';
import { mergeRowsByScope } from '../scope.js';
import { compareCrapRows } from './_crap-codec.js';
import {
  buildNewViolation,
  deriveUncoveredFiles,
  formatNewViolationMeasure,
  newMethodGateScore,
} from './_crap-new-method-gate.js';
import { classifyScoringSemantics, SCORING_SEMANTICS } from './_crap-read.js';
import {
  makeAggregate,
  makeEpsilon,
  makeRollup,
  percentile,
} from './_shared-metric.js';

export const name = 'crap';
export const keyField = 'path';

export { aheadStampOf, loadCrapBaseline } from './_crap-read.js';

const __filename = fileURLToPath(import.meta.url);

/**
 * Scorer version, walked up from this module's directory; the `'0.0.0'`
 * sentinel (unknown environment) makes the writer refuse to persist. The
 * walk-up can escape a worktree into the parent checkout, so a local pass
 * does not prove CI's.
 *
 * @returns {string}
 */
export function kernelVersion() {
  return resolveEscomplexVersion(path.dirname(__filename));
}

/**
 * Envelope stamps this kind adds, consumed by `writer.write`. A transpiler
 * change can rename or re-nest emitted methods, which moves scope-path keys,
 * so `tsTranspilerVersion` is stamped for the `ts-transpiler-drift` axis.
 * `ctx` carries the scan's `cwd` / `targetDirs` so the stamp names the
 * compiler the scorer resolved.
 *
 * @param {{ cwd?: string, targetDirs?: string[] }} [ctx]
 * @returns {{scoringSemantics: string, tsTranspilerVersion: string}}
 */
export function envelopeExtras(ctx = {}) {
  return {
    scoringSemantics: SCORING_SEMANTICS,
    tsTranspilerVersion: resolveTsTranspilerVersion(ctx),
  };
}

/** Project a scan row onto the persisted row shape. */
export function projectRow(row) {
  return {
    path: canonicalise(row.path ?? row.file),
    method: row.method,
    crap: row.crap,
  };
}

export function sortRows(rows) {
  return [...rows].sort(compareCrapRows);
}

export { percentile };

const aggregate = makeAggregate({
  fields: [
    {
      rowKey: 'crap',
      percentiles: [50, 95],
      extras: (sorted) => ({
        max: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
        methodsAbove20: sorted.filter((c) => c > 20).length,
      }),
    },
  ],
});

export const rollup = makeRollup({ aggregate });

/**
 * Pure compare(head, base); higher CRAP is worse. Rows pair through
 * {@link compareCrap}'s stem-bucket alignment, so an inserted namesake does
 * not mis-pair its siblings by ordinal. New methods are `additions`.
 */
export function compare(head, base) {
  const headRows = rowsOf(head);
  const baseRows = rowsOf(base);
  const pairs = pairByStem(headRows, baseRows);
  const out = {
    regressions: [],
    improvements: [],
    unchanged: [],
    additions: [],
  };
  for (const row of headRows) binHeadRow(out, row, pairs.get(row));
  const claimed = new Set(pairs.values());
  for (const b of baseRows) {
    if (!claimed.has(b)) binRemovedRow(out, b);
  }
  return out;
}

function rowsOf(snapshot) {
  return Array.isArray(snapshot?.rows) ? snapshot.rows : [];
}

/** Head rows grouped with base rows by `[path, method stem]`. */
function stemBuckets(headRows, baseRows) {
  const buckets = new Map();
  const bucketOf = (r) => {
    const key = JSON.stringify([r.path, methodStem(r.method)]);
    if (!buckets.has(key)) buckets.set(key, { cur: [], base: [] });
    return buckets.get(key);
  };
  for (const b of baseRows) bucketOf(b).base.push(b);
  for (const row of headRows) bucketOf(row).cur.push({ row });
  return buckets.values();
}

function pairByStem(headRows, baseRows) {
  const pairs = new Map();
  for (const { cur, base } of stemBuckets(headRows, baseRows)) {
    const curSorted = cur.sort((a, b) => byKeyOrder(a.row, b.row));
    for (const [e, b] of pairBucket(curSorted, base, 0)) pairs.set(e.row, b);
  }
  return pairs;
}

function binHeadRow(out, row, b) {
  const key = rowIdentity(row);
  if (!b) {
    out.additions.push({ key, head: row, base: null });
    return;
  }
  out[deltaBin((row.crap ?? 0) - (b.crap ?? 0))].push({
    key,
    head: row,
    base: b,
  });
}

function deltaBin(delta) {
  if (delta > 0) return 'regressions';
  return delta < 0 ? 'improvements' : 'unchanged';
}

/** A removed base row is an improvement only when it carried CRAP. */
function binRemovedRow(out, b) {
  const bin = (b.crap ?? 0) > 0 ? 'improvements' : 'unchanged';
  out[bin].push({ key: rowIdentity(b), head: null, base: b });
}

/**
 * Canonical row identity. Distinct from `keyField` (`'path'`, the rollup
 * grouping): a file has one row per method, so keying a merge on `keyField`
 * would collapse them.
 *
 * @param {{path: string, method: string}} row
 * @returns {string}
 */
export function rowIdentity(row) {
  return `${row.path}::${row.method}`;
}

/**
 * Sub-epsilon CRAP deltas resolve to the prior row bytes.
 *
 * @param {Array<{path: string, method: string, crap: number}>} prior
 * @param {Array<{path: string, method: string, crap: number}>} regenerated
 * @param {number} epsilon non-negative absolute tolerance on CRAP
 * @returns {Array<object>}
 */
export const applyEpsilon = makeEpsilon({
  identity: rowIdentity,
  metricField: 'crap',
});

/**
 * Scope-aware merge: identity is per method, but scope filters on `path`
 * alone (a diff names files), so out-of-scope files keep every prior row.
 *
 * @param {Array<{path: string, method: string, crap: number}>} prior
 * @param {Array<{path: string, method: string, crap: number}>} regenerated
 * @param {{mode: 'full'|'diff', files: Set<string>}|null|undefined} scope
 * @returns {Array<object>}
 */
export function mergeRows(prior, regenerated, scope) {
  return mergeRowsByScope({
    prior,
    regenerated,
    scope,
    scopeKey: (row) => row.path,
    identity: (row) => rowIdentity(row),
  });
}

// CLI-facing pure helpers for `check-crap.js`.

/**
 * Narrow rows to those whose `file` is in `scopeSet`. Apply to both scan and
 * baseline rows, or untouched files surface as "removed" on a scoped run.
 *
 * @template {{file: string}} R
 * @param {R[]} rows
 * @param {Set<string>} scopeSet
 * @returns {R[]}
 */
export function filterRowsByFileScope(rows, scopeSet) {
  if (!scopeSet) return rows ?? [];
  return (rows ?? []).filter((r) => scopeSet.has(r.file));
}

/**
 * The violation for a (current, baseline) pair, or `null` when it passes.
 * Cyclomatic-1 methods are exempt: their CRAP is a pure coverage proxy that
 * flaps under non-deterministic V8 instrumentation on Windows CI, and a real
 * regression would add branches and lose the exemption anyway.
 *
 * @param {{cyclomatic: number, crap: number}} row
 * @param {{crap: number, method: string}} baseline
 * @param {number} tolerance
 * @param {'regression'|'drifted-regression'} kind
 * @returns {object | null}
 */
export function checkCrapRegression(row, baseline, tolerance, kind) {
  if (row?.cyclomatic === 1) return null;
  if (row.crap <= baseline.crap + tolerance) return null;
  return {
    ...row,
    kind,
    baseline: baseline.crap,
    baselineMethod: baseline.method,
  };
}

/**
 * Compare scanned rows to baseline rows. Both sides bucket by (file, stem) —
 * the key with every `#<n>` stripped — and align in order inside a bucket
 * (see {@link alignBucket}): an exact key pairs first, so an unchanged method
 * is a plain comparison; an insert, remove or reorder re-pairs its namesakes
 * (`drifted`) instead of reporting them new and removed. Unpaired current
 * rows face the new-method ceiling; unpaired baseline rows are `removed`.
 * Unscorable rows (null crap/coverage) are bucketed and excluded from
 * `comparable` so they cannot dilute a ratio.
 */
export function compareCrap({
  currentRows,
  baselineRows,
  newMethodCeiling,
  tolerance,
}) {
  const rows = currentRows ?? [];
  const state = {
    uncoveredFiles: deriveUncoveredFiles(currentRows),
    newMethodCeiling,
    tolerance: Number.isFinite(tolerance) ? tolerance : 0,
    claimed: new Set(),
    verdicts: new Array(rows.length).fill(null),
    regressions: 0,
    newViolations: 0,
    drifted: 0,
  };
  const buckets = new Map();
  const bucketOf = (file, method) => {
    const key = JSON.stringify([file, methodStem(method)]);
    if (!buckets.has(key)) buckets.set(key, { cur: [], base: [] });
    return buckets.get(key);
  };
  for (const b of baselineRows ?? []) bucketOf(b.file, b.method).base.push(b);
  const unscorableRows = [];
  for (const [idx, row] of rows.entries()) {
    if (isUnscorableRow(row)) {
      unscorableRows.push({ ...row, kind: 'unscorable' });
      continue;
    }
    bucketOf(row.file, row.method).cur.push({ idx, row });
  }
  for (const { cur, base } of buckets.values()) {
    if (cur.length > 0) alignBucket(state, cur, base);
  }

  const removedRows = (baselineRows ?? []).filter((b) => !state.claimed.has(b));
  const total = rows.length;
  return {
    total,
    // Denominator of every ratio derived from this result.
    comparable: total - unscorableRows.length,
    regressions: state.regressions,
    newViolations: state.newViolations,
    drifted: state.drifted,
    unscorable: unscorableRows.length,
    removed: removedRows.length,
    violations: state.verdicts.filter((v) => v !== null),
    unscorableRows,
    removedRows,
  };
}

/** Score one (current, baseline) pair into the verdict slot `idx`. */
function scorePair(state, idx, row, baseline, kind) {
  const v = checkCrapRegression(row, baseline, state.tolerance, kind);
  if (v) {
    state.regressions += 1;
    state.verdicts[idx] = v;
  }
}

/** A current row with no baseline row: the new-method ceiling. */
function scoreNewMethod(state, idx, row) {
  const gateScore = newMethodGateScore(row, state.uncoveredFiles);
  if (gateScore > state.newMethodCeiling + state.tolerance) {
    state.newViolations += 1;
    state.verdicts[idx] = buildNewViolation(
      row,
      state.newMethodCeiling,
      gateScore,
    );
  }
}

/**
 * Source order of a persisted key: its per-segment `#<n>` ordinals (a bare
 * segment is 0), compared left to right.
 *
 * @param {{method: string}} a
 * @param {{method: string}} b
 * @returns {number}
 */
function byKeyOrder(a, b) {
  const ords = (m) =>
    m
      .split('/')
      .flatMap((seg) =>
        (seg.match(/#\d+/g) ?? ['#0']).map((o) => Number(o.slice(1))),
      );
  const [x, y] = [ords(a.method), ords(b.method)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.method.localeCompare(b.method);
}

/**
 * Order-aware pairing inside one stem bucket — current rows by `startLine`,
 * baseline rows by key order: same key within `tolerance` first; then the
 * earliest unclaimed row within `tolerance` (a re-keyed pair — never a
 * regression); then leftovers by key, then order, scored as regressions;
 * surplus current rows are new methods, surplus baseline rows stay removed.
 */
function alignBucket(state, cur, base) {
  const curSorted = [...cur].sort((a, b) => a.row.startLine - b.row.startLine);
  const pairs = pairBucket(curSorted, base, state.tolerance);
  for (const e of curSorted) scoreAligned(state, e, pairs.get(e));
}

/** Score one current entry against the baseline row it paired with, if any. */
function scoreAligned(state, e, b) {
  if (!b) {
    scoreNewMethod(state, e.idx, e.row);
    return;
  }
  state.claimed.add(b);
  if (b.method === e.row.method) {
    scorePair(state, e.idx, e.row, b, 'regression');
    return;
  }
  state.drifted += 1;
  scorePair(state, e.idx, e.row, b, 'drifted-regression');
}

/**
 * The pairing core of {@link alignBucket}: maps each entry of `curSorted`
 * (source order) to its baseline row; an unpaired entry has no mapping.
 *
 * @param {Array<{row: {method: string, crap: number}}>} curSorted
 * @param {Array<{method: string, crap: number}>} base
 * @param {number} tol
 * @returns {Map<object, object>}
 */
function pairBucket(curSorted, base, tol) {
  const free = [...base].sort(byKeyOrder);
  const near = (row) => (b) => Math.abs(row.crap - b.crap) <= tol;
  const sameKey = (row) => (b) => b.method === row.method;
  const passes = [
    (row) => (b) => sameKey(row)(b) && near(row)(b),
    near,
    sameKey,
    () => () => true,
  ];
  const pairs = new Map();
  for (const matches of passes) {
    for (const e of curSorted) {
      if (pairs.has(e)) continue;
      const at = free.findIndex(matches(e.row));
      if (at >= 0) pairs.set(e, free.splice(at, 1)[0]);
    }
  }
  reclaimOwnRows(pairs, free, tol, curSorted);
  return pairs;
}

/**
 * A re-keyed pair must not hide an increase: a row that scored higher than
 * its own exact-key baseline row takes it back when that row went unpaired
 * (a sibling removed alongside an increase), or when the row itself went
 * unpaired because a namesake re-keyed onto it (a later namesake added
 * alongside an increase; that namesake becomes the new method). Fails safe:
 * an earlier namesake inserted more complex than the existing one reads as
 * the existing method's regression.
 */
function reclaimOwnRows(pairs, free, tol, curSorted) {
  for (const e of curSorted) {
    const mine = pairs.get(e);
    if (mine?.method === e.row.method) continue;
    const isOwnIncrease = (b) =>
      b.method === e.row.method && e.row.crap > b.crap + tol;
    const at = free.findIndex(isOwnIncrease);
    if (at >= 0) {
      pairs.set(e, free.splice(at, 1)[0]);
      if (mine) free.push(mine);
      continue;
    }
    const holder = mine
      ? undefined
      : [...pairs.keys()].find((o) => isOwnIncrease(pairs.get(o)));
    if (holder) {
      pairs.set(e, pairs.get(holder));
      pairs.delete(holder);
    }
  }
}

/**
 * Strict on `null` (the scorer's "unresolved" value); a row merely omitting
 * `coverage` stays scorable.
 *
 * @param {{crap?: number|null, coverage?: number|null, unscorable?: boolean}} row
 * @returns {boolean}
 */
function isUnscorableRow(row) {
  return (
    row?.unscorable === true || row?.crap === null || row?.coverage === null
  );
}

export const INCOMPATIBLE_BASELINE_DIAGNOSTIC = 'crap-baseline-incompatible';

export const AHEAD_BASELINE_DIAGNOSTIC = 'crap-baseline-ahead';

/**
 * The CRAP capture script an operator hint names — the resolved
 * `gates.crap.captureScript` when the caller passes it, else the coverage
 * gate's default.
 *
 * @param {{ captureScript?: string } | undefined} ctx
 * @returns {string}
 */
function captureScriptOf(ctx) {
  return typeof ctx?.captureScript === 'string' && ctx.captureScript.length > 0
    ? ctx.captureScript
    : COVERAGE_CAPTURE_DEFAULTS.captureScript;
}

/** @param {{ captureScript?: string } | undefined} ctx */
function reseedRemedy(ctx) {
  return (
    `Re-derive the baseline: run 'npm run ${captureScriptOf(ctx)}' then ` +
    "'npm run crap:update -- --full-scope' and commit the result with a " +
    "'baseline-refresh:' subject."
  );
}

/**
 * Compat axes for `evaluateBaselineCompatibility`: `{ name, severity, check }`,
 * where `check(ctx)` returns null or a failure message. The first `fatal`
 * match fails; `warn` matches accumulate. Kernel drift only warns; a
 * transpiler change is fatal because it can rename or re-nest emitted
 * methods, which moves their scope-path keys.
 */
export const CRAP_COMPAT_AXES = [
  missingBaselineAxis('CRAP'),
  kernelDriftAxis('CRAP'),
  {
    name: 'scoring-semantics-drift',
    severity: 'fatal',
    check: ({ baseline, captureScript }) => {
      if (!baseline) return null;
      const stamped = baseline.scoringSemantics ?? null;
      // `ahead` is a skip, not a failure: see `aheadStampOf`.
      if (classifyScoringSemantics(stamped) !== 'behind') return null;
      return (
        `[CRAP] scoring semantics changed: baseline=${stamped ?? '<unstamped>'} ` +
        `running=${SCORING_SEMANTICS}. Rows keyed or scored under other ` +
        'semantics (or in the previous rows[] layout) are not comparable to ' +
        'rows scored now, so this baseline cannot be compared. ' +
        reseedRemedy({ captureScript })
      );
    },
  },
  {
    name: 'ts-transpiler-drift',
    severity: 'fatal',
    check: ({ baseline, runningTsTranspilerVersion, captureScript }) => {
      if (!baseline) return null;
      if (!isKnownVersion(runningTsTranspilerVersion)) return null;
      const baselineTs = baseline.tsTranspilerVersion;
      // Unstamped: no evidence either way.
      if (!isKnownVersion(baselineTs)) return null;
      if (baselineTs === runningTsTranspilerVersion) return null;
      // A pure-JS baseline has no transpiled method to re-key.
      if (!hasTranspiledRows(baseline)) return null;
      return (
        `[CRAP] tsTranspilerVersion changed: baseline=${baselineTs} running=${runningTsTranspilerVersion}. ` +
        'A transpiler change can rename or re-nest the methods it emits, which moves their ' +
        'scope-path keys — so rows scored under the previous transpiler are not comparable ' +
        `to rows scored under this one. ${reseedRemedy({ captureScript })}`
      );
    },
  },
];

/** Sources escomplex scores through the TypeScript transpiler. */
const TRANSPILED_SOURCE_RE = /\.(?:ts|tsx|mts|cts)$/i;

/**
 * `'0.0.0'` is the "unknown environment" sentinel, not a comparable version.
 *
 * @param {unknown} version
 * @returns {boolean}
 */
function isKnownVersion(version) {
  return typeof version === 'string' && version !== '' && version !== '0.0.0';
}

/**
 * @param {{rows?: Array<{path?: string, file?: string}>}|null} baseline
 * @returns {boolean}
 */
function hasTranspiledRows(baseline) {
  return (baseline?.rows ?? []).some((row) =>
    TRANSPILED_SOURCE_RE.test(String(row?.path ?? row?.file ?? '')),
  );
}

export function evaluateBaselineCompatibility(ctx) {
  return reduceCompatAxes(CRAP_COMPAT_AXES, ctx);
}

/**
 * Axes a loaded envelope can be judged on alone. `kernel-drift` is excluded:
 * it only warns, and this pass fails closed on any message.
 */
const LOADED_ENVELOPE_AXES = ['scoring-semantics-drift', 'ts-transpiler-drift'];

/**
 * Kind-module hook: `check-baselines` calls it after `reader.load` and fails
 * closed on a message, so an incompatible baseline is never silently compared.
 *
 * @param {object|null} baseline A loaded v2 baseline envelope.
 * @param {{runningTsTranspilerVersion?: string, cwd?: string,
 *   targetDirs?: string[], captureScript?: string}} [ctx]
 * @returns {string|null} Operator-facing message, or null when compatible.
 */
export function assertBaselineCompatible(baseline, ctx = {}) {
  if (!baseline) return null;
  const runningTsTranspilerVersion =
    ctx.runningTsTranspilerVersion ?? resolveTsTranspilerVersion(ctx);
  for (const name of LOADED_ENVELOPE_AXES) {
    const axis = CRAP_COMPAT_AXES.find((a) => a.name === name);
    const message = axis?.check({
      baseline,
      runningTsTranspilerVersion,
      captureScript: ctx.captureScript,
    });
    if (message) return message;
  }
  return null;
}

/**
 * Build the `--json` report. `fixGuidance` targets the baseline for a
 * regression and the ceiling for a new method.
 */
export function buildCrapReport({
  compareResult,
  scanSummary,
  kernelVersion: kvIn,
  escomplexVersion,
  newMethodCeiling,
  scopeInfo,
}) {
  const skippedNoCoverage =
    (scanSummary?.skippedFilesNoCoverage ?? 0) +
    (scanSummary?.skippedMethodsNoCoverage ?? 0);
  const violations = (compareResult.violations ?? []).map((v) => {
    const target = v.kind === 'new' ? v.ceiling : v.baseline;
    const fixGuidance = deriveFixGuidance({
      cyclomatic: v.cyclomatic,
      target,
    });
    return {
      file: v.file,
      method: v.method,
      startLine: v.startLine,
      cyclomatic: v.cyclomatic,
      coverage: v.coverage,
      crap: v.crap,
      baseline: v.kind === 'new' ? null : v.baseline,
      ceiling: v.kind === 'new' ? v.ceiling : newMethodCeiling,
      kind: v.kind,
      fixGuidance,
    };
  });
  // Consumers merging with the peer MI envelope need to know the scope.
  const scope = scopeInfo?.scope === 'full' ? 'full' : 'diff';
  const diffRef = scope === 'full' ? null : (scopeInfo?.diffRef ?? null);
  return {
    kernelVersion: kvIn,
    escomplexVersion,
    summary: {
      total: compareResult.total,
      regressions: compareResult.regressions,
      newViolations: compareResult.newViolations,
      drifted: compareResult.drifted,
      // Kept for report-schema stability; no coordinate arm remains.
      incomparable: 0,
      provenanceMismatched: 0,
      // Never scored from an assumed zero coverage.
      unscorable: (compareResult.unscorable ?? 0) + skippedNoCoverage,
      removed: compareResult.removed,
      skippedNoCoverage,
      scope,
      diffRef,
    },
    violations,
  };
}

/**
 * Replace per-method verdicts with one diagnostic, keeping the counts as
 * evidence. Used when the baseline is incompatible or stamped ahead.
 *
 * @param {object} envelope
 * @param {{name: string, message: string}} diagnostic
 * @returns {object}
 */
export function suppressVerdicts(envelope, diagnostic) {
  return {
    ...envelope,
    summary: {
      ...envelope.summary,
      regressions: 0,
      newViolations: 0,
    },
    violations: [],
    diagnostics: [diagnostic],
  };
}

export function printSummaryHeader(result, scanSummary) {
  Logger.info('\n--- CRAP Report ---');
  Logger.info(`Total methods scanned: ${result.total}`);
  Logger.info(`Regressions:           ${result.regressions}`);
  Logger.info(`New-method violations: ${result.newViolations}`);
  Logger.info(`Re-keyed (matched):    ${result.drifted}`);
  Logger.info(`Unscorable (no cov):   ${result.unscorable ?? 0}`);
  Logger.info(`Removed from baseline: ${result.removed}`);
  if (scanSummary?.skippedFilesNoCoverage) {
    Logger.info(
      `Files without coverage:${' '.repeat(1)}${scanSummary.skippedFilesNoCoverage}`,
    );
  }
  Logger.info('-------------------\n');
}

export function printViolation(v) {
  if (v.kind === 'new') {
    Logger.error(
      `[CRAP] ❌ NEW-METHOD over ceiling: ${v.file}::${v.method} (line ${v.startLine})`,
    );
    Logger.error(
      `       ${formatNewViolationMeasure(v)} > ceiling=${v.ceiling} (c=${v.cyclomatic}, cov=${v.coverage.toFixed(2)})`,
    );
    return;
  }
  Logger.error(
    `[CRAP] ❌ REGRESSION: ${v.file}::${v.method} (line ${v.startLine}${v.kind === 'drifted-regression' ? `, baseline key ${v.baselineMethod}` : ''})`,
  );
  Logger.error(
    `       crap=${v.crap.toFixed(2)} > baseline=${v.baseline.toFixed(2)} (c=${v.cyclomatic}, cov=${v.coverage.toFixed(2)})`,
  );
}

export function printRemovedRows(result) {
  if (result.removed <= 0) return;
  Logger.info(
    `[CRAP] ℹ ${result.removed} baseline row(s) absent from current scan (deleted or moved):`,
  );
  for (const r of result.removedRows) {
    Logger.info(`       - ${r.file}::${r.method}`);
  }
}
