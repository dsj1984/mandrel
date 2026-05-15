/**
 * story-merged-notify.js — best-effort `story-merged` dispatch for the
 * standalone-Story close path. Mirrors the event name used by
 * `post-merge-pipeline.notificationPhase` so operator subscriptions cover
 * both Epic-attached and standalone Stories.
 */

import { Logger } from '../Logger.js';

export async function dispatchStoryMergedNotify({
  notifyFn,
  labelFlipped,
  storyId,
  story,
  prUrl,
  autoMergeEnabled,
  autoMergeReason,
  orchestration,
  provider,
}) {
  if (!labelFlipped) return;
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
