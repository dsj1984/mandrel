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
import { readBaselineAtRef } from '../../baseline-loader.js';
import { deriveFixGuidance } from '../../crap-engine.js';
import { getCrapBaseline } from '../../crap-utils.js';
import { loadBaseline } from '../../gates/baseline-store.js';
import { Logger } from '../../Logger.js';
import {
  kernelDriftAxis,
  missingBaselineAxis,
  reduceCompatAxes,
} from '../envelope.js';
import { canonicalise } from '../path-canon.js';
import { mergeRowsByScope } from '../scope.js';
import {
  makeAggregate,
  makeCompare,
  makeEpsilon,
  makeRollup,
  percentile,
} from './_shared-metric.js';

export const name = 'crap';
export const keyField = 'path';

const __filename = fileURLToPath(import.meta.url);

/**
 * Resolve the running `typhonjs-escomplex` version by walking up from this
 * module's directory and reading the nearest
 * `node_modules/typhonjs-escomplex/package.json`. Returns `'0.0.0'` when
 * the dependency cannot be found — callers treat that sentinel as
 * "unknown environment" and the writer refuses to persist a baseline.
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
      'typhonjs-escomplex',
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

export function projectRow(row) {
  return {
    path: canonicalise(row.path ?? row.file),
    method: row.method,
    startLine: row.startLine,
    crap: row.crap,
  };
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
  identity: crapRowKey,
  betterIsHigher: false,
  metricField: 'crap',
  // Removed methods whose crap > 0 are improvements (the debt is gone).
  removedIsImprovement: (b) => (b.crap ?? 0) > 0,
});

function crapRowKey(row) {
  return `${row.path}::${row.method}@${row.startLine}`;
}

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
  identity: crapRowKey,
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
    identity: (row) => crapRowKey(row),
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
 * `baselineRows`, produce a structured verdict covering all four match
 * paths:
 *
 *   1. **exact**     — same (file, method, startLine). Regresses if
 *                      current crap > baseline crap + tolerance.
 *   2. **drifted**   — same (file, method) but startLine shifted. Uses
 *                      the closest line-drifted baseline row under the
 *                      same no-regression rule. A drift without
 *                      regression is reported informationally.
 *   3. **new**       — no baseline match. Violates if crap > ceiling.
 *   4. **removed**   — baseline rows not seen in the current scan.
 *                      Surfaced only; never a failure.
 */
