/**
 * Assignee-as-lease: the ticket's single assignee is the lease owner. A
 * foreign claim is always refused; `steal: true` (`--steal`) is the only way
 * past one. Provider needs `getTicket` and `updateTicket` with `assignees`
 * (replace) or `addAssignees` (append).
 */

/**
 * Shipped placeholder handle. Normalizes to `null` so an unset handle fails
 * closed and no PATCH writes a literal `[USERNAME]` (HTTP 422).
 */
// kept (dead-export allowlist): public config sentinel — the distributed
// `.agentrc.json` / templates carry this literal; exported so consumers and
// future call sites resolve it by symbol rather than re-typing the string.
export const OPERATOR_HANDLE_PLACEHOLDER = '@[USERNAME]';
const OPERATOR_HANDLE_PLACEHOLDER_BARE = '[USERNAME]';

/**
 * Bare login (trimmed, one leading `@` stripped) so it matches assignee
 * logins. `null` for empty or placeholder input; callers decide how to fail.
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
 * The first assignee is authoritative.
 *
 * @param {string[]|undefined|null} assignees
 * @returns {string|null}
 */
export function currentOwner(assignees) {
  if (!Array.isArray(assignees) || assignees.length === 0) return null;
  return assignees[0];
}

/**
 * @param {string} op
 * @param {object} opts
 * @returns {{ provider: object, ticketId: number, operator: string }}
 */
function normaliseOpts(op, opts) {
  const { provider, ticketId, operator } = opts ?? {};

  if (!provider || typeof provider.getTicket !== 'function') {
    throw new Error(`${op}: provider with getTicket/updateTicket is required`);
  }
  if (!Number.isInteger(ticketId) || ticketId < 1) {
    throw new Error(`${op}: ticketId must be a positive integer`);
  }
  if (typeof operator !== 'string' || operator.length === 0) {
    throw new Error(`${op}: operator must be a non-empty string`);
  }

  return { provider, ticketId, operator };
}

/**
 * Every claiming write is verified by re-read, since assignee writes are not
 * compare-and-set; a co-assigned foreign login yields `lost-race`.
 *
 * @param {object} opts
 * @param {object} opts.provider
 * @param {number} opts.ticketId
 * @param {string} opts.operator
 * @param {boolean} [opts.steal=false]        Transfer a foreign claim.
 * @returns {Promise<{
 *   acquired: boolean,
 *   owner: string,
 *   previousOwner: string|null,
 *   reason: 'unclaimed'|'already-held'|'stolen'|'held'|'lost-race',
 * }>}
 */
export async function acquireLease(opts) {
  const { provider, ticketId, operator } = normaliseOpts('acquireLease', opts);
  const steal = opts.steal === true;

  const ticket = await provider.getTicket(ticketId);
  const owner = currentOwner(ticket?.assignees);

  if (owner === null) {
    return claimAndVerify({
      provider,
      ticketId,
      operator,
      previousOwner: null,
      reason: 'unclaimed',
    });
  }

  if (owner === operator) {
    return {
      acquired: true,
      owner: operator,
      previousOwner: operator,
      reason: 'already-held',
    };
  }

  if (!steal) {
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
    reason: 'stolen',
  });
}

/**
 * Write, then re-read with `fresh: true`; on a foreign co-assignee, back out
 * and report `lost-race` so the loser never builds the winner's worktree.
 *
 * @param {object} args
 * @param {object} args.provider
 * @param {number} args.ticketId
 * @param {string} args.operator
 * @param {string|null} args.previousOwner
 * @param {string} args.reason                Success reason when the claim holds.
 * @returns {Promise<{ acquired: boolean, owner: string, previousOwner: string|null, reason: string }>}
 */
/**
 * Additive for an unowned ticket — a replacing PATCH would evict a
 * simultaneous claimer, hiding the collision verify keys on. Replacing only
 * for a steal.
 *
 * @param {string} operator
 * @param {string|null} previousOwner
 * @returns {{ addAssignees: string[] }|{ assignees: string[] }}
 */
function claimMutation(operator, previousOwner) {
  if (previousOwner === null) return { addAssignees: [operator] };
  return { assignees: [operator] };
}

async function claimAndVerify({
  provider,
  ticketId,
  operator,
  previousOwner,
  reason,
}) {
  await provider.updateTicket(ticketId, claimMutation(operator, previousOwner));

  const after = await provider.getTicket(ticketId, { fresh: true });
  const assignees = Array.isArray(after?.assignees) ? after.assignees : [];
  const foreign = assignees.filter((login) => login !== operator);

  if (foreign.length === 0) {
    return { acquired: true, owner: operator, previousOwner, reason };
  }

  // Lost the race: leave the winner as sole assignee.
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
 * No-op unless `operator` still owns it — a stale release never yanks a claim.
 *
 * @param {object} opts
 * @param {object} opts.provider
 * @param {number} opts.ticketId
 * @param {string} opts.operator
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
