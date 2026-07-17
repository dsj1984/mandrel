/**
 * ticket-lease.js — assignee-as-lease primitive (Story #3480, Epic #3457).
 *
 * The workflow-guards Feature (#3478) needs a way for one operator to take
 * an exclusive, time-bounded claim on a ticket so two concurrent runs do not
 * both drive the same Story. Rather than invent a new state column, the lease
 * rides the ticket's existing **assignees** surface: the single assignee *is*
 * the lease owner. Liveness is decided by the owner's last-heartbeat epoch-ms
 * compared against a configured TTL.
 *
 * **There is no live heartbeat source.** The `story.heartbeat` emitter this
 * module was designed against was structurally inert (it demanded an
 * `epicId >= 1` that v2, which has no Epics, never supplies) and has been
 * deleted. Every caller now reaches `acquireLease` through
 * `lease-guard-shared.acquireLeaseFailClosed` with `anchorHeartbeatToNow`,
 * which pins `heartbeatAt` to `now`: the lease **fails closed**, so any
 * foreign claim reads as live and refuses. A stranded claim is cleared with
 * `--steal`, never by TTL expiry. The TTL and the stale-reclaim branch below
 * are therefore reachable only via an explicit caller-supplied `heartbeatAt`
 * — the seam is kept, the automatic expiry is not real.
 *
 * The three exported operations are deliberately thin and provider-agnostic:
 *
 *   - `acquireLease`  — claim an unassigned ticket, re-affirm a self-held
 *                       claim, reclaim a ticket whose foreign claim has gone
 *                       stale (heartbeat older than TTL), or — with
 *                       `steal: true` — forcibly transfer a *live* foreign
 *                       claim.
 *   - `releaseLease`  — clear the assignment, but only when the operator
 *                       still holds it (a no-op once the ticket was
 *                       reassigned elsewhere, so a late release never steals
 *                       a claim back from whoever took over).
 *   - `describeLease` — a read-only snapshot of the current claim and its
 *                       liveness, used by callers (and tests) to reason about
 *                       a ticket without mutating it.
 *
 * Provider contract (a subset of `ITicketingProvider`):
 *   - `getTicket(id)`            → `{ assignees: string[], ... }`
 *   - `updateTicket(id, { assignees })` writes the assignee list.
 *
 * Liveness seam: callers supply the owner's last-heartbeat epoch-ms via the
 * `heartbeatAt` option (a number, or `null`/`undefined` when no heartbeat has
 * ever been recorded for the current owner). Threading the timestamp in keeps
 * this module pure and trivially unit-testable — it does not read any ledger
 * itself. A claim with no heartbeat is treated as stale (reclaimable) by
 * `isClaimLive`; note the live guards never take that branch, per the
 * fail-closed anchoring described above.
 *
 * `now` is injectable (epoch ms) for deterministic tests; it defaults to
 * `Date.now()`.
 */

import { resolveLeaseTtlMs } from '../config/limits.js';

/**
 * The shipped, non-personal operator-identity placeholder (and its bare,
 * post-normalise form). The committed `.agentrc.json` and the distributed
 * templates carry this sentinel so `github.operatorHandle` is schema-present
 * without naming a real person; each contributor overrides it with their own
 * handle in the gitignored `.agentrc.local.json`. It is NOT a usable lease
 * owner: `normalizeOperatorHandle` maps it to `null` so the guards fail closed
 * (a contributor who never set their handle is loudly refused, never silently
 * coordinated under a shared identity) and no assignee PATCH ever writes a
 * literal `[USERNAME]` (HTTP 422).
 */
// kept (dead-export allowlist): public config sentinel — the distributed
// `.agentrc.json` / templates carry this literal; exported so consumers and
// future call sites resolve it by symbol rather than re-typing the string.
export const OPERATOR_HANDLE_PLACEHOLDER = '@[USERNAME]';
const OPERATOR_HANDLE_PLACEHOLDER_BARE = '[USERNAME]';

