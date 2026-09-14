/**
 * kinds/crap.js — per-kind module for the CRAP baseline (Story #1891).
 *
 * Row shape: `{ path, method, startLine, crap }`. The per-kind v2 envelope
 * schema settles on `path` to match every other kind; the on-disk
 * baseline carries canonical `path:` rows end-to-end.
 *
 * `kernelVersion()` returns the installed `typhonjs-escomplex` package
 * version — the CRAP score depends on escomplex's cyclomatic-complexity
 * output, so drift in that dependency invalidates every committed row.
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

// The CRAP baseline read path (Story #5002) lives in `_crap-read.js` — the ONE
// door, re-exported here so `preview-gates.js` and every existing importer keep
// reaching it through this module.
export { loadCrapBaseline } from './_crap-read.js';

const __filename = fileURLToPath(import.meta.url);

/**
 * Package whose resolved version is stamped as the CRAP scorer identity.
 *
 * `escomplex-plugin-metrics-module` owns the Halstead and cyclomatic math. The
 * displaced `typhonjs-escomplex` shell contributed a parser and a plugin bus
 * and never computed a metric, so stamping it described the shell.
 */
const SCORER_PACKAGE = 'escomplex-plugin-metrics-module';

/**
 * Resolve the running scorer's version by walking up from this module's
 * directory and reading the nearest `node_modules/<SCORER_PACKAGE>/package.json`.
 *
 * The package read is `escomplex-plugin-metrics-module`, which computes the
 * metrics. It was `typhonjs-escomplex` until Story #5336 replaced that shell's
 * parse and dispatch layers; reading a package that no longer exists would
 * yield the sentinel below on every fresh install, and the writer would refuse
 * to persist a baseline. (Locally it can look fine anyway — the walk-up escapes
 * a worktree into the parent checkout, whose `node_modules` may still hold the
 * removed package. CI's fresh clone has no such parent.)
 *
 * Returns `'0.0.0'` when the dependency cannot be found — callers treat that
 * sentinel as "unknown environment" and the writer refuses to persist a
 * baseline.
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
 * Scoring-semantics stamp (Story #4775, fix part 5).
 *
 * `kernelVersion()` above tracks the `typhonjs-escomplex` package and
 * `escomplexVersion` tracks the same dependency — so a change in how THIS
 * repo joins escomplex methods to istanbul coverage moves neither. Rows
 * scored by the pre-#4775 join (exact transpiled-line equality, methods
 * dropped when unresolved) are not comparable to rows scored by the join
 * that replaced it (original-source coordinates, containment matching,
 * honest `requireCoverage: false`): the same method can carry a different
 * `crap`, a different `startLine`, or exist in one baseline and not the
 * other. Comparing across that boundary produces phantom regressions and,
 * worse, phantom passes.
 *
 * The stamp makes the boundary explicit and fails closed. Bump it whenever
 * the coverage join, the line coordinate system, the unresolved-method policy,
 * or the **method identity rule** changes.
 *
 * Story #4969 bumped it to `method-identity-v3` for the last of those. An
 * anonymous method used to be keyed by escomplex's `<anon method-N>` ordinal
 * and is now keyed by its enclosing-scope path; 34.6% of rows changed identity
 * in one step. Rows keyed the old way and rows keyed the new way describe the
 * same functions under different names, so pairing them is exactly the
 * mis-keyed join this stamp exists to refuse — hence the bump, which is what
 * makes the migration report nothing rather than a wall of phantom verdicts.
 *
 * Deliberately module-local: `envelopeExtras()` is the single production door
 * to this value, so exporting the bare constant would add a second entry
 * point that nothing in production reaches. Callers and tests that need the
 * string read it off `envelopeExtras().scoringSemantics`.
 */
const SCORING_SEMANTICS = 'method-identity-v3';

