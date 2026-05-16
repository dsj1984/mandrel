/* node:coverage ignore file -- top-level CLI gate; tested logic lives in lib/crap-engine.js + lib/crap-utils.js + lib/gates/baseline-store.js */

import path from 'node:path';
import { resolveCrapEnvOverrides } from './lib/baselines/env-overrides.js';
import {
  buildCrapReport,
  compareCrap,
  enforceCrapFloor,
  evaluateBaselineCompatibility,
  filterRowsByFileScope,
  loadCrapBaseline,
  printRemovedRows,
  printSummaryHeader,
  printViolation,
} from './lib/baselines/kinds/crap.js';
import { getChangedFiles } from './lib/changed-files.js';
import { runAsCli } from './lib/cli-utils.js';
import {
  getBaselines,
  getQuality,
  resolveConfig,
} from './lib/config-resolver.js';
import { loadCoverage } from './lib/coverage-utils.js';
import {
  KERNEL_VERSION,
  resolveEscomplexVersion,
  resolveTsTranspilerVersion,
  scanAndScore,
} from './lib/crap-utils.js';
import { writeBaseline } from './lib/gates/baseline-store.js';
import { emitFrictionSignal } from './lib/gates/friction.js';
import { parseGateArgs, resolveScopedRef } from './lib/gates/gate-cli.js';
import { Logger } from './lib/Logger.js';

export { resolveCrapEnvOverrides } from './lib/baselines/env-overrides.js';
// Story #1981, Task #1989: re-export hoisted helpers so any in-tree
// consumer still importing from check-crap.js keeps working until the
// CLI itself is deleted in Task #2006.
export {
  buildCrapReport,
  checkCrapRegression,
  compareCrap,
  enforceCrapFloor,
  evaluateBaselineCompatibility,
  filterRowsByFileScope,
  loadCrapBaseline,
  printRemovedRows,
  printSummaryHeader,
  printViolation,
} from './lib/baselines/kinds/crap.js';

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

function printSummary(result, scanSummary) {
  printSummaryHeader(result, scanSummary);
  for (const v of result.violations) {
    printViolation(v);
  }
  printRemovedRows(result);
}

async function emitFriction(storyId, epicId, result, orchestration) {
  const offenders = result.violations;
  if (offenders.length === 0) return;
  // `orchestration` here is the full resolved config bag — the legacy
  // parameter name predates bag-style threading and stays for surface stability.
  const category =
    orchestration?.delivery?.quality?.crap?.friction?.markerKey ??
    orchestration?.agentSettings?.quality?.crap?.friction?.markerKey ??
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
 * Resolve the diff-scope file set. Returns either a `Set<string>` of changed
 * files (when `--changed-since` is in effect) or `null` for full-scope. On a
 * bad ref returns `{ error: 1 }` so the caller exits with the right code.
 */
/**
 * Apply the `evaluateBaselineCompatibility` decision: returns the exit code
 * to short-circuit on, or `null` when the check is clean. Emits warnings for
 * the soft-fail path either way.
 */
function _applyCompatDecision(compat) {
  if (!compat.ok) {
    if (compat.exitCode === 0) Logger.info(compat.message);
    else Logger.error(compat.message);
    return compat.exitCode;
  }
  for (const warning of compat.warnings ?? []) {
    Logger.warn(warning);
  }
  return null;
}

/**
 * Pure predicate: did the comparator find any regression or new-method
 * ceiling violation? Wraps the two-field check so `handleCompareResult` is
 * a straight log → emit → return ladder without an inline conjunction.
 */
function hasComparisonFailures(result) {
  return result.regressions > 0 || result.newViolations > 0;
}

/**
 * Handle a non-zero compare result: log the failure hint and emit a
 * friction signal when a Story/Epic id pair is present. Returns the exit
 * code (1 on failure, 0 on success).
 */
async function _handleCompareResult(
  result,
  args,
  refreshTag,
  rest,
  agentSettings,
) {
  if (!hasComparisonFailures(result)) {
    Logger.info('[CRAP] ✅ check passed.');
    return 0;
  }
  Logger.error(
    `[CRAP] ❌ check failed. Reduce complexity or add coverage on the flagged methods, or run \`npm run crap:update\` with a \`${refreshTag}\` commit if justified.`,
  );
  if (args.storyId && args.epicId) {
    await emitFriction(args.storyId, args.epicId, result, {
      ...rest,
      agentSettings,
    });
  }
  return 1;
}

async function main() {
  const args = parseArgv();
  const { agentSettings, ...rest } = resolveConfig();
  const resolvedConfig = resolveConfig();
  const quality = getQuality({ agentSettings });
  const crap = quality.crap;

  if (crap.enabled === false) {
    Logger.info('[CRAP] gate skipped (disabled)');
    return 0;
  }

  // Story #1737: when CRAP declares `requireCoverage: true`, a missing or
  // empty `delivery.quality.gates.coverage` block is an operator error —
  // the gate cannot resolve a coveragePath without one. Fail fast with a
  // pointer to the new schema location.
  if (crap.requireCoverage) {
    const rawGates =
      resolvedConfig?.delivery?.quality?.gates ??
      resolvedConfig?.raw?.delivery?.quality?.gates;
    const coverageConfigured =
      rawGates &&
      typeof rawGates === 'object' &&
      rawGates.coverage &&
      typeof rawGates.coverage === 'object' &&
      Object.keys(rawGates.coverage).length > 0;
    if (!coverageConfigured) {
      Logger.error(
        '[CRAP] ❌ delivery.quality.gates.coverage is not configured but gates.crap.requireCoverage is true. ' +
          'Add a gates.coverage block (at minimum `coveragePath`) or set gates.crap.requireCoverage to false.',
      );
      return 1;
    }
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

runAsCli(import.meta.url, main, {
  source: 'CRAP',
  propagateExitCode: true,
  errorPrefix: '[CRAP] ❌ Fatal error',
});
