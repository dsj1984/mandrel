/**
 * transition-summary.js — Story-level summary of the batched task-start
 * fanout produced by `transitionTaskStates`.
 *
 * Replaces the previous N-per-Task `agent::executing` GitHub-comment fanout
 * with a single `low` notification routed to the Story. The dispatch
 * carries no `event` field, so under the curated `commentEvents` /
 * `webhookEvents` allowlists it never reaches either channel — init stays
 * silent on the GitHub timeline by default. The call remains as a sentinel
 * for operators who curate a `story-task-summary` event into their
 * `commentEvents` allowlist (out-of-tree extension).
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
