/**
 * phases/close.js — merge + post-merge pipeline phase (Story #2460,
 * Epic #2453 — CLI thinning pilot).
 *
 * Runs once the pre-merge gates have passed (or been skipped on a
 * resume path). Owns:
 *   - the resume-aware merge runner dispatch (`runResumeMerge` vs
 *     `runFinalizeMerge`, skipped entirely on a `resumeFromPostMerge` path),
 *   - the post-merge close pipeline (ticket transitions, cascade, health,
 *     dashboard regen) via `runPostMergeClose`,
 *   - the success-path close-result envelope serialisation.
 *
 * Public surface:
 *   - runMergePhase(ctx)
 *   - runPostMergePhase(ctx)
 *   - runClosePhase(ctx)         ← composite (merge → post-merge)
 *
 * The split between `runMergePhase` and `runPostMergePhase` keeps each
 * function at one level of abstraction (and well under the < 200 LOC /
 * CC < 12 phase-file budget).
 */

import { PROJECT_ROOT } from '../../../config-resolver.js';
import { Logger } from '../../../Logger.js';
import { runFinalizeMerge, runResumeMerge } from '../merge-runner.js';
import { runPostMergeClose } from '../post-merge-close.js';

/**
 * Run the merge step. Skipped entirely on the already-merged resume path
 * — the merge already landed on `origin/epic/<id>` during the prior close
 * attempt; the only remaining work is the post-merge pipeline.
 */
export async function runMergePhase(ctx) {
  const {
    resumeFromConflict,
    resumeFromPostMerge,
    cwd,
    epicBranch,
    storyBranch,
    story,
    storyId,
    epicId,
    config,
    bus,
    progress,
    progressLog,
  } = ctx;

  if (resumeFromPostMerge) {
    progress(
      'MERGE',
      `Skipping rebase + merge — story tip already reachable from ${epicBranch}`,
    );
    return;
  }

  const mergeArgs = {
    cwd,
    epicBranch,
    storyBranch,
    storyTitle: story.title,
    storyId,
    epicId,
    config,
    bus,
    log: progressLog,
  };
  await (resumeFromConflict ? runResumeMerge : runFinalizeMerge)(mergeArgs);
}

/**
 * Run the post-merge close pipeline — ticket transitions, cascade, health
 * regen, dashboard regen. Returns the final close-result envelope.
 */
export async function runPostMergePhase(ctx) {
  const {
    config,
    storyId,
    epicId,
    story,
    storyBranch,
    epicBranch,
    cwd,
    provider,
    notifyFn,
    tasks,
    skipDashboard,
    progress,
    phaseTimer,
    clearPhaseTimerState,
    bus,
  } = ctx;

  return runPostMergeClose({
    config,
    storyId,
    epicId,
    story,
    storyBranch,
    epicBranch,
    cwd,
    projectRoot: PROJECT_ROOT,
    provider,
    notify: notifyFn,
    tasks,
    skipDashboard,
    progress,
    logger: Logger,
    phaseTimer,
    clearPhaseTimerState,
    bus,
  });
}

/**
 * Composite phase: merge → post-merge close → serialise result.
 * The caller (`runStoryCloseLocked` in story-close.js) marks the
 * `close` phase on its phase timer before calling in.
 */
export async function runClosePhase(ctx) {
  await runMergePhase(ctx);
  const result = await runPostMergePhase(ctx);
  Logger.info(
    `\n--- STORY CLOSE RESULT ---\n${JSON.stringify(result, null, 2)}\n--- END RESULT ---\n`,
  );
  ctx.progress(
    'DONE',
    `✅ Story #${ctx.storyId} merged into ${ctx.epicBranch}. ${result.ticketsClosed.length} ticket(s) closed.`,
  );
  return { success: true, result };
}
