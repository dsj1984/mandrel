/**
 * kinds/crap.js — per-kind module for the CRAP baseline (Story #1891).
 *
 * Row shape: `{ path, method, startLine, crap }`. The legacy on-disk
 * baseline uses `file` instead of `path`; the per-kind v2 envelope schema
 * settles on `path` to match every other kind. The migration in Task
 * #1901 emits `path`; Story #1895 then regenerates the on-disk baseline
 * through the new writer, and Story #1892 updates the reader to consume
 * `path`.
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
import {
  getCrapBaseline,
  resolveEscomplexVersion,
  resolveTsTranspilerVersion,
} from '../../crap-utils.js';
import { loadBaseline } from '../../gates/baseline-store.js';
import { Logger } from '../../Logger.js';
import {
  applyFloorPolicy,
  formatViolation,
  loadFloorConfig,
  parseFloorFlag,
} from '../../quality-floors.js';
import { canonicalise } from '../path-canon.js';
import { mergeRowsByScope } from '../scope.js';

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

function aggregate(rows) {
  if (!rows || rows.length === 0) {
    return { p50: 0, p95: 0, max: 0, methodsAbove20: 0 };
  }
  const sorted = [...rows].map((r) => r.crap).sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
    methodsAbove20: sorted.filter((c) => c > 20).length,
  };
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  // Nearest-rank percentile — keeps the rollup integer-friendly without
  // pulling in a stats dep.
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1),
  );
  return sortedValues[idx];
}

export function rollup(rows, components = []) {
  const out = { '*': aggregate(rows) };
  for (const c of components ?? []) {
    const matched = (rows ?? []).filter((r) => componentMatches(c, r.path));
    out[c.name] = aggregate(matched);
  }
  return out;
}

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
export function compare(head, base) {
  const headRows = Array.isArray(head?.rows) ? head.rows : [];
  const baseRows = Array.isArray(base?.rows) ? base.rows : [];
  const baseByKey = new Map();
  for (const r of baseRows) baseByKey.set(crapRowKey(r), r);
  const seen = new Set();
  const regressions = [];
  const improvements = [];
  const unchanged = [];
  const additions = [];
  for (const h of headRows) {
    const key = crapRowKey(h);
    seen.add(key);
    const b = baseByKey.get(key);
    if (!b) {
      additions.push({ key, head: h, base: null });
      continue;
    }
    const delta = (h.crap ?? 0) - (b.crap ?? 0);
    if (delta > 0) regressions.push({ key, head: h, base: b });
    else if (delta < 0) improvements.push({ key, head: h, base: b });
    else unchanged.push({ key, head: h, base: b });
  }
  for (const b of baseRows) {
    const key = crapRowKey(b);
    if (seen.has(key)) continue;
    if ((b.crap ?? 0) > 0) improvements.push({ key, head: null, base: b });
    else unchanged.push({ key, head: null, base: b });
  }
  return { regressions, improvements, unchanged, additions };
}

function crapRowKey(row) {
  return `${row.path}::${row.method}@${row.startLine}`;
}

function componentMatches(component, p) {
  if (!component || typeof component.includes !== 'string') return false;
  return p === component.includes || p.startsWith(`${component.includes}/`);
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
export function applyEpsilon(prior, regenerated, epsilon) {
  const priorRows = Array.isArray(prior) ? prior : [];
  const regenRows = Array.isArray(regenerated) ? regenerated : [];
  const eps = Number.isFinite(epsilon) && epsilon >= 0 ? epsilon : 0;
  const priorByKey = new Map();
  for (const r of priorRows) priorByKey.set(crapRowKey(r), r);
  return regenRows.map((row) => {
    const p = priorByKey.get(crapRowKey(row));
    if (!p) return row;
    return Math.abs((row.crap ?? 0) - (p.crap ?? 0)) <= eps ? p : row;
  });
}

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
 * Pure decision helper for the missing-baseline / kernel-mismatch /
 * escomplex-mismatch / tsTranspiler-mismatch gate paths. Lets tests
 * assert the exact operator-facing message without spawning a child
 * process.
 *
 * Story #791 retired the transitional `bootstrap` exit-0 path: a missing
 * baseline still fails closed (exit 1). Story #829 (5.29.0) softened
 * `kernelVersion` and `tsTranspilerVersion` drift to **warn**, not fail;
 * `escomplexVersion` mismatch continues to fail closed.
 */
