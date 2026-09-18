/**
 * story-merged-notify.js — flip a standalone Story to its close-entry rest
 * state, `agent::closing`, and fire the `story-closing` notify. The issue
 * stays open until confirm-merge.js sees the merge, because auto-merge lands
 * asynchronously and the PR can still fail. Both steps are best-effort:
 * failures are logged and swallowed, never failing the close.
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
    // Only an `agent::done` transition closes the issue, so this leaves it
    // open. The canonical mutator also syncs the board column and cascades
    // to any parent. `notify` is omitted: the typed `story-closing` event
    // below supersedes the generic state-transition one.
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
