/**
 * Notification helpers — shared severity vocabulary and webhook URL resolver.
 *
 * The unified `notify()` API in `notify.js` is the single dispatch entry
 * point for two event-allowlist-gated channels: GitHub comments
 * (`notifications.commentEvents`) and the Slack webhook
 * (`notifications.webhookEvents`). Both channels filter independently by
 * event-name membership — there is no fallback chain and severity is no
 * longer a routing factor for either channel.
 *
 * Severity vocabulary: low | medium | high. Severity is carried as
 * envelope metadata so Slack consumers can color-code by it and so
 * high-severity comments still `@mention` the operator, but it does not
 * gate channel delivery.
 *   - low    — routine pipeline progress: task transitions, story-run
 *              progress upserts. `transitionTicketState` skips the
 *              `notify()` dispatch entirely for these so the comment
 *              channel never sees them.
 *   - medium — operator-visible milestones: story / epic → done
 *              transitions, story-merged, epic milestones.
 *   - high   — operator must act: epic blockers, HITL gates,
 *              autonomous-chain failures. Webhook envelope prefix is
 *              `[Action Required]`; high-severity comments always
 *              `@mention` the operator.
 *
 * Webhook URL resolution: `process.env.NOTIFICATION_WEBHOOK_URL` only —
 * loaded from `.env` locally, the Claude Code web environment-variables UI,
 * or `ENV_FILE` on GitHub Actions. The webhook URL is never read from
 * `.agentrc.json` and (as of Epic #702) is no longer sourced from
 * `.mcp.json`.
 */

import { AGENT_LABELS } from '../label-constants.js';

export const SEVERITY_RANK = Object.freeze({ low: 0, medium: 1, high: 2 });

/**
 * Compute the severity of a ticket-state-transition event.
 *
 * Today only Story or Epic tickets reaching `agent::done` rate `medium`;
 * every other transition (intermediate or task-level) is `low`. State-
 * transition events never reach `high` — that level is reserved for
 * explicit `notify()` calls signalling operator action is required.
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

/**
 * Render a state-transition event into a human-readable summary line used
 * as both the GitHub comment body and the webhook message text.
 */
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
