#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * notify.js
 *
 * Single dispatch entry point for runtime notifications across two
 * independent channels.
 *
 * Lifecycle-bus integration (Epic #2172): under the Wave-7+ runtime,
 * `notify()` is invoked from the `NotifyDispatcher` listener
 * (`lib/orchestration/lifecycle/listeners/notify-dispatcher.js`),
 * which subscribes to lifecycle events and maps `event.severity` →
 * `notify()` payload. Direct inline calls at phase boundaries are no
 * longer the canonical path — listeners on the bus are. See
 * [`docs/LIFECYCLE.md`](../docs/LIFECYCLE.md) for the bus contract,
 * event taxonomy, and the dispatcher's wiring. Direct CLI / library
 * invocations remain supported for one-shot operator commands and the
 * structured-comment back-channel.
 *
 * Channels:
 *
 *   1. GITHUB COMMENT — gated by `notifications.commentEvents` (event
 *      allowlist). Only dispatches whose `event` name appears in the
 *      allowlist reach the ticket. @mentions operator on `high` severity;
 *      on `medium` when `mentionOperator` is set. Callers may pass
 *      `opts.skipComment: true` to suppress the comment for a single
 *      dispatch while still firing the webhook (used for structured-
 *      comment writers that already posted the ticket-side body themselves).
 *   2. WEBHOOK — gated by `notifications.webhookEvents` (event allowlist).
 *      Only dispatches whose `event` name appears in the allowlist reach
 *      the webhook. The webhook channel is curated for the epic narrative
 *      (% progress + blockers), not the firehose of per-story transitions;
 *      the default allowlist is the five `epic-*` events. Payload envelope:
 *      `{ text, severity, event?, level?, ticketId?, epicId?, phase? }` —
 *      `text` always populated for back-compat with `{text}`-only consumers.
 *
 * Each channel filters independently — no fallback chain. Severity is
 * carried as envelope metadata (so Slack consumers can color-code by it
 * and high-severity comments still `@mention` the operator) but is no
 * longer a routing factor for either channel.
 *
 * Severity vocabulary: low | medium | high. See `lib/notifications/notifier.js`
 * for the `eventSeverity()` helper used by ticket-state-transition events.
 */

import { createHmac } from 'node:crypto';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import {
  resolveWebhookUrl,
  SEVERITY_RANK,
} from './lib/notifications/notifier.js';
import { createProvider } from './lib/provider-factory.js';

/** Map notification severity to a `postComment` badge style. */
const SEVERITY_TO_COMMENT_TYPE = {
  low: 'progress',
  medium: 'notification',
  high: 'friction',
};

/**
 * Resolve a channel's event allowlist. Returns a `Set<string>` for O(1)
 * membership lookups. An absent/empty allowlist suppresses the channel
 * entirely — there is no implicit fallback to a severity-based gate.
 */
function resolveEventAllowlist(notifications, key) {
  const list = notifications?.[key];
  if (!Array.isArray(list)) return new Set();
  return new Set(list.filter((e) => typeof e === 'string' && e));
}

function buildWebhookPayload({
  config,
  ticketId,
  severity,
  message,
  operator,
  event,
  level,
  epicId,
  phase,
}) {
  const cleanMessage = message.replace(operator, '').trim();
  const repo = config.github?.repo;
  const numericTicketId = Number.parseInt(ticketId, 10);
  const prefix = severity === 'high' ? '[Action Required]' : `[${severity}]`;
  const ticketPart =
    Number.isFinite(numericTicketId) && numericTicketId > 0
      ? ` ${repo ? `${repo}#${numericTicketId}` : `#${numericTicketId}`}`
      : '';
  const text = `${prefix}${ticketPart}: ${cleanMessage}`;

  // `text` first for back-compat with `{text}`-only consumers (Slack-style
  // incoming webhooks). Typed fields follow for routable subscribers.
  const envelope = { text, severity };
  if (Number.isFinite(numericTicketId) && numericTicketId > 0) {
    envelope.ticketId = numericTicketId;
  }
  if (event) envelope.event = event;
  if (level) envelope.level = level;
  if (Number.isFinite(epicId) && epicId > 0) envelope.epicId = epicId;
  if (phase) envelope.phase = phase;
  return JSON.stringify(envelope);
}

async function sendWebhook(url, payloadBody, fetchImpl = globalThis.fetch) {
  const headers = { 'Content-Type': 'application/json' };
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (webhookSecret) {
    const signature = createHmac('sha256', webhookSecret)
      .update(payloadBody)
      .digest('hex');
    headers['X-Signature-256'] = `sha256=${signature}`;
  }
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: payloadBody,
    });
    if (!res.ok) {
      Logger.warn(
        `[Notify] Webhook returned ${res.status}: ${await res.text().catch(() => '')}`,
      );
    }
  } catch (err) {
    Logger.warn(`[Notify] Failed to send webhook: ${err.message}`);
  }
}

/**
 * Dispatch a notification across the two channels.
 *
 * @param {number} ticketId - GitHub Issue number to post the notification on.
 *   Pass 0 (or any non-positive) to skip the GitHub comment and fire the
 *   webhook only.
 * @param {{
 *   severity?: 'low'|'medium'|'high',
 *   message: string,
 *   event?: string,
 *   level?: 'task'|'story'|'wave'|'epic',
 *   epicId?: number,
 *   phase?: string,
 * }} payload - `severity` defaults to `medium` when omitted; it controls
 *   @mention behavior on the comment channel and is carried as webhook
 *   envelope metadata, but does not gate either channel. `event` is
 *   required for any channel to fire — event-less dispatches are no-ops.
 * @param {{
 *   config?: object,
 *   provider?: object,
 *   webhookUrl?: string|null,
 *   skipComment?: boolean,
 *   fetchImpl?: typeof fetch,
 * }} [opts] - `fetchImpl` is injected into the webhook POST in place of
 *   `globalThis.fetch`; it defaults to the global, so production callers
 *   never pass it. Tests inject a fake to assert the request body,
 *   `X-Signature-256` header, and the 4xx/5xx response branches without a
 *   live network call or a global monkeypatch.
 */
