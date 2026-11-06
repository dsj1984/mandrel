/**
 * Per-kind module for the CRAP baseline. Row shape:
 * `{ path, method, startLine, crap }`.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COVERAGE_CAPTURE_DEFAULTS } from '../../config/gates/coverage.schema.js';
import {
  COORDINATE_ORIGINAL,
  COORDINATE_TRANSPILED,
  deriveFixGuidance,
} from '../../crap-engine.js';
import {
  anonymousStem,
  isAnonymousMethodLabel,
} from '../../crap-method-identity.js';
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
import {
  buildNewViolation,
  deriveUncoveredFiles,
  formatNewViolationMeasure,
  newMethodGateScore,
} from './_crap-new-method-gate.js';
import {
  makeAggregate,
  makeCompare,
  makeEpsilon,
  makeRollup,
  percentile,
} from './_shared-metric.js';

export const name = 'crap';
export const keyField = 'path';

export { loadCrapBaseline } from './_crap-read.js';

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
 * Scoring-semantics stamp. The scorer version does not move when this repo's
 * coverage join changes, yet rows scored under different joins are not
 * comparable (phantom regressions and phantom passes), so the stamp fails
 * closed across that boundary. Bump it whenever the coverage join, the line
 * coordinate system, the unresolved-method policy, or the method identity
 * rule changes. Module-local: read it via `envelopeExtras().scoringSemantics`.
 */
const SCORING_SEMANTICS = 'method-identity-v4';

/**
 * Envelope stamps this kind adds, consumed by `writer.write`. A transpiler
 * change can move every TS row's `startLine` (half the row identity key), so
 * `tsTranspilerVersion` is stamped for the `ts-transpiler-drift` axis.
 * `provenanceStamped` is a positive marker that per-row provenance was
 * recorded; no other stamp can detect its absence. `ctx` carries the scan's
 * `cwd` / `targetDirs` so the stamp names the compiler the scorer resolved.
 *
 * @param {{ cwd?: string, targetDirs?: string[] }} [ctx]
 * @returns {{scoringSemantics: string, tsTranspilerVersion: string,
 *   provenanceStamped: boolean}}
 */
export function envelopeExtras(ctx = {}) {
  return {
    scoringSemantics: SCORING_SEMANTICS,
    tsTranspilerVersion: resolveTsTranspilerVersion(ctx),
    provenanceStamped: true,
  };
}

/**
 * Project a scan row onto the persisted row shape. `coordinateSystem` and
 * `anonymous` are written only when non-default, so a plain JS row stays the
 * four-key row and existing baselines stay byte-identical.
 */
export function projectRow(row) {
  const projected = {
    path: canonicalise(row.path ?? row.file),
    method: row.method,
    startLine: row.startLine,
    crap: row.crap,
  };
  if (row.coordinateSystem === COORDINATE_TRANSPILED) {
    projected.coordinateSystem = COORDINATE_TRANSPILED;
  }
  // `anonymous`: `method` is a derived scope-path identity, not a source name.
  if (row.anonymous === true) {
    projected.anonymous = true;
  }
  return projected;
}

/**
 * A row's coordinate provenance. An unstamped row is always an
 * original-source coordinate, so the default is sound, not a guess.
 *
 * @param {{coordinateSystem?: string}|null|undefined} row
 * @returns {string}
 */
function coordinateSystemOf(row) {
  return row?.coordinateSystem ?? COORDINATE_ORIGINAL;
}

export function sortRows(rows) {
  return [...rows].sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    return a.method.localeCompare(b.method);
  });
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
 * Pure compare(head, base) keyed by `path::method@startLine`; higher CRAP is
 * worse. New methods are `additions`, not regressions — the new-method
 * ceiling is `check-baselines`' job.
 */
export const compare = makeCompare({
  identity: rowIdentity,
  betterIsHigher: false,
  metricField: 'crap',
  // Removed methods whose crap > 0 are improvements (the debt is gone).
  removedIsImprovement: (b) => (b.crap ?? 0) > 0,
});

/**
 * Canonical row identity. Distinct from `keyField` (`'path'`, the rollup
 * grouping): a file has one row per method, so keying a merge on `keyField`
 * would collapse them.
 *
 * @param {{path: string, method: string, startLine: number}} row
 * @returns {string}
 */