/**
 * Envelope-level stamps this kind contributes beyond the shared envelope
 * keys. Consumed by `writer.write` via the kind-module protocol.
 *
 * `tsTranspilerVersion` joined the stamp set in Story #4866. A TS row's
 * `startLine` is only an original-source coordinate because a sourcemap said
 * so, and that map is the transpiler's output — so a transpiler change can
 * move every TS row's coordinate, which is half the row identity key. Without
 * the stamp on disk the `ts-transpiler-drift` axis had nothing to compare and
 * passed vacuously.
 *
 * `provenanceStamped` joined in Story #4901 as a **positive** marker: the
 * writer asserting it recorded per-row provenance at all. Absence is the only
 * evidence a pre-#4866 baseline leaves, and no other stamp detects it —
 * `kernelVersion` / `escomplexVersion` track the escomplex package (unmoved
 * by the fix), `scoringSemantics` did not change, and `tsTranspilerVersion`
 * is unreliable in the negative (the `'0.0.0'` sentinel). See the
 * `provenance-unstamped` axis.
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
 * Project a scan row onto the persisted baseline row shape.
 *
 * `coordinateSystem` is written **only** when it is not the default
 * `original` (Story #4866). A pure-JavaScript scan therefore emits the exact
 * four-key row it always did — byte-identical baselines, no refresh — while a
 * row that kept transpiled coordinates is distinguishable on disk from one
 * whose sourcemap lookup resolved.
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
  // Story #4969, same write-only-when-non-default idiom: `anonymous` marks a
  // `method` that is a derived scope-path identity rather than a name the
  // source carries. A named row stays the exact four-key row it always was.
  if (row.anonymous === true) {
    projected.anonymous = true;
  }
  return projected;
}

/**
 * Read a row's coordinate provenance, defaulting to `original`.
 *
 * A baseline written before Story #4866 carries no stamp at all, and every
 * such row IS an original-source coordinate — un-remapped rows could not
 * reach a `requireCoverage: true` baseline, and the pure-JavaScript case was
 * never affected. Defaulting is therefore back-compatible, not a guess.
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

// Re-export percentile so existing consumers that imported it from crap.js
// keep working without an import path change.
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
 * Pure compare(head, base) for the CRAP kind. Diffs rows by the
 * `path::method@startLine` composite identity (per-method granularity).
 *
 * Higher CRAP = worse. A row regresses when its crap score increases vs
 * base; improves when it decreases; unchanged when equal. New methods
 * land in the `additions` bucket; absolute-ceiling enforcement is the
 * unified `check-baselines` gate's job (the per-method ceiling is a
 * different concern from regression vs base). Removed methods with
 * prior crap > 0 count as improvements.
 *
 * Story #2012 — sibling fix to maintainability.compare. The prior
 * behaviour treated any new method with crap > 0 as a regression, which
 * conflated "new code with a non-zero score" with "existing code that
 * got worse". New methods are now `additions` so a Story that lands a
 * new file no longer fails close-validation through the regression arm.
 *
 * No I/O. No process exit. No friction emission.
 */
export const compare = makeCompare({
  identity: rowIdentity,
  betterIsHigher: false,
  metricField: 'crap',
  // Removed methods whose crap > 0 are improvements (the debt is gone).
  removedIsImprovement: (b) => (b.crap ?? 0) > 0,
});

/**
 * Canonical CRAP row identity (Story #5215) — the composite
 * `path::method@startLine`, exported under the protocol name every kind
 * module answers to.
 *
 * This kind is the reason identity is a separate concept from `keyField`.
 * `keyField` is `'path'` because the rollup groups by file, but a file
 * ships one row per method, so a merge keyed on `keyField` would collapse
 * every method in a file to one row and drop the rest. `compare`,
 * `applyEpsilon` and `mergeRows` have always keyed on this composite;
 * exporting it makes the same identity available to callers that used to
 * have no choice but to guess from `keyField`.
 *
 * @param {{path: string, method: string, startLine: number}} row
 * @returns {string}
 */
export function rowIdentity(row) {
  return `${row.path}::${row.method}@${row.startLine}`;
}

// `methodIdentityKey` / `indexBaselineRowsByFile` (Story #4981) are now
// module-local to `crap-baseline-join.js` (Story #5002): after that module
// absorbed the per-file queue wiring, both callers are inside it, so the
// exports — and the re-export that used to live here — were reachable from
// tests alone. `resolveIncrementalContext` is the production door to the
// index; `rowIdentity` above is the composite key it halves.

