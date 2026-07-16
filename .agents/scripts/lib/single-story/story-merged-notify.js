/**
 * story-merged-notify.js — flip a standalone Story to its close-entry rest
 * state and fire the matching operator notification.
 *
 * Story #3385 — the standalone close path no longer flips `agent::done`
 * (and no longer closes the GitHub issue) at PR-open time. GitHub
 * auto-merge completes *asynchronously* after `single-story-close.js`
 * exits, so closing the issue at PR-open left the Story marked "done"
 * while its PR could still fail CI, go `BEHIND` base, or be closed
 * without merging — stranding a CLOSED issue with no merged work.
 *
 * The fix brings the standalone path to parity with the epic path
 * (#2155): the Story rests at `agent::closing` while the PR is open with
 * auto-merge armed, and only flips `agent::done` (closing the issue) once
 * the merge is confirmed by the post-merge confirmation step
 * (`single-story-confirm-merge.js`, invoked by the CI-watch loop in
 * `single-story-deliver.md` Step 5). This module owns the close-entry
 * `agent::closing` flip + the `story-closing` notify; the `agent::done`
 * flip + the `story-merged` notify live in `./confirm-merge.js`.
 *
 * Both the label flip and the notify dispatch are best-effort: failures
 * are logged and swallowed so neither a flaky GitHub API nor a flaky
 * webhook ever fails the close.
 */

import { notify as defaultNotify } from '../../notify.js';
import { Logger } from '../Logger.js';
import {
  STATE_LABELS,
  transitionTicketState,
} from '../orchestration/ticketing.js';

export async function flipLabelAndNotify({
  provider,
  notifyFn,
  storyId,
  story,
  prUrl,
  autoMergeEnabled,
  autoMergeReason,
  config,
  progress,
}) {
  const labelFlipped = await flipLabel(
    provider,
    storyId,
    story,
    progress,
    config,
  );
  if (!labelFlipped) return;
  await fireStoryClosingNotify({
    notifyFn: notifyFn ?? defaultNotify,
    storyId,
    story,
    prUrl,
    autoMergeEnabled,
    autoMergeReason,
    config,
    provider,
  });
}

async function flipLabel(provider, storyId, story, progress, config) {
  try {
    // Story #3385 — flip to `agent::closing`, NOT `agent::done`. The
    // canonical mutator (`transitionTicketState`) only closes the GitHub
    // issue (`state: 'closed'`, `state_reason: 'completed'`) on a
    // transition to `agent::done`; flipping to `agent::closing` leaves the
    // issue OPEN, which is exactly the rest state the standalone path must
    // hold while the PR is open with auto-merge armed.
    //
    // Route through the canonical state mutator so the Projects v2 Status
    // column mirrors the `agent::closing` flip (Story #2548 wires
    // column-sync inside `transitionTicketState`). Threading the
    // prefetched `story` as `ticketSnapshot` preserves the round-trip
    // elimination from Story #1795.
    //
    // Cascade is left at the default (true) so Stories that have a parent
    // Feature (e.g. an Epic-parented Story closed via the standalone path)
    // propagate the `agent::closing` state upward. For truly standalone
    // Stories with no parent the cascade short-circuits immediately via
    // the provider-capability guard in `cascadeParentState`, so there is
    // no extra cost.
    //
    // We deliberately omit `notify` here: the `state-transition`
    // notification that `transitionTicketState` would dispatch is
    // redundant with the typed `story-closing` event that
    // `fireStoryClosingNotify` emits immediately afterwards.
    //
    // `config` is threaded so the on-disk board-metadata cache (issue #4555)
    // lands under the project's configured `tempRoot` rather than the
    // framework default, matching every other transition call site.
    await transitionTicketState(provider, storyId, STATE_LABELS.CLOSING, {
      ticketSnapshot: story,
      config,
    });
    progress?.('LABELS', `🏷️  Story #${storyId} → agent::closing`);
    return true;
  } catch (err) {
    Logger.error(
      `[single-story-close] ⚠️ Failed to flip Story labels: ${err?.message ?? err}`,
    );
    return false;
  }
}

async function fireStoryClosingNotify({
  notifyFn,
  storyId,
  story,
  prUrl,
  autoMergeEnabled,
  autoMergeReason,
  config,
  provider,
}) {
  const autoMergeNote = autoMergeEnabled
    ? 'auto-merge enabled — GitHub will squash-merge when required checks pass, then the Story flips to `agent::done`'
    : `auto-merge not enabled (${autoMergeReason ?? 'unknown'}) — operator merges via GitHub UI, then the Story flips to \`agent::done\``;
  try {
    await notifyFn(
      storyId,
      {
        severity: 'medium',
        message: `🔁 Standalone Story #${storyId} — *${story.title}* — flipped to \`agent::closing\`. PR: ${prUrl} (${autoMergeNote}). The issue stays OPEN until the merge is confirmed.`,
        event: 'story-closing',
        level: 'story',
      },
      { config, provider },
    );
  } catch (err) {
    Logger.warn(
      `[single-story-close] ⚠️ story-closing notify dispatch failed (swallowed): ${err?.message ?? err}`,
    );
  }
}
