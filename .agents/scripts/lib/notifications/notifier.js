/**
 * Notification helpers — severity vocabulary and webhook URL resolver for
 * `notify.js`. Both channels (GitHub comments, Slack webhook) gate only on
 * their event allowlists; severity is envelope metadata:
 *   - low    — routine progress; `transitionTicketState` skips `notify()`.
 *   - medium — operator-visible milestones (Story/Epic done, merged).
 *   - high   — operator must act (Story/Epic blocked): webhook prefix
 *              `[Action Required]`, and comments always `@mention` the
 *              operator.
 *
 * The webhook URL comes only from `process.env.NOTIFICATION_WEBHOOK_URL`,
 * never from `.agentrc.json` or `.mcp.json`.
 */

import { AGENT_LABELS } from '../label-constants.js';

export const SEVERITY_RANK = Object.freeze({ low: 0, medium: 1, high: 2 });

/**
 * A Story/Epic entering `agent::blocked` rates `high` — the protocol's one
 * runtime pause point, so the operator must act. A Story/Epic reaching
 * `agent::done` rates `medium`. Every other transition is `low`.
 *
 * @param {{ kind?: string, ticket?: { type?: string }, toState?: string|null }} event
 */
export function eventSeverity(event) {
  if (event?.kind === 'state-transition') {
    const type = event.ticket?.type;
    const isStoryOrEpic = type === 'story' || type === 'epic';
    if (isStoryOrEpic && event.toState === AGENT_LABELS.BLOCKED) return 'high';
    if (isStoryOrEpic && event.toState === AGENT_LABELS.DONE) return 'medium';
  }
  return 'low';
}

/** Used as both comment body and webhook text. */
export function renderTransitionMessage(event) {
  const ticket = event.ticket ?? {};
  const from = event.fromState ? `\`${event.fromState}\` ` : '';
  const summary = `${ticket.type ?? 'ticket'} #${ticket.id} · ${from}→ \`${event.toState ?? ''}\``;
  return ticket.title ? `${summary} — ${ticket.title.slice(0, 80)}` : summary;
}

export function resolveWebhookUrl() {
  return process.env.NOTIFICATION_WEBHOOK_URL?.trim() || null;
}
