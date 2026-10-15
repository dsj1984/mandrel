/**
 * reassert-status-column — re-fire `ColumnSync` from a ticket's current
 * labels after merge confirmation. GitHub's built-in PR workflows overwrite
 * Status minutes after auto-merge, so a bounded poll-and-refire is needed to
 * win that race; a one-shot mutation routinely lost it.
 */

import { defaultSleep } from '../util/sleep.js';
import { ColumnSync, columnForLabels } from './column-sync.js';

/** Four attempts at 5 s cover a ~15 s window past typical bot timing. */
const DEFAULT_POLL_ATTEMPTS = 4;

const DEFAULT_POLL_DELAY_MS = 5000;

function requirePositiveInt(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(
      `reassertStatusColumn requires a positive integer ${name}`,
    );
  }
}

function assertArgs({ provider, ticketId, pollAttempts }) {
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
  requirePositiveInt(ticketId, 'ticketId');
  requirePositiveInt(pollAttempts, 'pollAttempts');
}

/** `undefined` on a transient read failure (logged), else the column. */
async function readColumnOrSkip(ctx, i) {
  try {
    return await ctx.sync.readCurrentColumn(ctx.ticketId);
  } catch (err) {
    ctx.logger?.warn?.(
      `[reassertStatusColumn] drift-check #${i} failed (transient): ${
        err?.message ?? err
      }. Continuing.`,
    );
    return undefined;
  }
}

/** The re-fire envelope, or `null` on a transient failure (logged). */
async function refire(ctx, i) {
  try {
    return await ctx.sync.sync(ctx.ticketId, ctx.labels);
  } catch (err) {
    ctx.logger?.warn?.(
      `[reassertStatusColumn] re-fire attempt ${i} failed (transient): ${
        err?.message ?? err
      }. Continuing.`,
    );
    return null;
  }
}

/**
 * One drift-check tick. Returns a terminal envelope to stop polling, or
 * `null` to keep going; `state` carries `attempts` and the last envelope.
 */
async function pollTick(ctx, state, i) {
  await ctx.sleepFn(ctx.pollDelayMs);
  const current = await readColumnOrSkip(ctx, i);
  if (current === undefined) return null;
  if (current === ctx.targetColumn) return state.lastEnvelope;
  ctx.logger?.info?.(
    `[reassertStatusColumn] drift detected on attempt ${i} (current=${
      current ?? '<null>'
    } target=${ctx.targetColumn}); re-firing.`,
  );
  const next = await refire(ctx, i);
  if (next === null) return null;
  state.attempts += 1;
  state.lastEnvelope = { ...next, attempts: state.attempts };
  // A skip after a successful sync is unexpected: stop retrying.
  return next.status === 'synced' ? null : state.lastEnvelope;
}

async function finalVerdict(ctx, state) {
  let final = null;
  try {
    final = await ctx.sync.readCurrentColumn(ctx.ticketId);
  } catch {
    // An unreadable column after the budget reads as drift.
  }
  if (final === ctx.targetColumn) return state.lastEnvelope;
  return {
    status: 'drifted',
    column: ctx.targetColumn,
    attempts: state.attempts,
  };
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
  assertArgs({ provider, ticketId, pollAttempts });

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
  const ctx = {
    sync,
    ticketId,
    labels,
    targetColumn,
    logger,
    sleepFn,
    pollDelayMs,
  };
  const state = { attempts: 1, lastEnvelope: { ...initial, attempts: 1 } };

  // Bounded so a hostile bot cannot stall the close path.
  for (let i = 1; i < pollAttempts; i += 1) {
    const done = await pollTick(ctx, state, i);
    if (done) return done;
  }
  return finalVerdict(ctx, state);
}
