/* node:coverage ignore file -- top-level CLI gate; tested logic lives in lib/maintainability-engine.js + lib/gates/baseline-store.js */

import path from 'node:path';
import { resolveMaintainabilityEnvOverrides } from './lib/baselines/env-overrides.js';
import {
  buildMaintainabilityReport,
  enforceMaintainabilityFloor,
  loadMaintainabilityBaseline,
} from './lib/baselines/kinds/maintainability.js';
import { getChangedFiles } from './lib/changed-files.js';
import { runAsCli } from './lib/cli-utils.js';
import {
  getBaselines,
  getQuality,
  resolveConfig,
} from './lib/config-resolver.js';
import { writeBaseline } from './lib/gates/baseline-store.js';
import { emitFrictionSignal } from './lib/gates/friction.js';
import { parseGateArgs, resolveScopedRef } from './lib/gates/gate-cli.js';
import { Logger } from './lib/Logger.js';
import { calculateAll, scanDirectory } from './lib/maintainability-utils.js';

export { resolveMaintainabilityEnvOverrides } from './lib/baselines/env-overrides.js';
// Story #1981, Task #1989: re-export hoisted helpers so any in-tree
// consumer still importing from check-maintainability.js keeps working
// until the CLI itself is deleted in Task #2006.
export {
  buildMaintainabilityReport,
  enforceMaintainabilityFloor,
  loadMaintainabilityBaseline,
  MI_REPORT_KERNEL_VERSION,
} from './lib/baselines/kinds/maintainability.js';

/**
 * CI script to verify that maintainability scores haven't regressed.
 * Exit code 1 if regressions are found, 0 otherwise.
 *
 * When invoked with `--story <id>` (or `FRICTION_STORY_ID` env) and
 * `--epic <id>` (or `FRICTION_EPIC_ID` env) the script also appends a
 * `friction` signal record to the per-Story
 * `temp/epic-<eid>/story-<sid>/signals.ndjson` stream naming every
 * regressed file — turning the previously silent CI-exit into a signal
 * the analyzer can pick up without scraping CI logs.
 *
 * When invoked with `--json <path>` the script writes a structured envelope
 * shaped like the CRAP parity output (`{ kernelVersion, summary, violations }`)
 * minus `fixGuidance`. The MI model is not amenable to the two-axis CRAP
 * decomposition, so per-violation guidance is intentionally absent.
 */

function compareScores(scores, baseline, tolerance) {
  let regressions = 0;
  let newFiles = 0;
  let improvements = 0;
  const regressedFiles = [];

  for (const [file, score] of Object.entries(scores)) {
    const baselineScore = baseline[file];

    if (baselineScore === undefined) {
      Logger.info(
        `[Maintainability] 🆕 New file detected: ${file} (Score: ${score.toFixed(2)})`,
      );
      newFiles++;
      continue;
    }

    if (score < baselineScore - tolerance) {
      const diff = baselineScore - score;
      Logger.error(`[Maintainability] ❌ REGRESSION in ${file}`);
      Logger.error(`                Current: ${score.toFixed(2)}`);
      Logger.error(`                Baseline: ${baselineScore.toFixed(2)}`);
      Logger.error(`                Drop: -${diff.toFixed(2)}`);
      regressions++;
      regressedFiles.push({
        file,
        current: score,
        baseline: baselineScore,
        drop: diff,
      });
    } else if (score > baselineScore + tolerance) {
      improvements++;
    }
  }

  return { regressions, newFiles, improvements, regressedFiles };
}

/**
 * Pure: coerce a raw argv/env value to a positive integer Story ID, or null
 * when it cannot be interpreted as one. Re-exported here as the historical
 * public name; the canonical implementation lives in lib/gates/gate-cli.js.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export { coercePositiveInt as coerceStoryId } from './lib/gates/gate-cli.js';

/**
 * Resolve the Story ID for friction signals. CLI `--story <id>` wins;
 * otherwise `FRICTION_STORY_ID` env. Returns null when neither yields a
 * positive int. Thin wrapper around `parseGateArgs` so the env fallback
 * stays in one place.
 *
 * @param {string[]} [argv]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function parseStoryIdArg(
  argv = process.argv.slice(2),
  env = process.env,
) {
  return parseGateArgs(argv, { env }).storyId;
}

/**
 * Resolve the Epic ID for friction signals. CLI `--epic <id>` wins;
 * otherwise `FRICTION_EPIC_ID` env.
 *
 * @param {string[]} [argv]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function parseEpicIdArg(
  argv = process.argv.slice(2),
  env = process.env,
) {
  return parseGateArgs(argv, { env }).epicId;
}

export function parseChangedSinceArg(argv = process.argv.slice(2)) {
  return parseGateArgs(argv).changedSinceRef;
}

/**
 * Pure: detect the `--full-scope` opt-out flag in argv. When present, the
 * caller forces a full-repo scan regardless of config / env defaults.
 *
 * Exported for testing.
 *
 * @param {string[]} [argv]
 * @returns {boolean}
 */
