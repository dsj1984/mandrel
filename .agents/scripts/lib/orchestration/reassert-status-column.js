/**
 * reassert-status-column — re-fire `ColumnSync` from a ticket's current
 * labels after merge confirmation. GitHub's built-in PR workflows overwrite
 * Status minutes after auto-merge, so a bounded poll-and-refire is needed to
 * win that race; a one-shot mutation routinely lost it.
 */

import { ColumnSync, columnForLabels } from './column-sync.js';

/** Four attempts at 5 s cover a ~15 s window past typical bot timing. */
const DEFAULT_POLL_ATTEMPTS = 4;

const DEFAULT_POLL_DELAY_MS = 5000;

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Re-assert one ticket's Status column. Returns `ColumnSync.sync`'s envelope
 * plus `attempts`: `synced` (confirmed), `drifted` (budget exhausted, still
 * wrong — returned, not thrown), or `skipped` with a reason (before any
 * polling). Throws on an unusable provider; GraphQL/network errors from the
 * first sync propagate.
 *
 * @param {{
 *   provider: { getTicket: Function, graphql: Function, owner: string, repo: string, projectNumber?: number|null },
 *   ticketId: number,
 *   logger?: { info: Function, warn: Function },
 *   pollAttempts?: number,
 *   pollDelayMs?: number,
 *   sleepFn?: (ms: number) => Promise<void>,
 *   config?: object,
 * }} args
 * @returns {Promise<{ status: string, column?: string, reason?: string, attempts?: number }>}
 */
export async function reassertStatusColumn(args) {
  const {
    provider,
    ticketId,
    logger,
    pollAttempts = DEFAULT_POLL_ATTEMPTS,
    pollDelayMs = DEFAULT_POLL_DELAY_MS,
    sleepFn = defaultSleep,
    config,
  } = args ?? {};
  if (!provider || typeof provider.getTicket !== 'function') {
    throw new TypeError(
      'reassertStatusColumn requires a provider with getTicket',
    );
  }
  if (typeof provider.graphql !== 'function') {
    throw new TypeError(
      'reassertStatusColumn requires a provider with graphql (for ColumnSync)',
    );
  }
  if (!Number.isInteger(ticketId) || ticketId <= 0) {
    throw new TypeError(
      'reassertStatusColumn requires a positive integer ticketId',
    );
  }
  if (!Number.isInteger(pollAttempts) || pollAttempts <= 0) {
    throw new TypeError(
      'reassertStatusColumn requires a positive integer pollAttempts',
    );
  }

  const ticket = await provider.getTicket(ticketId);
  const labels = Array.isArray(ticket?.labels) ? ticket.labels : [];
  const targetColumn = columnForLabels(labels);
  if (!targetColumn) {
    return { status: 'skipped', reason: 'no-matching-label' };
  }
  const sync = new ColumnSync({ provider, logger: logger ?? console, config });

  const initial = await sync.sync(ticketId, labels);
  if (initial.status !== 'synced') {
    return initial;
  }
  let attempts = 1;
  let lastEnvelope = { ...initial, attempts };

  // Bounded so a hostile bot cannot stall the close path.
  for (let i = 1; i < pollAttempts; i += 1) {
    await sleepFn(pollDelayMs);
    let current;
    try {
      current = await sync.readCurrentColumn(ticketId);
    } catch (err) {
      logger?.warn?.(
        `[reassertStatusColumn] drift-check #${i} failed (transient): ${
          err?.message ?? err
        }. Continuing.`,
      );
      continue;
    }
    if (current === targetColumn) {
      return lastEnvelope;
    }
    logger?.info?.(
      `[reassertStatusColumn] drift detected on attempt ${i} (current=${
        current ?? '<null>'
      } target=${targetColumn}); re-firing.`,
    );
    try {
      const next = await sync.sync(ticketId, labels);
      attempts += 1;
      // A skip after a successful sync is unexpected: stop retrying.
      if (next.status !== 'synced') {
        return { ...next, attempts };
      }
      lastEnvelope = { ...next, attempts };
    } catch (err) {
      logger?.warn?.(
        `[reassertStatusColumn] re-fire attempt ${i} failed (transient): ${
          err?.message ?? err
        }. Continuing.`,
      );
    }
  }

  let final;
  try {
    final = await sync.readCurrentColumn(ticketId);
  } catch {
    final = null;
  }
  if (final === targetColumn) {
    return lastEnvelope;
  }
  return {
    status: 'drifted',
    column: targetColumn,
    attempts,
  };
}
