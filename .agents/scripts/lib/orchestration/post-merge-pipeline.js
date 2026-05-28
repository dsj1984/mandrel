/**
 * post-merge-pipeline.js — sequencer for the post-merge phases of
 * `story-close`.
 *
 * After the Story branch is merged into the Epic branch, several best-effort
 * cleanup + reporting phases must run:
 *
 *   1. worktree-reap       — remove the per-Story worktree.
 *   2. branch-cleanup      — delete the Story branch (local + remote).
 *   3. ticket-closure      — transition the Story to agent::done
 *                            and run cascade completion.
 *   4. notification        — fire the story-complete webhook.
 *   5. dashboard-refresh   — regenerate the dispatch manifest.
 *   6. temp-cleanup        — delete the per-Story manifest pair under
 *                            `temp/epic-<eid>/stories/story-<sid>/manifest.{md,json}`
 *                            (Epic #1030 Story #1040). Falls back to the
 *                            legacy flat `temp/story-manifest-<id>.{md,json}`
 *                            layout when `epicId` is unknown — both paths
 *                            are tried so partial migrations don't leak
 *                            files in either layout.
 *   7. detectors           — fire rework + retry signal detectors against
 *                            this Story's `traces.ndjson` and persist each
 *                            emission to `signals.ndjson` BEFORE the
 *                            analyzer renders the perf-summary comment.
 *   8. perf-summary        — shell out to `analyze-execution.js` so the
 *                            analyzer is the single writer of the
 *                            `<!-- structured:story-perf-summary -->`
 *                            comment on the Story ticket.
 *
 * Each phase is wrapped by `runPhase` so a single failure does not abort
 * the rest of the close-out — the same best-effort contract that the
 * pre-extraction inline code provided. Phase return values are merged into
 * a `state` object whose shape `runStoryClose` consumes to build the final
 * structured result.
 *
 * The phase implementations live under `./post-merge/phases/` (one file
 * per phase) — this module is a pure sequencer that imports each phase,
 * re-exports them for backwards compatibility, and runs them in order
 * via `runPhase`.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Logger } from '../Logger.js';
import { detectorsPhase } from './detectors-phase.js';
import { runPhase } from './phase-runner.js';
import { branchCleanupPhase } from './post-merge/phases/branch-cleanup.js';
import { dashboardRefreshPhase } from './post-merge/phases/dashboard-refresh.js';
import { notificationPhase } from './post-merge/phases/notification.js';
import { tempCleanupPhase } from './post-merge/phases/temp-cleanup.js';
import { ticketClosurePhase } from './post-merge/phases/ticket-closure.js';
import {
  createWorktreeReapState,
  worktreeReapPhase,
} from './post-merge/phases/worktree-reap.js';

export {
  branchCleanupPhase,
  dashboardRefreshPhase,
  detectorsPhase,
  notificationPhase,
  tempCleanupPhase,
  ticketClosurePhase,
  worktreeReapPhase,
};

function reapPhaseLogger(progress) {
  return progress ?? (() => {});
}

/**
 * perfSummaryPhase — shells out to `analyze-execution.js --story <sid>
 * --epic <eid> --phase-timings <path>` so the analyzer is the single
 * writer of the `<!-- structured:story-perf-summary -->` comment on the
 * Story ticket (Epic #1030 Story #1046). Replaces the legacy
 * `<!-- structured:phase-timings -->` post that lived inline in
 * `post-merge-close.js`.
 *
 * Best-effort: any failure (missing analyzer, non-zero exit, no path
 * supplied) logs a warning and resolves — the merge has already
 * succeeded and we would rather lose the perf summary than roll back
 * closure.
 *
 * @param {{
 *   storyId: number|string,
 *   epicId: number|string,
 *   phaseTimingsPath: string|null|undefined,
 *   projectRoot?: string,
 *   progress?: Function,
 *   logger?: object,
 *   spawnFn?: typeof execFileSync,
 * }} ctx
 * @returns {Promise<{ status: 'ok'|'skipped'|'failed', reason?: string }>}
 */
