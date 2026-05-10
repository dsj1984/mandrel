#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * notify.js
 *
 * Single dispatch entry point for orchestration notifications across three
 * independent channels:
 *
 *   1. GITHUB COMMENT — gated by `notifications.commentMinLevel` (severity).
 *      @mentions operator on `high`; on `medium` when `mentionOperator` is
 *      set. Callers may pass `opts.skipComment: true` to suppress the
 *      comment for a single dispatch while still firing webhook/terminal
 *      (used for batched task-start fanout and for the structured-comment
 *      webhook mirror where the GitHub comment was already written by the
 *      upsert).
 *   2. WEBHOOK — gated by `notifications.webhookEvents` (event allowlist).
 *      Only dispatches whose `event` name appears in the allowlist reach
 *      the webhook. Severity is *not* a routing factor for this channel —
 *      it is carried as envelope metadata for Slack consumers that
 *      color-code by it. The webhook channel is curated for the epic
 *      narrative (% progress + blockers), not the firehose of per-story
 *      transitions; the default allowlist is the five `epic-*` events.
 *      Payload envelope: `{ text, severity, event?, level?, ticketId?,
 *      epicId?, phase? }` — `text` always populated for back-compat with
 *      `{text}`-only consumers.
 *   3. TERMINAL — gated by `notifications.terminalMinLevel` (severity).
 *      Controls the `Logger.info` chatter this dispatcher emits about its
 *      own activity.
 *
 * Each channel filters independently — no fallback chain.
 *
 * Severity vocabulary: low | medium | high. See `lib/notifications/notifier.js`
 * for full details and the `eventSeverity()` helper used by ticket-state-
 * transition events.
 */

import { createHmac } from 'node:crypto';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import {
  meetsMinLevel,
  resolveWebhookUrl,
  SEVERITY_RANK,
} from './lib/notifications/notifier.js';
import { createProvider } from './lib/provider-factory.js';

const DEFAULT_LEVEL = 'medium';

/** Map notification severity to a `postComment` badge style. */
const SEVERITY_TO_COMMENT_TYPE = {
  low: 'progress',
  medium: 'notification',
  high: 'friction',
};

function resolveChannelLevels(notifications) {
  const ns = notifications ?? {};
  return {
    comment: ns.commentMinLevel ?? DEFAULT_LEVEL,
    terminal: ns.terminalMinLevel ?? DEFAULT_LEVEL,
  };
}

/**
 * Resolve the webhook event allowlist. Returns a `Set<string>` for O(1)
 * membership lookups. An absent/empty allowlist suppresses the webhook
 * entirely — there is no implicit fallback to a severity-based gate.
 */
function resolveWebhookEvents(notifications) {
  const list = notifications?.webhookEvents;
  if (!Array.isArray(list)) return new Set();
  return new Set(list.filter((e) => typeof e === 'string' && e));
}

