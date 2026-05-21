/**
 * reassert-status-column — re-fire `ColumnSync` against a ticket's
 * current label set so the GitHub Projects v2 Status column matches the
 * orchestrator's view (Story #2845).
 *
 * Why a dedicated helper:
 *   `transitionTicketState` already calls `syncProjectStatusColumn` at
 *   label-flip time, but the GitHub built-in `Pull request merged` /
 *   `Pull request linked to issue` workflows fire ~minutes after the
 *   PR auto-merges and overwrite Status. The orchestrator's close path
 *   has long-since exited by then, so "the last write" is the bot's.
 *   This helper is invoked AFTER the merge confirmation step (via the
 *   `resync-status-column.js` CLI the `/single-story-deliver` workflow
 *   doc calls) to reassert authority and win the race deterministically.
 *
 *   Operators who disable the conflicting bot workflows (via the
 *   `--reap-conflicting-workflows` bootstrap flag) get the same outcome
 *   without needing the re-sync, but the helper is cheap to fire and
 *   defends against bot workflows that get re-enabled later or that
 *   GitHub adds in the future.
 *
 * Surface:
 *   - {@link reassertStatusColumn} — read the ticket's current labels,
 *     pick the canonical column via {@link columnForLabels}, push it
 *     via `ColumnSync.sync`. Returns the sync envelope.
 */

import { ColumnSync, columnForLabels } from './column-sync.js';

/**
 * Re-assert the Status column for a single ticket. Reads the ticket's
 * current labels so the caller doesn't have to pass them (the typical
 * use site is a post-merge CLI that knows the ticket id only).
 *
 * Returns the same envelope shape as `ColumnSync.sync`:
 *   - `{ status: 'synced', column }` — the mutation landed.
 *   - `{ status: 'skipped', reason }` — no-op for an enumerated reason
 *     (`no-matching-label`, `no-project`, `no-meta`, `no-option-<col>`,
 *     `not-on-project`).
 *
 * Throws when the provider is unusable. Other failures (GraphQL,
 * network) propagate from `ColumnSync.sync` and `provider.getTicket` —
 * callers wrap in try/catch if they want best-effort semantics.
 *
 * @param {{
 *   provider: { getTicket: Function, graphql: Function, owner: string, repo: string, projectNumber?: number|null },
 *   ticketId: number,
 *   logger?: { info: Function, warn: Function },
 * }} args
 * @returns {Promise<{ status: string, column?: string, reason?: string }>}
 */
export async function reassertStatusColumn(args) {
  const { provider, ticketId, logger } = args ?? {};
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
  const ticket = await provider.getTicket(ticketId);
  const labels = Array.isArray(ticket?.labels) ? ticket.labels : [];
  const targetColumn = columnForLabels(labels);
  if (!targetColumn) {
    return { status: 'skipped', reason: 'no-matching-label' };
  }
  const sync = new ColumnSync({ provider, logger: logger ?? console });
  return sync.sync(ticketId, labels);
}
