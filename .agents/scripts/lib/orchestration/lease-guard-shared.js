/**
 * lease-guard-shared.js — Story #3992: single-source the lease-acquisition
 * kernel shared by the three per-surface lease guards.
 *
 * The per-surface lease guards — today `single-story-lease-guard.js`;
 * historically also the retired Epic-tier deliver/mandrel-plan guards —
 * each carried their own copy of
 * the operator-handle resolution and the fail-closed acquire wrapper around
 * `ticket-lease.acquireLease` (refuse any foreign assignee, throwing an
 * operator-facing message naming the current owner unless `--steal`). The
 * three copies had
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
 *     `git user.email` for `/mandrel-deliver`; bare `operatorHandle` for the
 *     plan/standalone paths).
 *   - **Missing-handle behaviour** — `'null'` (return null; the caller fails
 *     closed at acquire time) vs `'throw'` (refuse immediately with surface
 *     wording). The divergence between the plan path (`null`) and the
 *     standalone path (`throw`) is intentional: the plan path also calls
 *     `resolveOperator` on its best-effort release leg, where a missing
 *     handle must degrade to a `no-operator` no-op rather than throw.
 *   - **Refusal wording** — each surface renders its own operator-facing
 *     message via `renderRefusal(result, ticketId)`.
 *
 * A third axis, **liveness anchoring**, is gone: Story #5006 deleted the
 * lease TTL, so every foreign claim refuses unconditionally and there is no
 * heartbeat to anchor.
 *
 * The unclaimed / already-held / foreign-claim decision table itself (and
 * the steal transfer) lives in `ticket-lease.acquireLease`; this kernel owns
 * the refuse-by-throw boundary that the three guards previously each
 * re-implemented.
 *
 * Per `docs/contributing/orchestration-error-handling.md`, failures surface via
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
 * message when the claim is refused (foreign owner, no `steal`).
 *
 * Unclaimed and self-held tickets proceed — the self-held case without a
 * write. A foreign assignee always refuses unless `steal` is set.
 *
 * @param {object} opts
 * @param {object} opts.provider          Ticketing provider.
 * @param {number} opts.ticketId          Ticket to claim.
 * @param {string} opts.operator          Resolved operator handle.
 * @param {boolean} [opts.steal=false]    Forcibly transfer a foreign claim.
 * @param {(result: object, ticketId: number) => string} opts.renderRefusal
 *   Renders the operator-facing refusal message for a refused claim.
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
