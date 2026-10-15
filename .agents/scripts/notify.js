#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * notify.js — dispatch a notification to two independently gated channels:
 * a GitHub comment (`notifications.commentEvents` allowlist) and a webhook
 * (`notifications.webhookEvents` allowlist; `text` is the body Slack-style
 * hooks read). Severity never routes; it only drives @mentions and rides the
 * webhook envelope as metadata.
 */

import { createHmac } from 'node:crypto';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import {
  resolveWebhookUrl,
  SEVERITY_RANK,
} from './lib/notifications/notifier.js';
import { createProvider } from './lib/provider-factory.js';

const SEVERITY_TO_COMMENT_TYPE = {
  low: 'progress',
  medium: 'notification',
  high: 'friction',
};

/** An absent or empty allowlist suppresses the channel entirely. */
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
 * @param {number} ticketId - Non-positive skips the comment (webhook only).
 * @param {{
 *   severity?: 'low'|'medium'|'high',
 *   message: string,
 *   event?: string,
 *   level?: 'task'|'story'|'wave'|'epic',
 *   epicId?: number,
 *   phase?: string,
 * }} payload - Without `event` no channel fires.
 * @param {{
 *   config?: object,
 *   provider?: object,
 *   webhookUrl?: string|null,
 *   skipComment?: boolean,
 *   fetchImpl?: typeof fetch,
 * }} [opts] - `skipComment` suppresses the comment for writers that already
 *   posted the ticket-side body.
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

  const ctx = { config, operator, notifications, severity, message, event };
  if (event && commentEvents.has(event) && opts.skipComment !== true) {
    await postOperatorComment(provider, ticketId, ctx);
  }
  if (event && webhookEvents.has(event)) {
    await fireWebhook(opts, { ...ctx, ticketId, level, epicId, phase });
  }
}

async function postOperatorComment(provider, ticketId, ctx) {
  const numericId = Number.parseInt(ticketId, 10);
  if (Number.isNaN(numericId) || numericId <= 0) return;
  const { severity, message, operator, notifications } = ctx;
  const mention =
    severity === 'high' ||
    (severity === 'medium' && notifications?.mentionOperator);
  await provider.postComment(numericId, {
    body: mention ? `${operator} ${message}` : message,
    type: SEVERITY_TO_COMMENT_TYPE[severity],
  });
}

async function fireWebhook(opts, payload) {
  // Only `undefined` resolves from env; an explicit `null` means none.
  const webhookUrl =
    opts.webhookUrl === undefined ? resolveWebhookUrl() : opts.webhookUrl;
  if (!webhookUrl) {
    // Allowlisted but no URL: warn rather than drop silently.
    Logger.warn(
      `[Notify] Webhook event (${payload.event}) suppressed — no webhook URL resolved (NOTIFICATION_WEBHOOK_URL unset or empty).`,
    );
    return;
  }
  Logger.info(`[Notify] Firing webhook (${payload.event}) to ${webhookUrl}...`);
  await sendWebhook(webhookUrl, buildWebhookPayload(payload), opts.fetchImpl);
}

const NOTIFY_USAGE_ERROR =
  'Usage: node notify.js [TicketId] <Message> [--severity low|medium|high]';
const MESSAGE_REQUIRED_ERROR = '[Notify] Error: Message is required.';
const NUMERIC_ID = /^\d+$/;

const NOTIFY_OPTIONS = {
  severity: { type: 'string' },
  ticket: { type: 'string' },
  issue: { type: 'string' },
};

function requireSeverity(raw) {
  if (raw === undefined) return 'medium';
  if (typeof raw === 'string' && Object.hasOwn(SEVERITY_RANK, raw)) return raw;
  throw new Error('[Notify] --severity requires one of: low | medium | high.');
}

function requireTicketId(raw) {
  if (typeof raw === 'string' && NUMERIC_ID.test(raw)) {
    return Number.parseInt(raw, 10);
  }
  throw new Error('[Notify] Error: --ticket/--issue requires a numeric ID.');
}

/** Without `--ticket`, a leading numeric positional is the legacy ticket id. */
function splitTicketAndMessage(explicitTicket, positionals) {
  if (explicitTicket !== undefined) {
    return {
      ticketId: requireTicketId(explicitTicket),
      message: positionals.join(' ').trim(),
    };
  }
  const [first = '', ...rest] = positionals;
  if (NUMERIC_ID.test(first)) {
    return {
      ticketId: Number.parseInt(first, 10),
      message: rest.join(' ').trim(),
    };
  }
  return { ticketId: 0, message: first };
}

export function parseNotifyArgs(args) {
  if (args.length < 1) throw new Error(NOTIFY_USAGE_ERROR);
  const { values, positionals } = parseArgs({
    args,
    options: NOTIFY_OPTIONS,
    allowPositionals: true,
    strict: false,
  });
  const severity = requireSeverity(values.severity);
  const explicitTicket = values.ticket ?? values.issue;
  if (positionals.length === 0 && explicitTicket === undefined) {
    throw new Error(MESSAGE_REQUIRED_ERROR);
  }
  const { ticketId, message } = splitTicketAndMessage(
    explicitTicket,
    positionals,
  );
  if (!message) throw new Error(MESSAGE_REQUIRED_ERROR);
  return { ticketId, message, severity };
}

async function main() {
  const args = process.argv.slice(2);
  const { ticketId, message, severity } = parseNotifyArgs(args);

  await notify(ticketId, {
    severity,
    message,
    event: 'operator-message',
  });
}

runAsCli(import.meta.url, main, { source: 'Notify' });
