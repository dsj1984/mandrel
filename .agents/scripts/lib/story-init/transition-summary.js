/**
 * transition-summary.js — Story-level summary of the batched task-start
 * fanout produced by `transitionTaskStates`.
 *
 * Replaces the previous N-per-Task `agent::executing` GitHub-comment fanout
 * with a single `low` notification routed to the Story. The notification
 * still passes through `notify()` so `notifications.commentMinLevel`
 * continues to gate the GitHub comment — at the default `medium`
 * threshold the comment is filtered out, so init becomes silent on the
 * GitHub timeline. The summary dispatch carries no `event` field, so it
 * never reaches the webhook channel (which is gated by the
 * `notifications.webhookEvents` allowlist). Per-Task transition notifies
 * fired by the caller's `notify` hook follow the same rule — they reach
 * the webhook only when their event name is on the allowlist (story-level
 * events are excluded from the default curated vocabulary).
 */

/**
 * @param {object} deps
 * @param {Function|null} deps.notify - The standard `notify(ticketId, payload)` hook.
 * @param {number} deps.storyId
 * @param {number[]} deps.transitioned - IDs of Tasks that flipped to `agent::executing`.
 * @returns {Promise<{posted: boolean, message: string|null}>}
 */
export async function postBatchedTransitionSummary({
  notify,
  storyId,
  transitioned,
}) {
  if (typeof notify !== 'function') return { posted: false, message: null };
  if (!Array.isArray(transitioned) || transitioned.length === 0) {
    return { posted: false, message: null };
  }
  const taskList = transitioned.map((id) => `#${id}`).join(', ');
  const message = `Story #${storyId} · ${transitioned.length} Task(s) transitioned to \`agent::executing\`: ${taskList}`;
  await notify(storyId, { severity: 'low', message });
  return { posted: true, message };
}