/**
 * Normalise an operator handle into the bare login GitHub writes to (and
 * returns from) a ticket's `assignees`. Trims surrounding whitespace and
 * strips a single leading `@` so an `@`-prefixed `operatorHandle` matches a
 * bare assignee login (otherwise the assignee PATCH is rejected HTTP 422 and
 * the self-held-claim comparison `owner === operator` never matches).
 *
 * Returns `null` for a non-string, empty, whitespace-only, or placeholder
 * handle (`@[USERNAME]`) so each caller can apply its own absent-handling
 * (degrade to a no-op, or throw). Treating the placeholder as unset is what
 * makes the shipped sentinel safe: a contributor who never overrode it is
 * indistinguishable from one who set nothing, so the guards fail closed.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeOperatorHandle(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^@/, '');
  if (trimmed.length === 0 || trimmed === OPERATOR_HANDLE_PLACEHOLDER_BARE) {
    return null;
  }
  return trimmed;
}

/**
 * Decide whether a foreign claim is still "live" given the owner's last
 * heartbeat and the configured TTL. A claim is live when a heartbeat exists
 * and is no older than `ttlMs`. A missing heartbeat (`null`/`undefined`) or a
 * heartbeat older than the TTL is stale and therefore reclaimable.
 *
 * The `heartbeatAt` seam is retained, but there is no longer any in-repo
 * heartbeat *source*: the `story.heartbeat` emitter was structurally inert
 * (it required an `epicId >= 1` that v2 never sets) and was deleted along
 * with the ledger reader that scanned for it. Every live caller reaches this
 * through `lease-guard-shared.acquireLeaseFailClosed` with
 * `anchorHeartbeatToNow`, which pins `heartbeatAt` to `now` so ANY foreign
 * claim reads live and the guard fails closed — a stranded claim is cleared
 * with `--steal`, not by TTL expiry. The parameter stays because that
 * anchoring is expressed through it.
 *
 * @param {object} args
 * @param {number|null|undefined} args.heartbeatAt  Owner's last heartbeat (epoch ms).
 * @param {number} args.ttlMs                        Lease TTL in milliseconds.
 * @param {number} args.now                          Current time (epoch ms).
 * @returns {boolean}
 */
export function isClaimLive({ heartbeatAt, ttlMs, now }) {
  if (typeof heartbeatAt !== 'number' || !Number.isFinite(heartbeatAt)) {
    return false;
  }
  return now - heartbeatAt <= ttlMs;
}

/**
 * Normalise the assignee list into a single current owner. The lease model is
 * single-holder: the first assignee is authoritative. Returns `null` for an
 * unassigned ticket.
 *
 * @param {string[]|undefined|null} assignees
 * @returns {string|null}
 */
export function currentOwner(assignees) {
  if (!Array.isArray(assignees) || assignees.length === 0) return null;
  return assignees[0];
}

/**
 * Validate and normalise the shared option bag for the lease operations.
 *
 * @param {string} op
 * @param {object} opts
 * @returns {{ provider: object, ticketId: number, operator: string, ttlMs: number, now: number }}
 */
function normaliseOpts(op, opts) {
  const { provider, ticketId, operator, config, now } = opts ?? {};

  if (!provider || typeof provider.getTicket !== 'function') {
    throw new Error(`${op}: provider with getTicket/updateTicket is required`);
  }
  if (!Number.isInteger(ticketId) || ticketId < 1) {
    throw new Error(`${op}: ticketId must be a positive integer`);
  }
  if (typeof operator !== 'string' || operator.length === 0) {
    throw new Error(`${op}: operator must be a non-empty string`);
  }

  const ttlMs = resolveLeaseTtlMs(config, opts.ttlMs);
  const resolvedNow =
    typeof now === 'number' && Number.isFinite(now) ? now : Date.now();

  return { provider, ticketId, operator, ttlMs, now: resolvedNow };
}

