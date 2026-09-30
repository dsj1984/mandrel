/**
 * confirm-merge.js — post-merge confirmation for a standalone Story.
 *
 * Auto-merge completes asynchronously after close exits, so the
 * `agent::closing → agent::done` flip (which closes the issue) is gated on a
 * confirmed `MERGED` PR here, never fired at PR-open. Not-yet-merged cases
 * return `pending` rather than throw so the CI-watch loop can re-poll; a
 * stalled PR leaves the Story sticky at `agent::closing`.
 */

import { notify as defaultNotify } from '../../notify.js';
import { gh as defaultGh } from '../gh-exec.js';
import { Logger } from '../Logger.js';
import { isPrMerged } from '../orchestration/merge-poll.js';
import {
  STATE_LABELS,
  transitionTicketState,
} from '../orchestration/ticketing.js';
import { sleep as defaultSleep } from '../util/poll-loop.js';

/**
 * Backoff before each RETRY of the post-merge done flip (so attempts =
 * length + 1). A transient label write is the common failure; the transition
 * is idempotent, so a retry cannot double-apply.
 */
const DONE_FLIP_RETRY_DELAYS_MS = Object.freeze([500, 2000]);

/**
 * @param {{ cwd: string, prNumber: number, gh?: object }} args
 * @returns {Promise<{ state: string|null, mergedAt: string|null }>}
 */
export async function readPrMergeState({ cwd, prNumber, gh = defaultGh }) {
  // gh-exec spawns against the process cwd (the main repo); `cwd` is
  // accepted for call-site clarity only.
  void cwd;
  const view = await gh.pr.view(prNumber, ['state', 'mergedAt']);
  return {
    state: typeof view?.state === 'string' ? view.state : null,
    mergedAt: typeof view?.mergedAt === 'string' ? view.mergedAt : null,
  };
}

/**
 * @param {object} args
 * @param {object} args.provider        Ticketing provider.
 * @param {number} args.storyId
 * @param {number} args.prNumber
 * @param {string} [args.prUrl]
 * @param {string} args.cwd
 * @param {object} [args.config]
 * @param {Function} [args.progress]
 * @param {object} [args.injectedGh]
 * @param {Function} [args.injectedNotify]
 * @param {(args: object) => Promise<{state: string|null, mergedAt: string|null}>} [args.readPrMergeStateFn]
 * @param {{ state: string|null, mergedAt: string|null }} [args.prState] The
 *   merge state the caller already read, so a land reads it once; omitted,
 *   it is read here.
 * @param {(ms: number) => Promise<void>} [args.sleepFn] Backoff between
 *   done-flip attempts; injectable so tests do not sleep.
 * @returns {Promise<object>} `done` | `noop` (already-done) | `pending`
 *   (pr-open / pr-not-merged) | `flip-failed`.
 */
export async function confirmStoryMerged({
  provider,
  storyId,
  prNumber,
  prUrl,
  cwd,
  config,
  progress,
  injectedGh,
  injectedNotify,
  readPrMergeStateFn = readPrMergeState,
  prState,
  sleepFn = defaultSleep,
}) {
  progress?.('CONFIRM', `Confirming merge for standalone Story #${storyId}...`);

  const story = await provider.getTicket(storyId);

  // Only the `agent::done` label short-circuits. A closed issue alone does
  // not: the PR's `Closes #<id>` footer closes it before this step runs, and
  // the flip must still happen (transitionTicketState is idempotent on a
  // closed issue).
  if (story.labels?.includes(STATE_LABELS.DONE)) {
    progress?.(
      'CONFIRM',
      `⏭  Story #${storyId} already agent::done — nothing to confirm.`,
    );
    return { storyId, action: 'noop', reason: 'already-done', merged: true };
  }

  const { state, mergedAt } =
    prState ??
    (await readPrMergeStateFn({
      cwd,
      prNumber,
      gh: injectedGh,
    }));

  if (!isPrMerged({ state, mergedAt })) {
    return pendingResult({ storyId, prNumber, state, progress });
  }

  // Best-effort: a flaky API must not crash confirmation; re-runs are idempotent.
  const flipped = await flipDoneWithRetry({
    provider,
    storyId,
    story,
    progress,
    sleepFn,
  });
  if (flipped) {
    await fireStoryMergedNotify({
      notifyFn: injectedNotify ?? defaultNotify,
      storyId,
      story,
      prUrl,
      config,
      provider,
    });
  }
  return {
    storyId,
    action: flipped ? 'done' : 'flip-failed',
    merged: true,
  };
}

/** The PR is not merged yet: the Story stays at `agent::closing`. */
function pendingResult({ storyId, prNumber, state, progress }) {
  const reason = state === 'CLOSED' ? 'pr-not-merged' : 'pr-open';
  progress?.(
    'CONFIRM',
    `⏳ PR #${prNumber} not yet merged (state=${state ?? 'unknown'}). Story stays at agent::closing.`,
  );
  return { storyId, action: 'pending', reason, merged: false };
}

/** Only a write that fails every bounded attempt reports the flip failed. */
async function flipDoneWithRetry({
  provider,
  storyId,
  story,
  progress,
  sleepFn,
}) {
  for (const delayMs of [0, ...DONE_FLIP_RETRY_DELAYS_MS]) {
    if (delayMs > 0) await sleepFn(delayMs);
    if (await flipDone(provider, storyId, story, progress)) return true;
  }
  return false;
}

async function flipDone(provider, storyId, story, progress) {
  try {
    await transitionTicketState(provider, storyId, STATE_LABELS.DONE, {
      ticketSnapshot: story,
    });
    progress?.(
      'LABELS',
      `🏷️  Story #${storyId} → agent::done (merge confirmed)`,
    );
    return true;
  } catch (err) {
    Logger.error(
      `[single-story-confirm-merge] ⚠️ Failed to flip Story #${storyId} to agent::done: ${err?.message ?? err}`,
    );
    return false;
  }
}

async function fireStoryMergedNotify({
  notifyFn,
  storyId,
  story,
  prUrl,
  config,
  provider,
}) {
  try {
    await notifyFn(
      storyId,
      {
        severity: 'medium',
        message: `✅ Standalone Story #${storyId} — *${story.title}* — merge confirmed; flipped to \`agent::done\` and closed the issue.${prUrl ? ` PR: ${prUrl}.` : ''}`,
        event: 'story-merged',
        level: 'story',
      },
      { config, provider },
    );
  } catch (err) {
    Logger.warn(
      `[single-story-confirm-merge] ⚠️ story-merged notify dispatch failed (swallowed): ${err?.message ?? err}`,
    );
  }
}