export async function notify(ticketId, payload, opts = {}) {
  const config = opts.config || resolveConfig();
  const provider = opts.provider || createProvider(config);

  const { severity = 'medium', message, event, level, epicId, phase } = payload;
  if (!Object.hasOwn(SEVERITY_RANK, severity)) {
    throw new Error(
      `[Notify] Invalid severity "${severity}". Expected: low | medium | high.`,
    );
  }
  const operator = config.github?.operatorHandle || '@operator';
  const notifications = config.github?.notifications;
  const commentEvents = resolveEventAllowlist(notifications, 'commentEvents');
  const webhookEvents = resolveEventAllowlist(notifications, 'webhookEvents');

  const numericId = Number.parseInt(ticketId, 10);
  const noTicket = Number.isNaN(numericId) || numericId <= 0;
  const callerSuppressed = opts.skipComment === true;
  const eventAllowedOnComments = Boolean(event) && commentEvents.has(event);
  const fireComment = !noTicket && !callerSuppressed && eventAllowedOnComments;

  if (fireComment) {
    // High always @mentions; medium @mentions when `mentionOperator` is set;
    // low never @mentions.
    const mention =
      severity === 'high' ||
      (severity === 'medium' && notifications?.mentionOperator);
    const commentBody = mention ? `${operator} ${message}` : message;

    await provider.postComment(numericId, {
      body: commentBody,
      type: SEVERITY_TO_COMMENT_TYPE[severity],
    });
  }

  // Webhook channel: gated by event-name allowlist. A dispatch without an
  // `event` field can never reach the webhook — there is no implicit
  // category for unlabelled notifications.
  if (event && webhookEvents.has(event)) {
    // `opts.webhookUrl === undefined` → resolve from process env.
    // Explicit `null` or string → caller was explicit; don't resolve.
    const webhookUrl =
      opts.webhookUrl === undefined ? resolveWebhookUrl() : opts.webhookUrl;
    if (webhookUrl) {
      Logger.info(`[Notify] Firing webhook (${event}) to ${webhookUrl}...`);
      const payloadBody = buildWebhookPayload({
        config,
        ticketId,
        severity,
        message,
        operator,
        event,
        level,
        epicId,
        phase,
      });
      await sendWebhook(webhookUrl, payloadBody, opts.fetchImpl);
    } else {
      // Event was on the allowlist but no URL is available — surface this
      // so the operator notices a missing/empty NOTIFICATION_WEBHOOK_URL
      // instead of silently dropping the dispatch.
      Logger.warn(
        `[Notify] Webhook event (${event}) suppressed — no webhook URL resolved (NOTIFICATION_WEBHOOK_URL unset or empty).`,
      );
    }
  }
}

export function parseNotifyArgs(args) {
  if (args.length < 1) {
    throw new Error(
      'Usage: node notify.js [TicketId] <Message> [--severity low|medium|high]',
    );
  }

  let severity = 'medium';
  const sevIdx = args.indexOf('--severity');
  let working = args;
  if (sevIdx !== -1) {
    const raw = args[sevIdx + 1];
    if (!raw || !Object.hasOwn(SEVERITY_RANK, raw)) {
      throw new Error(
        '[Notify] --severity requires one of: low | medium | high.',
      );
    }
    severity = raw;
    working = args.filter((_a, i) => i !== sevIdx && i !== sevIdx + 1);
  }

  if (working.length === 0) {
    throw new Error('[Notify] Error: Message is required.');
  }

  let ticketId = 0;
  let message = '';
  const explicitTicketFlag = working.findIndex(
    (arg) => arg === '--ticket' || arg === '--issue',
  );

  if (explicitTicketFlag !== -1) {
    const rawTicketId = working[explicitTicketFlag + 1] ?? '';
    if (!/^\d+$/.test(rawTicketId)) {
      throw new Error(
        '[Notify] Error: --ticket/--issue requires a numeric ID.',
      );
    }
    ticketId = Number.parseInt(rawTicketId, 10);
    const positional = working.filter(
      (_arg, idx) =>
        idx !== explicitTicketFlag && idx !== explicitTicketFlag + 1,
    );
    message = positional.join(' ').trim();
  } else {
    const firstArg = working[0];
    const isNumeric = /^\d+$/.test(firstArg);

    if (isNumeric) {
      ticketId = Number.parseInt(firstArg, 10);
      message = working.slice(1).join(' ').trim();
    } else {
      message = firstArg;
    }
  }

  if (!message) {
    throw new Error('[Notify] Error: Message is required.');
  }

  return { ticketId, message, severity };
}

async function main() {
  const args = process.argv.slice(2);
  const { ticketId, message, severity } = parseNotifyArgs(args);

  // CLI fires always carry the `operator-message` event so they route
  // through the same event-name allowlist as the rest of the system.
  await notify(ticketId, {
    severity,
    message,
    event: 'operator-message',
  });
}

runAsCli(import.meta.url, main, { source: 'Notify' });
