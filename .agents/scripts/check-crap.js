import path from 'node:path';
import { readBaselineAtRef } from './lib/baseline-loader.js';
import { getChangedFiles } from './lib/changed-files.js';
import { runAsCli } from './lib/cli-utils.js';
import {
  getBaselines,
  getQuality,
  resolveConfig,
} from './lib/config-resolver.js';
import { loadCoverage } from './lib/coverage-utils.js';
import { deriveFixGuidance } from './lib/crap-engine.js';
import {
  getCrapBaseline,
  KERNEL_VERSION,
  resolveEscomplexVersion,
  resolveTsTranspilerVersion,
  scanAndScore,
} from './lib/crap-utils.js';
import { loadBaseline, writeBaseline } from './lib/gates/baseline-store.js';
import { emitFrictionSignal } from './lib/gates/friction.js';
import { parseGateArgs, resolveScopedRef } from './lib/gates/gate-cli.js';
import { Logger } from './lib/Logger.js';
import {
  applyFloorPolicy,
  formatViolation,
  loadFloorConfig,
  parseFloorFlag,
} from './lib/quality-floors.js';
/**
 * CLI: verify CRAP scores against the committed baseline.
 *
 * Hybrid enforcement — tracked methods must not regress beyond `tolerance`;
 * new (untracked) methods must stay at or below `newMethodCeiling`. Removed
 * baseline rows are surfaced (not suppressed, not a failure) so a deletion is
 * visible at review time.
 *
 * Contract:
 *   - `settings.quality.crap.enabled === false` → skip, exit 0.
 *   - Missing baseline → fail closed, exit 1 with a bootstrap-instruction
 *     message. (The transitional informational mode from #596 was retired in
 *     Story #791; the gate is now hard-enforcing across all three firing
 *     sites — close-validation, pre-push, CI.)
 *   - Baseline `kernelVersion` or `escomplexVersion` mismatch vs. the running
 *     scorer → fail closed, exit 1 with a message pointing at
 *     `npm run crap:update`.
 *   - Otherwise: exit 1 if any regression or new-method ceiling violation,
 *     else exit 0.
 *
 * `--story <id>` (or the `FRICTION_STORY_ID` env) plus `--epic <id>` (or
 * the `FRICTION_EPIC_ID` env) mirrors `check-maintainability.js` — on
 * failure we append a `friction` signal to the per-Story
 * `temp/epic-<eid>/story-<sid>/signals.ndjson` stream naming every
 * violating method.
 *
 * Environment overrides (take precedence over `.agentrc.json`):
 *   - `CRAP_NEW_METHOD_CEILING` — integer; overrides `crap.newMethodCeiling`.
 *   - `CRAP_TOLERANCE`          — float;   overrides `crap.tolerance`.
 *   - `CRAP_REFRESH_TAG`        — string;  overrides `crap.refreshTag` (surfaced
 *                                          in the failure hint).
 * These were originally consumed by the (since-removed) baseline-refresh CI
 * guardrail so it could force base-branch values regardless of what the PR
 * branch config said. Retained as a general-purpose override for local
 * re-runs and operator-driven baseline diagnosis. Malformed values log a
 * warning and fall back to the config value — a typo must never silently
 * relax the gate.
 */

/**
 * Pure helper: resolve the effective CRAP config by layering env-var overrides
 * on top of the resolved `.agentrc.json` values. Exported so tests can assert
 * the precedence + malformed-value behavior without spawning the CLI.
 *
 * @param {{ newMethodCeiling?: unknown, tolerance?: unknown, refreshTag?: unknown }} crapConfig
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ newMethodCeiling: number, tolerance: number, refreshTag: string, overrides: string[] }}
 */
