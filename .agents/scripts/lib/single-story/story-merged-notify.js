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

export async function flipLabelAndNotify({
  provider,
  notifyFn,
  storyId,
  story,
  prUrl,
  autoMergeEnabled,
  autoMergeReason,
  orchestration,
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
    orchestration,
    provider,
  });
}

async function flipLabel(provider, storyId, story, progress) {
  try {
    const labels = (story.labels || [])
      .filter((l) => !l.startsWith('agent::'))
      .concat('agent::done');
    await provider.updateTicket(storyId, { labels });
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
  orchestration,
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
      { orchestration, provider },
    );
  } catch (err) {
    Logger.warn(
      `[single-story-close] ⚠️ story-merged notify dispatch failed (swallowed): ${err?.message ?? err}`,
    );
  }
}