/**
 * Pure stabilizer for s-stability-epsilon (Story #1964). CRAP rows match
 * by the composite `path::method@startLine` identity. Sub-epsilon CRAP
 * deltas resolve to the prior row bytes; missing-prior rows fall through.
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
 * Pure scope-aware merge for s-diff-scoped-writes (Story #1974). CRAP rows
 * match identity by the composite `path::method@startLine`, but the scope
 * filter applies on `path` alone (a Story diff identifies files, not
 * methods). In diff mode, rows whose `path` is OUTSIDE `scope.files` are
 * preserved from `prior` verbatim — including every method on that file.
 * In full mode (or no scope), regenerated wins everywhere.
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

// ---------------------------------------------------------------------------
// CLI-facing pure helpers (Story #1981, Task #1989).
// Hoisted from `.agents/scripts/check-crap.js` so the per-kind module owns
// the loader / comparator / report-builder / floor-enforcer surface and the
// CLI shell is reduced to argv parsing + orchestration. Behavior preserved
// byte-for-byte vs the CLI version; only the import path changed.
// ---------------------------------------------------------------------------

/**
 * Pure helper: narrow a list of rows to the ones whose `file` field is in
 * `scopeSet`. Shared between scan-row filtering and baseline-row filtering
 * so the `--changed-since` code path treats both sides of the comparison
 * the same way (otherwise every baseline row for an untouched file would
 * surface as "removed" on every diff-scoped run).
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
 * Pure helper: decide whether a single (current, baseline) row pair counts
 * as a CRAP regression. Returns the violation object to push, or `null`
 * when the row passes (within tolerance, or exempted).
 *
 * Trivial (cyclomatic=1) methods are exempted from the regression check.
 * Their CRAP score collapses to a pure coverage proxy in [1, 2] — under
 * non-deterministic Node 22 V8 instrumentation on Windows CI, single-
 * statement wrappers like `deleteComment(ctx, id)` flap between cov=1.00
 * (crap=1) and cov=0.17 (crap≈1.58) across runs of identical source. A
 * real regression on a c=1 method requires it to gain branches, at which
 * point row.cyclomatic is no longer 1 and this exemption no longer
 * applies. New-method ceiling enforcement is unaffected.
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
 * Pure comparator. Given scanned `currentRows` and committed
 * `baselineRows`, produce a structured verdict covering all five match
 * paths:
 *
 *   1. **exact**        — same (file, method, startLine). Regresses if
 *                         current crap > baseline crap + tolerance.
 *   2. **drifted**      — same (file, method) but startLine shifted. Uses
 *                         the closest line-drifted baseline row under the
 *                         same no-regression rule. A drift without
 *                         regression is reported informationally.
 *   3. **incomparable** — same (file, method), but the two rows express
 *                         their startLine in DIFFERENT coordinate systems
 *                         (Story #4866). Reported, never scored.
 *   4. **new**          — no baseline match. Violates if crap > ceiling.
 *   5. **removed**      — baseline rows not seen in the current scan.
 *                         Surfaced only; never a failure.
 *
 * **Why the incomparable bucket exists.** The drift heuristic assumes both
 * rows measure the same axis and the method simply moved along it. When one
 * row's line is an original-source coordinate and the other's is a transpiled
 * one, the "distance" it minimises over is the gap between two coordinate
 * systems, not a code movement — so it pairs rows arbitrarily and then scores
 * the pairing. That is precisely how a scan that changed nothing reports a
 * regression no edit can satisfy. Refusing is the only sound answer: a row
 * whose provenance differs from every candidate's is counted and surfaced,
 * and it does NOT fall through to the new-method arm (it is not new; it is
 * unmeasurable against this baseline).
 *
 * **`provenanceMismatched` is captured BEFORE the provenance filter runs**
 * (Story #4871). `incomparable` only counts rows where *every* candidate
 * disagreed on coordinates; a row with one agreeing candidate and three
 * disagreeing ones scores normally and leaves no trace. That made the
 * evidence of coordinate mixing strictly narrower than the mixing itself —
 * and the unsound-basis backstop, which needs exactly that evidence, had
 * nothing sound to read. The counter below is incremented for **any** row
 * with at least one provenance-mismatched candidate, whichever arm then
 * resolves it.
 *
 * **Unscorable rows never reach an arm.** A row the scan could not score
 * (`crap: null` / `coverage: null`, or an explicit `unscorable: true`) carries
 * no measurement to compare. It is bucketed and counted, and it is excluded
 * from `comparable` so it cannot dilute any ratio derived from this result.
 *
 * **A new method in a wholly-uncovered file is gated on complexity alone**
 * (Story #5002) — see `newMethodGateScore`.
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
    // Evidence first, filtering second — see the block comment above.
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
      // Only rows expressed in the SAME coordinate system are comparable;
      // everything else would be resolved through a line-distance heuristic
      // that cannot mean anything across two coordinate systems.
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
    // Rows that carried a measurement and therefore *could* be compared. The
    // denominator of every ratio derived from this result.
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
 * True when a scanned row carries no measurement to compare.
 *
 * Deliberately strict on `null`: a scan row always sets `crap`, and the
 * scorer's own contract is that an unresolved method yields `crap: null` /
 * `coverage: null` rather than an inferred zero. A caller-built row that
 * simply omits `coverage` is not making that claim and stays scorable.
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
 * Pick the baseline row a drifted method should be scored against: the
 * closest un-seen candidate by `startLine` distance, falling back to the
 * first when every candidate has already been claimed (duplicate method
 * names in one file).
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
 * Fraction of a compare's comparable rows that hit a coordinate-provenance
 * mismatch before the comparison basis is judged self-evidently unsound
 * (Story #4866, numerator corrected in Story #4871).
 *
 * **What this ratio must measure.** The backstop exists for one condition: the
 * scan and the baseline expressing `startLine` in different coordinate
 * systems, which makes the nearest-line drift heuristic pair rows arbitrarily
 * and then score the pairing. The only quantity that evidences that condition
 * is a provenance disagreement between a row and its baseline candidates.
 *
 * **Why `drifted` was the wrong numerator.** A row reaches the drift arm only
 * *after* passing the provenance filter, so every drifted row is one whose
 * coordinate system **agreed** with its baseline's. Counting agreements as
 * evidence of disagreement is not a mis-calibration, it is the wrong
 * measurement: on this pure-JavaScript repository — where a coordinate mix is
 * structurally impossible — it read 56–68% across every diff scope, which
 * suppressed the gate's per-method verdicts on every commit while the gate
 * still reported success. `startLine` is half the row identity key, so any
 * insertion re-keys every method below it; ordinary drift is the normal
 * operating state, not an anomaly.
 *
 * Deliberately module-local, like `SCORING_SEMANTICS` above: the three
 * tuning values below are reachable through `assessComparisonBasis` — which
 * takes them as overridable options — so exporting the bare constants would
 * add entry points nothing in production reaches.
 */
