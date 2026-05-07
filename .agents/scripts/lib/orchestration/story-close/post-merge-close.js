/**
 * post-merge-close.js — drives everything that happens after the merge
 * commit lands on `epic/<id>`: post-merge pipeline (worktree reap, branch
 * cleanup, ticket cascade, health/manifest refresh), pending-cleanup drain
 * reconciliation, phase-timings comment, phase-timer state file cleanup,
 * and final result-object assembly.
 *
 * Extracted from story-close.js (Story #956, Theme A finishing touch) so
 * the close orchestrator becomes a thin CLI shell.
 *
 * No retry logic, no merge logic, no validation logic — those live in
 * `merge-runner.js` and `pre-merge-validation.js` respectively. This helper
 * is purely the post-merge pipeline orchestration that previously lived
 * inline at the tail of `runStoryClose`.
 */

import { clearActiveStoryEnv as defaultClearActiveStoryEnv } from '../../observability/active-story-env.js';
import { runPostMergePipeline as defaultRunPostMergePipeline } from '../post-merge-pipeline.js';
import { upsertStructuredComment as defaultUpsertStructuredComment } from '../ticketing.js';
import {
  drainPendingCleanupAfterClose as defaultDrainPendingCleanupAfterClose,
  reconcileCleanupState as defaultReconcileCleanupState,
} from './cleanup-reconciler.js';
import { renderPhaseTimingsCommentBody as defaultRenderPhaseTimingsCommentBody } from './comment-bodies.js';

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
 *   frictionEmitter: object,
 *   tasks: object[],
 *   skipDashboard: boolean,
 *   progress: Function,
 *   logger: object,
 *   phaseTimer: object,
 *   clearPhaseTimerState: Function,
 *   runPostMergePipeline?: typeof defaultRunPostMergePipeline,
 *   drainPendingCleanupAfterClose?: typeof defaultDrainPendingCleanupAfterClose,
 *   reconcileCleanupState?: typeof defaultReconcileCleanupState,
 *   upsertStructuredComment?: typeof defaultUpsertStructuredComment,
 *   renderPhaseTimingsCommentBody?: typeof defaultRenderPhaseTimingsCommentBody,
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
  frictionEmitter,
  tasks,
  skipDashboard,
  progress,
  logger,
  phaseTimer,
  clearPhaseTimerState,
  runPostMergePipeline = defaultRunPostMergePipeline,
  drainPendingCleanupAfterClose = defaultDrainPendingCleanupAfterClose,
  reconcileCleanupState = defaultReconcileCleanupState,
  upsertStructuredComment = defaultUpsertStructuredComment,
  renderPhaseTimingsCommentBody = defaultRenderPhaseTimingsCommentBody,
  clearActiveStoryEnv = defaultClearActiveStoryEnv,
}) {
  // Reap must precede branch cleanup: git refuses to delete a branch that
  // is still checked out by a live worktree. The pipeline runs the phases
  // in this order — see post-merge-pipeline.js.
  phaseTimer.mark('api-sync');
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
    frictionEmitter,
    tasks,
    skipDashboard,
    progress,
    logger,
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
  const healthUpdated = pipelineState.healthUpdated;
  const manifestUpdated = pipelineState.manifestUpdated;

  // Phase-timings summary — the structured comment that the epic runner's
  // progress reporter aggregates into median/p95 rows. Failure to post is
  // non-fatal — the merge has already succeeded and we would rather log
  // than roll back closure.
  const timingSummary = phaseTimer.finish();
  try {
    await upsertStructuredComment(
      provider,
      storyId,
      'phase-timings',
      renderPhaseTimingsCommentBody(timingSummary),
    );
  } catch (err) {
    logger.warn?.(
      `[story-close] ⚠️ Failed to post phase-timings comment: ${err.message}`,
    );
  }
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
    healthUpdated,
    manifestUpdated,
  };
}
