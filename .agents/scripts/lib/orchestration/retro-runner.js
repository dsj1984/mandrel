/**
 * lib/orchestration/retro-runner.js — In-process Retro module (sequencer).
 *
 * Story #1155 (Epic #1142, 5.40.0) — extracts the helper-driven
 * `epic-retro` invocation into a callable module so the
 * `/deliver` runner can fire Phase E without a separate LLM
 * helper turn. (Story #2259, Epic #2172: the legacy deliver-runner
 * CLI was retired once delivery moved entirely into the slash
 * command.) The retro fires before `/deliver`'s finalize step
 * opens the PR — the operator's PR-merge is the final human gate, not
 * the retro itself.
 *
 * Story #3001 — the runner body was decomposed into `./retro/phases/`
 * (one file per functional unit) following the established pattern at
 * `./git-cleanup/phases/`, `./story-close/phases/`, and
 * `./post-merge/phases/`. This file is now a thin sequencer that owns
 * the `runRetro` entry point and re-exports the phase-level helpers so
 * existing import sites stay unchanged.
 *
 * Public API:
 *   - `runRetro({ epicId, provider, logger })` → `{ posted, compact, scorecard, body, defectClasses }`.
 *   - `composeRetroBody(input)` (pure, exported for tests).
 *   - `gatherRetroSignals({ epicId, provider })` (exported for tests).
 *   - `appendChecksSection(body, findings)` (pure, exported for tests).
 *   - `deriveDefectClasses(routedProposals)` (pure, exported for tests).
 *
 * Story #4135 (Epic #4131, F11) — the runner now derives a
 * **recurring-defect-class signal** from the routed-proposal actionable
 * items (categories that recurred ≥2 times across review/deliver-caught
 * friction, or a force-flagged `agent::blocked` category). The derived
 * classes ride on the `runRetro` envelope as `defectClasses[]` and are
 * stamped onto the proposed `gh issue create` commands as `friction::<class>`
 * labels (the routed-proposals composer already emits that label), which is
 * the durable substrate the `/plan` Phase 0 prior-feedback fetcher reads
 * back to surface recurring classes to the planner. The derivation is
 * **no-op-safe**: absent or empty routed proposals yield an empty array and
 * no behavioural change to the existing retro/post path.
 *
 * Behaviour:
 *   - Reads child Stories' `story-perf-summary` comments to aggregate
 *     `frictionByCategory` totals (Story #1046 unified-summary path).
 *   - Reads child Stories' label sets to count HITL pause events
 *     (`agent::blocked`).
 *   - Reads the Epic's `parked-follow-ons` structured comment for the
 *     parked + recut counts (with a fallback to per-Story body grep on the
 *     `<!-- recut-of: #N -->` marker).
 *   - Selects the compact (clean-manifest) or full retro shape via
 *     `isCleanManifest`.
 *   - Posts the composed markdown as a `retro` structured comment on the
 *     Epic, terminated with the `retro-complete: <ISO>` HTML marker.
 *   - **Never** routes through `notify.js` — GitHub is the sole retro
 *     archive; the webhook must not see the retro body.
 */

import nodeFs from 'node:fs';

import { runChecks } from '../checks/index.js';
import { assembleState } from '../checks/state.js';
import { composeRetroBody } from './retro/phases/compose-body.js';
import { gatherRetroSignals } from './retro/phases/gather-signals.js';
import { composeAndPostRetro } from './retro/phases/post-and-mirror.js';
import { upsertStructuredComment } from './ticketing.js';

// Re-export phase-level helpers so existing import sites stay unchanged.
export { appendChecksSection } from './retro/phases/checks.js';
export {
  composeRetroBody,
  deriveDefectClasses,
} from './retro/phases/compose-body.js';
export { gatherRetroSignals } from './retro/phases/gather-signals.js';