/**
 * Read-only snapshot of the current lease on a ticket. Never mutates.
 *
 * @param {object} opts
 * @param {object} opts.provider              Ticketing provider (getTicket).
 * @param {number} opts.ticketId              Ticket to inspect.
 * @param {string} opts.operator              The operator asking.
 * @param {number|null} [opts.heartbeatAt]    Owner's last heartbeat (epoch ms).
 * @param {object} [opts.config]              Resolved config (for TTL default).
 * @param {number} [opts.ttlMs]               Explicit TTL override (epoch ms).
 * @param {number} [opts.now]                 Injectable clock (epoch ms).
 * @returns {Promise<{
 *   ticketId: number,
 *   owner: string|null,
 *   heldByOperator: boolean,
 *   live: boolean,
 *   ttlMs: number,
 * }>}
 */
export async function describeLease(opts) {
  const { provider, ticketId, operator, ttlMs, now } = normaliseOpts(
    'describeLease',
    opts,
  );
  const ticket = await provider.getTicket(ticketId);
  const owner = currentOwner(ticket?.assignees);
  const heldByOperator = owner === operator;
  const live =
    owner === null
      ? false
      : isClaimLive({ heartbeatAt: opts.heartbeatAt, ttlMs, now });
  return { ticketId, owner, heldByOperator, live, ttlMs };
}

/**
 * Acquire (or re-affirm) a lease on a ticket for `operator`.
 *
 * Outcomes:
 *   - Unassigned ticket            → assign operator, `acquired: true`,
 *                                     `reason: 'unclaimed'`.
 *   - Operator already holds it    → no write, `acquired: true`,
 *                                     `reason: 'already-held'`.
 *   - Live foreign claim, no steal → no write, `acquired: false`,
 *                                     `owner: <foreign>`, `reason: 'held'`.
 *   - Stale foreign claim          → reassign operator, `acquired: true`,
 *                                     `reason: 'reclaimed'`.
 *   - Foreign claim + `steal:true` → reassign operator, `acquired: true`,
 *                                     `reason: 'stolen'`.
 *   - Lost a write race            → a foreign login co-assigned between our
 *                                     PATCH and the verify re-read; back the
 *                                     operator out, `acquired: false`,
 *                                     `owner: <foreign>`, `reason: 'lost-race'`.
 *
 * Every claiming write is verified: GitHub's assignee PATCH is not a
 * compare-and-set, so two runs that both read the ticket unassigned will both
 * write themselves. {@link claimAndVerify} re-reads after the write and refuses
 * (fail-closed) when a foreign login is present, so the loser of a simultaneous
 * claim never proceeds as though it holds the lease.
 *
 * @param {object} opts
 * @param {object} opts.provider              Ticketing provider.
 * @param {number} opts.ticketId              Ticket to claim.
 * @param {string} opts.operator              Operator acquiring the lease.
 * @param {number|null} [opts.heartbeatAt]    Current owner's last heartbeat (epoch ms).
 * @param {boolean} [opts.steal=false]        Transfer a live foreign claim.
 * @param {object} [opts.config]              Resolved config (TTL default).
 * @param {number} [opts.ttlMs]               Explicit TTL override.
 * @param {number} [opts.now]                 Injectable clock.
 * @returns {Promise<{
 *   acquired: boolean,
 *   owner: string,
 *   previousOwner: string|null,
 *   reason: 'unclaimed'|'already-held'|'reclaimed'|'stolen'|'held'|'lost-race',
 * }>}
 */
export async function acquireLease(opts) {
  const { provider, ticketId, operator, ttlMs, now } = normaliseOpts(
    'acquireLease',
    opts,
  );
  const steal = opts.steal === true;

  const ticket = await provider.getTicket(ticketId);
  const owner = currentOwner(ticket?.assignees);

  // Unclaimed → take it.
  if (owner === null) {
    return claimAndVerify({
      provider,
      ticketId,
      operator,
      previousOwner: null,
      reason: 'unclaimed',
    });
  }

  // Already ours → no write needed.
  if (owner === operator) {
    return {
      acquired: true,
      owner: operator,
      previousOwner: operator,
      reason: 'already-held',
    };
  }

  // Foreign claim — decide on liveness / steal.
  const live = isClaimLive({ heartbeatAt: opts.heartbeatAt, ttlMs, now });
  if (live && !steal) {
    return {
      acquired: false,
      owner,
      previousOwner: owner,
      reason: 'held',
    };
  }

  return claimAndVerify({
    provider,
    ticketId,
    operator,
    previousOwner: owner,
    reason: steal && live ? 'stolen' : 'reclaimed',
  });
}

