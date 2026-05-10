import fs from 'node:fs';
import path from 'node:path';
import { readBaselineAtRef } from './lib/baseline-loader.js';
import { getChangedFiles } from './lib/changed-files.js';
import {
  getBaselines,
  getQuality,
  resolveConfig,
} from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import {
  calculateAll,
  getBaseline,
  scanDirectory,
} from './lib/maintainability-utils.js';
import { appendSignal } from './lib/observability/signals-writer.js';

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

const TOLERANCE = 0.001; // Allow for tiny floating point variances

/**
 * Pure helper: resolve the effective MI tolerance by layering the
 * `CRAP_TOLERANCE` env-var on top of the default. Shared with `check-crap.js`
 * so the baseline-refresh-guardrail CI job can force base-branch values on
 * both gates with a single environment variable. Malformed values warn and
 * fall back to the default — a typo in CI must never silently relax the gate.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ tolerance: number, overrides: string[] }}
 */
export function resolveMaintainabilityEnvOverrides(env) {
  const overrides = [];
  let tolerance = TOLERANCE;
  const raw = env?.CRAP_TOLERANCE;
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      tolerance = parsed;
      overrides.push(`tolerance=${parsed} (CRAP_TOLERANCE)`);
    } else {
      Logger.warn(
        `[Maintainability] ⚠ ignoring malformed CRAP_TOLERANCE=${raw}; keeping default ${TOLERANCE}`,
      );
    }
  }
  return { tolerance, overrides };
}

// Envelope version for the --json parity output. Bump when the report shape
// changes so downstream agent workflows can detect breaks without guessing.
// 1.1.0 — TypeScript support landed in 5.29.0. Reports may now include rows
// keyed on `.ts`/`.tsx` paths in addition to `.js`/`.mjs`/`.cjs`. Score
// values for unchanged JS files are byte-identical across the bump.
export const MI_REPORT_KERNEL_VERSION = '1.1.0';

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
 * when it cannot be interpreted as one. Exported so the argv-walking loop and
 * the env fallback can share a single coercion rule and so tests can pin the
 * "what counts as a Story ID" contract without invoking the CLI.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function coerceStoryId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Resolve the Story ID for friction signals. CLI arg wins; otherwise
 * `FRICTION_STORY_ID` env. Returns null when neither yields a positive int.
 *
 * @param {string[]} [argv]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function parseStoryIdArg(
  argv = process.argv.slice(2),
  env = process.env,
) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--story') {
      const fromArgv = coerceStoryId(argv[i + 1]);
      if (fromArgv !== null) return fromArgv;
    }
  }
  return coerceStoryId(env.FRICTION_STORY_ID);
}

/**
 * Resolve the Epic ID for friction signals. CLI arg wins; otherwise
 * `FRICTION_EPIC_ID` env. Returns null when neither yields a positive int.
 *
 * @param {string[]} [argv]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function parseEpicIdArg(
  argv = process.argv.slice(2),
  env = process.env,
) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--epic') {
      const fromArgv = coerceStoryId(argv[i + 1]);
      if (fromArgv !== null) return fromArgv;
    }
  }
  return coerceStoryId(env.FRICTION_EPIC_ID);
}

export function parseChangedSinceArg(argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--changed-since') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) return next;
      return 'main';
    }
  }
  return null;
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
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--epic-ref') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) return next;
    }
  }
  return null;
}

function parseJsonPathArg(argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json' && argv[i + 1]) return argv[i + 1];
  }
  return null;
}

/**
 * Build the MI parity envelope. Shape matches the CRAP `--json` output:
 *   { kernelVersion, summary, violations }
 * sans `fixGuidance` (MI scores don't decompose along the two CRAP axes).
 *
 * @param {Record<string, number>} scores current MI scores keyed by file
 * @param {{
 *   regressions: number,
 *   newFiles: number,
 *   improvements: number,
 *   regressedFiles: Array<{file: string, current: number, baseline: number, drop: number}>
 * }} stats
 * @returns {{ kernelVersion: string, summary: object, violations: Array<object> }}
 */
export function buildMaintainabilityReport(scores, stats) {
  const total = Object.keys(scores ?? {}).length;
  const violations = (stats?.regressedFiles ?? []).map((r) => ({
    file: r.file,
    current: r.current,
    baseline: r.baseline,
    drop: r.drop,
    kind: 'regression',
  }));
  return {
    kernelVersion: MI_REPORT_KERNEL_VERSION,
    summary: {
      total,
      regressions: stats?.regressions ?? 0,
      newFiles: stats?.newFiles ?? 0,
      improvements: stats?.improvements ?? 0,
    },
    violations,
  };
}

