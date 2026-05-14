#!/usr/bin/env node
/**
 * check-mutation.js — Story-close mutation gate (Story #1736, Epic #1720).
 *
 * Reads the configured mutation gate (`delivery.quality.gates.mutation`),
 * invokes the Stryker runner, and enforces per-workspace mutation-score
 * floors against either the recorded baseline or the configured `floors`
 * block.
 *
 * Exit contract (uniform across new story-close gates):
 *
 *   - exit 0 + `[mutation] passed (...)` → gate satisfied.
 *   - exit 0 + `[mutation] skipped — no Stryker config found. Run
 *     `npx stryker init` to enable.` → prerequisites missing. The
 *     on-by-default contract requires self-skip rather than failure when
 *     a consumer has not opted into Stryker yet.
 *   - exit 0 + `[mutation] skipped — disabled in config` → operator opted
 *     out by setting `delivery.quality.gates.mutation.enabled: false`.
 *   - exit 1 + per-workspace diagnostic lines → at least one workspace
 *     mutation score is below the resolved floor (or below baseline minus
 *     tolerance).
 *
 * Per-workspace violation lines lead with the offending workspace name,
 * the observed score, and the floor that was breached, so an operator
 * grepping the close-validation log can identify the failing workspace
 * without re-reading the report.
 */

import path from 'node:path';

import { runAsCli } from './lib/cli-utils.js';
import {
  getQuality,
  PROJECT_ROOT,
  resolveConfig,
} from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import {
  DEFAULT_BASELINE_PATH,
  DEFAULT_TOLERANCE_PCT,
  readBaseline,
} from './lib/mutation/baseline-snapshot.js';
import { runStryker } from './lib/mutation/stryker-runner.js';

/**
 * Resolve the mutation gate block from the merged `delivery.quality`
 * accessor. Falls back to safe defaults when the gate block is absent.
 *
 * @param {object} agentSettings
 * @returns {{
 *   enabled: boolean,
 *   baselinePath: string,
 *   tolerancePct: number,
 *   floors: Record<string, number> | null,
 *   strykerConfigPath: string | null,
 *   timeoutMs: number | null,
 * }}
 */
export function resolveMutationGate(agentSettings) {
  const quality = getQuality({ agentSettings });
  const gate = quality.gates?.mutation ?? {};
  const baselinePath =
    typeof gate.baselinePath === 'string' && gate.baselinePath.length > 0
      ? gate.baselinePath
      : DEFAULT_BASELINE_PATH;
  const tol = gate.tolerance;
  const tolerancePct =
    tol &&
    typeof tol === 'object' &&
    Number.isFinite(tol.value) &&
    tol.value >= 0
      ? tol.value
      : DEFAULT_TOLERANCE_PCT;
  const floors = extractFloors(gate.floors);
  const strykerConfigPath =
    typeof gate.strykerConfigPath === 'string' &&
    gate.strykerConfigPath.length > 0
      ? gate.strykerConfigPath
      : null;
  const enabled = gate.enabled !== false;
  const timeoutMs = Number.isFinite(gate.timeoutMs) ? gate.timeoutMs : null;
  return {
    enabled,
    baselinePath,
    tolerancePct,
    floors,
    strykerConfigPath,
    timeoutMs,
  };
}

/**
 * Pull the per-workspace mutation-score floor map from the gate's
 * `floors` block. Workspace-keyed format: `{ "*": { mutation: 75 }, ... }`.
 *
 * Returns a flattened `{ "<workspace>": <score> }` object. Returns `null`
 * when no usable floor is configured.
 *
 * @param {unknown} floors
 * @returns {Record<string, number> | null}
 */
