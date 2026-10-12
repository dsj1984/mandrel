/**
 * phases/reconcile-done.js — a Story closed as completed can still carry a
 * stale lifecycle label: a close that blocked before auto-merge landed its
 * PR leaves `agent::blocked` on the closed issue, and the re-run takes the
 * already-closed early return. With merge evidence on the Story branch, this
 * finishes the flip through the shared `agent::done` confirm. Best-effort —
 * the land already happened, so nothing here may change the `landed`
 * terminal; every failure is logged and swallowed.
 */

import { gh as defaultGh } from '../../../gh-exec.js';
import { Logger } from '../../../Logger.js';
import { confirmStoryMerged } from '../../../single-story/confirm-merge.js';
import { STATE_LABELS } from '../../ticketing.js';
import { parsePrNumber } from './code-review.js';
import { pickHeadPullRequest } from './pull-request.js';

/** Close reasons meaning nothing merged — no label is owed. */
const UNLANDED_CLOSE_REASONS = new Set(['not_planned', 'duplicate']);

/**
 * @param {{ storyId: number, storyBranch: string, options: { cwd: string },
 *   story: { labels?: string[], stateReason?: string|null } }} ctx
 * @param {{ provider: object, config: object, gh?: object,
 *   notify?: Function, sleep?: Function }} deps
 * @param {(tag: string, msg: string) => void} progress
 * @returns {Promise<string>} `skipped` | `no-merged-pr` | `error` | the
 *   `confirmStoryMerged` action.
 */
export async function reconcileDoneLabel(ctx, deps, progress) {
  const { storyId, story, storyBranch } = ctx;
  if (
    UNLANDED_CLOSE_REASONS.has(story.stateReason) ||
    story.labels?.includes(STATE_LABELS.DONE)
  ) {
    return 'skipped';
  }
  try {
    const rows = await (deps.gh ?? defaultGh).pr.list(
      ['--head', storyBranch, '--state', 'all'],
      ['url', 'state', 'mergedAt'],
    );
    const head = pickHeadPullRequest(rows);
    if (head?.state !== 'MERGED') {
      progress(
        'NOOP',
        `No merged PR on ${storyBranch} — leaving Story #${storyId}'s labels as they are.`,
      );
      return 'no-merged-pr';
    }
    const confirmed = await confirmStoryMerged({
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
    });
    return confirmed.action;
  } catch (err) {
    Logger.warn(
      `[single-story-close] ⚠️ Could not reconcile Story #${storyId} to agent::done: ${err?.message ?? err}`,
    );
    return 'error';
  }
}
