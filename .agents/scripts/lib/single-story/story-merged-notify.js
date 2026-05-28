/**
 * story-merged-notify.js — flip Story label to agent::done and fire the
 * `story-merged` event for a standalone-Story close. Mirrors the event
 * name used by `post-merge-pipeline.notificationPhase` so operator
 * subscriptions cover both Epic-attached and standalone Stories.
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
  const labelFlipped = await flipLabel(provider, storyId, story, progress);
  if (!labelFlipped) return;
  await fireStoryMergedNotify({
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

async function flipLabel(provider, storyId, story, progress) {
  try {
    // Route through the canonical state mutator so the Projects v2
    // Status column mirrors the `agent::done` flip (Story #2548 wires
    // column-sync inside `transitionTicketState`). Threading the
    // prefetched `story` as `ticketSnapshot` preserves the round-trip
    // elimination from Story #1795.
    //
    // Cascade is left at the default (true) so Stories that have a
    // parent Feature (e.g. an Epic-parented Story closed via the
    // standalone path) propagate completion upward. For truly
    // standalone Stories with no parent the cascade short-circuits
    // immediately via the provider-capability guard in
    // `cascadeParentState`, so there is no extra cost.
    //
    // We deliberately omit `notify` here: the `state-transition`
    // notification that `transitionTicketState` would dispatch is
    // redundant with the typed `story-merged` event that
    // `fireStoryMergedNotify` emits immediately afterwards. Operator
    // subscribers consume `story-merged` (it mirrors the
    // post-merge-pipeline event name for Epic-attached Stories), so
    // letting the close path own the dispatch keeps both lanes on a
    // single event per Story merge.
    await transitionTicketState(provider, storyId, STATE_LABELS.DONE, {
      ticketSnapshot: story,
    });
    progress?.('LABELS', `🏷️  Story #${storyId} → agent::done`);
    return true;
  } catch (err) {
    Logger.error(
      `[single-story-close] ⚠️ Failed to flip Story labels: ${err?.message ?? err}`,
    );
    return false;
  }
}

async function fireStoryMergedNotify({
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
    ? 'auto-merge enabled — GitHub will squash-merge when required checks pass'
    : `auto-merge not enabled (${autoMergeReason ?? 'unknown'}) — operator merges via GitHub UI`;
  try {
    await notifyFn(
      storyId,
      {
        severity: 'medium',
        message: `✅ Standalone Story #${storyId} — *${story.title}* — flipped to \`agent::done\`. PR: ${prUrl} (${autoMergeNote}).`,
        event: 'story-merged',
        level: 'story',
      },
      { config, provider },
    );
  } catch (err) {
    Logger.warn(
      `[single-story-close] ⚠️ story-merged notify dispatch failed (swallowed): ${err?.message ?? err}`,
    );
  }
}
