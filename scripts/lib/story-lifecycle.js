/**
 * Story lifecycle helpers shared between story-init and story-close.
 *
 * These three pure/IO-helpers capture the overlap previously duplicated across
 * the two CLI scripts — parsing the `Epic: #N` / `parent: #N` references out
 * of a Story body, fetching child `type::task` tickets, and batch-transitioning
 * those tasks to a target state label.
 *
 * The shape is narrow on purpose: init/close still own their own orchestration
 * (branch bootstrap, merge, cascade, notifications). Expanding this module to
 * cover those would over-abstract — they are genuinely different concerns.
 */

import { TYPE_LABELS } from './label-constants.js';
import {
  STATE_LABELS,
  transitionTicketState,
} from './orchestration/ticketing.js';

/**
 * Parse the `Epic: #N` and `parent: #N` references from a Story body.
 *
 * @param {string} body  Raw Story body Markdown.
 * @returns {{ epicId: number|null, featureId: number|null }}
 */
export function resolveStoryHierarchy(body) {
  const source = body ?? '';
  const epicMatch = source.match(/(?:^\s*epic:\s*#(\d+))/im);
  const parentMatch = source.match(/(?:^\s*parent:\s*#(\d+))/im);
  return {
    epicId: epicMatch ? Number.parseInt(epicMatch[1], 10) : null,
    featureId: parentMatch ? Number.parseInt(parentMatch[1], 10) : null,
  };
}

/**
 * Fetch the Story's direct children and return only those labelled
 * `type::task`. Epic/Story/Feature children are filtered out.
 *
 * @param {object} provider  ITicketingProvider instance.
 * @param {number} storyId   Story ticket number.
 * @returns {Promise<object[]>} Array of task tickets.
 */
export async function fetchChildTasks(provider, storyId) {
  const subTickets = await provider.getSubTickets(storyId);
  return subTickets.filter((t) => t.labels.includes(TYPE_LABELS.TASK));
}

/**
 * Detect transient HTTP errors (rate limits, gateways, server errors) that
 * are worth retrying. Permission/validation errors are not retried — the
 * second attempt would fail the same way.
 *
 * @param {Error} err
 * @returns {boolean}
 */
function isRetryableError(err) {
  const status = err?.status ?? err?.statusCode;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500 && status < 600) return true;
  const msg = (err?.message ?? '').toLowerCase();
  return (
    msg.includes('rate limit') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('socket hang up')
  );
}

/**
 * Batch-transition a set of tickets to the target state label. Tickets
 * already carrying `STATE_LABELS.DONE` (or the target itself) are skipped.
 * Each transition runs in parallel with a per-ticket retry budget for
 * transient errors (429, 5xx, network). Permanent failures are recorded
 * in `failed` without aborting the batch.
 *
 * @param {object} provider  ITicketingProvider instance.
 * @param {object[]} tickets Array of ticket objects with `id` and `labels`.
 * @param {string} targetLabel  Target `agent::...` label (e.g. STATE_LABELS.EXECUTING).
 * @param {object} [opts]
 * @param {(phase: string, message: string) => void} [opts.progress]  Progress reporter.
 * @param {(ticketId: number, err: Error) => void}  [opts.onError]     Per-failure callback.
 * @param {number} [opts.concurrency=10]    Max parallel ticket transitions.
 * @param {number} [opts.retries=3]         Max attempts per ticket on transient errors.
 * @param {number} [opts.retryBaseMs=500]   Base for exponential backoff (attempt * base).
 * @param {Function} [opts.notify] Optional notify function — forwarded to
 *   each `transitionTicketState` call so successful transitions fire a
 *   state-transition notification.
 * @returns {Promise<{ transitioned: number[], skipped: number[], failed: Array<{ id: number, error: string, attempts: number }> }>}
 */
export async function batchTransitionTickets(
  provider,
  tickets,
  targetLabel,
  opts = {},
) {
  const { progress, onError, notify } = opts;
  const transitioned = [];
  const skipped = [];
  const failed = [];

  const concurrency = opts.concurrency ?? 10;
  const maxRetries = opts.retries ?? 3;
  const retryBaseMs = opts.retryBaseMs ?? 500;

  const processTicket = async (ticket) => {
    if (ticket.labels.includes(targetLabel)) {
      progress?.('TICKETS', `  #${ticket.id} already ${targetLabel} — skipped`);
      skipped.push(ticket.id);
      return;
    }
    if (
      targetLabel !== STATE_LABELS.DONE &&
      ticket.labels.includes(STATE_LABELS.DONE)
    ) {
      progress?.('TICKETS', `  #${ticket.id} already done — skipped`);
      skipped.push(ticket.id);
      return;
    }
    let lastErr;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await transitionTicketState(provider, ticket.id, targetLabel, {
          notify,
        });
        progress?.(
          'TICKETS',
          `  #${ticket.id} → ${targetLabel} ✅${attempt > 1 ? ` (after ${attempt} attempts)` : ''}`,
        );
        transitioned.push(ticket.id);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt >= maxRetries || !isRetryableError(err)) break;
        const delay = retryBaseMs * 2 ** (attempt - 1);
        progress?.(
          'TICKETS',
          `  #${ticket.id} transient error (${err.message}); retrying in ${delay}ms (${attempt}/${maxRetries - 1})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    failed.push({
      id: ticket.id,
      error: lastErr?.message ?? String(lastErr),
      attempts: maxRetries,
    });
    if (onError) onError(ticket.id, lastErr);
    else
      console.error(`  #${ticket.id} → FAILED: ${lastErr?.message ?? lastErr}`);
  };

  // Process in batches to avoid overwhelming the API with concurrent requests.
  for (let i = 0; i < tickets.length; i += concurrency) {
    const batch = tickets.slice(i, i + concurrency);
    await Promise.all(batch.map(processTicket));
  }

  return { transitioned, skipped, failed };
}
