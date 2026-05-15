#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-close.js — Epic-level close entry point.
 *
 * Two responsibilities:
 *
 *   1. Run the self-healing checks registry (scope=`epic-close`,
 *      autoFix=true) as a preflight guard. Any surviving `blocker`
 *      finding short-circuits with exit code 2 ("preflight refused").
 *
 *   2. On a clean preflight, run the post-merge close-tail (Story
 *      #1951):
 *        - Close the Epic's planning artifacts (PRD + Tech Spec) via
 *          `closePlanningArtifacts`. Best-effort.
 *        - Verify the Epic ticket is `state: 'closed'` via
 *          `verifyAndRecoverEpicClose`; if GitHub did not auto-close
 *          it (typically because the PR-driven `Closes #N` was
 *          suppressed), apply a recovery transition to `agent::done`.
 *
 * Idempotent. Re-running against an Epic whose planning artifacts and
 * Epic ticket are already closed is a no-op (each ticket transition is
 * a no-op when the label already matches).
 *
 * Usage:
 *   node .agents/scripts/epic-close.js --epic <epicId>
 *
 * Exit codes:
 *   0 → preflight clean, close-tail completed (or skipped where not applicable)
 *   1 → unexpected error
 *   2 → preflight refused (blocker findings)
 *
 * @see .agents/scripts/lib/preflight-runner.js
 * @see .agents/scripts/epic-deliver-finalize.js
 */

import {
  closePlanningArtifacts as defaultClosePlanningArtifacts,
  verifyAndRecoverEpicClose as defaultVerifyAndRecoverEpicClose,
} from './epic-deliver-finalize.js';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig as defaultResolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import {
  PREFLIGHT_REFUSED_EXIT_CODE,
  runPreflight,
} from './lib/preflight-runner.js';
import { createProvider as defaultCreateProvider } from './lib/provider-factory.js';

/** Default Logger adapter — same shape preflight-runner uses. */
const DEFAULT_LOGGER = {
  info: (msg) => Logger.info(msg),
  warn: (msg) => Logger.warn(msg),
  error: (msg) => Logger.error(msg),
};

/**
 * Run the close-tail: planning-artifact close + Epic state recovery.
 * Exported so the unit-test harness can drive it directly without
 * having to thread fixture probes through the preflight runner.
 *
 * @param {{
 *   epicId: number,
 *   provider: object,
 *   logger?: object,
 *   closePlanningArtifactsFn?: typeof defaultClosePlanningArtifacts,
 *   verifyAndRecoverEpicCloseFn?: typeof defaultVerifyAndRecoverEpicClose,
 * }} opts
 * @returns {Promise<{
 *   planningClose: object,
 *   epicClose: object,
 * }>}
 */
export async function runEpicCloseTail({
  epicId,
  provider,
  logger = DEFAULT_LOGGER,
  closePlanningArtifactsFn = defaultClosePlanningArtifacts,
  verifyAndRecoverEpicCloseFn = defaultVerifyAndRecoverEpicClose,
} = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      'runEpicCloseTail: epicId is required (positive integer).',
    );
  }
  if (!provider) {
    throw new TypeError('runEpicCloseTail: provider is required.');
  }

  // Read the Epic so we have `linkedIssues.{prd,techSpec}` for the
  // planning-close step. `getEpic` is preferred (parses linkedIssues
  // out of the body); fall back to `getTicket` for test doubles.
  let epic = null;
  try {
    if (typeof provider.getEpic === 'function') {
      epic = await provider.getEpic(epicId);
    } else if (typeof provider.getTicket === 'function') {
      epic = await provider.getTicket(epicId);
    }
  } catch (err) {
    logger.warn?.(
      `[epic-close] failed to read Epic #${epicId}: ${err?.message ?? err}`,
    );
  }

  const planningClose = await closePlanningArtifactsFn({
    epicId,
    epic,
    provider,
    logger,
  });

  const epicClose = await verifyAndRecoverEpicCloseFn({
    epicId,
    provider,
    logger,
  });

  return { planningClose, epicClose };
}

/**
 * Run the epic-close entry point. Exported for testing.
 *
 * @param {object} [opts]
 * @param {number|string} [opts.epicId]
 * @param {string} [opts.cwd=process.cwd()]
 * @param {object} [opts.probes]   Test-only — forwarded to assembleState.
 * @param {object} [opts.registry] Test-only — bypass loadRegistry.
 * @param {string} [opts.dir]      Test-only fixture directory.
 * @param {{ info?: Function, warn?: Function, error?: Function }} [opts.logger]
 * @param {object} [opts.injectedProvider] Test-only — bypass createProvider.
 * @param {object} [opts.injectedConfig]   Test-only — bypass resolveConfig.
 * @param {Function} [opts.runEpicCloseTailFn] Test seam for the close-tail body.
 * @returns {Promise<{
 *   status: 'ok' | 'blocked',
 *   findings: Array,
 *   fixed: Array,
 *   planningClose?: object,
 *   epicClose?: object,
 * }>}
 */
export async function runEpicClose({
  epicId,
  cwd = process.cwd(),
  probes,
  registry,
  dir,
  logger = DEFAULT_LOGGER,
  injectedProvider,
  injectedConfig,
  resolveConfigFn = defaultResolveConfig,
  createProviderFn = defaultCreateProvider,
  runEpicCloseTailFn = runEpicCloseTail,
} = {}) {
  const parsedEpicId = Number.parseInt(epicId, 10);
  const haveEpicId = Number.isInteger(parsedEpicId) && parsedEpicId > 0;

  logger.info(
    `[epic-close] Running preflight checks (scope=epic-close) for Epic #${haveEpicId ? parsedEpicId : '?'}...`,
  );
  const preflight = await runPreflight({
    scope: 'epic-close',
    autoFix: true,
    cwd,
    probes,
    registry,
    dir,
    logger,
  });
  if (preflight.blocked) {
    return {
      status: 'blocked',
      findings: preflight.findings,
      fixed: preflight.fixed,
    };
  }

  if (!haveEpicId) {
    logger.warn(
      '[epic-close] preflight clean — --epic <id> not supplied; skipping close-tail.',
    );
    return {
      status: 'ok',
      findings: preflight.findings,
      fixed: preflight.fixed,
    };
  }

  const config = injectedConfig ?? resolveConfigFn({ cwd });
  const provider = injectedProvider ?? createProviderFn(config.orchestration);

  logger.info(`[epic-close] Running close-tail for Epic #${parsedEpicId}...`);
  const tail = await runEpicCloseTailFn({
    epicId: parsedEpicId,
    provider,
    logger,
  });
  logger.info(
    `[epic-close] complete — planning: prd=${tail.planningClose.prd.status} techSpec=${tail.planningClose.techSpec.status}; epic=${tail.epicClose.status}.`,
  );

  return {
    status: 'ok',
    findings: preflight.findings,
    fixed: preflight.fixed,
    planningClose: tail.planningClose,
    epicClose: tail.epicClose,
  };
}

runAsCli(
  import.meta.url,
  async () => {
    const epicIdArg = process.argv.find((a) => a.startsWith('--epic='));
    const epicId = epicIdArg
      ? epicIdArg.slice('--epic='.length)
      : (() => {
          const i = process.argv.indexOf('--epic');
          return i >= 0 ? process.argv[i + 1] : undefined;
        })();
    const result = await runEpicClose({ epicId });
    if (result.status === 'blocked') {
      process.exit(PREFLIGHT_REFUSED_EXIT_CODE);
    }
  },
  { source: 'epic-close' },
);
