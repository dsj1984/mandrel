/**
 * phases/preflight.js — story-close preflight phase (Story #2460, Epic
 * #2453 — CLI thinning pilot).
 *
 * Wraps the registry-driven preflight scan + the canonical "preflight
 * refused" close-result envelope. Runs BEFORE `withEpicMergeLock` so the
 * per-Epic lock is not acquired just to release it on a refused
 * preflight (the project-wide exit-code 2 reservation).
 *
 * Public surface:
 *   - runStoryClosePreflight(opts)         ← exported (story-close.js re-export)
 *   - emitPreflightBlockedResult(opts)
 *   - runPreflightPhase(ctx)               ← pipeline entry
 */

import { Logger } from '../../../Logger.js';
import {
  PREFLIGHT_REFUSED_EXIT_CODE,
  runPreflight,
} from '../../../preflight-runner.js';
import { emitBlockedCloseResult } from '../merge-runner.js';

/**
 * Run the story-close preflight gate. Exported so tests can drive it
 * with an inline registry / probe spies without re-entering the full
 * close orchestrator.
 *
 * @param {object} opts
 * @param {string|number} opts.storyId
 * @param {string} [opts.cwd=process.cwd()]
 * @param {object} [opts.probes]
 * @param {object} [opts.registry]
 * @param {string} [opts.dir]
 * @param {object} [opts.logger]
 * @returns {Promise<{ ok: boolean, findings: Array, fixed: Array }>}
 */
export async function runStoryClosePreflight({
  storyId,
  cwd = process.cwd(),
  probes,
  registry,
  dir,
  logger,
} = {}) {
  Logger.info(
    `[story-close] Running preflight checks (scope=story-close) for Story #${storyId ?? '?'}...`,
  );
  const preflight = await runPreflight({
    scope: 'story-close',
    autoFix: true,
    cwd,
    probes,
    registry,
    dir,
    logger,
  });
  return {
    ok: !preflight.blocked,
    findings: preflight.findings,
    fixed: preflight.fixed,
  };
}

/**
 * Emit the canonical close-result envelope for the "preflight refused"
 * exit. Shape mirrors `emitBaselineBlockedResult` so the wave aggregator's
 * label-derivation fallback sees a consistent envelope.
 */
export async function emitPreflightBlockedResult({
  storyId,
  preflight,
  progress,
}) {
  return emitBlockedCloseResult({
    storyId,
    phase: 'preflight',
    reason: 'preflight-refused',
    extra: { findings: preflight.findings },
    progress,
    blockedMessage: `Story #${storyId} blocked: preflight refused — ${preflight.findings.length} blocker finding(s).`,
    logger: Logger,
  });
}

/**
 * Phase pipeline entry. Returns one of:
 *   - { ok: true } when preflight passed (caller continues)
 *   - { ok: false, exitEnvelope } when preflight refused (caller short-circuits
 *     with `{ success: false, result: exitEnvelope, exitCode: PREFLIGHT_REFUSED_EXIT_CODE }`)
 */
export async function runPreflightPhase({ ctx }) {
  const outcome = await runStoryClosePreflight({
    storyId: ctx.storyId,
    cwd: ctx.cwd,
  });
  if (outcome.ok) return { ok: true };
  const exitEnvelope = await emitPreflightBlockedResult({
    storyId: ctx.storyId,
    preflight: outcome,
    progress: ctx.progress,
  });
  return {
    ok: false,
    exitEnvelope: {
      success: false,
      result: exitEnvelope,
      exitCode: PREFLIGHT_REFUSED_EXIT_CODE,
    },
  };
}