export function rowIdentity(row) {
  return `${row.path}::${row.method}@${row.startLine}`;
}

/**
 * Sub-epsilon CRAP deltas resolve to the prior row bytes.
 *
 * @param {Array<{path: string, method: string, startLine: number, crap: number}>} prior
 * @param {Array<{path: string, method: string, startLine: number, crap: number}>} regenerated
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
 * @param {Array<{path: string, method: string, startLine: number, crap: number}>} prior
 * @param {Array<{path: string, method: string, startLine: number, crap: number}>} regenerated
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
 * @param {{crap: number, startLine: number}} baseline
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
    baselineStartLine: baseline.startLine,
  };
}

/**
 * Compare scanned rows to baseline rows. Match arms: **exact** (same file,
 * method, startLine), **drifted** (named: same method, nearest startLine;
 * anonymous: same stem, see {@link alignAnonymousBucket}), **incomparable**
 * (every candidate is in a different coordinate system), **new** (gated
 * against the ceiling), **removed** (surfaced only). `rekeyed` counts drifted
 * anonymous pairs whose labels differ.
 *
 * Across coordinate systems the drift heuristic would pair rows arbitrarily
 * and report regressions no edit can satisfy, so such rows are counted, not
 * scored, and never fall through to the new-method arm.
 * `provenanceMismatched` counts any row with at least one mismatched
 * candidate, captured before the filter discards that evidence — it feeds the
 * unsound-basis backstop. Unscorable rows (null crap/coverage) are bucketed
 * and excluded from `comparable` so they cannot dilute a ratio.
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
    tolerance,
    methodIndex: new Map(),
    claimed: new Set(),
    verdicts: new Array(rows.length).fill(null),
    incomparableRows: [],
    regressions: 0,
    newViolations: 0,
    drifted: 0,
    rekeyed: 0,
  };
  const exactIndex = new Map();
  for (const b of baselineRows ?? []) {
    exactIndex.set(rowKey(b), b);
    const mk = `${b.file}::${b.method}`;
    if (!state.methodIndex.has(mk)) state.methodIndex.set(mk, []);
    state.methodIndex.get(mk).push(b);
  }

  const unscorableRows = [];
  const named = [];
  const anonymous = [];
  let provenanceMismatched = 0;
  for (const [idx, row] of rows.entries()) {
    if (isUnscorableRow(row)) {
      unscorableRows.push({ ...row, kind: 'unscorable' });
      continue;
    }
    const candidates =
      state.methodIndex.get(`${row.file}::${row.method}`) ?? [];
    if (candidates.some((c) => !sameCoords(c, row))) provenanceMismatched += 1;
    if (isAnonymousMethodLabel(row.method)) {
      anonymous.push({ idx, row });
      continue;
    }
    const exact = exactIndex.get(rowKey(row));
    if (exact && sameCoords(exact, row)) {
      state.claimed.add(exact);
      scorePair(state, idx, row, exact, 'regression');
    } else {
      named.push({ idx, row, candidates });
    }
  }
  for (const entry of named) pairNamedRow(state, entry);
  pairAnonymousRows(state, anonymous, baselineRows ?? []);

  const removedRows = (baselineRows ?? []).filter((b) => !state.claimed.has(b));
  const total = rows.length;
  return {
    total,
    // Denominator of every ratio derived from this result.
    comparable: total - unscorableRows.length,
    regressions: state.regressions,
    newViolations: state.newViolations,
    drifted: state.drifted,
    rekeyed: state.rekeyed,
    provenanceMismatched,
    incomparable: state.incomparableRows.length,
    unscorable: unscorableRows.length,
    removed: removedRows.length,
    violations: state.verdicts.filter((v) => v !== null),
    incomparableRows: state.incomparableRows,
    unscorableRows,
    removedRows,
  };
}

/** @param {{file: string, method: string, startLine: number}} row */
function rowKey(row) {
  return `${row.file}::${row.method}@${row.startLine}`;
}

