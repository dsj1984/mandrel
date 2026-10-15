/**
 * phases/reconcile-done.js — a Story closed as completed can still carry a
 * stale lifecycle label: a close that blocked before auto-merge landed its
 * PR leaves `agent::blocked` on the closed issue, and the re-run takes the
 * already-closed early return (the boot sweep reaches the same state for a
 * PR that merged after close was gone). With merge evidence on the Story
 * branch, this finishes the flip AND the land tail (lease release, worktree
 * reap, epic rollup) through the shared confirm-and-land pairing. Best-effort
 * — the land already happened, so nothing here may change the `landed`
 * terminal; every failure is logged and swallowed.
 */

import { gh as defaultGh } from '../../../gh-exec.js';
import { Logger } from '../../../Logger.js';
import { confirmAndLand } from '../../../single-story/confirm-and-land.js';
import { STATE_LABELS } from '../../ticketing.js';
import { parsePrNumber } from './code-review.js';
import { pickHeadPullRequest } from './pull-request.js';

/** Close reasons meaning nothing merged — no label is owed. */
const UNLANDED_CLOSE_REASONS = new Set(['not_planned', 'duplicate']);

/**
 * @param {{ storyId: number, storyBranch: string, options: { cwd: string },
 *   story: { labels?: string[], stateReason?: string|null } }} ctx
 * @param {{ provider: object, config: object, gh?: object,
 *   notify?: Function, sleep?: Function, runPostLandTail?: Function }} deps
 * @param {(tag: string, msg: string) => void} progress
 * @returns {Promise<string>} `skipped` | `no-merged-pr` | `error` | the
 *   `confirmStoryMerged` action.
 */
export async function reconcileDoneLabel(ctx, deps, progress) {
  const { storyId, story } = ctx;
  if (
    UNLANDED_CLOSE_REASONS.has(story.stateReason) ||
    story.labels?.includes(STATE_LABELS.DONE)
  ) {
    return 'skipped';
  }
  try {
    return await reconcileFromMergedHead(ctx, deps, progress);
  } catch (err) {
    Logger.warn(
      `[single-story-close] ⚠️ Could not reconcile Story #${storyId} to agent::done: ${err?.message ?? err}`,
    );
    return 'error';
  }
}

/** The Story branch's head PR, or `null` when it is not MERGED. */
async function readMergedHead(storyBranch, gh) {
  const rows = await (gh ?? defaultGh).pr.list(
    ['--head', storyBranch, '--state', 'all'],
    ['url', 'state', 'mergedAt'],
  );
  const head = pickHeadPullRequest(rows);
  return head?.state === 'MERGED' ? head : null;
}

async function reconcileFromMergedHead(ctx, deps, progress) {
  const { storyId, storyBranch } = ctx;
  const head = await readMergedHead(storyBranch, deps.gh);
  if (!head) {
    progress(
      'NOOP',
      `No merged PR on ${storyBranch} — leaving Story #${storyId}'s labels as they are.`,
    );
    return 'no-merged-pr';
  }
  const { confirmation } = await confirmAndLand({
    provider: deps.provider,
    storyId,
    prNumber: parsePrNumber(head.url),
    prUrl: head.url,
    cwd: ctx.options.cwd,
    config: deps.config,
    progress,
    injectedNotify: deps.notify,
    prState: { state: 'MERGED', mergedAt: null },
    sleepFn: deps.sleep,
    storyBranch,
    runPostLandTailFn: deps.runPostLandTail,
  });
  return confirmation.action;
}
