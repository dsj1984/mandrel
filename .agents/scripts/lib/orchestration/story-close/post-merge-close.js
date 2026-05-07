/**
 * post-merge-close.js — drives everything that happens after the merge
 * commit lands on `epic/<id>`: post-merge pipeline (worktree reap, branch
 * cleanup, ticket cascade, health/manifest refresh, perf-summary via
 * analyze-execution.js), pending-cleanup drain reconciliation, phase-timer
 * state file cleanup, and final result-object assembly.
 *
 * Extracted from story-close.js (Story #956, Theme A finishing touch) so
 * the close orchestrator becomes a thin CLI shell.
 *
 * No retry logic, no merge logic, no validation logic — those live in
 * `merge-runner.js` and `pre-merge-validation.js` respectively. This helper
 * is purely the post-merge pipeline orchestration that previously lived
 * inline at the tail of `runStoryClose`.
 *
 * Epic #1030 Story #1046 — the legacy inline `phase-timings` structured
 * comment post was replaced by a `perf-summary` phase inside
 * post-merge-pipeline.js that shells out to `analyze-execution.js`. The
 * timer summary is written to a per-Story JSON file under
 * `temp/epic-<eid>/story-<sid>/phase-timings.json` so the analyzer can
 * read it; this helper writes the file and hands the path to the pipeline.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { clearActiveStoryEnv as defaultClearActiveStoryEnv } from '../../observability/active-story-env.js';
import { runPostMergePipeline as defaultRunPostMergePipeline } from '../post-merge-pipeline.js';
import {
  drainPendingCleanupAfterClose as defaultDrainPendingCleanupAfterClose,
  reconcileCleanupState as defaultReconcileCleanupState,
} from './cleanup-reconciler.js';

/**
 * @param {{
 *   orchestration: object,
 *   storyId: number|string,
 *   epicId: number|string,
 *   story: object,
 *   storyBranch: string,
 *   epicBranch: string,
 *   cwd: string,
 *   projectRoot: string,
 *   provider: object,
 *   notify: Function,
 *   tasks: object[],
 *   skipDashboard: boolean,
 *   progress: Function,
 *   logger: object,
 *   phaseTimer: object,
 *   clearPhaseTimerState: Function,
 *   runPostMergePipeline?: typeof defaultRunPostMergePipeline,
 *   drainPendingCleanupAfterClose?: typeof defaultDrainPendingCleanupAfterClose,
 *   reconcileCleanupState?: typeof defaultReconcileCleanupState,
 *   writeFileFn?: typeof writeFile,
 *   mkdirFn?: typeof mkdir,
 * }} opts
 * @returns {Promise<object>} the final close result object.
 */
export async function runPostMergeClose({
  orchestration,
  storyId,
  epicId,
  story,
  storyBranch,
  epicBranch,
  cwd,
  projectRoot,
  provider,
  notify,
  tasks,
  skipDashboard,
  progress,
  logger,
  phaseTimer,
  clearPhaseTimerState,
  runPostMergePipeline = defaultRunPostMergePipeline,
  drainPendingCleanupAfterClose = defaultDrainPendingCleanupAfterClose,
  reconcileCleanupState = defaultReconcileCleanupState,
  writeFileFn = writeFile,
  mkdirFn = mkdir,
  clearActiveStoryEnv = defaultClearActiveStoryEnv,
}) {
  // Finish the timer up-front so the analyzer phase inside the pipeline
  // can read the summary from disk. None of the pipeline phases
  // (worktree-reap, branch-cleanup, ticket-closure, …) are tracked by
  // phase-timer.js — `mark('api-sync')` is the last marked phase — so
  // closing the timer here does not lose any spans.
  phaseTimer.mark('api-sync');
  const timingSummary = phaseTimer.finish();
  let phaseTimingsPath = null;
  try {
    const dir = path.join(
      projectRoot,
      'temp',
      `epic-${epicId}`,
      `story-${storyId}`,
    );
    await mkdirFn(dir, { recursive: true });
    phaseTimingsPath = path.join(dir, 'phase-timings.json');
    await writeFileFn(phaseTimingsPath, JSON.stringify(timingSummary, null, 2));
  } catch (err) {
    phaseTimingsPath = null;
    logger.warn?.(
      `[story-close] ⚠️ Failed to write phase-timings JSON: ${err.message}`,
    );
  }

  // Reap must precede branch cleanup: git refuses to delete a branch that
  // is still checked out by a live worktree. The pipeline runs the phases
  // in this order — see post-merge-pipeline.js. The `perf-summary` phase
  // inside the pipeline shells out to analyze-execution.js, which is the
  // single writer of the `<!-- structured:story-perf-summary -->` comment.
  const pipelineState = await runPostMergePipeline({
    orchestration,
    storyId,
    epicId,
    story,
    storyBranch,
    epicBranch,
    repoRoot: cwd,
    projectRoot,
    provider,
    notify,
    tasks,
    skipDashboard,
    progress,
    logger,
    phaseTimingsPath,
  });
  if (
    orchestration?.worktreeIsolation?.enabled &&
    !pipelineState.worktreeReap
  ) {
    throw new Error(
      'story-close invariant violated: worktreeReap state missing while worktree isolation is enabled.',
    );
  }
  const pendingCleanupDrain = await drainPendingCleanupAfterClose({
    repoRoot: cwd,
    orchestration,
    progress,
    logger,
  });
  const reconciledCleanup = reconcileCleanupState({
    storyId,
    worktreeReap: pipelineState.worktreeReap,
    branchCleanup: pipelineState.branchCleanup,
    pendingCleanupDrain,
  });
  const branchCleanup = reconciledCleanup.branchCleanup;
  const worktreeReap = reconciledCleanup.worktreeReap;
  const { closedTickets, cascadedTo, cascadeFailed } =
    pipelineState.ticketClosure;
  const manifestUpdated = pipelineState.manifestUpdated;

  try {
    clearPhaseTimerState({ mainCwd: cwd, storyId });
  } catch (err) {
    logger.warn?.(
      `[story-close] ⚠️ Failed to clear phase-timer state file: ${err.message}`,
    );
  }

  // Clear the trace-hook env vars (Story #1043). The worktree was
  // reaped above so the `.env.local` is already gone; this also
  // clears the vars on the parent process so any tooling invoked
  // *after* close — planning, dispatch, ad-hoc CLI — falls back to
  // the hook's no-op branch instead of polluting a stale Story
  // directory.
  try {
    clearActiveStoryEnv({ logger });
  } catch (err) {
    logger.warn?.(
      `[story-close] ⚠️ Failed to clear active-Story env: ${err.message}`,
    );
  }

  return {
    storyId,
    epicId,
    action: 'merged',
    merged: true,
    branchDeleted: branchCleanup.localDeleted && branchCleanup.remoteDeleted,
    branchLocalDeleted: branchCleanup.localDeleted,
    branchRemoteDeleted: branchCleanup.remoteDeleted,
    worktreeReap,
    pendingCleanupDrain,
    ticketsClosed: closedTickets,
    cascadedTo: cascadedTo ?? [],
    cascadeFailed: cascadeFailed ?? [],
    manifestUpdated,
  };
}