function sameCoords(a, b) {
  return coordinateSystemOf(a) === coordinateSystemOf(b);
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

/** Count candidates with another coordinate system as incomparable. */
function markIncomparable(state, row, others) {
  state.incomparableRows.push({
    ...row,
    kind: 'incomparable',
    coordinateSystem: coordinateSystemOf(row),
    baselineCoordinateSystem: coordinateSystemOf(others[0]),
  });
  for (const c of others) state.claimed.add(c);
}

/** A named key miss: same name, nearest `startLine`. */
function pairNamedRow(state, { idx, row, candidates }) {
  if (candidates.length === 0) {
    scoreNewMethod(state, idx, row);
    return;
  }
  const comparable = candidates.filter((c) => sameCoords(c, row));
  if (comparable.length === 0) {
    markIncomparable(state, row, candidates);
    return;
  }
  const pick = pickDriftCandidate(comparable, row, state.claimed);
  state.claimed.add(pick);
  state.drifted += 1;
  scorePair(state, idx, row, pick, 'drifted-regression');
}

/**
 * Anonymous rows bucket by (file, stem): an insert, remove or reorder moves
 * ordinals and lines but never the stem. A coordinate system with no
 * baseline rows of its own, while another has some, stays incomparable.
 */
function pairAnonymousRows(state, entries, baselineRows) {
  const bucketOf = (r) => `${r.file}\u0000${anonymousStem(r.method)}`;
  const baseBuckets = new Map();
  for (const b of baselineRows) {
    if (!isAnonymousMethodLabel(b.method)) continue;
    const k = bucketOf(b);
    if (!baseBuckets.has(k)) baseBuckets.set(k, []);
    baseBuckets.get(k).push(b);
  }
  const curBuckets = new Map();
  for (const e of entries) {
    const k = `${bucketOf(e.row)}\u0000${coordinateSystemOf(e.row)}`;
    if (!curBuckets.has(k)) curBuckets.set(k, []);
    curBuckets.get(k).push(e);
  }
  for (const cur of curBuckets.values()) {
    const all = baseBuckets.get(bucketOf(cur[0].row)) ?? [];
    const base = all.filter((b) => sameCoords(b, cur[0].row));
    if (base.length === 0 && all.length > 0) {
      for (const e of cur) markIncomparable(state, e.row, all);
      continue;
    }
    alignAnonymousBucket(state, cur, base);
  }
}

/**
 * Order-aware pairing inside one stem bucket, both sides by `startLine`:
 * same label within `tolerance` (exact key first); then the earliest
 * unclaimed row within `tolerance` (a re-keyed pair — never a regression);
 * then leftovers by key, label, then order, scored as regressions; surplus
 * current rows are new methods, surplus baseline rows stay removed.
 */
function alignAnonymousBucket(state, cur, base) {
  const byLine = (a, b) => a.startLine - b.startLine;
  const curSorted = [...cur].sort((a, b) => byLine(a.row, b.row));
  const free = [...base].sort(byLine);
  const tol = Number.isFinite(state.tolerance) ? state.tolerance : 0;
  const near = (row) => (b) => Math.abs(row.crap - b.crap) <= tol;
  const sameKey = (row) => (b) => rowKey(b) === rowKey(row);
  const sameLabel = (row) => (b) => b.method === row.method;
  const both = (f, g) => (row) => (b) => f(row)(b) && g(row)(b);

  const passes = [
    both(sameKey, near),
    both(sameLabel, near),
    near,
    sameKey,
    sameLabel,
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
  reclaimOwnRows(pairs, free, tol);
  for (const e of curSorted) {
    const b = pairs.get(e);
    if (!b) {
      scoreNewMethod(state, e.idx, e.row);
      continue;
    }
    state.claimed.add(b);
    if (rowKey(b) === rowKey(e.row)) {
      scorePair(state, e.idx, e.row, b, 'regression');
      continue;
    }
    state.drifted += 1;
    if (b.method !== e.row.method) state.rekeyed += 1;
    scorePair(state, e.idx, e.row, b, 'drifted-regression');
  }
}

/**
 * A re-keyed pair must not hide an increase: when a row's own exact-key
 * baseline row went unpaired and scored lower, pair it with that row instead
 * (a sibling removed alongside an increase would otherwise mask it).
 */
function reclaimOwnRows(pairs, free, tol) {
  for (const [e, b] of pairs) {
    if (b.method === e.row.method) continue;
    const at = free.findIndex(
      (f) => rowKey(f) === rowKey(e.row) && e.row.crap > f.crap + tol,
    );
    if (at < 0) continue;
    pairs.set(e, free.splice(at, 1)[0]);
    free.push(b);
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

/**
 * Closest unclaimed candidate by `startLine`; the first when all are claimed
 * (duplicate method names in one file).
 *
 * @param {Array<{startLine: number}>} comparable
 * @param {{startLine: number}} row
 * @param {Set<object>} claimed
 * @returns {object}
 */
function pickDriftCandidate(comparable, row, claimed) {
  let pick = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const c of comparable) {
    if (claimed.has(c)) continue;
    const d = Math.abs(c.startLine - row.startLine);
    if (d < bestDist) {
      bestDist = d;
      pick = c;
    }
  }
  return pick ?? comparable[0];
}

/**
 * Share of comparable rows with a provenance mismatch above which the basis
 * is unsound. The numerator must be provenance mismatch, never `drifted`:
 * drifted rows passed the provenance filter, and ordinary insertions drift
 * most rows.
 */
const UNSOUND_BASIS_MISMATCH_RATIO = 0.5;

/** Small diff-scoped samples legitimately drift; don't judge them. */
const UNSOUND_BASIS_MIN_SAMPLE = 20;

const UNSOUND_BASIS_DIAGNOSTIC = 'crap-unsound-comparison-basis';

export const INCOMPATIBLE_BASELINE_DIAGNOSTIC = 'crap-baseline-incompatible';

/**
 * Whether a `compareCrap` result rests on a sound basis
 * (`provenanceMismatched / comparable`). Above the ratio the per-method
 * verdicts come from a mis-keyed join and must be suppressed.
 * Returns `{ sound: true }` or `{ sound: false, diagnostic: {name, message} }`.
 *
 * @param {{total?: number, comparable?: number, provenanceMismatched?: number,
 *   incomparable?: number}} compareResult
 * @param {{ratio?: number, minSample?: number, captureScript?: string}} [opts]
 */
export function assessComparisonBasis(compareResult, opts = {}) {
  const ratio = Number.isFinite(opts.ratio)
    ? opts.ratio
    : UNSOUND_BASIS_MISMATCH_RATIO;
  const minSample = Number.isFinite(opts.minSample)
    ? opts.minSample
    : UNSOUND_BASIS_MIN_SAMPLE;
  const comparable = compareResult?.comparable ?? compareResult?.total ?? 0;
  if (comparable < minSample) return { sound: true };
  // `incomparable` is a subset; max guards a caller supplying only one.
  const mismatched = Math.max(
    compareResult?.provenanceMismatched ?? 0,
    compareResult?.incomparable ?? 0,
  );
  const observed = mismatched / comparable;
  if (observed <= ratio) return { sound: true };
  return {
    sound: false,
    diagnostic: {
      name: UNSOUND_BASIS_DIAGNOSTIC,
      message:
        `[CRAP] ⚠ Comparison basis is unsound: ${mismatched}/${comparable} ` +
        `(${(observed * 100).toFixed(1)}%) of comparable methods matched a ` +
        'baseline row expressed in a DIFFERENT line coordinate system — ' +
        `above the ${(ratio * 100).toFixed(0)}% threshold.\n` +
        '       At this ratio the baseline and the scan are not describing ' +
        'the same line coordinates, so every per-method verdict below would ' +
        'be derived from a mis-keyed join rather than from your change. ' +
        'They are suppressed.\n' +
        `       Re-seed the baseline: run 'npm run ${captureScriptOf(opts)}' then ` +
        "'npm run crap:update -- --full-scope' and commit the result with a " +
        "'baseline-refresh:' subject. The authoritative check-baselines gate " +
        'still gates the merge.',
    },
  };
}

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
 * transpiler change is fatal because it moves `startLine`, half the row
 * identity key.
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
      if (stamped === SCORING_SEMANTICS) return null;
      return (
        `[CRAP] scoring semantics changed: baseline=${stamped ?? '<unstamped>'} ` +
        `running=${SCORING_SEMANTICS}. Rows scored by the previous per-method ` +
        'coverage join are not comparable to rows scored by the current one, ' +
        `so this baseline cannot be compared. ${reseedRemedy({ captureScript })}`
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
      // Unstamped: no evidence either way (see `provenance-unstamped`).
      if (!isKnownVersion(baselineTs)) return null;
      if (baselineTs === runningTsTranspilerVersion) return null;
      // A pure-JS baseline has no transpiled coordinate to move.
      if (!hasTranspiledRows(baseline)) return null;
      return (
        `[CRAP] tsTranspilerVersion changed: baseline=${baselineTs} running=${runningTsTranspilerVersion}. ` +
        "A TS row's startLine is an original-source coordinate only because the transpiler's " +
        'sourcemap said so, and that coordinate is half the row identity key — so rows scored ' +
        `under the previous transpiler are not comparable to rows scored under this one. ${reseedRemedy({ captureScript })}`
      );
    },
  },
  {
    // Closes the unstamped exemption above. Keyed on a positive marker, since
    // absence can't separate "no provenance" from "typescript unresolvable";
    // scoped to transpiled rows because pure-JS coordinates coincide.
    name: 'provenance-unstamped',
    severity: 'fatal',
    check: ({ baseline, captureScript }) =>
      baseline &&
      baseline.provenanceStamped !== true &&
      hasTranspiledRows(baseline)
        ? '[CRAP] baseline predates coordinate-provenance stamping: it carries ' +
          'transpiled-source rows but no `provenanceStamped` marker, so it ' +
          'asserts by omission that every row is an original-source coordinate. ' +
          '`startLine` is half the row identity key, so the comparator would ' +
          'key those rows against a coordinate space they are not in and ' +
          `report regressions no edit can satisfy. ${reseedRemedy({ captureScript })}`
        : null,
  },
  {
    // Catches a half-migrated baseline: a diff-scoped refresh keeps
    // out-of-scope ordinal-keyed anonymous rows under a current-semantics
    // stamp, and those rows pair with nothing. Keyed on the positive
    // `anonymous` marker.
    name: 'anon-identity-unstamped',
    severity: 'fatal',
    check: ({ baseline, captureScript }) => {
      if (!baseline) return null;
      const stale = (baseline.rows ?? []).filter(
        (row) => isAnonymousMethodLabel(row?.method) && row?.anonymous !== true,
      );
      if (stale.length === 0) return null;
      return (
        `[CRAP] baseline carries ${stale.length} anonymous row(s) keyed by the ` +
        'superseded `<anon method-N>` ordinal (e.g. ' +
        `${stale[0].path ?? stale[0].file}::${stale[0].method}) while the ` +
        'envelope claims the current scoring semantics. Those ordinals ' +
        'renumber whenever any anonymous function is added or removed, so the ' +
        'comparator would score the live methods against the new-method ' +
        `ceiling instead of their own baseline. ${reseedRemedy({ captureScript })}`
      );
    },
  },
];

/** Sources whose escomplex coordinates are transpiled, not original. */
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
const LOADED_ENVELOPE_AXES = [
  'scoring-semantics-drift',
  'ts-transpiler-drift',
  'provenance-unstamped',
  'anon-identity-unstamped',
];

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
      incomparable: compareResult.incomparable ?? 0,
      provenanceMismatched: compareResult.provenanceMismatched ?? 0,
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
 * evidence. Used when the baseline is incompatible or the basis unsound.
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
  Logger.info(`Drifted (matched):     ${result.drifted}`);
  Logger.info(`Re-keyed (anonymous):  ${result.rekeyed ?? 0}`);
  Logger.info(`Provenance mismatched: ${result.provenanceMismatched ?? 0}`);
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
    `[CRAP] ❌ REGRESSION: ${v.file}::${v.method} (line ${v.startLine}${v.kind === 'drifted-regression' ? `, baseline line ${v.baselineStartLine}` : ''})`,
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
    Logger.info(
      `       - ${r.file}::${r.method} (baseline line ${r.startLine})`,
    );
  }
}