const UNSOUND_BASIS_MISMATCH_RATIO = 0.5;

/**
 * Minimum comparable rows before the unsound-basis check is allowed to fire.
 * A diff-scoped preview can legitimately score three methods, two of which
 * moved; that is a normal edit, not a broken basis. Mirrors the
 * minimum-sample discipline the coverage-join resolution floor already uses.
 */
const UNSOUND_BASIS_MIN_SAMPLE = 20;

/** Diagnostic name for an unsound comparison basis. */
const UNSOUND_BASIS_DIAGNOSTIC = 'crap-unsound-comparison-basis';

/** Diagnostic name for a baseline the running scorer refuses to compare. */
export const INCOMPATIBLE_BASELINE_DIAGNOSTIC = 'crap-baseline-incompatible';

/**
 * Pure verdict on whether a `compareCrap` result rests on a sound basis.
 *
 * The numerator is `provenanceMismatched` — rows whose baseline candidates
 * included at least one expressed in a different coordinate system, counted
 * by `compareCrap` **before** its provenance filter discards that evidence.
 * The denominator is `comparable`: rows that carried a measurement at all, so
 * a method the scan could not score cannot dilute the ratio into silence.
 *
 * Above the ratio the per-method verdicts are noise derived from a mis-keyed
 * join, and reporting them as regressions asks the operator to fix code that
 * is not broken. Below it — including a scan where every row drifted, which
 * is what an ordinary insertion produces — the verdicts stand.
 *
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
  // `incomparable` is the total-mismatch subset of `provenanceMismatched`, so
  // it is already counted; the max guards a caller that supplies only one.
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

/**
 * Declarative axis table for `evaluateBaselineCompatibility` (Story #2467).
 *
 * Each axis is a pure `{ name, severity, check }` triple. `check` receives
 * the compat context `{ baseline, runningKernelVersion,
 * runningEscomplexVersion, runningTsTranspilerVersion }` and returns either
 * `null` (axis passed) or a `string` message describing the failure.
 *
 * - `severity: 'fatal'` — first match short-circuits the reduce and the
 *   function returns `{ ok: false, exitCode: 1, kind, message }`.
 * - `severity: 'warn'`  — every match accumulates into `warnings[]` and the
 *   function still returns `{ ok: true, warnings }`.
 *
 * Story #791 retired the transitional `bootstrap` exit-0 path: a missing
 * baseline still fails closed. Story #829 (5.29.0) softened `kernelVersion`
 * drift to **warn**, not fail, and did the same for `tsTranspilerVersion` —
 * but that second half was re-escalated to **fatal** once Story #4866 made a
 * TS row's `startLine` an original-source coordinate resolved through the
 * transpiler's sourcemap. `startLine` is half the row identity key, so a
 * transpiler change makes the rows incomparable rather than merely stale; see
 * the `ts-transpiler-drift` axis below for the two exemptions that bound it.
 *
 * There is no `escomplexVersion` axis. One existed, declared `fatal`, and
 * could not fire in either direction: the v2 envelope does not carry the
 * field, so the loaded-envelope pass excluded it as vacuous, and the peer pass
 * back-filled the value from the running scorer before comparing it against
 * the running scorer. A gate that presents as fatal and cannot fail is worse
 * than an absent one, so it was removed rather than repaired — `scoringSemantics`
 * is the axis that actually rejects an incompatible scorer.
 */
