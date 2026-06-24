/**
 * reassert-status-column — re-fire `ColumnSync` against a ticket's
 * current label set so the GitHub Projects v2 Status column matches the
 * orchestrator's view (Story #2845, hardened in Story #2876).
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
 *   without needing the re-sync. The helper is defense-in-depth and is
 *   cheap to fire — Story #2876 added a bounded poll-and-retry loop so
 *   the defense actually works against an asynchronous bot overwrite
 *   that lands after the initial mutation. Without the loop, a one-shot
 *   mutation routinely lost the race (reproduced on Story #2871 /
 *   PR #2872).
 *
 * Surface:
 *   - {@link reassertStatusColumn} — read the ticket's current labels,
 *     pick the canonical column via {@link columnForLabels}, push it
 *     via `ColumnSync.sync`, then poll the live Status for a bounded
 *     window and re-fire on drift. Returns the sync envelope augmented
 *     with `attempts`.
 */

import { ColumnSync, columnForLabels } from './column-sync.js';

/**
 * Default total mutation attempts (including the initial sync). At
 * `pollDelayMs = 5000`, four attempts cover a ~15 s defense window —
 * long enough to outlast the typical GitHub built-in workflow fire
 * timing without ballooning the close-path wall clock.
 */
export const DEFAULT_POLL_ATTEMPTS = 4;

/**
 * Default delay between drift checks (ms). Five seconds is a sweet
 * spot: short enough that the operator doesn't perceive the close
 * path as hung, long enough that one re-fire usually wins the race.
 */
export const DEFAULT_POLL_DELAY_MS = 5000;

/**
 * Production sleep function. Tests inject `sleepFn: () => Promise.resolve()`
 * so the poll loop runs instantly.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Re-assert the Status column for a single ticket. Reads the ticket's
 * current labels so the caller doesn't have to pass them (the typical
 * use site is a post-merge CLI that knows the ticket id only).
 *
 * Returns the same envelope shape as `ColumnSync.sync`, augmented with
 * `attempts` (the number of mutations actually fired):
 *   - `{ status: 'synced', column, attempts }` — the mutation landed
 *     and the drift-check confirmed Status matches the target. If
 *     drift was detected and re-fired, `attempts` reflects the total
 *     mutation count.
 *   - `{ status: 'drifted', column, attempts }` — the helper exhausted
 *     `pollAttempts` and the live Status still didn't match the
 *     target. Returned, not thrown — the caller decides whether to
 *     escalate. `column` carries the target column the helper was
 *     trying to set.
 *   - `{ status: 'skipped', reason }` — no-op for an enumerated reason
 *     (`no-matching-label`, `no-project`, `no-meta`, `no-option-<col>`,
 *     `not-on-project`). Skip paths short-circuit before the poll loop.
 *
 * Throws when the provider is unusable. Other failures (GraphQL,
 * network) propagate from `ColumnSync.sync` and `provider.getTicket` —
 * callers wrap in try/catch if they want best-effort semantics.
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

  // First attempt — always fires through ColumnSync.sync so the skip
  // paths (no-project / no-meta / no-option-<col> / not-on-project)
  // short-circuit before we enter the poll loop.
  const initial = await sync.sync(ticketId, labels);
  if (initial.status !== 'synced') {
    return initial;
  }
  let attempts = 1;
  let lastEnvelope = { ...initial, attempts };

  // Drift loop — read live Status, re-fire if it doesn't match the
  // target column. Bounded by pollAttempts so a hostile bot can't
  // stall the close path indefinitely.
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
      // Sticky confirmation — return the existing envelope.
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
      // Skip envelopes during the retry loop are unexpected once we've
      // already synced once; preserve their shape but stop retrying.
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

  // Exhausted the poll budget — final drift read to report the
  // honest outcome to the caller.
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