function buildWebhookPayload({
  orchestration,
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
  const repo = orchestration.github?.repo;
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

async function sendWebhook(url, payloadBody) {
  const headers = { 'Content-Type': 'application/json' };
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (webhookSecret) {
    const signature = createHmac('sha256', webhookSecret)
      .update(payloadBody)
      .digest('hex');
    headers['X-Signature-256'] = `sha256=${signature}`;
  }
  try {
    const res = await fetch(url, {
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
 * Dispatch a notification across the three channels.
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
 * }} payload - `severity` defaults to `medium` when omitted. `event`,
 *   `level`, `epicId`, `phase` populate the typed webhook envelope when
 *   provided; they have no effect on comment/terminal channels.
 */
export async function notify(ticketId, payload, opts = {}) {
  const orchestration = opts.orchestration || resolveConfig().orchestration;
  const provider = opts.provider || createProvider(orchestration);

  const { severity = 'medium', message, event, level, epicId, phase } = payload;
  if (!Object.hasOwn(SEVERITY_RANK, severity)) {
    throw new Error(
      `[Notify] Invalid severity "${severity}". Expected: low | medium | high.`,
    );
  }
  const operator = orchestration.github.operatorHandle || '@operator';
  const channels = resolveChannelLevels(orchestration.notifications);
  const webhookEvents = resolveWebhookEvents(orchestration.notifications);
  const log = (line) => {
    if (meetsMinLevel(severity, channels.terminal)) Logger.info(line);
  };

  const numericId = Number.parseInt(ticketId, 10);
  const noTicket = Number.isNaN(numericId) || numericId <= 0;
  const callerSuppressed = opts.skipComment === true;
  const belowCommentMinLevel = !meetsMinLevel(severity, channels.comment);
  const skipGitHub = noTicket || callerSuppressed || belowCommentMinLevel;

  if (!skipGitHub) {
    log(`[Notify] Sending ${severity.toUpperCase()} to Issue #${numericId}...`);

    // High always @mentions; medium @mentions when `mentionOperator` is set;
    // low never @mentions.
    const mention =
      severity === 'high' ||
      (severity === 'medium' && orchestration.notifications?.mentionOperator);
    const commentBody = mention ? `${operator} ${message}` : message;

    await provider.postComment(numericId, {
      body: commentBody,
      type: SEVERITY_TO_COMMENT_TYPE[severity],
    });
  } else if (noTicket) {
    log(
      `[Notify] Sending ${severity.toUpperCase()}... (Skipping GitHub comment — no ticket)`,
    );
  }

  // Webhook channel: gated by event-name allowlist, not severity. A
  // dispatch without an `event` field can never reach the webhook — there
  // is no implicit category for unlabelled notifications.
  if (event && webhookEvents.has(event)) {
    // `opts.webhookUrl === undefined` → resolve from process env.
    // Explicit `null` or string → caller was explicit; don't resolve.
    const webhookUrl =
      opts.webhookUrl === undefined ? resolveWebhookUrl() : opts.webhookUrl;
    if (webhookUrl) {
      log(`[Notify] Firing webhook (${event}) to ${webhookUrl}...`);
      const payloadBody = buildWebhookPayload({
        orchestration,
        ticketId,
        severity,
        message,
        operator,
        event,
        level,
        epicId,
        phase,
      });
      await sendWebhook(webhookUrl, payloadBody);
    }
  }
}

export function parseNotifyArgs(args) {
  if (args.length < 1) {
    Logger.fatal(
      'Usage: node notify.js [TicketId] <Message> [--severity low|medium|high]',
    );
  }

  let severity = 'medium';
  const sevIdx = args.indexOf('--severity');
  let working = args;
  if (sevIdx !== -1) {
    const raw = args[sevIdx + 1];
    if (!raw || !Object.hasOwn(SEVERITY_RANK, raw)) {
      Logger.fatal('[Notify] --severity requires one of: low | medium | high.');
    }
    severity = raw;
    working = args.filter((_a, i) => i !== sevIdx && i !== sevIdx + 1);
  }

  if (working.length === 0) {
    Logger.fatal('[Notify] Error: Message is required.');
  }

  let ticketId = 0;
  let message = '';
  const explicitTicketFlag = working.findIndex(
    (arg) => arg === '--ticket' || arg === '--issue',
  );

  if (explicitTicketFlag !== -1) {
    const rawTicketId = working[explicitTicketFlag + 1] ?? '';
    if (!/^\d+$/.test(rawTicketId)) {
      Logger.fatal('[Notify] Error: --ticket/--issue requires a numeric ID.');
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
    Logger.fatal('[Notify] Error: Message is required.');
  }

  return { ticketId, message, severity };
}

async function main() {
  const args = process.argv.slice(2);
  const { ticketId, message, severity } = parseNotifyArgs(args);

  await notify(ticketId, { severity, message });
}

runAsCli(import.meta.url, main, { source: 'Notify' });