export function resolveCrapEnvOverrides(crapConfig, env) {
  const overrides = [];
  let newMethodCeiling = Number.isFinite(crapConfig?.newMethodCeiling)
    ? crapConfig.newMethodCeiling
    : 30;
  // Default 0.05 (raised from 0.001 in 5.36.1). CRAP scores are
  // `c² · (1 − cov)³ + c`, so a sub-percent per-method coverage rounding
  // shift across CI environments — same code, different escomplex /
  // coverage build — moves the score by ~0.01 on its own. A 0.001
  // tolerance flagged that as a regression; real regressions cross
  // whole-integer thresholds (e.g. 8 → 12) and clear 0.05 trivially.
  let tolerance = Number.isFinite(crapConfig?.tolerance)
    ? crapConfig.tolerance
    : 0.05;
  let refreshTag =
    typeof crapConfig?.refreshTag === 'string' && crapConfig.refreshTag.length
      ? crapConfig.refreshTag
      : 'baseline-refresh:';

  const rawCeiling = env?.CRAP_NEW_METHOD_CEILING;
  if (rawCeiling !== undefined && rawCeiling !== '') {
    const parsed = Number(rawCeiling);
    if (Number.isFinite(parsed) && parsed >= 0) {
      newMethodCeiling = parsed;
      overrides.push(`newMethodCeiling=${parsed} (CRAP_NEW_METHOD_CEILING)`);
    } else {
      Logger.warn(
        `[CRAP] ⚠ ignoring malformed CRAP_NEW_METHOD_CEILING=${rawCeiling}; keeping config value ${newMethodCeiling}`,
      );
    }
  }

  const rawTolerance = env?.CRAP_TOLERANCE;
  if (rawTolerance !== undefined && rawTolerance !== '') {
    const parsed = Number(rawTolerance);
    if (Number.isFinite(parsed) && parsed >= 0) {
      tolerance = parsed;
      overrides.push(`tolerance=${parsed} (CRAP_TOLERANCE)`);
    } else {
      Logger.warn(
        `[CRAP] ⚠ ignoring malformed CRAP_TOLERANCE=${rawTolerance}; keeping config value ${tolerance}`,
      );
    }
  }

  const rawRefreshTag = env?.CRAP_REFRESH_TAG;
  if (typeof rawRefreshTag === 'string' && rawRefreshTag.length > 0) {
    refreshTag = rawRefreshTag;
    overrides.push(`refreshTag=${rawRefreshTag} (CRAP_REFRESH_TAG)`);
  }

  return { newMethodCeiling, tolerance, refreshTag, overrides };
}

function readGateExtra(argv, flag) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag) {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) return next;
      return undefined;
    }
  }
  return undefined;
}

export function parseArgv(argv = process.argv.slice(2)) {
  const parsed = parseGateArgs(argv, {
    extras: {
      baselinePath: (a) => readGateExtra(a, '--baseline'),
      coveragePath: (a) => readGateExtra(a, '--coverage'),
    },
  });
  return {
    storyId: parsed.storyId,
    epicId: parsed.epicId,
    baselinePath: parsed.extras.baselinePath,
    coveragePath: parsed.extras.coveragePath,
    changedSinceRef: parsed.changedSinceRef,
    fullScope: parsed.fullScope,
    epicRef: parsed.epicRef,
    jsonPath: parsed.jsonPath ?? undefined,
  };
}

/**
 * Resolve the CRAP `--changed-since` ref. Thin gate-specific wrapper over
 * `resolveScopedRef`: pins the CRAP-first env precedence and reuses the
 * CLI `--changed-since` / `--full-scope` precedence shared with MI.
 *
 * Exported for testing.
 */
export function resolveCrapChangedSince({
  parsedArgs,
  env = process.env,
  crapConfig,
}) {
  const argv = [];
  if (parsedArgs?.fullScope) argv.push('--full-scope');
  if (typeof parsedArgs?.changedSinceRef === 'string') {
    argv.push('--changed-since', parsedArgs.changedSinceRef);
  }
  return resolveScopedRef({
    argv,
    env,
    config: crapConfig,
    primaryEnv: 'CRAP_CHANGED_SINCE',
    secondaryEnv: 'MAINTAINABILITY_CHANGED_SINCE',
  });
}