export function parseFullScopeArg(argv = process.argv.slice(2)) {
  return parseGateArgs(argv).fullScope;
}

/**
 * Resolve the MI `--changed-since` ref. Thin wrapper over
 * `resolveScopedRef` that pins the MI-first env precedence and reuses
 * the precedence chain shared with CRAP (Story #1394 AC15 parity).
 *
 * Exported for testing.
 */
export function resolveChangedSinceRef({
  argv = process.argv.slice(2),
  env = process.env,
  maintainabilityConfig,
} = {}) {
  return resolveScopedRef({
    argv,
    env,
    config: maintainabilityConfig,
    primaryEnv: 'MAINTAINABILITY_CHANGED_SINCE',
    secondaryEnv: 'CRAP_CHANGED_SINCE',
  });
}

/**
 * Resolve `--epic-ref <ref>` from argv. Returns the ref string when present
 * and non-empty, else null. Story #1120: when set, the gate reads the
 * baseline file at that git ref via `baseline-loader.readBaselineAtRef`
 * instead of via the working-tree fs read. The close-validation chain
 * threads `epic/<id>` into this flag so the gate compares against the
 * Epic-branch HEAD's committed baseline, not whatever the main checkout's
 * working tree happens to carry.
 *
 * Exported for testing.
 */
export function parseEpicRefArg(argv = process.argv.slice(2)) {
  return parseGateArgs(argv).epicRef;
}

function parseJsonPathArg(argv = process.argv.slice(2)) {
  return parseGateArgs(argv).jsonPath;
}

async function emitRegressionFriction(storyId, epicId, regressedFiles, config) {
  if (regressedFiles.length === 0) return;
  await emitFrictionSignal({
    storyId,
    epicId,
    category: 'baseline-refresh-regression',
    tool: 'check-maintainability.js',
    details: `${regressedFiles.length} file(s) below maintainability baseline`,
    payload: {
      regressedFiles: regressedFiles.map((r) => ({
        file: r.file,
        current: r.current,
        baseline: r.baseline,
        drop: r.drop,
      })),
    },
    config,
    logger: Logger,
    logLabel: 'Maintainability',
  });
}

function printSummaryReport(scores, stats) {
  const { regressions, improvements, newFiles } = stats;
  Logger.info('\n--- Maintainability Report ---');
  Logger.info(`Total Files Checked: ${Object.keys(scores).length}`);
  Logger.info(
    `Pass:                ${Object.keys(scores).length - regressions}`,
  );
  Logger.info(`Regressions:         ${regressions}`);
  Logger.info(`Improvements:        ${improvements}`);
  Logger.info(`New Files:           ${newFiles}`);
  Logger.info('------------------------------\n');
}

async function main() {
  Logger.info('[Maintainability] Verifying code quality against baseline...');

  const { agentSettings } = resolveConfig();
  const baselinePath = getBaselines({ agentSettings }).maintainability.path;
  const epicRef = parseEpicRefArg();
  const baseline = loadAndValidateBaseline({ baselinePath, epicRef });

  const targetDirs = getQuality({ agentSettings }).maintainability.targetDirs;
  const files = [];
  targetDirs.forEach((dir) => {
    scanDirectory(dir, files);
  });

  const maintainabilityConfig = getQuality({ agentSettings }).maintainability;
  const resolvedScope = resolveChangedSinceRef({
    argv: process.argv.slice(2),
    env: process.env,
    maintainabilityConfig,
  });
  const changedSinceRef = resolvedScope.ref;
  Logger.info(
    `[Maintainability] scope=${resolvedScope.scope}${changedSinceRef ? ` ref=${changedSinceRef}` : ''} (source=${resolvedScope.source})`,
  );
  const { scopedFiles, scopedBaseline } = applyDiffScope({
    files,
    baseline,
    changedSinceRef,
  });

  const scores = await calculateAll(scopedFiles);

  const { tolerance, overrides } = resolveMaintainabilityEnvOverrides(
    process.env,
    maintainabilityConfig,
  );
  if (overrides.length > 0) {
    Logger.info(
      `[Maintainability] env overrides active: ${overrides.join(', ')}`,
    );
  }
  const stats = compareScores(scores, scopedBaseline, tolerance);
  printSummaryReport(scores, stats);

  maybeWriteMaintainabilityReport({ scores, stats, resolvedScope });

  if (stats.regressions > 0) {
    await handleRegression(stats, agentSettings);
  }

  if (enforceMaintainabilityFloor(scores, process.argv.slice(2)) !== 0) {
    process.exit(1);
  }

  Logger.info('[Maintainability] ✅ Clean Code check passed.');
}