function writeJsonReport(jsonPath, envelope) {
  const abs = path.isAbsolute(jsonPath)
    ? jsonPath
    : path.resolve(process.cwd(), jsonPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(envelope, null, 2)}\n`);
}

async function emitRegressionFriction(storyId, epicId, regressedFiles) {
  if (!storyId || !epicId || regressedFiles.length === 0) return;
  try {
    await appendSignal({
      epicId,
      storyId,
      signal: {
        kind: 'friction',
        timestamp: new Date().toISOString(),
        epicId,
        storyId,
        category: 'baseline-refresh-regression',
        source: { tool: 'check-maintainability.js' },
        details: `${regressedFiles.length} file(s) below maintainability baseline`,
        regressedFiles: regressedFiles.map((r) => ({
          file: r.file,
          current: r.current,
          baseline: r.baseline,
          drop: r.drop,
        })),
      },
    });
  } catch (err) {
    Logger.warn(
      `[Maintainability] friction signal append failed: ${err?.message ?? err}`,
    );
  }
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

/**
 * Pure helper: resolve the baseline using either the working-tree fs read
 * (legacy) or `readBaselineAtRef(epicRef, path)` (Story #1120, when
 * `epicRef` is supplied). Exported so tests can pin the precedence
 * without spawning the CLI.
 *
 * @param {{
 *   baselinePath: string,
 *   epicRef: string | null,
 *   readBaseline?: typeof getBaseline,
 *   readAtRef?: typeof readBaselineAtRef,
 *   logger?: { warn: (m: string) => void },
 * }} opts
 * @returns {Record<string, number>}
 */
export function loadMaintainabilityBaseline({
  baselinePath,
  epicRef,
  readBaseline = getBaseline,
  readAtRef = readBaselineAtRef,
  logger = console,
}) {
  if (!epicRef) return readBaseline(baselinePath);
  try {
    const parsed = readAtRef(epicRef, baselinePath);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    logger.warn(
      `[Maintainability] ⚠ failed to read baseline at ref "${epicRef}": ${err?.message ?? err}. Falling back to working-tree read.`,
    );
    return readBaseline(baselinePath);
  }
}

async function main() {
  Logger.info('[Maintainability] Verifying code quality against baseline...');

  const { agentSettings } = resolveConfig();
  const baselinePath = getBaselines({ agentSettings }).maintainability.path;
  const epicRef = parseEpicRefArg();
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

  const targetDirs = getQuality({ agentSettings }).maintainability.targetDirs;
  const files = [];
  targetDirs.forEach((dir) => {
    scanDirectory(dir, files);
  });

  const changedSinceRef = parseChangedSinceArg();
  let scopedFiles = files;
  let scopedBaseline = baseline;
  if (changedSinceRef) {
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
    scopedFiles = files.filter((abs) => {
      const rel = path.relative(process.cwd(), abs).replace(/\\/g, '/');
      return scopeSet.has(rel);
    });
    scopedBaseline = Object.fromEntries(
      Object.entries(baseline).filter(([file]) => scopeSet.has(file)),
    );
  }

  const scores = await calculateAll(scopedFiles);

  const { tolerance, overrides } = resolveMaintainabilityEnvOverrides(
    process.env,
  );
  if (overrides.length > 0) {
    Logger.info(
      `[Maintainability] env overrides active: ${overrides.join(', ')}`,
    );
  }
  const stats = compareScores(scores, scopedBaseline, tolerance);
  printSummaryReport(scores, stats);

  const jsonPath = parseJsonPathArg();
  if (jsonPath) {
    try {
      writeJsonReport(jsonPath, buildMaintainabilityReport(scores, stats));
      Logger.info(`[Maintainability] structured report written: ${jsonPath}`);
    } catch (err) {
      Logger.warn(
        `[Maintainability] failed to write --json report: ${err?.message ?? err}`,
      );
    }
  }

  if (stats.regressions > 0) {
    Logger.error(
      '[Maintainability] ❌ Regression check failed. Please refactor the affected files or update the baseline if the change is justified.',
    );
    const storyId = parseStoryIdArg();
    const epicId = parseEpicIdArg();
    if (storyId && epicId) {
      await emitRegressionFriction(storyId, epicId, stats.regressedFiles);
    }
    process.exit(1);
  }

  Logger.info('[Maintainability] ✅ Clean Code check passed.');
}

// cli-opt-out: Windows-aware main-guard with leading-slash drive-letter normalisation; the bespoke logic predates runAsCli and stays for parity with check-crap.js.
// Only run main when invoked directly — keep the module importable from tests.
const isDirect = (() => {
  try {
    const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
    const self = new URL(import.meta.url).pathname;
    // Normalize: on Windows URL pathname has a leading slash before the drive.
    const normalizedSelf = /^\/[A-Za-z]:/.test(self) ? self.slice(1) : self;
    return path.resolve(normalizedSelf) === invoked;
  } catch {
    return false;
  }
})();

if (isDirect) {
  main().catch((err) => {
    Logger.error(`[Maintainability] ❌ Fatal error: ${err.message}`);
    process.exit(1);
  });
}