export async function perfSummaryPhase(ctx) {
  const {
    storyId,
    epicId,
    phaseTimingsPath,
    projectRoot,
    progress,
    logger,
    spawnFn = execFileSync,
  } = ctx;
  const log = reapPhaseLogger(progress);
  if (!phaseTimingsPath) {
    log('PERF', '⏭️ Skipping perf-summary (no phase-timings path provided)');
    return { status: 'skipped', reason: 'no-phase-timings-path' };
  }
  const root = projectRoot ?? process.cwd();
  const analyzerPath = path.join(
    root,
    '.agents',
    'scripts',
    'analyze-execution.js',
  );
  const args = [
    analyzerPath,
    '--story',
    String(storyId),
    '--epic',
    String(epicId),
    '--phase-timings',
    phaseTimingsPath,
  ];
  log(
    'PERF',
    `Running analyzer: analyze-execution.js --story ${storyId} --epic ${epicId}`,
  );
  try {
    spawnFn(process.execPath, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    log('PERF', '✅ story-perf-summary posted');
    return { status: 'ok' };
  } catch (err) {
    const reason = err?.message ?? String(err);
    logger?.warn?.(
      `[post-merge-pipeline] ⚠️ analyze-execution failed (non-fatal): ${reason}`,
    );
    return { status: 'failed', reason };
  }
}

export const DEFAULT_POST_MERGE_PHASES = Object.freeze([
  {
    name: 'worktree-reap',
    fn: worktreeReapPhase,
    stateKey: 'worktreeReap',
    fallback: createWorktreeReapState({
      status: 'failed',
      reason: 'phase-error',
    }),
  },
  { name: 'branch-cleanup', fn: branchCleanupPhase, stateKey: 'branchCleanup' },
  { name: 'ticket-closure', fn: ticketClosurePhase, stateKey: 'ticketClosure' },
  { name: 'notification', fn: notificationPhase },
  {
    name: 'dashboard-refresh',
    fn: dashboardRefreshPhase,
    stateKey: 'manifestUpdated',
  },
  { name: 'temp-cleanup', fn: tempCleanupPhase },
  // Detectors MUST run before `perf-summary`. The perf phase shells out
  // to `analyze-execution.js`, which reads the per-Story signals stream
  // to author the `<!-- structured:story-perf-summary -->` comment;
  // emitting rework/retry events first ensures the rendered surface
  // reflects this Story's signals.
  { name: 'detectors', fn: detectorsPhase, stateKey: 'detectors' },
  { name: 'perf-summary', fn: perfSummaryPhase, stateKey: 'perfSummary' },
]);

/**
 * Sequence the post-merge phases of `story-close`. Every phase runs
 * under `runPhase` so a single failure logs `[phase=<name>] <err>` and the
 * pipeline keeps going. Each phase's return value is recorded under its
 * `stateKey` (when defined) on the returned state object.
 *
 * @param {object} ctx          Phase collaborators (provider, notify,
 *                              logger, progress, etc.).
 * @param {Array<{name: string, fn: Function, stateKey?: string, fallback?: any}>} [phases]
 *                              Phase descriptors. Defaults to `DEFAULT_POST_MERGE_PHASES`.
 * @returns {Promise<object>}   Aggregated state from each phase.
 */
export async function runPostMergePipeline(
  ctx,
  phases = DEFAULT_POST_MERGE_PHASES,
) {
  const logger = ctx.logger ?? Logger;
  const state = {
    worktreeReap: createWorktreeReapState(),
    branchCleanup: { localDeleted: false, remoteDeleted: false },
    ticketClosure: { closedTickets: [], cascadedTo: [], cascadeFailed: [] },
    manifestUpdated: false,
  };
  for (const phase of phases) {
    const value = await runPhase(phase.name, () => phase.fn(ctx, state), {
      logger,
      fallback: phase.fallback,
    });
    if (phase.stateKey && value !== undefined) state[phase.stateKey] = value;
  }
  return state;
}