/**
 * Load the MI baseline at the optional epic ref, log the ref-read header
 * if any, and bail out (exit 0) when no baseline exists. Extracted from
 * `main` to keep the orchestrator's CRAP under the v6 ceiling.
 *
 * @returns {Record<string, number>}
 */
function loadAndValidateBaseline({ baselinePath, epicRef }) {
  const baseline = loadMaintainabilityBaseline({ baselinePath, epicRef });
  if (epicRef) {
    Logger.info(
      `[Maintainability] reading baseline at ref ${epicRef} (path=${baselinePath})`,
    );
  }
  if (Object.keys(baseline).length === 0) {
    Logger.warn(
      `[Maintainability] ⚠️ No baseline found at ${baselinePath}${epicRef ? ` (ref ${epicRef})` : ''}. Run 'npm run maintainability:update' to create one.`,
    );
    process.exit(0);
  }
  return baseline;
}

/**
 * Handle the regression-found path: log, optionally emit a friction
 * signal, then exit non-zero. Extracted from `main` to keep CRAP under
 * the v6 ceiling.
 */
async function handleRegression(stats, agentSettings) {
  Logger.error(
    '[Maintainability] ❌ Regression check failed. Please refactor the affected files or update the baseline if the change is justified.',
  );
  const storyId = parseStoryIdArg();
  const epicId = parseEpicIdArg();
  if (storyId && epicId) {
    await emitRegressionFriction(storyId, epicId, stats.regressedFiles, {
      agentSettings,
    });
  }
  process.exit(1);
}

/**
 * Apply diff-scope to the file list + baseline. When `changedSinceRef` is
 * unset, returns the inputs unchanged (full-scope). Extracted from `main`
 * to keep the orchestrator's CRAP under the v6 ceiling.
 *
 * @returns {{ scopedFiles: string[], scopedBaseline: Record<string, number> }}
 */
function applyDiffScope({ files, baseline, changedSinceRef }) {
  if (!changedSinceRef) return { scopedFiles: files, scopedBaseline: baseline };
  let changedList;
  try {
    changedList = getChangedFiles({
      ref: changedSinceRef,
      cwd: process.cwd(),
    });
  } catch (err) {
    Logger.error(
      `[Maintainability] ❌ ${err?.message ?? err}. Pass a resolvable ref or drop --changed-since for a full scan.`,
    );
    process.exit(1);
  }
  const scopeSet = new Set(changedList);
  Logger.info(
    `[Maintainability] --changed-since ${changedSinceRef}: ${scopeSet.size} changed file(s) in diff`,
  );
  const scopedFiles = files.filter((abs) => {
    const rel = path.relative(process.cwd(), abs).replace(/\\/g, '/');
    return scopeSet.has(rel);
  });
  const scopedBaseline = Object.fromEntries(
    Object.entries(baseline).filter(([file]) => scopeSet.has(file)),
  );
  return { scopedFiles, scopedBaseline };
}

/**
 * Optionally serialize the run's structured JSON report. Extracted from
 * `main` to keep the orchestrator's CRAP under the v6 ceiling.
 */
function maybeWriteMaintainabilityReport({ scores, stats, resolvedScope }) {
  const jsonPath = parseJsonPathArg();
  if (!jsonPath) return;
  try {
    writeBaseline({
      baselinePath: jsonPath,
      data: buildMaintainabilityReport(scores, stats, {
        scope: resolvedScope.scope,
        diffRef: resolvedScope.ref,
      }),
    });
    Logger.info(`[Maintainability] structured report written: ${jsonPath}`);
  } catch (err) {
    Logger.warn(
      `[Maintainability] failed to write --json report: ${err?.message ?? err}`,
    );
  }
}

runAsCli(import.meta.url, main, {
  source: 'Maintainability',
  errorPrefix: '[Maintainability] ❌ Fatal error',
});