/**
 * Write the operator to a ticket's assignees, then re-read to confirm the
 * claim actually stuck before reporting success.
 *
 * The assignee write is not atomic — GitHub offers no compare-and-set on the
 * assignees surface — so two runs that both observed the ticket unassigned (or
 * a stale foreign claim) will both PATCH themselves in. Without a check the
 * loser of that race returns `acquired: true` and marches into the worktree
 * the winner is already building. The verify closes that window: it re-reads
 * with `fresh: true` (bypassing any provider cache so it sees the other run's
 * write, not our own), and if a foreign login is present it concedes — removes
 * the operator from the assignee set so no phantom co-owner lingers, and
 * returns `acquired: false` / `reason: 'lost-race'` so the fail-closed caller
 * refuses. A clean read (assignees exactly `[operator]`) confirms the claim.
 *
 * It does not eliminate the race — two writes still happen — but it makes the
 * outcome deterministic: exactly one operator survives as the sole assignee,
 * and the other is told it lost.
 *
 * @param {object} args
 * @param {object} args.provider              Ticketing provider.
 * @param {number} args.ticketId              Ticket being claimed.
 * @param {string} args.operator              Operator acquiring the lease.
 * @param {string|null} args.previousOwner    Owner before this write (for the result).
 * @param {string} args.reason                Success reason when the claim holds.
 * @returns {Promise<{ acquired: boolean, owner: string, previousOwner: string|null, reason: string }>}
 */
async function claimAndVerify({
  provider,
  ticketId,
  operator,
  previousOwner,
  reason,
}) {
  await provider.updateTicket(ticketId, { assignees: [operator] });

  const after = await provider.getTicket(ticketId, { fresh: true });
  const assignees = Array.isArray(after?.assignees) ? after.assignees : [];
  const foreign = assignees.filter((login) => login !== operator);

  if (foreign.length === 0) {
    return { acquired: true, owner: operator, previousOwner, reason };
  }

  // A foreign login co-assigned after our write — we lost a simultaneous
  // claim. Back ourselves out so the winner is the sole assignee, and report
  // the loss so the fail-closed caller refuses rather than double-delivering.
  await provider
    .updateTicket(ticketId, { assignees: foreign })
    .catch(() => undefined);
  return {
    acquired: false,
    owner: foreign[0],
    previousOwner,
    reason: 'lost-race',
  };
}

/**
 * Release a lease the operator currently holds.
 *
 * Clears the ticket's assignees only when `operator` is still the recorded
 * owner. If the ticket has since been reassigned (or was never held by this
 * operator), the call is a no-op — a stale release must never yank a claim
 * away from whoever legitimately holds it now.
 *
 * @param {object} opts
 * @param {object} opts.provider   Ticketing provider.
 * @param {number} opts.ticketId   Ticket to release.
 * @param {string} opts.operator   Operator releasing the lease.
 * @param {object} [opts.config]   Resolved config (TTL default).
 * @param {number} [opts.ttlMs]    Explicit TTL override.
 * @param {number} [opts.now]      Injectable clock.
 * @returns {Promise<{
 *   released: boolean,
 *   owner: string|null,
 *   reason: 'released'|'not-held',
 * }>}
 */
export async function releaseLease(opts) {
  const { provider, ticketId, operator } = normaliseOpts('releaseLease', opts);
  const ticket = await provider.getTicket(ticketId);
  const owner = currentOwner(ticket?.assignees);

  if (owner !== operator) {
    return { released: false, owner, reason: 'not-held' };
  }

  await provider.updateTicket(ticketId, { assignees: [] });
  return { released: true, owner: null, reason: 'released' };
}
