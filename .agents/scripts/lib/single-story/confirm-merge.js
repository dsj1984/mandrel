/**
 * confirm-merge.js — post-merge confirmation for a standalone Story.
 *
 * Story #3385 — `single-story-close.js` leaves a standalone Story at
 * `agent::closing` with its GitHub issue OPEN while the PR is open with
 * auto-merge armed. GitHub auto-merge completes *asynchronously* after the
 * close script exits, so the `agent::done` flip (which closes the issue)
 * must be driven by a post-merge confirmation rather than fired at
 * PR-open. This module is that driver: it reads the live PR state, and
 * only once the merge is confirmed (`state === 'MERGED'`) flips
 * `agent::closing → agent::done` — which routes through the canonical
 * `transitionTicketState` mutator that closes the issue
 * (`state: 'closed'`, `state_reason: 'completed'`).
 *
 * Outcomes (returned as a structured envelope, never thrown for the
 * not-yet-merged / recoverable cases so the CI-watch loop can re-poll):
 *
 *   - `{ action: 'done', merged: true }`
 *       PR merged → flipped `agent::done`, issue closed.
 *   - `{ action: 'noop', reason: 'already-done' }`
 *       Story already carries `agent::done`. A closed issue *alone* does
 *       NOT short-circuit — GitHub's `Closes #<id>` footer closes the issue
 *       on auto-merge before this step runs, so a closed issue whose label
 *       is still `agent::closing` must still drive the `agent::done` flip
 *       (Story #3415).
 *   - `{ action: 'pending', reason: 'pr-open' | 'pr-not-merged' }`
 *       PR is still open (or closed-without-merge); the Story is left at
 *       `agent::closing` and the issue stays OPEN. Recoverable — re-run
 *       once the merge lands.
 *
 * This mirrors the epic path's `assertMergeReachable` gate in
 * `post-merge-close.js`: the `agent::done` transition is the single
 * writer gated behind a confirmed merge, so the label sequence is exactly
 * `executing → closing → done` on a successful close and
 * `executing → closing` (sticky) on a stalled / failed PR.
 */

import { notify as defaultNotify } from '../../notify.js';
import { gh as defaultGh } from '../gh-exec.js';
import { Logger } from '../Logger.js';
import {
  STATE_LABELS,
  transitionTicketState,
} from '../orchestration/ticketing.js';

/**
 * Read the live PR state for `prNumber` via `gh pr view --json`.
 *
 * @param {{ cwd: string, prNumber: number, gh?: object }} args
 * @returns {Promise<{ state: string|null, mergedAt: string|null }>}
 */
export async function readPrMergeState({ cwd, prNumber, gh = defaultGh }) {
  // `cwd` is accepted on the signature for call-site clarity, but the
  // `gh-exec` facade spawns `gh` against the current process cwd (matching
  // `ensurePullRequestWith`); the CLI runs from the main-repo so the
  // effective cwd is correct.
  void cwd;
  const view = await gh.pr.view(prNumber, ['state', 'mergedAt']);
  // `gh.pr.view` resolves the parsed JSON when `--json` fields are passed.
  return {
    state: typeof view?.state === 'string' ? view.state : null,
    mergedAt: typeof view?.mergedAt === 'string' ? view.mergedAt : null,
  };
}

/**
 * Confirm a standalone Story's PR merged and flip `agent::closing →
 * agent::done` (closing the issue) when it has.
 *
 * @param {object} args
 * @param {object} args.provider        Ticketing provider.
 * @param {number} args.storyId
 * @param {number} args.prNumber
 * @param {string} [args.prUrl]
 * @param {string} args.cwd             Working directory for `gh`.
 * @param {object} [args.config]        Resolved config (threaded to notify).
 * @param {Function} [args.progress]
 * @param {object} [args.injectedGh]    Test seam for the `gh` facade.
 * @param {Function} [args.injectedNotify] Test seam for the notify fn.
 * @param {(args: object) => Promise<{state: string|null, mergedAt: string|null}>} [args.readPrMergeStateFn]
 *   Test seam for the PR-state reader.
 * @returns {Promise<object>} structured envelope (see module docblock).
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
}) {
  progress?.('CONFIRM', `Confirming merge for standalone Story #${storyId}...`);

  const story = await provider.getTicket(storyId);

  // Idempotence: short-circuit only when the Story already carries
  // `agent::done`. A *closed issue alone* is NOT sufficient — GitHub
  // auto-merge closes the issue via the `Closes #<id>` PR footer *before*
  // this confirm step runs, so a Story whose label is still `agent::closing`
  // routinely arrives here with `state === 'closed'`. Gating the noop on
  // `state === 'closed'` mistook that for already-done and skipped the
  // `agent::closing → agent::done` flip, stranding the label and the
  // Projects board at "In Progress" (reproduced on Story #3413 / PR #3414).
  // Requiring the `agent::done` label preserves idempotence for a genuinely
  // finished Story while still driving the flip for the closed-by-footer
  // case below (`transitionTicketState` is idempotent against an
  // already-closed issue).
  if (story.labels?.includes(STATE_LABELS.DONE)) {
    progress?.(
      'CONFIRM',
      `⏭  Story #${storyId} already agent::done — nothing to confirm.`,
    );
    return { storyId, action: 'noop', reason: 'already-done', merged: true };
  }

  const { state, mergedAt } = await readPrMergeStateFn({
    cwd,
    prNumber,
    gh: injectedGh,
  });

  const isMerged = state === 'MERGED' || Boolean(mergedAt);
  if (!isMerged) {
    const reason = state === 'CLOSED' ? 'pr-not-merged' : 'pr-open';
    progress?.(
      'CONFIRM',
      `⏳ PR #${prNumber} not yet merged (state=${state ?? 'unknown'}). Story stays at agent::closing.`,
    );
    return { storyId, action: 'pending', reason, merged: false };
  }

  // Merge confirmed — flip agent::closing → agent::done. This routes
  // through the canonical mutator, which closes the issue
  // (`state: 'closed'`, `state_reason: 'completed'`) on the `agent::done`
  // transition. Best-effort: a flaky GitHub API must not crash the
  // confirmation (the CI-watch loop re-runs idempotently).
  const flipped = await flipDone(provider, storyId, story, progress);
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