/**
 * Pure helper — narrow a list of rows to the ones whose `file` field is in
 * `scopeSet`. Shared between scan-row filtering and baseline-row filtering so
 * the `--changed-since` code path treats both sides of the comparison the
 * same way (otherwise every baseline row for an untouched file would surface
 * as "removed" on every diff-scoped run).
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
 * Pure comparator. Given scanned `currentRows` and committed `baselineRows`,
 * produce a structured verdict covering all four match paths:
 *
 *   1. **exact**     — same (file, method, startLine). Regresses if current
 *                      crap > baseline crap + tolerance.
 *   2. **drifted**   — same (file, method) but startLine shifted. Uses the
 *                      closest line-drifted baseline row; regresses under the
 *                      same no-regression rule. A drift without regression is
 *                      reported informationally in `drifted`.
 *   3. **new**       — no baseline match. Violates if crap > newMethodCeiling.
 *   4. **removed**   — baseline rows not seen in the current scan. Surfaced
 *                      only; never a failure.
 *
 * @param {{
 *   currentRows: Array<{file: string, method: string, startLine: number, cyclomatic: number, coverage: number, crap: number}>,
 *   baselineRows: Array<{file: string, method: string, startLine: number, crap: number}>,
 *   newMethodCeiling: number,
 *   tolerance: number,
 * }} params
 * @returns {{
 *   total: number,
 *   regressions: number,
 *   newViolations: number,
 *   drifted: number,
 *   removed: number,
 *   violations: Array<object>,
 *   removedRows: Array<object>,
 * }}
 */
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
      // Pick the closest un-seen candidate by startLine distance; fall back to
      // the first one if all have been seen (duplicate method names).
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
 * escomplex-mismatch / tsTranspiler-mismatch gate paths. Lets tests assert
 * the exact operator-facing message without spawning a child process.
 *
 * Story #791 retired the transitional `bootstrap` exit-0 path: a missing
 * baseline still fails closed (exit 1) so close-validation, pre-push, and
 * CI all enforce uniformly. Operators bootstrap explicitly via
 * `npm run crap:update` + a `baseline-refresh:` commit.
 *
 * Story #829 (5.29.0) softened `kernelVersion` and `tsTranspilerVersion`
 * drift to **warn**, not fail: when consumers pin-and-bump the framework
 * the kernel may move ahead of their committed baseline, and they need
 * runway to refresh deliberately rather than discovering the bump from
 * a hard CI red. `escomplexVersion` mismatch continues to fail closed —
 * a different kernel can change scoring semantics without warning.
 *
 * @param {{
 *   baseline: {kernelVersion: string, escomplexVersion: string, tsTranspilerVersion?: string, rows: Array}|null,
 *   runningKernelVersion: string,
 *   runningEscomplexVersion: string,
 *   runningTsTranspilerVersion?: string,
 * }} params
 * @returns {{ ok: true, warnings: string[] }
 *   | { ok: false, exitCode: 1, kind: 'missing-baseline'|'escomplex-mismatch', message: string }}
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
 * Build the structured `--json` report envelope.
 *
 * Violations carry the same fields the stdout printer emits plus a
 * deterministic `fixGuidance` block derived from the formula: target is the
 * baseline for regressions and the ceiling for new-method violations. Rows
 * are deep-cloned so callers can safely mutate the envelope without
 * corrupting the live comparator result.
 *
 * @param {{
 *   compareResult: ReturnType<typeof compareCrap>,
 *   scanSummary: { skippedFilesNoCoverage?: number, skippedMethodsNoCoverage?: number },
 *   kernelVersion: string,
 *   escomplexVersion: string,
 *   newMethodCeiling: number,
 * }} params
 * @returns {{
 *   kernelVersion: string,
 *   escomplexVersion: string,
 *   summary: object,
 *   violations: Array<object>,
 * }}
 */
