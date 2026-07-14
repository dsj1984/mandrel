/**
 * Best-effort blocked-close result helper shared by Story-scope review.
 *
 * @module lib/orchestration/story-close/emit-blocked
 */

import { Logger } from '../../Logger.js';

/**
 * Best-effort `story.blocked` lifecycle emit. The bus is optional and emit
 * failures are swallowed so the blocked result remains the caller-visible
 * outcome.
 */
async function emitStoryBlockedSafe({ bus, storyId, reason, logger }) {
  if (!bus) return;
  try {
    await bus.emit('story.blocked', {
      storyId: Number(storyId),
      reason: String(reason),
    });
  } catch (err) {
    logger?.warn?.(
      `[story-close] story.blocked emit failed for #${storyId} (swallowed): ${err?.message ?? err}`,
    );
  }
}

/**
 * @param {object} args
 * @returns {Promise<object>}
 */
export async function emitBlockedCloseResult({
  storyId,
  phase,
  reason,
  extra = {},
  bus = null,
  progress,
  blockedMessage,
  logger = Logger,
}) {
  const result = { success: false, status: 'blocked', phase, reason, ...extra };
  await emitStoryBlockedSafe({ bus, storyId, reason, logger });
  logger.info?.(
    `\n--- STORY CLOSE RESULT ---\n${JSON.stringify(result, null, 2)}\n--- END RESULT ---\n`,
  );
  progress('BLOCKED', blockedMessage);
  return result;
}