export function evaluateBaselineCompatibility({
  baseline,
  runningKernelVersion,
  runningEscomplexVersion,
  runningTsTranspilerVersion,
}) {
  if (baseline === null || baseline === undefined) {
    return {
      ok: false,
      exitCode: 1,
      kind: 'missing-baseline',
      message:
        "[CRAP] ❌ no baseline found — run 'npm run crap:update' and commit with a 'baseline-refresh:' subject to bootstrap",
    };
  }
  if (baseline.escomplexVersion !== runningEscomplexVersion) {
    return {
      ok: false,
      exitCode: 1,
      kind: 'escomplex-mismatch',
      message: `[CRAP] scorer changed from ${baseline.escomplexVersion} to ${runningEscomplexVersion} — run 'npm run crap:update'`,
    };
  }
  const warnings = [];
  if (baseline.kernelVersion !== runningKernelVersion) {
    warnings.push(
      `[CRAP] ⚠ kernelVersion drift: baseline=${baseline.kernelVersion} running=${runningKernelVersion}. ` +
        "Run 'npm run crap:update' and commit with a 'baseline-refresh:' subject to refresh.",
    );
  }
  const baselineTs = baseline.tsTranspilerVersion ?? '0.0.0';
  if (runningTsTranspilerVersion && baselineTs !== runningTsTranspilerVersion) {
    warnings.push(
      `[CRAP] ⚠ tsTranspilerVersion drift: baseline=${baselineTs} running=${runningTsTranspilerVersion}. ` +
        "Run 'npm run crap:update' and commit with a 'baseline-refresh:' subject to refresh.",
    );
  }
  return { ok: true, warnings };
}

/**
 * Story #1895: project a canonical envelope read from the Epic ref back
 * to the legacy CRAP shape (`escomplexVersion`/`tsTranspilerVersion`
 * backfilled from the running scorer, rows re-keyed by `file`). Returns
 * `null` when `parsed` isn't a canonical envelope so the legacy
 * shape-check path can run.
 */
function projectEpicRefCrapEnvelope(parsed) {
  if (
    !Array.isArray(parsed.rows) ||
    parsed.rows.length === 0 ||
    typeof parsed.rows[0]?.path !== 'string'
  ) {
    return null;
  }
  return {
    kernelVersion: parsed.kernelVersion,
    escomplexVersion: resolveEscomplexVersion(),
    tsTranspilerVersion: resolveTsTranspilerVersion(),
    rows: parsed.rows.map((row) => ({
      crap: row.crap,
      file: row.path,
      method: row.method,
      startLine: row.startLine,
    })),
  };
}

/**
 * Pure helper: resolve the CRAP baseline either from the working tree
 * (legacy fs read via `getCrapBaseline`) or, when `epicRef` is supplied,
 * from `git show <epicRef>:<baselinePath>` via `readBaselineAtRef`.
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
  const projected = projectEpicRefCrapEnvelope(parsed);
  if (projected) return projected;
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
 * Story #1602 — absolute CRAP ceiling (≤20 per method by default). Pure
 * decision helper: returns either `{ exitCode: 0, skipped: true }`,
 * `{ exitCode: 0 }`, or `{ exitCode: 1, violations, ceiling, messages }`.
 * The CLI wrapper renders the messages via `Logger` and returns the exit
 * code; tests can inspect the structured result without monkey-patching
 * the logger.
 *
 * `options.floors` overrides the `loadFloorConfig()` default — used by
 * tests and by callers that have already loaded the floor config.
 *
 * @param {{rows?: Array<{file: string, method: string, crap: number}>}} scan
 * @param {string[]} argv
 * @param {{floors?: object}} [options]
 * @returns {0 | 1}
 */
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

export function enforceCrapFloor(scan, argv, options = {}) {
  if (!parseFloorFlag(argv)) {
    Logger.info('[CRAP] ⚠️  floor gate skipped (--floor=off)');
    return 0;
  }
  const floors = options.floors ?? loadFloorConfig();
  const records = (scan?.rows ?? []).map((r) => ({
    file: r.file,
    method: r.method,
    score: r.crap,
  }));
  const { violations } = applyFloorPolicy(records, floors, 'crap');
  if (violations.length === 0) return 0;
  Logger.error(
    `[CRAP] ❌ Absolute CRAP ceiling violated (${violations.length} method(s); ceiling=${floors.crap}):`,
  );
  for (const v of violations) {
    Logger.error(`                ${formatViolation(v)}`);
  }
  Logger.error(
    '[CRAP] Reduce complexity or add coverage on the flagged methods; the ceiling is non-negotiable. Use `--floor=off` only when running `crap:update`.',
  );
  return 1;
}
