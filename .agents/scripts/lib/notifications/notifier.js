/**
 * Notification helpers — severity vocabulary and webhook URL resolver for
 * `notify.js`. Both channels (GitHub comments, Slack webhook) gate only on
 * their event allowlists; severity is envelope metadata:
 *   - low    — routine progress; `transitionTicketState` skips `notify()`.
 *   - medium — operator-visible milestones (Story/Epic done, merged).
 *   - high   — operator must act: webhook prefix `[Action Required]`, and
 *              comments always `@mention` the operator.
 *
 * The webhook URL comes only from `process.env.NOTIFICATION_WEBHOOK_URL`,
 * never from `.agentrc.json` or `.mcp.json`.
 */

import { AGENT_LABELS } from '../label-constants.js';

export const SEVERITY_RANK = Object.freeze({ low: 0, medium: 1, high: 2 });

/**
 * Only a Story/Epic reaching `agent::done` rates `medium`; transitions never
 * reach `high`, which is reserved for explicit operator-action `notify()`
 * calls.
 *
 * @param {{ kind?: string, ticket?: { type?: string }, toState?: string|null }} event
 */
export function eventSeverity(event) {
  if (event?.kind === 'state-transition') {
    const type = event.ticket?.type;
    const isStoryOrEpic = type === 'story' || type === 'epic';
    if (isStoryOrEpic && event.toState === AGENT_LABELS.DONE) return 'medium';
  }
  return 'low';
}

/** Used as both comment body and webhook text. */
export function renderTransitionMessage(event) {
  const type = event.ticket?.type ?? 'ticket';
  const id = event.ticket?.id;
  const title = event.ticket?.title ?? '';
  const toState = event.toState ?? '';
  const fromState = event.fromState ?? '';
  let summary = fromState
    ? `${type} #${id} · \`${fromState}\` → \`${toState}\``
    : `${type} #${id} · → \`${toState}\``;
  if (title) summary += ` — ${title.slice(0, 80)}`;
  return summary;
}

export function resolveWebhookUrl() {
  return process.env.NOTIFICATION_WEBHOOK_URL?.trim() || null;
}
