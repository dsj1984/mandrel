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

import { Logger } from '../../../Logger.js';
import { PROJECT_ROOT } from '../../../project-root.js';
import { STATE_LABELS } from '../../ticketing.js';
import { runFinalizeMerge, runResumeMerge } from '../merge-runner.js';
import { runPostMergeClose } from '../post-merge-close.js';

/**
 * Story #2961 — final assertion that the Story ticket reached
 * `agent::done` after the post-merge cascade. The cascade is the single
 * writer of the `closing → done` label flip; without this readback,
 * `runStoryClose` returns `success: true` even when the flip silently
 * failed (the failure mode that Epic #2880 wave 0's friction note
 * F-W0-2 surfaced via the runner's GitHub probe — see Story #2894).
 *
 * Outcomes:
 *   - `{ ok: true }` — ticket has `agent::done` (or is closed).
 *   - `{ ok: false, actualLabels }` — cascade returned but the label
 *     never reached `agent::done`. The caller must downgrade
 *     `success: true` → `success: false`.
 *   - `{ ok: 'skipped', warning }` — `provider.getTicket` threw. The
 *     verification could not run, but the close itself succeeded, so
 *     the caller returns the success envelope with a `warnings[]` entry.
 */
export async function verifyFinalStoryLabel({ provider, storyId }) {
  if (!provider || typeof provider.getTicket !== 'function') {
    return {
      ok: 'skipped',
      warning: `label-verification-skipped: provider.getTicket unavailable`,
    };
  }
  let ticket;
  try {
    ticket = await provider.getTicket(storyId, { fresh: true });
  } catch (err) {
    return {
      ok: 'skipped',
      warning: `label-verification-skipped: ${err?.message ?? err}`,
    };
  }
  const labels = Array.isArray(ticket?.labels) ? ticket.labels : [];
  if (labels.includes(STATE_LABELS.DONE) || ticket?.state === 'closed') {
    return { ok: true };
  }
  return { ok: false, actualLabels: labels };
}

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
 * Pure envelope builder. Given the post-merge `result` and the
 * `verifyFinalStoryLabel` verdict, returns the close-result envelope
 * `runClosePhase` will surface back to `runStoryClose`. Exported so the
 * contract test can drive the failure / skipped / success branches
 * without spinning up the merge + cascade pipeline.
 */
export function buildCloseEnvelope({ result, verdict, storyId }) {
  if (verdict.ok === false) {
    const failedResult = {
      ...result,
      status: 'failed',
      phase: 'closing',
      reason: 'label-transition-failed',
      actualLabels: verdict.actualLabels,
    };
    Logger.warn?.(
      `[story-close] ❌ Story #${storyId} cascade returned but label is not ` +
        `${STATE_LABELS.DONE} (actual: ${JSON.stringify(verdict.actualLabels)}). ` +
        `Returning failure envelope.`,
    );
    return { success: false, result: failedResult };
  }
  if (verdict.ok === 'skipped') {
    return {
      success: true,
      result: { ...result, warnings: [verdict.warning] },
    };
  }
  return { success: true, result };
}

/**
 * Composite phase: merge → post-merge close → final-label readback →
 * envelope serialise. The caller (`runStoryCloseLocked` in
 * story-close.js) marks the `close` phase on its phase timer before
 * calling in.
 */
export async function runClosePhase(ctx) {
  await runMergePhase(ctx);
  const result = await runPostMergePhase(ctx);

  // Story #2961 — final readback before declaring success. The
  // post-merge cascade is the single writer for the `closing → done`
  // label flip; if it silently failed, surface a failure envelope here
  // rather than relying on the runner's downstream GitHub probe.
  const verdict = await verifyFinalStoryLabel({
    provider: ctx.provider,
    storyId: ctx.storyId,
  });
  const envelope = buildCloseEnvelope({
    result,
    verdict,
    storyId: ctx.storyId,
  });

  Logger.info(
    `\n--- STORY CLOSE RESULT ---\n${JSON.stringify(envelope.result, null, 2)}\n--- END RESULT ---\n`,
  );
  if (envelope.success) {
    ctx.progress(
      'DONE',
      `✅ Story #${ctx.storyId} merged into ${ctx.epicBranch}. ${envelope.result.ticketsClosed.length} ticket(s) closed.`,
    );
  }
  return envelope;
}
