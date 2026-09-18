/**
 * lease-guard-shared.js — the lease-acquisition kernel shared by lease
 * guards; surfaces differ only in injected policy (operator candidates,
 * missing-handle behaviour, refusal wording). The claim decision table lives
 * in `ticket-lease.acquireLease`; this owns the refuse-by-throw boundary.
 * Failures throw, never `Logger.fatal`.
 */

import { acquireLease, normalizeOperatorHandle } from './ticket-lease.js';

/**
 * First candidate that normalizes to a bare login (strips `@`, maps the
 * `@[USERNAME]` placeholder to `null` — else the assignee PATCH 422s).
 * `'null'` suits paths with a best-effort release leg, which must no-op.
 *
 * @param {object} opts
 * @param {Array<string|null|undefined>} opts.candidates  Ordered raw handles.
 * @param {'null'|'throw'} [opts.missingHandleBehavior='null']
 * @param {string} [opts.missingHandleMessage]
 * @returns {string|null} Bare operator handle, or `null` (policy `'null'`).
 * @throws {Error} When no candidate resolves and the policy is `'throw'`.
 */
export function resolveOperatorFromCandidates({
  candidates,
  missingHandleBehavior = 'null',
  missingHandleMessage,
} = {}) {
  for (const raw of candidates ?? []) {
    const normalized = normalizeOperatorHandle(raw);
    if (normalized !== null) return normalized;
  }
  if (missingHandleBehavior === 'throw') {
    throw new Error(missingHandleMessage);
  }
  return null;
}

/**
 * Acquire a lease; a foreign claim without `steal` throws the surface's
 * refusal.
 *
 * @param {object} opts
 * @param {object} opts.provider
 * @param {number} opts.ticketId
 * @param {string} opts.operator
 * @param {boolean} [opts.steal=false]
 * @param {(result: object, ticketId: number) => string} opts.renderRefusal
 * @returns {Promise<{ acquired: boolean, owner: string, previousOwner: string|null, reason: string }>}
 * @throws {Error} When the claim is refused (`result.acquired === false`).
 */
export async function acquireLeaseFailClosed({
  provider,
  ticketId,
  operator,
  steal = false,
  renderRefusal,
}) {
  const result = await acquireLease({
    provider,
    ticketId,
    operator,
    steal,
  });
  if (!result.acquired) {
    throw new Error(renderRefusal(result, ticketId));
  }
  return result;
}