export function extractFloors(floors) {
  if (!floors || typeof floors !== 'object' || Array.isArray(floors)) {
    return null;
  }
  const out = /** @type {Record<string, number>} */ ({});
  for (const [workspace, bag] of Object.entries(floors)) {
    if (!bag || typeof bag !== 'object') continue;
    const score = /** @type {Record<string, unknown>} */ (bag).mutation;
    if (Number.isFinite(score) && /** @type {number} */ (score) >= 0) {
      out[workspace] = /** @type {number} */ (score);
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Compare measured per-workspace mutation scores against the resolved
 * floors and baseline. Pure — never logs and never throws.
 *
 * Resolution order for each workspace's floor:
 *   1. Configured `gates.mutation.floors.<workspace>.mutation`
 *   2. Configured `gates.mutation.floors["*"].mutation` (catch-all)
 *   3. Recorded baseline for the workspace minus `tolerancePct`
 *   4. Recorded baseline for `"*"` minus `tolerancePct`
 *
 * When neither floors nor baseline cover a measured workspace, the
 * comparison is skipped (no violation, no pass) — the operator has not
 * yet declared a floor or recorded a baseline for that workspace, and
 * the gate should not invent one.
 *
 * @param {{
 *   measured: Record<string, number>,
 *   floors: Record<string, number> | null,
 *   baseline: { workspaces: Record<string, number>, tolerancePct: number } | null,
 *   tolerancePct: number,
 * }} opts
 * @returns {{
 *   ok: boolean,
 *   violations: Array<{ workspace: string, observed: number, floor: number, source: 'floors' | 'baseline' }>,
 *   passed: Array<{ workspace: string, observed: number, floor: number, source: 'floors' | 'baseline' }>,
 *   ungated: string[],
 * }}
 */
export function evaluateFloors({ measured, floors, baseline, tolerancePct }) {
  const violations = [];
  const passed = [];
  const ungated = [];
  const tol = Number.isFinite(tolerancePct)
    ? tolerancePct
    : DEFAULT_TOLERANCE_PCT;
  for (const [workspace, observed] of Object.entries(measured ?? {})) {
    if (!Number.isFinite(observed)) {
      ungated.push(workspace);
      continue;
    }
    const floor = resolveFloorFor(workspace, floors, baseline, tol);
    if (floor === null) {
      ungated.push(workspace);
      continue;
    }
    const record = {
      workspace,
      observed,
      floor: floor.value,
      source: floor.source,
    };
    if (observed + Number.EPSILON < floor.value) {
      violations.push(record);
    } else {
      passed.push(record);
    }
  }
  return { ok: violations.length === 0, violations, passed, ungated };
}

function resolveFloorFor(workspace, floors, baseline, tolerancePct) {
  if (floors) {
    if (Number.isFinite(floors[workspace])) {
      return { value: floors[workspace], source: 'floors' };
    }
    if (Number.isFinite(floors['*'])) {
      return { value: floors['*'], source: 'floors' };
    }
  }
  if (baseline && baseline.workspaces) {
    const baselineTol = Number.isFinite(baseline.tolerancePct)
      ? baseline.tolerancePct
      : tolerancePct;
    if (Number.isFinite(baseline.workspaces[workspace])) {
      return {
        value: baseline.workspaces[workspace] - baselineTol,
        source: 'baseline',
      };
    }
    if (Number.isFinite(baseline.workspaces['*'])) {
      return {
        value: baseline.workspaces['*'] - baselineTol,
        source: 'baseline',
      };
    }
  }
  return null;
}

/**
 * Top-level orchestrator — dependency-injection friendly so tests can pin
 * every external boundary. Returns the exit code (0 or 1) and a structured
 * outcome so callers can render their own diagnostics.
 *
 * @param {{
 *   cwd?: string,
 *   resolveConfigFn?: typeof resolveConfig,
 *   readBaselineFn?: typeof readBaseline,
 *   runStrykerFn?: typeof runStryker,
 *   logger?: { info?: (m: string) => void, warn?: (m: string) => void, error?: (m: string) => void },
 *   argv?: string[],
 * }} [opts]
 * @returns {Promise<{ status: 0 | 1, outcome: string, detail?: string }>}
 */
export async function runMutationGate({
  cwd = PROJECT_ROOT,
  resolveConfigFn = resolveConfig,
  readBaselineFn = readBaseline,
  runStrykerFn = runStryker,
  logger = Logger,
  argv: _argv = process.argv.slice(2),
} = {}) {
  const { agentSettings } = resolveConfigFn({ cwd });
  const gate = resolveMutationGate(agentSettings);

  if (!gate.enabled) {
    logger.info?.('[mutation] skipped — disabled in config');
    return { status: 0, outcome: 'skipped-disabled' };
  }

  const runResult = await runStrykerFn({
    cwd,
    configPath: gate.strykerConfigPath,
    timeoutMs: gate.timeoutMs ?? undefined,
  });

  if (runResult.skipped) {
    if (runResult.reason && /no Stryker config/i.test(runResult.reason)) {
      logger.info?.(
        '[mutation] skipped — no Stryker config found. Run `npx stryker init` to enable.',
      );
      return { status: 0, outcome: 'skipped-no-config' };
    }
    logger.info?.(
      `[mutation] skipped — ${runResult.reason ?? 'runner reported skip'}`,
    );
    return { status: 0, outcome: 'skipped-runner' };
  }

  if (!runResult.ok) {
    logger.error?.(
      `[mutation] failed — Stryker invocation error: ${runResult.error ?? 'unknown error'}`,
    );
    return { status: 1, outcome: 'stryker-failed', detail: runResult.error };
  }

  const baseline = readBaselineSafe({
    cwd,
    baselinePath: gate.baselinePath,
    readBaselineFn,
    logger,
  });

  const evaluation = evaluateFloors({
    measured: runResult.byWorkspace,
    floors: gate.floors,
    baseline,
    tolerancePct: gate.tolerancePct,
  });

  for (const v of evaluation.violations) {
    logger.error?.(
      `[mutation] ❌ workspace '${v.workspace}' mutation score ${v.observed.toFixed(2)}% below ${v.source === 'baseline' ? 'baseline-adjusted ' : ''}floor ${v.floor.toFixed(2)}%`,
    );
  }
  for (const w of evaluation.ungated) {
    logger.warn?.(
      `[mutation] ⚠ workspace '${w}' has no configured floor or baseline — measurement recorded but not gated`,
    );
  }

  if (!evaluation.ok) {
    logger.error?.(
      `[mutation] ❌ ${evaluation.violations.length} workspace(s) below floor. Refresh the baseline with \`node .agents/scripts/update-mutation-baseline.js\` after adding tests.`,
    );
    return {
      status: 1,
      outcome: 'floor-violated',
      detail: JSON.stringify(evaluation.violations),
    };
  }

  const summary = Object.entries(runResult.byWorkspace ?? {})
    .map(([w, s]) => `${w}=${Number(s).toFixed(2)}%`)
    .join(', ');
  logger.info?.(`[mutation] ✅ passed (${summary})`);
  return { status: 0, outcome: 'passed' };
}

function readBaselineSafe({ cwd, baselinePath, readBaselineFn, logger }) {
  const abs = path.isAbsolute(baselinePath)
    ? baselinePath
    : path.resolve(cwd, baselinePath);
  try {
    return readBaselineFn(abs, { cwd });
  } catch (err) {
    logger.warn?.(
      `[mutation] ⚠ failed to read baseline at ${baselinePath}: ${err instanceof Error ? err.message : String(err)}. Falling back to configured floors only.`,
    );
    return null;
  }
}

async function main() {
  const result = await runMutationGate();
  if (result.status !== 0) {
    process.exit(result.status);
  }
}

runAsCli(import.meta.url, main, { source: 'check-mutation' });
