/**
 * Notification helpers — shared severity vocabulary and webhook URL resolver.
 *
 * The unified `notify()` API in `notify.js` is the single dispatch entry
 * point for both:
 *
 *   1. Manual orchestration milestones (story merged, epic complete, HITL
 *      gates) — called explicitly by orchestration scripts.
 *   2. Ticket-state-transition events — `transitionTicketState` invokes
 *      `notify()` directly when a `notify` function is injected via opts.
 *   3. Structured-comment mirrors — the progress writers
 *      (`upsertStoryRunProgress`, `ProgressReporter`) call `notify()`
 *      after a successful upsert with `skipComment: true` so the webhook
 *      carries the same cadence as GitHub watchers see in the issue
 *      thread.
 *
 * Severity vocabulary: low | medium | high.
 *   - low    — routine pipeline progress: task transitions and
 *              `story-run-progress` upserts. Filtered out at the default
 *              `medium` threshold on every channel.
 *   - medium — operator-visible milestones: story state transitions,
 *              epic-run-progress, epic-complete. Default
 *              threshold for delivery on every channel.
 *   - high   — operator must act: epic blockers, HITL gates,
 *              autonomous-chain failures. Webhook prefix is
 *              `[Action Required]`; callers should also lead the message
 *              body with `🚨 Action Required:` so the GitHub comment
 *              carries the same signal.
 *
 * Channel gates: per-channel `commentMinLevel`, `webhookMinLevel`, and
 * `terminalMinLevel` filter independently — there is no fallback chain.
 *
 * Webhook URL resolution: `process.env.NOTIFICATION_WEBHOOK_URL` only —
 * loaded from `.env` locally, the Claude Code web environment-variables UI,
 * or `ENV_FILE` on GitHub Actions. The webhook URL is never read from
 * `.agentrc.json` and (as of Epic #702) is no longer sourced from
 * `.mcp.json`.
 */

import { AGENT_LABELS } from '../label-constants.js';

export const SEVERITY_RANK = Object.freeze({ low: 0, medium: 1, high: 2 });
export const DEFAULT_MIN_LEVEL = 'medium';

export function meetsMinLevel(severity, minLevel) {
  const sev = SEVERITY_RANK[severity] ?? SEVERITY_RANK.low;
  const min = SEVERITY_RANK[minLevel] ?? SEVERITY_RANK[DEFAULT_MIN_LEVEL];
  return sev >= min;
}

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
