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

// Framework default MI tolerance. Raised from 0.001 to 0.5 because real-world
// noise (Node-version churn, escomplex internal updates, typhonjs-escomplex
// rounding) routinely drifts +/- 0.05 to 0.3 on otherwise-unchanged files —
// well below the threshold of "actually less maintainable." A 0.5 floor
// stops the pre-push hook from auto-ratcheting the baseline on noise.
// (The CI guardrail that mechanically flagged unlabeled baseline edits
// was removed in 5.42; the floor stays because the underlying noise is
// real.) Projects that want stricter MI tracking can override via
// `agentSettings.quality.maintainability.tolerance` in `.agentrc.json`.
const DEFAULT_TOLERANCE = 0.5;

/**
 * Pure helper: resolve the effective MI tolerance by layering precedence:
 *   1. `CRAP_TOLERANCE` env-var (CI override — the baseline-refresh-
 *      guardrail uses this to force base-branch values on both gates).
 *   2. `agentSettings.quality.maintainability.tolerance` from the config.
 *   3. `DEFAULT_TOLERANCE` (0.5).
 *
 * Malformed env values warn and fall through to the next layer — a typo in
 * CI must never silently relax the gate, but it also must not skip the
 * configured project value.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ tolerance?: number }} [maintainabilityConfig]
 * @returns {{ tolerance: number, overrides: string[] }}
 */
export function resolveMaintainabilityEnvOverrides(env, maintainabilityConfig) {
  const overrides = [];
  let tolerance = DEFAULT_TOLERANCE;
  // Layer 2: config value (lower precedence than env, higher than default).
  const configured = maintainabilityConfig?.tolerance;
  if (
    typeof configured === 'number' &&
    Number.isFinite(configured) &&
    configured >= 0
  ) {
    tolerance = configured;
    overrides.push(
      `tolerance=${configured} (quality.maintainability.tolerance)`,
    );
  }
  // Layer 1: env override (highest precedence).
  const raw = env?.CRAP_TOLERANCE;
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      tolerance = parsed;
      overrides.push(`tolerance=${parsed} (CRAP_TOLERANCE)`);
    } else {
      Logger.warn(
        `[Maintainability] ⚠ ignoring malformed CRAP_TOLERANCE=${raw}; keeping ${tolerance}`,
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
 * Pure: detect the `--full-scope` opt-out flag in argv. When present, the
 * caller forces a full-repo scan regardless of config / env defaults.
 *
 * Exported for testing.
 *
 * @param {string[]} [argv]
 * @returns {boolean}
 */
export function parseFullScopeArg(argv = process.argv.slice(2)) {
  return argv.includes('--full-scope');
}

/**
 * Pure: resolve the effective `--changed-since` ref by layering precedence:
 *   1. CLI `--full-scope` → returns null (full-scope wins; documented opt-out).
 *   2. CLI `--changed-since <ref>` (or bare flag, defaults to 'main').
 *   3. Env `MAINTAINABILITY_CHANGED_SINCE` (or `CRAP_CHANGED_SINCE` for parity).
 *   4. `agentSettings.quality.maintainability.diffRef` from the resolved config.
 *   5. Framework default 'main' when `defaultScope === 'diff'`.
 *
 * Returns the ref string when diff-scoping should run, or `null` for a full-
 * repo scan. The Tech Spec (Epic #1386) flips the framework default from "off"
 * to diff-scoped on `main`, with `--full-scope` as the explicit opt-out so
 * operators that need a full-repo scan retain a one-flag escape hatch.
 *
 * Exported for testing.
 *
 * @param {{
 *   argv?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   maintainabilityConfig?: { defaultScope?: string, diffRef?: string },
 * }} [opts]
 * @returns {{ ref: string | null, scope: 'diff' | 'full', source: string }}
 */
export function resolveChangedSinceRef({
  argv = process.argv.slice(2),
  env = process.env,
  maintainabilityConfig,
} = {}) {
  // Layer 1: --full-scope opt-out wins over everything.
  if (parseFullScopeArg(argv)) {
    return { ref: null, scope: 'full', source: '--full-scope' };
  }
  // Layer 2: explicit --changed-since flag.
  const fromArgv = parseChangedSinceArg(argv);
  if (fromArgv) {
    return { ref: fromArgv, scope: 'diff', source: '--changed-since' };
  }
  // Layer 3: env var override.
  const fromEnv = env?.MAINTAINABILITY_CHANGED_SINCE ?? env?.CRAP_CHANGED_SINCE;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return {
      ref: fromEnv,
      scope: 'diff',
      source: env?.MAINTAINABILITY_CHANGED_SINCE
        ? 'MAINTAINABILITY_CHANGED_SINCE'
        : 'CRAP_CHANGED_SINCE',
    };
  }
  // Layer 4: project config.
  const configuredScope = maintainabilityConfig?.defaultScope;
  const configuredRef = maintainabilityConfig?.diffRef;
  if (configuredScope === 'full') {
    return { ref: null, scope: 'full', source: 'config.defaultScope=full' };
  }
  if (typeof configuredRef === 'string' && configuredRef.length > 0) {
    return {
      ref: configuredRef,
      scope: 'diff',
      source: 'config.diffRef',
    };
  }
  // Layer 5: framework default — diff-scope against 'main'.
  return { ref: 'main', scope: 'diff', source: 'default' };
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
 * Story #1394: `summary` now carries `scope` ("diff" | "full") and `diffRef`
 * (the resolved git ref the diff was scoped against, or null for full-scope
 * runs). Downstream tooling (`quality-preview`, the auto-refresh evaluator)
 * needs the scope tag to decide whether the envelope can be merged with a
 * peer envelope from the other gate or whether a full-repo refresh just
 * happened.
 *
 * @param {Record<string, number>} scores current MI scores keyed by file
 * @param {{
 *   regressions: number,
 *   newFiles: number,
 *   improvements: number,
 *   regressedFiles: Array<{file: string, current: number, baseline: number, drop: number}>
 * }} stats
 * @param {{ scope?: 'diff' | 'full', diffRef?: string | null }} [scopeInfo]
 * @returns {{ kernelVersion: string, summary: object, violations: Array<object> }}
 */
export function buildMaintainabilityReport(scores, stats, scopeInfo) {
  const total = Object.keys(scores ?? {}).length;
  const violations = (stats?.regressedFiles ?? []).map((r) => ({
    file: r.file,
    current: r.current,
    baseline: r.baseline,
    drop: r.drop,
    kind: 'regression',
  }));
  const scope = scopeInfo?.scope === 'full' ? 'full' : 'diff';
  const diffRef = scope === 'full' ? null : (scopeInfo?.diffRef ?? null);
  return {
    kernelVersion: MI_REPORT_KERNEL_VERSION,
    summary: {
      total,
      regressions: stats?.regressions ?? 0,
      newFiles: stats?.newFiles ?? 0,
      improvements: stats?.improvements ?? 0,
      scope,
      diffRef,
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

async function emitRegressionFriction(storyId, epicId, regressedFiles, config) {
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
      config,
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
    maintainabilityConfig,
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
      writeJsonReport(
        jsonPath,
        buildMaintainabilityReport(scores, stats, {
          scope: resolvedScope.scope,
          diffRef: resolvedScope.ref,
        }),
      );
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
      await emitRegressionFriction(storyId, epicId, stats.regressedFiles, {
        agentSettings,
      });
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