export function compareCrap({
  currentRows,
  baselineRows,
  newMethodCeiling,
  tolerance,
}) {
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
  let regressions = 0;
  let newViolations = 0;
  let drifted = 0;

  for (const row of currentRows ?? []) {
    const exactKey = `${row.file}::${row.method}@${row.startLine}`;
    const methodKey = `${row.file}::${row.method}`;
    const exact = exactIndex.get(exactKey);
    if (exact) {
      seenBaselineKeys.add(exactKey);
      const v = checkCrapRegression(row, exact, tolerance, 'regression');
      if (v) {
        regressions += 1;
        violations.push(v);
      }
      continue;
    }

    const candidates = methodIndex.get(methodKey);
    if (Array.isArray(candidates) && candidates.length > 0) {
      // Pick the closest un-seen candidate by startLine distance; fall back
      // to the first one if all have been seen (duplicate method names).
      let pick = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const c of candidates) {
        const k = `${c.file}::${c.method}@${c.startLine}`;
        if (seenBaselineKeys.has(k)) continue;
        const d = Math.abs(c.startLine - row.startLine);
        if (d < bestDist) {
          bestDist = d;
          pick = c;
        }
      }
      if (!pick) pick = candidates[0];
      seenBaselineKeys.add(`${pick.file}::${pick.method}@${pick.startLine}`);
      drifted += 1;
      const v = checkCrapRegression(row, pick, tolerance, 'drifted-regression');
      if (v) {
        regressions += 1;
        violations.push(v);
      }
      continue;
    }

    if (row.crap > newMethodCeiling + tolerance) {
      newViolations += 1;
      violations.push({
        ...row,
        kind: 'new',
        baseline: null,
        ceiling: newMethodCeiling,
      });
    }
  }

  const removedRows = [];
  for (const b of baselineRows ?? []) {
    const k = `${b.file}::${b.method}@${b.startLine}`;
    if (!seenBaselineKeys.has(k)) removedRows.push(b);
  }

  return {
    total: currentRows?.length ?? 0,
    regressions,
    newViolations,
    drifted,
    removed: removedRows.length,
    violations,
    removedRows,
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
 * and `tsTranspilerVersion` drift to **warn**, not fail; `escomplexVersion`
 * mismatch continues to fail closed.
 */
export const CRAP_COMPAT_AXES = [
  // Universal axes hoisted into envelope.js (Story #2467, Task #2492). The
  // missing-baseline and kernel-drift checks live in exactly one place;
  // each per-kind table composes them in with its own kind label.
  missingBaselineAxis('CRAP'),
  {
    name: 'escomplex-mismatch',
    severity: 'fatal',
    check: ({ baseline, runningEscomplexVersion }) =>
      baseline && baseline.escomplexVersion !== runningEscomplexVersion
        ? `[CRAP] scorer changed from ${baseline.escomplexVersion} to ${runningEscomplexVersion} — run 'npm run crap:update'`
        : null,
  },
  kernelDriftAxis('CRAP'),
  {
    name: 'ts-transpiler-drift',
    severity: 'warn',
    check: ({ baseline, runningTsTranspilerVersion }) => {
      if (!baseline || !runningTsTranspilerVersion) return null;
      const baselineTs = baseline.tsTranspilerVersion ?? '0.0.0';
      if (baselineTs === runningTsTranspilerVersion) return null;
      return (
        `[CRAP] ⚠ tsTranspilerVersion drift: baseline=${baselineTs} running=${runningTsTranspilerVersion}. ` +
        "Run 'npm run crap:update' and commit with a 'baseline-refresh:' subject to refresh."
      );
    },
  },
];

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
 * Pure helper: resolve the CRAP baseline either from the working tree
 * (via `getCrapBaseline`) or, when `epicRef` is supplied, from
 * `git show <epicRef>:<baselinePath>` via `readBaselineAtRef`.
 *
 * Story #1120 threads `epic/<id>` into close-validation so the
 * comparison runs against the Epic-branch HEAD's committed baseline.
 * This helper delegates the read to baseline-store and applies the CRAP
 * shape-check + `tsTranspilerVersion` back-fill on top.
 */
export function loadCrapBaseline({
  baselinePath,
  epicRef,
  readAtRef = readBaselineAtRef,
  readFromTree = getCrapBaseline,
  logger = console,
}) {
  const parsed = loadBaseline({
    baselinePath,
    epicRef,
    readAtRef,
    readFromTree,
    logger,
    label: 'CRAP',
  });
  // No-epicRef path delegates to readFromTree which already applies the
  // shape-check + tsTranspilerVersion back-fill, so a tree read returns
  // either a valid envelope or null. Epic-ref path bypasses that helper
  // — shape-check + back-fill happens here.
  if (!epicRef) return parsed;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  if (typeof parsed.kernelVersion !== 'string') return null;
  if (typeof parsed.escomplexVersion !== 'string') return null;
  if (!Array.isArray(parsed.rows)) return null;
  if (typeof parsed.tsTranspilerVersion !== 'string') {
    parsed.tsTranspilerVersion = '0.0.0';
  }
  return parsed;
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
      removed: compareResult.removed,
      skippedNoCoverage,
      scope,
      diffRef,
    },
    violations,
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
      `       crap=${v.crap.toFixed(2)} > ceiling=${v.ceiling} (c=${v.cyclomatic}, cov=${v.coverage.toFixed(2)})`,
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
