/**
 * Per-kind module for the CRAP baseline. Row shape:
 * `{ path, method, startLine, crap }`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COORDINATE_ORIGINAL,
  COORDINATE_TRANSPILED,
  deriveFixGuidance,
} from '../../crap-engine.js';
import { isAnonymousMethodLabel } from '../../crap-method-identity.js';
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

/** The package that computes the metrics; its version stamps the scorer identity. */
const SCORER_PACKAGE = 'escomplex-plugin-metrics-module';

/**
 * Resolve the scorer version from the nearest `node_modules/<SCORER_PACKAGE>`,
 * walking up. Returns the `'0.0.0'` "unknown environment" sentinel when not
 * found, which makes the writer refuse to persist. The walk-up can escape a
 * worktree into the parent checkout, so a local pass does not prove CI's.
 *
 * @returns {string}
 */
export function kernelVersion() {
  let dir = path.dirname(__filename);
  const { root } = path.parse(dir);
  while (true) {
    const pkgPath = path.join(
      dir,
      'node_modules',
      SCORER_PACKAGE,
      'package.json',
    );
    if (fs.existsSync(pkgPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (parsed && typeof parsed.version === 'string') {
          return parsed.version;
        }
      } catch {
        // fall through to parent lookup
      }
    }
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}

/**
 * Scoring-semantics stamp. The scorer version does not move when this repo's
 * coverage join changes, yet rows scored under different joins are not
 * comparable (phantom regressions and phantom passes), so the stamp fails
 * closed across that boundary. Bump it whenever the coverage join, the line
 * coordinate system, the unresolved-method policy, or the method identity
 * rule changes. Module-local: read it via `envelopeExtras().scoringSemantics`.
 */
const SCORING_SEMANTICS = 'method-identity-v3';

/**
 * Envelope stamps this kind adds, consumed by `writer.write`. A transpiler
 * change can move every TS row's `startLine` (half the row identity key), so
 * `tsTranspilerVersion` is stamped for the `ts-transpiler-drift` axis.
 * `provenanceStamped` is a positive marker that per-row provenance was
 * recorded; no other stamp can detect its absence.
 *
 * @returns {{scoringSemantics: string, tsTranspilerVersion: string,
 *   provenanceStamped: boolean}}
 */
export function envelopeExtras() {
  return {
    scoringSemantics: SCORING_SEMANTICS,
    tsTranspilerVersion: resolveTsTranspilerVersion(),
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
 * method, startLine), **drifted** (same method, nearest startLine),
 * **incomparable** (every candidate is in a different coordinate system),
 * **new** (gated against the ceiling), **removed** (surfaced only).
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
  const uncoveredFiles = deriveUncoveredFiles(currentRows);
  const exactIndex = new Map();
  const methodIndex = new Map();
  for (const b of baselineRows ?? []) {
    exactIndex.set(`${b.file}::${b.method}@${b.startLine}`, b);
    const mk = `${b.file}::${b.method}`;
    if (!methodIndex.has(mk)) methodIndex.set(mk, []);
    methodIndex.get(mk).push(b);
  }
  const seenBaselineKeys = new Set();

  const violations = [];
  const incomparableRows = [];
  const unscorableRows = [];
  let regressions = 0;
  let newViolations = 0;
  let drifted = 0;
  let provenanceMismatched = 0;

  for (const row of currentRows ?? []) {
    if (isUnscorableRow(row)) {
      unscorableRows.push({ ...row, kind: 'unscorable' });
      continue;
    }
    const exactKey = `${row.file}::${row.method}@${row.startLine}`;
    const methodKey = `${row.file}::${row.method}`;
    const rowCoords = coordinateSystemOf(row);
    const candidates = methodIndex.get(methodKey) ?? [];
    if (candidates.some((c) => coordinateSystemOf(c) !== rowCoords)) {
      provenanceMismatched += 1;
    }

    const exact = exactIndex.get(exactKey);
    if (exact && coordinateSystemOf(exact) === rowCoords) {
      seenBaselineKeys.add(exactKey);
      const v = checkCrapRegression(row, exact, tolerance, 'regression');
      if (v) {
        regressions += 1;
        violations.push(v);
      }
      continue;
    }

    if (candidates.length > 0) {
      const comparable = candidates.filter(
        (c) => coordinateSystemOf(c) === rowCoords,
      );
      if (comparable.length === 0) {
        incomparableRows.push({
          ...row,
          kind: 'incomparable',
          coordinateSystem: rowCoords,
          baselineCoordinateSystem: coordinateSystemOf(candidates[0]),
        });
        for (const c of candidates) {
          seenBaselineKeys.add(`${c.file}::${c.method}@${c.startLine}`);
        }
        continue;
      }
      const pick = pickDriftCandidate(comparable, row, seenBaselineKeys);
      seenBaselineKeys.add(`${pick.file}::${pick.method}@${pick.startLine}`);
      drifted += 1;
      const v = checkCrapRegression(row, pick, tolerance, 'drifted-regression');
      if (v) {
        regressions += 1;
        violations.push(v);
      }
      continue;
    }

    const gateScore = newMethodGateScore(row, uncoveredFiles);
    if (gateScore > newMethodCeiling + tolerance) {
      newViolations += 1;
      violations.push(buildNewViolation(row, newMethodCeiling, gateScore));
    }
  }

  const removedRows = [];
  for (const b of baselineRows ?? []) {
    const k = `${b.file}::${b.method}@${b.startLine}`;
    if (!seenBaselineKeys.has(k)) removedRows.push(b);
  }

  const total = currentRows?.length ?? 0;
  return {
    total,
    // Denominator of every ratio derived from this result.
    comparable: total - unscorableRows.length,
    regressions,
    newViolations,
    drifted,
    provenanceMismatched,
    incomparable: incomparableRows.length,
    unscorable: unscorableRows.length,
    removed: removedRows.length,
    violations,
    incomparableRows,
    unscorableRows,
    removedRows,
  };
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
 * @param {Array<{file: string, method: string, startLine: number}>} comparable
 * @param {{startLine: number}} row
 * @param {Set<string>} seenBaselineKeys
 * @returns {object}
 */
function pickDriftCandidate(comparable, row, seenBaselineKeys) {
  let pick = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const c of comparable) {
    const k = `${c.file}::${c.method}@${c.startLine}`;
    if (seenBaselineKeys.has(k)) continue;
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
 * @param {{ratio?: number, minSample?: number}} [opts]
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
        "       Re-seed the baseline: run 'npm run test:coverage' then " +
        "'npm run crap:update -- --full-scope' and commit the result with a " +
        "'baseline-refresh:' subject. The authoritative check-baselines gate " +
        'still gates the merge.',
    },
  };
}