/**
 * The one re-seed recipe every coordinate-invalidating axis ends on. Three
 * axes and the unsound-basis diagnostic previously carried their own copy of
 * this sentence; a single constant keeps them from drifting apart on the
 * command an operator is told to run.
 */
const RESEED_REMEDY =
  "Re-derive the baseline: run 'npm run test:coverage' then " +
  "'npm run crap:update -- --full-scope' and commit the result with a " +
  "'baseline-refresh:' subject.";

export const CRAP_COMPAT_AXES = [
  // Universal axes hoisted into envelope.js (Story #2467, Task #2492). The
  // missing-baseline and kernel-drift checks live in exactly one place;
  // each per-kind table composes them in with its own kind label.
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
      // An unstamped (or sentinel) baseline has nothing to compare — the
      // stamp landed in Story #4866 and comparing against its absence would
      // fail every pre-existing baseline closed for no evidence at all.
      if (!isKnownVersion(baselineTs)) return null;
      if (baselineTs === runningTsTranspilerVersion) return null;
      // Scoped to baselines that actually contain transpiled sources: a
      // transpiler change moves TS row coordinates and nothing else. A
      // pure-JavaScript tree has no coordinate to move, so a TS bump there is
      // not a coordinate-invalidating event and must not fail its gate.
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
    // Story #4901. Closes the exemption directly above: `ts-transpiler-drift`
    // returns null for an unstamped baseline rather than fail every
    // pre-existing one for want of evidence — and a pre-#4866 baseline is
    // exactly that shape, so the one door that could catch it lets it through
    // while it asserts by omission that all its rows are original coordinates.
    // Keyed on a positive marker because absence alone cannot separate
    // "written before provenance existed" from "typescript was unresolvable".
    // Scoped like `ts-transpiler-drift`: a pure-JavaScript baseline's two
    // coordinate systems coincide, so it was never affected and must not fail.
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
    // Story #4969. The `scoring-semantics-drift` axis above rejects a baseline
    // stamped with the OLD semantics wholesale, which covers a clean migration.
    // It cannot see a HALF-migrated one: a diff-scoped refresh preserves
    // out-of-scope rows verbatim, so a baseline can carry ordinal-keyed rows
    // for the files that were never re-scored while the writer stamps the
    // envelope with the current semantics — the stamp says v3, some rows are
    // still v2, and the one axis that would catch it has already passed.
    //
    // Such a row cannot be paired with anything: its `<anon method-N>` label
    // matches no scope-path identity, so the comparator files the live method
    // as NEW (scored against the ceiling, not its own baseline) and the stale
    // row as removed. Keyed on the positive `anonymous` marker for the same
    // reason `provenance-unstamped` is: absence is the only trace the old
    // writer leaves.
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
 * `'0.0.0'` is this codebase's established "unknown environment" sentinel for
 * a resolved dependency version, not a real release. Treating it as a
 * comparable value would turn "we could not resolve typescript" into
 * "typescript changed".
 *
 * @param {unknown} version
 * @returns {boolean}
 */
function isKnownVersion(version) {
  return typeof version === 'string' && version !== '' && version !== '0.0.0';
}

/**
 * True when a baseline contains at least one row derived from a transpiled
 * source — the only rows a transpiler-version change can move.
 *
 * @param {{rows?: Array<{path?: string, file?: string}>}|null} baseline
 * @returns {boolean}
 */
function hasTranspiledRows(baseline) {
  return (baseline?.rows ?? []).some((row) =>
    TRANSPILED_SOURCE_RE.test(String(row?.path ?? row?.file ?? '')),
  );
}

/**
 * Pure decision helper for the missing-baseline / kernel-mismatch /
 * escomplex-mismatch / tsTranspiler-mismatch gate paths. Lets tests
 * assert the exact operator-facing message without spawning a child
 * process.
 *
 * Story #2467 rewrote the body as a reduce over `CRAP_COMPAT_AXES` to
 * collapse the cyclomatic complexity below the project ceiling. Behavior
 * is preserved byte-for-byte vs the prior imperative implementation.
 */
export function evaluateBaselineCompatibility(ctx) {
  return reduceCompatAxes(CRAP_COMPAT_AXES, ctx);
}

/**
 * The compat axes a *loaded* envelope can be judged against on its own,
 * without a second baseline to diff. Each invalidates one half of the row
 * identity key. Three are about the `startLine` half: one names the join that
 * produced the rows, one names the transpiler whose sourcemap decided what a
 * TS row's `startLine` even means, and one (Story #4901) catches a baseline
 * predating both questions. The fourth (Story #4969) is about the `method`
 * half — a baseline still carrying ordinal-keyed anonymous rows.
 *
 * `kernel-drift` stays out: it is a warn-level axis, and this pass turns a
 * message into a fail-closed error. (`escomplex-mismatch` was the other
 * exclusion until it was removed outright — see `CRAP_COMPAT_AXES`.)
 */
const LOADED_ENVELOPE_AXES = [
  'scoring-semantics-drift',
  'ts-transpiler-drift',
  'provenance-unstamped',
  'anon-identity-unstamped',
];

/**
 * Kind-module hook (Story #4775, extended by Story #4866): judge a *loaded*
 * v2 envelope against the axes that need no peer baseline. The unified
 * `check-baselines` gate calls it straight after `reader.load` and turns a
 * message into a fail-closed schema-class error, so a baseline written by
 * incompatible scoring semantics — or by a different transpiler, which moves
 * the coordinates that are half the row identity key — can never be silently
 * compared against current scores.
 *
 * This is the *production* door for `ts-transpiler-drift`. Before #4866 the
 * axis was reachable only from its own unit test: nothing in production called
 * `evaluateBaselineCompatibility`, and this function deliberately excluded it.
 *
 * @param {object|null} baseline A loaded v2 baseline envelope.
 * @param {{runningTsTranspilerVersion?: string}} [ctx] Injectable running
 *   versions; resolved from the environment when omitted.
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
 * Build the structured `--json` report envelope.
 *
 * Violations carry the same fields the stdout printer emits plus a
 * deterministic `fixGuidance` block derived from the formula: target is
 * the baseline for regressions and the ceiling for new-method
 * violations. Rows are deep-cloned so callers can safely mutate the
 * envelope without corrupting the live comparator result.
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
  // Story #1394: tag the envelope with the scope used to produce it so
  // downstream tooling can detect whether the diff was scoped or
  // full-repo before merging this envelope with the peer MI envelope.
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
      // Story #4866: rows the compare refused to resolve because their
      // coordinate provenance differs from the baseline's.
      incomparable: compareResult.incomparable ?? 0,
      // Story #4871: rows whose baseline candidates included at least one in a
      // different coordinate system — the evidence the unsound-basis backstop
      // reads, captured before the provenance filter discards it.
      provenanceMismatched: compareResult.provenanceMismatched ?? 0,
      // Story #4871: methods carrying no measurement to compare — the scan
      // found no coverage artifact for them. Reported, never scored from an
      // assumed zero, and never part of a ratio's denominator.
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
 * Rebuild a CRAP envelope with its per-method verdicts suppressed and one
 * named diagnostic in their place (Story #4866).
 *
 * Used by the preview gate on the two conditions under which a per-method
 * verdict cannot mean anything: a baseline the running scorer refuses to
 * compare, and a comparison basis whose drifted-row ratio proves the two
 * sides disagree on coordinates. The counts stay so the operator can see the
 * evidence; only the accusations go.
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

/**
 * Logger-only printers hoisted from `check-crap.js`. Kept here so the
 * CLI shell stays thin and the printers can be exercised in unit tests
 * without spawning the CLI.
 */
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
