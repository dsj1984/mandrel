/**
 * single-story-lease-guard.js — wire the assignee-as-lease primitive
 * (`ticket-lease.js`, Story #3480) into the standalone `/single-story-deliver`
 * path (Story #3483, Epic #3457).
 *
 * The standalone workflow has no Epic-scoped dispatch manifest to serialise
 * two operators driving the same Story, so a concurrent `single-story-init`
 * could happily clobber another operator's in-flight run. This guard closes
 * that gap by taking an exclusive, time-bounded lease on the Story ticket at
 * init and clearing it at close:
 *
 *   - `acquireStoryLease` — claim the Story for the resolved operator. A live
 *     **foreign** claim (the assignee is someone else and their heartbeat is
 *     within the TTL) is fatal: the guard throws a message naming the current
 *     owner so the operator knows who to coordinate with. Unclaimed,
 *     self-held, and stale-foreign claims all proceed (the primitive reclaims
 *     stale claims automatically).
 *   - `releaseStoryLease` — clear the Story assignment on a clean close, but
 *     only when the operator still holds it (the primitive no-ops a stale
 *     release so a late close never yanks a claim back from whoever took
 *     over).
 *
 * The guard is deliberately thin and provider-agnostic: it resolves the
 * operator handle from config, delegates liveness + assignee mutation to the
 * pure `ticket-lease.js` primitive, and threads the owner's last heartbeat in
 * as an injected value (defaulting to `null` — treated as stale/reclaimable —
 * because the standalone path has no Epic ledger to read a per-owner
 * heartbeat from). Keeping `heartbeatAt` injectable keeps this module
 * trivially unit-testable.
 */

import { acquireLease, releaseLease } from './ticket-lease.js';

/**
 * Resolve the operator handle used as the lease owner from resolved config.
 * Strips a leading `@` so the assignee list carries a bare GitHub login (the
 * assignees API expects logins, not `@`-prefixed mentions).
 *
 * @param {object} config Resolved `.agentrc.json` config.
 * @returns {string} Bare operator handle.
 * @throws {Error} When no `github.operatorHandle` is configured — without an
 *   operator identity the lease has no owner to record, so the standalone
 *   path cannot safely serialise concurrent runs.
 */
export function resolveOperator(config) {
  const raw = config?.github?.operatorHandle;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(
      'single-story lease: github.operatorHandle is not configured. ' +
        'Set it in .agentrc.json so the standalone Story lease has an owner.',
    );
  }
  return raw.trim().replace(/^@/, '');
}

/**
 * Acquire (or re-affirm / reclaim) the Story lease for the standalone path.
 * Throws when a live foreign claim blocks the take — the message names the
 * current owner so the operator can coordinate. Returns the primitive's
 * acquire result otherwise.
 *
 * @param {object} opts
 * @param {object} opts.provider           Ticketing provider (getTicket/updateTicket).
 * @param {number} opts.storyId            Story ticket to claim.
 * @param {object} opts.config             Resolved config (operator handle + TTL default).
 * @param {string} [opts.operator]         Override the resolved operator (tests).
 * @param {number|null} [opts.heartbeatAt] Current owner's last heartbeat (epoch ms).
 * @param {number} [opts.now]              Injectable clock (epoch ms) for tests.
 * @returns {Promise<{ acquired: boolean, owner: string, previousOwner: string|null, reason: string }>}
 * @throws {Error} When a live foreign claim refuses the acquire.
 */
export async function acquireStoryLease({
  provider,
  storyId,
  config,
  operator,
  heartbeatAt = null,
  now,
}) {
  const owner = operator ?? resolveOperator(config);
  const result = await acquireLease({
    provider,
    ticketId: storyId,
    operator: owner,
    heartbeatAt,
    config,
    now,
  });
  if (!result.acquired) {
    throw new Error(
      `single-story lease: Story #${storyId} is currently held by @${result.owner}. ` +
        'Another /single-story-deliver run owns this Story; coordinate with that ' +
        'operator or wait for the claim to go stale before re-running init.',
    );
  }
  return result;
}

/**
 * Release the Story lease on a clean close. No-ops (via the primitive) when
 * the operator no longer holds the claim, so a late close never steals a
 * claim back from whoever legitimately took over.
 *
 * @param {object} opts
 * @param {object} opts.provider    Ticketing provider.
 * @param {number} opts.storyId     Story ticket to release.
 * @param {object} opts.config      Resolved config (operator handle).
 * @param {string} [opts.operator]  Override the resolved operator (tests).
 * @returns {Promise<{ released: boolean, owner: string|null, reason: string }>}
 */
export async function releaseStoryLease({
  provider,
  storyId,
  config,
  operator,
}) {
  const owner = operator ?? resolveOperator(config);
  return releaseLease({ provider, ticketId: storyId, operator: owner, config });
}
