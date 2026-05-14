#!/usr/bin/env node
/**
 * update-mutation-baseline.js — Refresh `baselines/mutation.json` from a
 * fresh Stryker run (Story #1736, Task #1752 + #1753).
 *
 * Reads the configured mutation gate (`delivery.quality.gates.mutation`),
 * invokes the Stryker runner from `lib/mutation/stryker-runner.js`, and
 * atomically rewrites the baseline file with the new per-workspace
 * mutation scores. Preserves the configured `tolerancePct` (from the
 * gate's `tolerance.value`) so the file is self-contained — consumers
 * don't need to read `.agentrc.json` to interpret the baseline.
 *
 * Exit codes:
 *   0 — baseline refreshed (didChange true) or no change (didChange false)
 *   0 — Stryker skipped (no config) with an explanatory line on stderr
 *   1 — Stryker invocation failed
 *
 * The refresh is intentionally non-fatal when Stryker is not configured:
 * the operator can run `npx stryker init` and re-invoke this script.
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
  writeBaseline,
} from './lib/mutation/baseline-snapshot.js';
import { runStryker } from './lib/mutation/stryker-runner.js';

/**
 * Resolve the mutation gate config relevant to baseline refresh.
 *
 * @param {object} agentSettings
 * @returns {{ baselinePath: string, tolerancePct: number, strykerConfigPath: string | null }}
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
  const strykerConfigPath =
    typeof gate.strykerConfigPath === 'string' &&
    gate.strykerConfigPath.length > 0
      ? gate.strykerConfigPath
      : null;
  return { baselinePath, tolerancePct, strykerConfigPath };
}

/**
 * @param {{
 *   cwd?: string,
 *   runStrykerFn?: typeof runStryker,
 *   writeBaselineFn?: typeof writeBaseline,
 *   resolveConfigFn?: typeof resolveConfig,
 *   logger?: { info?: (m: string) => void, warn?: (m: string) => void, error?: (m: string) => void },
 * }} [opts]
 * @returns {Promise<{ status: 0 | 1, didChange: boolean, skipped: boolean, reason?: string, baselinePath: string }>}
 */
export async function refreshMutationBaseline({
  cwd = PROJECT_ROOT,
  runStrykerFn = runStryker,
  writeBaselineFn = writeBaseline,
  resolveConfigFn = resolveConfig,
  logger = Logger,
} = {}) {
  const { agentSettings } = resolveConfigFn({ cwd });
  const gate = resolveMutationGate(agentSettings);
  const absBaseline = path.isAbsolute(gate.baselinePath)
    ? gate.baselinePath
    : path.resolve(cwd, gate.baselinePath);

  logger.info?.(`[mutation] refreshing baseline → ${gate.baselinePath}`);
  const runResult = await runStrykerFn({
    cwd,
    configPath: gate.strykerConfigPath,
  });
  if (runResult.skipped) {
    logger.info?.(
      `[mutation] skipped — ${runResult.reason ?? 'runner reported skip'}`,
    );
    return {
      status: 0,
      didChange: false,
      skipped: true,
      reason: runResult.reason ?? 'runner-skip',
      baselinePath: absBaseline,
    };
  }
  if (!runResult.ok) {
    logger.error?.(
      `[mutation] Stryker invocation failed: ${runResult.error ?? 'unknown error'}`,
    );
    return {
      status: 1,
      didChange: false,
      skipped: false,
      reason: runResult.error ?? 'stryker-failed',
      baselinePath: absBaseline,
    };
  }

  const writeResult = writeBaselineFn(absBaseline, {
    tolerancePct: gate.tolerancePct,
    workspaces: runResult.byWorkspace,
  });

  if (writeResult.didChange) {
    logger.info?.(`[mutation] baseline updated at ${gate.baselinePath}`);
  } else {
    logger.info?.(`[mutation] baseline unchanged at ${gate.baselinePath}`);
  }

  return {
    status: 0,
    didChange: writeResult.didChange,
    skipped: false,
    baselinePath: absBaseline,
  };
}

async function main() {
  const result = await refreshMutationBaseline();
  if (result.status !== 0) {
    process.exit(result.status);
  }
}

runAsCli(import.meta.url, main, { source: 'update-mutation-baseline' });