export function buildCrapReport({
  compareResult,
  scanSummary,
  kernelVersion,
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
  // downstream tooling (`quality-preview`, the auto-refresh evaluator) can
  // detect whether the diff was scoped or full-repo before merging this
  // envelope with the peer MI envelope.
  const scope = scopeInfo?.scope === 'full' ? 'full' : 'diff';
  const diffRef = scope === 'full' ? null : (scopeInfo?.diffRef ?? null);
  return {
    kernelVersion,
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

function printSummary(result, scanSummary) {
  printSummaryHeader(result, scanSummary);
  for (const v of result.violations) {
    printViolationLine(v);
  }
  printRemovedRows(result);
}

function printSummaryHeader(result, scanSummary) {
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

function printViolationLine(v) {
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

function printRemovedRows(result) {
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

async function emitFriction(storyId, epicId, result, orchestration) {
  const offenders = result.violations;
  if (offenders.length === 0) return;
  // `orchestration` here is the full resolved config bag — the legacy
  // parameter name predates bag-style threading and stays for surface stability.
  const category =
    orchestration?.agentSettings?.maintainability?.crap?.friction?.markerKey ??
    'crap-baseline-regression';
  await emitFrictionSignal({
    storyId,
    epicId,
    category,
    tool: 'check-crap.js',
    details: `${offenders.length} CRAP violation(s) detected`,
    payload: {
      violations: offenders.map((v) => ({
        file: v.file,
        method: v.method,
        startLine: v.startLine,
        crap: v.crap,
        baseline: v.kind === 'new' ? null : v.baseline,
        ceiling: v.kind === 'new' ? v.ceiling : null,
        cyclomatic: v.cyclomatic,
        coverage: v.coverage,
        kind: v.kind,
      })),
    },
    config: orchestration,
    logger: Logger,
    logLabel: 'CRAP',
  });
}

/**
 * Pure helper: resolve the CRAP baseline either from the working tree
 * (legacy fs read via `getCrapBaseline`) or, when `epicRef` is supplied,
 * from `git show <epicRef>:<baselinePath>` via `readBaselineAtRef`.
 *
 * Story #1120 threads `epic/<id>` into close-validation so the comparison
 * runs against the Epic-branch HEAD's committed baseline. This helper
 * delegates the read to baseline-store and applies the CRAP shape-check
 * + `tsTranspilerVersion` back-fill on top.
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
  // No-epicRef path delegates to readFromTree (defaults to getCrapBaseline)
  // which already applies the shape-check + tsTranspilerVersion back-fill,
  // so a tree read returns either a valid envelope or null. Epic-ref path
  // bypasses that helper — shape-check + back-fill happens here.
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

async function main() {
  const args = parseArgv();
  const { agentSettings, ...rest } = resolveConfig();
  const crap = getQuality({ agentSettings }).crap;

  if (crap.enabled === false) {
    Logger.info('[CRAP] gate skipped (disabled)');
    return 0;
  }

  // Story #1394: diff-scoped scan is the default. The resolver layers CLI
  // flags > env > config > framework default and returns the effective ref
  // (or null for `--full-scope`). Resolve BEFORE the baseline / kernel-
  // mismatch checks — a bad ref must always surface (AC14); silent
  // degradation to bootstrap exit 0 when the ref is misspelled would defeat
  // the entire purpose of the flag.
  const resolvedScope = resolveCrapChangedSince({
    parsedArgs: args,
    env: process.env,
    crapConfig: crap,
  });
  Logger.info(
    `[CRAP] scope=${resolvedScope.scope}${resolvedScope.ref ? ` ref=${resolvedScope.ref}` : ''} (source=${resolvedScope.source})`,
  );
  const scopeOutcome = resolveScopeSet(resolvedScope);
  if (scopeOutcome.exitCode !== undefined) return scopeOutcome.exitCode;
  const scopeSet = scopeOutcome.scopeSet;

  const baseline = loadBaselineWithRefLog({ args, agentSettings });
  const runningEscomplex = resolveEscomplexVersion();
  const compatOutcome = checkBaselineCompat(baseline, runningEscomplex);
  if (compatOutcome.exitCode !== undefined) return compatOutcome.exitCode;

  const targetDirs = Array.isArray(crap.targetDirs) ? crap.targetDirs : [];
  const requireCoverage = crap.requireCoverage !== false;
  const coveragePath =
    args.coveragePath ?? crap.coveragePath ?? 'coverage/coverage-final.json';
  const { newMethodCeiling, tolerance, refreshTag, overrides } =
    resolveCrapEnvOverrides(crap, process.env);
  if (overrides.length > 0) {
    Logger.info(`[CRAP] env overrides active: ${overrides.join(', ')}`);
  }

  const coverage = loadCoverage(path.resolve(process.cwd(), coveragePath));

  const scan = await scanAndScore({
    targetDirs,
    coverage,
    requireCoverage,
    cwd: process.cwd(),
    scopeFiles: scopeSet,
  });

  const baselineRows = scopeSet
    ? filterRowsByFileScope(baseline.rows, scopeSet)
    : baseline.rows;

  const result = compareCrap({
    currentRows: scan.rows,
    baselineRows,
    newMethodCeiling,
    tolerance,
  });

  printSummary(result, scan);

  maybeWriteJsonReport({
    args,
    result,
    scan,
    runningEscomplex,
    newMethodCeiling,
    resolvedScope,
  });

  if (result.regressions > 0 || result.newViolations > 0) {
    await handleGateFailure({ result, refreshTag, args, agentSettings, rest });
    return 1;
  }

  const floorExit = enforceCrapFloor(scan, process.argv.slice(2));
  if (floorExit !== 0) return floorExit;

  Logger.info('[CRAP] ✅ check passed.');
  return 0;
}

/**
 * Load the CRAP baseline (optionally at the epic ref) and log the
 * ref-read header. Extracted from `main` to keep CRAP under the v6 ceiling.
 */
function loadBaselineWithRefLog({ args, agentSettings }) {
  const baselinePath =
    args.baselinePath ?? getBaselines({ agentSettings }).crap.path;
  const baseline = loadCrapBaseline({
    baselinePath,
    epicRef: args.epicRef,
  });
  if (args.epicRef) {
    Logger.info(
      `[CRAP] reading baseline at ref ${args.epicRef} (path=${baselinePath})`,
    );
  }
  return baseline;
}

/**
 * Emit the gate-failure log line + optional friction signal. Extracted
 * from `main` to keep CRAP under the v6 ceiling.
 */
async function handleGateFailure({
  result,
  refreshTag,
  args,
  agentSettings,
  rest,
}) {
  Logger.error(
    `[CRAP] ❌ check failed. Reduce complexity or add coverage on the flagged methods, or run \`npm run crap:update\` with a \`${refreshTag}\` commit if justified.`,
  );
  if (args.storyId && args.epicId) {
    await emitFriction(args.storyId, args.epicId, result, {
      ...rest,
      agentSettings,
    });
  }
}

/**
 * Run the baseline-compat check + emit warnings. Returns `{exitCode}` when
 * the caller should exit early; otherwise `{exitCode: undefined}` and main
 * continues. Extracted from `main` to keep CRAP under the v6 ceiling.
 *
 * @returns {{ exitCode: number | undefined }}
 */
function checkBaselineCompat(baseline, runningEscomplex) {
  const runningTs = resolveTsTranspilerVersion();
  const compat = evaluateBaselineCompatibility({
    baseline,
    runningKernelVersion: KERNEL_VERSION,
    runningEscomplexVersion: runningEscomplex,
    runningTsTranspilerVersion: runningTs,
  });
  if (!compat.ok) {
    if (compat.exitCode === 0) Logger.info(compat.message);
    else Logger.error(compat.message);
    return { exitCode: compat.exitCode };
  }
  for (const warning of compat.warnings ?? []) {
    Logger.warn(warning);
  }
  return { exitCode: undefined };
}

/**
 * Resolve the changed-since scope into a Set of files (or null for full
 * scope). Extracted from `main` to keep the orchestrator method's CRAP
 * under the v6 ceiling.
 *
 * @returns {{ scopeSet: Set<string> | null, exitCode?: number }}
 */
function resolveScopeSet(resolvedScope) {
  if (!resolvedScope.ref) return { scopeSet: null };
  try {
    const changed = getChangedFiles({
      ref: resolvedScope.ref,
      cwd: process.cwd(),
    });
    const scopeSet = new Set(changed);
    Logger.info(
      `[CRAP] --changed-since ${resolvedScope.ref}: ${scopeSet.size} changed file(s) in diff`,
    );
    return { scopeSet };
  } catch (err) {
    Logger.error(
      `[CRAP] ❌ ${err?.message ?? err}. Pass a resolvable ref or drop --changed-since for a full scan.`,
    );
    return { scopeSet: null, exitCode: 1 };
  }
}

/**
 * Optionally serialize the run's structured JSON report to `args.jsonPath`.
 * Extracted from `main` to keep the orchestrator method's CRAP under the
 * v6 ceiling.
 */
function maybeWriteJsonReport({
  args,
  result,
  scan,
  runningEscomplex,
  newMethodCeiling,
  resolvedScope,
}) {
  if (!args.jsonPath) return;
  const envelope = buildCrapReport({
    compareResult: result,
    scanSummary: scan,
    kernelVersion: KERNEL_VERSION,
    escomplexVersion: runningEscomplex,
    newMethodCeiling,
    scopeInfo: {
      scope: resolvedScope.scope,
      diffRef: resolvedScope.ref,
    },
  });
  try {
    writeBaseline({ baselinePath: args.jsonPath, data: envelope });
    Logger.info(`[CRAP] structured report written: ${args.jsonPath}`);
  } catch (err) {
    Logger.warn(`[CRAP] failed to write --json report: ${err?.message ?? err}`);
  }
}

/**
 * Story #1602 — absolute CRAP ceiling (≤20 per method by default).
 * Runs after the ratchet/new-method check so a method that's matched
 * the baseline but exceeds the ceiling still trips the gate. Opt-out:
 * `--floor=off` for baseline-update runs. Extracted from `main` to keep
 * the orchestrator method's per-method CRAP under the v6 ceiling.
 *
 * @returns {0 | 1} exit code (0 = pass / skipped, 1 = violation)
 */
function enforceCrapFloor(scan, argv) {
  if (!parseFloorFlag(argv)) {
    Logger.info('[CRAP] ⚠️  floor gate skipped (--floor=off)');
    return 0;
  }
  const floors = loadFloorConfig();
  const records = (scan.rows ?? []).map((r) => ({
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

runAsCli(import.meta.url, main, {
  source: 'CRAP',
  propagateExitCode: true,
  errorPrefix: '[CRAP] ❌ Fatal error',
});
