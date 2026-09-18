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

  const numericId = Number.parseInt(ticketId, 10);
  const noTicket = Number.isNaN(numericId) || numericId <= 0;
  const callerSuppressed = opts.skipComment === true;
  const eventAllowedOnComments = Boolean(event) && commentEvents.has(event);
  const fireComment = !noTicket && !callerSuppressed && eventAllowedOnComments;

  if (fireComment) {
    const mention =
      severity === 'high' ||
      (severity === 'medium' && notifications?.mentionOperator);
    const commentBody = mention ? `${operator} ${message}` : message;

    await provider.postComment(numericId, {
      body: commentBody,
      type: SEVERITY_TO_COMMENT_TYPE[severity],
    });
  }

  if (event && webhookEvents.has(event)) {
    // Only `undefined` resolves from env; an explicit `null` means none.
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
      // Allowlisted but no URL: warn rather than drop silently.
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

  await notify(ticketId, {
    severity,
    message,
    event: 'operator-message',
  });
}

runAsCli(import.meta.url, main, { source: 'Notify' });