const RESEED_REMEDY =
  "Re-derive the baseline: run 'npm run test:coverage' then " +
  "'npm run crap:update -- --full-scope' and commit the result with a " +
  "'baseline-refresh:' subject.";

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
    check: ({ baseline }) => {
      if (!baseline) return null;
      const stamped = baseline.scoringSemantics ?? null;
      if (stamped === SCORING_SEMANTICS) return null;
      return (
        `[CRAP] scoring semantics changed: baseline=${stamped ?? '<unstamped>'} ` +
        `running=${SCORING_SEMANTICS}. Rows scored by the previous per-method ` +
        'coverage join are not comparable to rows scored by the current one, ' +
        `so this baseline cannot be compared. ${RESEED_REMEDY}`
      );
    },
  },
  {
    name: 'ts-transpiler-drift',
    severity: 'fatal',
    check: ({ baseline, runningTsTranspilerVersion }) => {
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
        `under the previous transpiler are not comparable to rows scored under this one. ${RESEED_REMEDY}`
      );
    },
  },
  {
    // Closes the unstamped exemption above. Keyed on a positive marker, since
    // absence can't separate "no provenance" from "typescript unresolvable";
    // scoped to transpiled rows because pure-JS coordinates coincide.
    name: 'provenance-unstamped',
    severity: 'fatal',
    check: ({ baseline }) =>
      baseline &&
      baseline.provenanceStamped !== true &&
      hasTranspiledRows(baseline)
        ? '[CRAP] baseline predates coordinate-provenance stamping: it carries ' +
          'transpiled-source rows but no `provenanceStamped` marker, so it ' +
          'asserts by omission that every row is an original-source coordinate. ' +
          '`startLine` is half the row identity key, so the comparator would ' +
          'key those rows against a coordinate space they are not in and ' +
          `report regressions no edit can satisfy. ${RESEED_REMEDY}`
        : null,
  },
  {
    // Catches a half-migrated baseline: a diff-scoped refresh keeps
    // out-of-scope ordinal-keyed anonymous rows under a current-semantics
    // stamp, and those rows pair with nothing. Keyed on the positive
    // `anonymous` marker.
    name: 'anon-identity-unstamped',
    severity: 'fatal',
    check: ({ baseline }) => {
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
        `ceiling instead of their own baseline. ${RESEED_REMEDY}`
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
 * @param {{runningTsTranspilerVersion?: string}} [ctx]
 * @returns {string|null} Operator-facing message, or null when compatible.
 */
export function assertBaselineCompatible(baseline, ctx = {}) {
  if (!baseline) return null;
  const runningTsTranspilerVersion =
    ctx.runningTsTranspilerVersion ?? resolveTsTranspilerVersion();
  for (const name of LOADED_ENVELOPE_AXES) {
    const axis = CRAP_COMPAT_AXES.find((a) => a.name === name);
    const message = axis?.check({ baseline, runningTsTranspilerVersion });
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