/**
 * Public: compose and post the retro structured comment on the Epic.
 *
 * Story #1290 (Epic #1143) — at /deliver Phase 5, the runner invokes
 * the self-healing checks registry with `scope: 'retro'` and
 * `autoFix: false`. The retro is **read-only by construction**: the
 * registry runner enforces the invariant by throwing if any caller flips
 * `autoFix: true` under `scope: 'retro'`. Findings are appended to the
 * retro body via `appendChecksSection`, which suppresses the section when
 * findings are empty so the compact "🟢 Clean sprint" shape is preserved.
 *
 * Story #2252 — when `opts.bus` is supplied the runner emits
 * `retro.start` immediately on entry and `retro.end` immediately before
 * returning the envelope. On throw the helper emits `retro.end` with
 * `posted: false` before re-throwing so the ledger always carries the
 * closing boundary.
 *
 * @param {{
 *   epicId: number,
 *   provider: object,
 *   logger?: { info?: Function, warn?: Function },
 *   forceFull?: boolean,
 *   timestamp?: string,
 *   bus?: object|null,
 *   now?: () => number,
 *   manualInterventions?: number,
 *   frameworkRepo?: string,
 *   consumerRepo?: string,
 *   config?: object|null,
 *   gatherFn?: typeof gatherRetroSignals,
 *   composeFn?: typeof composeRetroBody,
 *   upsertFn?: typeof upsertStructuredComment,
 *   runChecksFn?: typeof runChecks,
 *   assembleStateFn?: typeof assembleState,
 *   cwd?: string,
 * }} opts
 * @returns {Promise<{
 *   posted: boolean,
 *   compact: boolean,
 *   scorecard: object,
 *   body: string,
 *   findings: object[],
 *   defectClasses: Array<{ category: string, occurrences: number, source: 'framework'|'consumer', label: string }>,
 *   commentId?: number,
 * }>}
 */
export async function runRetro(opts = {}) {
  const {
    epicId,
    provider,
    logger,
    forceFull = false,
    timestamp,
    bus,
    now = Date.now,
    manualInterventions = 0,
    frameworkRepo,
    consumerRepo,
    config = null,
    gatherFn = gatherRetroSignals,
    composeFn = composeRetroBody,
    upsertFn = upsertStructuredComment,
    runChecksFn = runChecks,
    assembleStateFn = assembleState,
    cwd,
    fsImpl = nodeFs,
    perfThresholds = null,
  } = opts;

  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError('runRetro: epicId is required (positive integer).');
  }
  if (!provider) {
    throw new TypeError('runRetro: provider is required.');
  }
  // Epic #2646 Story C (Task #2700) — `bus` is now a hard input. The
  // previous guarded `emitLifecycleSafe` helper that tolerated a null
  // bus is gone.
  if (!bus || typeof bus.emit !== 'function') {
    throw new TypeError('runRetro: bus is required (object with emit()).');
  }

  logger?.info?.(`[retro-runner] Composing retro for Epic #${epicId}...`);
  const startedAt = typeof now === 'function' ? now() : Date.now();
  await bus.emit('retro.start', { epicId });
  let retroPathWritten = null;
  try {
    return await composeAndPostRetro({
      epicId,
      provider,
      logger,
      forceFull,
      timestamp,
      bus,
      now,
      manualInterventions,
      frameworkRepo,
      consumerRepo,
      config,
      gatherFn,
      composeFn,
      upsertFn,
      runChecksFn,
      assembleStateFn,
      cwd,
      fsImpl,
      startedAt,
      perfThresholds,
      onMirrorWritten: (p) => {
        retroPathWritten = p;
      },
    });
  } catch (err) {
    // Surface the closing boundary even on throw — the ledger must
    // always show a matched start/end pair.
    const endedAt = typeof now === 'function' ? now() : Date.now();
    const payload = {
      epicId,
      posted: false,
      durationMs: Math.max(0, Math.floor(endedAt - startedAt)),
    };
    if (retroPathWritten) payload.retroPath = retroPathWritten;
    await bus.emit('retro.end', payload);
    throw err;
  }
}
