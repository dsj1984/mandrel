/**
 * Best-effort blocked-close result helper shared by Story-scope review.
 *
 * @module lib/orchestration/story-close/emit-blocked
 */

import { Logger } from '../../Logger.js';
import { emitTerseResult } from '../../observability/terse-result.js';

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
  // Story #4685 — full detail to a temp log; single summary line in its place.
  emitTerseResult({
    label: 'STORY CLOSE RESULT',
    result,
    scope: storyId,
    summary: { storyId, status: 'blocked', phase, reason },
    log: logger,
  });
  progress('BLOCKED', blockedMessage);
  return result;
}
