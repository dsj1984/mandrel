/**
 * lease-guard-shared.js — Story #3992: single-source the lease-acquisition
 * kernel shared by the three per-surface lease guards.
 *
 * `epic-deliver-lease-guard.js`, `epic-plan-lease-guard.js`, and
 * `single-story-lease-guard.js` historically each carried their own copy of
 * the operator-handle resolution and the fail-closed acquire wrapper around
 * `ticket-lease.acquireLease` (anchor `heartbeatAt` to `now` so a foreign
 * assignee always reads as a live claim, then throw an operator-facing
 * refusal naming the current owner unless `--steal`). The three copies had
 * already diverged — different `resolveOperator` signatures and different
 * missing-handle behaviour (`null` vs `throw`) — and were synchronised only
 * by docstring promise ("This mirrors the sibling lease guards…").
 *
 * This module is the single home for the kernel, modelled on the
 * shared plumbing inside `story-close/format-autofix.js` (Story #3332,
 * consolidated by Story #4017). The
 * per-surface guards now differ only in injected **policy**:
 *
 *   - **Operator candidates** — each surface supplies its own ordered
 *     candidate list (e.g. `--as` flag → `github.operatorHandle` →
 *     `git user.email` for `/deliver`; bare `operatorHandle` for the
 *     plan/standalone paths).
 *   - **Missing-handle behaviour** — `'null'` (return null; the caller fails
 *     closed at acquire time) vs `'throw'` (refuse immediately with surface
 *     wording). The divergence between the plan path (`null`) and the
 *     standalone path (`throw`) is intentional: the plan path also calls
 *     `resolveOperator` on its best-effort release leg, where a missing
 *     handle must degrade to a `no-operator` no-op rather than throw.
 *   - **Refusal wording** — each surface renders its own operator-facing
 *     message via `renderRefusal(result, ticketId)`.
 *   - **Liveness anchoring** — the plan/standalone paths have no heartbeat
 *     ledger, so they anchor `heartbeatAt` to `now` (fail-closed: every
 *     foreign claim reads live). `/deliver` threads a real
 *     `heartbeatAt` through from the lifecycle ledger, so it opts out of
 *     anchoring.
 *
 * The unclaimed / already-held / foreign-claim decision table itself (and
 * the steal transfer) lives in `ticket-lease.acquireLease`; this kernel owns
 * the fail-closed parameterisation and the refuse-by-throw boundary that the
 * three guards previously each re-implemented.
 *
 * Per `.agents/rules/orchestration-error-handling.md`, failures surface via
 * `throw new Error(...)`, never `Logger.fatal`.
 */

import { acquireLease, normalizeOperatorHandle } from './ticket-lease.js';

/**
 * Resolve the operator handle from an ordered candidate list, applying the
 * surface's missing-handle policy.
 *
 * Each candidate is passed through the shared `normalizeOperatorHandle` so a
 * leading `@` is stripped (the assignees API expects bare logins, not
 * `@`-prefixed mentions) and the shipped `@[USERNAME]` placeholder maps to
 * `null` — otherwise the assignee PATCH is rejected (HTTP 422) and the
 * self-held-claim comparison (`owner === operator`) never matches. The first
 * candidate that normalises to a non-null handle wins.
 *
 * @param {object} opts
 * @param {Array<string|null|undefined>} opts.candidates  Ordered raw handles.
 * @param {'null'|'throw'} [opts.missingHandleBehavior='null']  What to do
 *   when no candidate resolves: return `null`, or throw with the surface's
 *   configured wording.
 * @param {string} [opts.missingHandleMessage]  Error message used when
 *   `missingHandleBehavior` is `'throw'`.
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
 * Acquire a ticket lease, failing closed by throwing the surface's refusal
 * message when the claim is refused (live foreign owner, no `steal`).
 *
 * When `anchorHeartbeatToNow` is set (the plan/standalone paths, which have
 * no heartbeat ledger), `heartbeatAt` and `now` are both anchored to the
 * same resolved clock value so `isClaimLive` returns true for ANY foreign
 * owner — `acquireLease` then refuses a foreign assignee unless `steal` is
 * set, while unclaimed and self-held tickets still proceed without a write.
 * When unset (`/deliver`), the caller-supplied `heartbeatAt` / `now`
 * pass through untouched.
 *
 * @param {object} opts
 * @param {object} opts.provider          Ticketing provider.
 * @param {number} opts.ticketId          Ticket to claim.
 * @param {string} opts.operator          Resolved operator handle.
 * @param {number|null} [opts.heartbeatAt=null]  Current owner's last
 *   heartbeat (epoch ms). Ignored when `anchorHeartbeatToNow` is set.
 * @param {boolean} [opts.steal=false]    Forcibly transfer a foreign claim.
 * @param {object} [opts.config]          Resolved config (TTL default).
 * @param {number} [opts.now]             Injectable clock (epoch ms; tests).
 * @param {boolean} [opts.anchorHeartbeatToNow=false]  Fail-closed liveness
 *   anchoring for surfaces with no heartbeat source.
 * @param {(result: object, ticketId: number) => string} opts.renderRefusal
 *   Renders the operator-facing refusal message for a refused claim.
 * @returns {Promise<{ acquired: boolean, owner: string, previousOwner: string|null, reason: string }>}
 * @throws {Error} When the claim is refused (`result.acquired === false`).
 */
export async function acquireLeaseFailClosed({
  provider,
  ticketId,
  operator,
  heartbeatAt = null,
  steal = false,
  config,
  now,
  anchorHeartbeatToNow = false,
  renderRefusal,
}) {
  let resolvedHeartbeatAt = heartbeatAt;
  let resolvedNow = now;
  if (anchorHeartbeatToNow) {
    resolvedNow =
      typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    resolvedHeartbeatAt = resolvedNow;
  }
  const result = await acquireLease({
    provider,
    ticketId,
    operator,
    heartbeatAt: resolvedHeartbeatAt,
    steal,
    config,
    now: resolvedNow,
  });
  if (!result.acquired) {
    throw new Error(renderRefusal(result, ticketId));
  }
  return result;
}
