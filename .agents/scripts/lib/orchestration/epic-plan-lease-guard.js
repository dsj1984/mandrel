/**
 * epic-plan-lease-guard.js — `/epic-plan` workflow guards (Story #3481,
 * Epic #3457).
 *
 * Wires the assignee-as-lease primitive (`ticket-lease.js`, Story #3480) and a
 * decompose-idempotency guard into the split planning flow so two concurrent
 * `/epic-plan` runs cannot both drive the same Epic, and so a re-run does not
 * silently duplicate the Feature/Story tree:
 *
 *   - `acquireEpicPlanLease`   — claim the Epic before Phase 7 (spec). Refuses
 *                                (throws, exit non-zero) when a *live* foreign
 *                                claim already holds the Epic, naming the
 *                                current owner. Liveness is decided from the
 *                                owner's most-recent `story.heartbeat` in the
 *                                Epic lifecycle ledger vs. the configured lease
 *                                TTL — the same seam the lease primitive uses.
 *   - `releaseEpicPlanLease`   — release the claim after Phase 8 (decompose).
 *                                Best-effort and self-scoped: a no-op once the
 *                                Epic was reassigned elsewhere.
 *   - `assertNoOpenPlanChildren` — refuse Phase 8 persist when the Epic already
 *                                has open Feature/Story children, unless the
 *                                operator passed `--force` (a deliberate
 *                                re-decompose that closes the old tree).
 *
 * The PRD / Tech Spec find-or-create idempotency already lives in
 * `phases/plan-epic.js` (keyed on `epic.linkedIssues`); these guards add the
 * cross-run mutual exclusion and the child-duplication refusal around it.
 */

import { readFileSync } from 'node:fs';

import { getGitHub } from '../config/github.js';
import { epicLedgerPath } from '../config/temp-paths.js';
import { Logger } from '../Logger.js';
import { TYPE_LABELS } from '../label-constants.js';
import { parseLedger } from './lifecycle/trace-logger.js';
import { acquireLease, releaseLease } from './ticket-lease.js';

/**
 * Resolve the operator handle that owns this `/epic-plan` run from
 * `github.operatorHandle`. The assignee-as-lease primitive is single-holder
 * keyed on a non-empty string; when no operator is configured the lease cannot
 * be keyed, so this returns `null` and the preflight degrades to a no-op rather
 * than wedging every plan run in a repo that has not set the handle.
 *
 * @param {object} config Resolved config bag.
 * @returns {string|null}
 */
export function resolveOperator(config) {
  const handle = getGitHub(config).operatorHandle;
  if (typeof handle !== 'string' || handle.trim() === '') {
    return null;
  }
  return handle.trim();
}

/**
 * Read the most-recent `story.heartbeat` epoch-ms recorded for a given lease
 * owner from the Epic lifecycle ledger. Returns `null` when the ledger is
 * absent, unreadable, or carries no heartbeat for that owner — which the lease
 * primitive treats as a stale (reclaimable) claim.
 *
 * The ledger is NDJSON; each `story.heartbeat` record carries
 * `payload.operator` (Story #3480) and `payload.timestamp` (ISO-8601). A
 * malformed ledger downgrades to `null` rather than throwing so a corrupt
 * observability artifact never wedges the planning preflight.
 *
 * @param {object} args
 * @param {number} args.epicId
 * @param {string} args.owner            Lease owner whose heartbeat to find.
 * @param {object} [args.config]         Resolved config (for ledger path).
 * @param {string} [args.ledgerPath]     Explicit path override (tests).
 * @param {(eid: number, config?: object) => string} [args.ledgerPathResolver]
 *        Injectable resolver (tests). Defaults to `epicLedgerPath`.
 * @param {(p: string) => string} [args.readFile]  Injectable reader (tests).
 * @returns {number|null}
 */
export function latestHeartbeatForOwner({
  epicId,
  owner,
  config,
  ledgerPath,
  ledgerPathResolver = epicLedgerPath,
  readFile = (p) => readFileSync(p, 'utf8'),
}) {
  if (typeof owner !== 'string' || owner.length === 0) return null;
  const resolvedPath = ledgerPath ?? ledgerPathResolver(epicId, config);

  let text;
  try {
    text = readFile(resolvedPath);
  } catch (_err) {
    // No ledger yet (fresh Epic) → no heartbeat → reclaimable.
    return null;
  }

  let records;
  try {
    records = parseLedger(text);
  } catch (_err) {
    // Corrupt ledger is an observability problem, not a planning blocker.
    return null;
  }

  let latest = null;
  for (const record of records) {
    const payload = record?.payload;
    if (!payload || payload.event !== 'story.heartbeat') continue;
    if (payload.operator !== owner) continue;
    const ts = Date.parse(payload.timestamp ?? '');
    if (!Number.isFinite(ts)) continue;
    if (latest === null || ts > latest) latest = ts;
  }
  return latest;
}

/**
 * Acquire the Epic-lease before Phase 7. Resolves the operator and the current
 * owner's last heartbeat, then delegates the live/stale decision to
 * `acquireLease`. A *live* foreign claim throws (caught at the CLI boundary →
 * exit non-zero) naming the current owner; a stale or unclaimed Epic is taken.
 *
 * @param {object} args
 * @param {import('../ITicketingProvider.js').ITicketingProvider} args.provider
 * @param {number} args.epicId
 * @param {object} [args.config]
 * @param {boolean} [args.steal=false]   Force-transfer a live foreign claim.
 * @param {number} [args.now]            Injectable clock (epoch ms; tests).
 * @param {string} [args.ledgerPath]     Ledger path override (tests).
 * @returns {Promise<{ acquired: boolean, owner: string|null, previousOwner: string|null, reason: string }>}
 */
export async function acquireEpicPlanLease({
  provider,
  epicId,
  config,
  steal = false,
  now,
  ledgerPath,
}) {
  const operator = resolveOperator(config);
  if (operator === null) {
    Logger.warn(
      `[epic-plan] Epic-lease preflight skipped for #${epicId}: ` +
        'github.operatorHandle is unset in .agentrc.json (no lease key).',
    );
    return {
      acquired: true,
      owner: null,
      previousOwner: null,
      reason: 'no-operator',
    };
  }

  // `acquireLease` judges a foreign claim's liveness from the *current owner's*
  // heartbeat — not necessarily our own. Read the assignee first so the
  // heartbeat lookup is keyed on whoever actually holds the Epic.
  const ticket = await provider.getTicket(epicId);
  const currentOwner =
    Array.isArray(ticket?.assignees) && ticket.assignees.length > 0
      ? ticket.assignees[0]
      : null;
  const ownerHeartbeat = currentOwner
    ? latestHeartbeatForOwner({
        epicId,
        owner: currentOwner,
        config,
        ledgerPath,
      })
    : null;

  const result = await acquireLease({
    provider,
    ticketId: epicId,
    operator,
    heartbeatAt: ownerHeartbeat,
    steal,
    config,
    now,
  });

  if (!result.acquired) {
    throw new Error(
      `[epic-plan] Epic #${epicId} is currently claimed by '${result.owner}' ` +
        `(live lease). Refusing to plan concurrently. Wait for that run to ` +
        `finish, or re-run with the lease steal override once you have ` +
        `confirmed the other run is dead.`,
    );
  }

  Logger.info(
    `[epic-plan] Acquired Epic-lease on #${epicId} for '${operator}' ` +
      `(reason: ${result.reason}).`,
  );
  return result;
}

/**
 * Release the Epic-lease after Phase 8. Best-effort: a release failure (or a
 * lease already reassigned elsewhere) MUST NOT fail the decompose phase, which
 * has already persisted the plan by the time release runs.
 *
 * @param {object} args
 * @param {import('../ITicketingProvider.js').ITicketingProvider} args.provider
 * @param {number} args.epicId
 * @param {object} [args.config]
 * @returns {Promise<{ released: boolean, owner: string|null, reason: string }>}
 */
export async function releaseEpicPlanLease({ provider, epicId, config }) {
  const operator = resolveOperator(config);
  if (operator === null) {
    return { released: false, owner: null, reason: 'no-operator' };
  }
  try {
    const result = await releaseLease({
      provider,
      ticketId: epicId,
      operator,
      config,
    });
    if (result.released) {
      Logger.info(`[epic-plan] Released Epic-lease on #${epicId}.`);
    } else {
      Logger.info(
        `[epic-plan] Epic-lease on #${epicId} not released (${result.reason}).`,
      );
    }
    return result;
  } catch (err) {
    Logger.warn(
      `[epic-plan] Lease release on #${epicId} failed (non-fatal): ${err.message}`,
    );
    return { released: false, owner: null, reason: 'release-error' };
  }
}

/**
 * Refuse a Phase 8 decompose-persist when the Epic already has open
 * Feature/Story children, unless `force` is set. This is the idempotency guard
 * that prevents a re-run from stacking a duplicate Feature/Story tree on top of
 * an existing one. Under `--force` the decomposer closes and recreates the
 * tree, so the guard steps aside.
 *
 * @param {object} args
 * @param {import('../ITicketingProvider.js').ITicketingProvider} args.provider
 * @param {number} args.epicId
 * @param {boolean} [args.force=false]
 * @returns {Promise<{ openChildren: Array<{ id: number, title: string }> }>}
 */
export async function assertNoOpenPlanChildren({
  provider,
  epicId,
  force = false,
}) {
  if (force) return { openChildren: [] };

  const children = await provider.getSubTickets(epicId);
  const openChildren = (children ?? []).filter((t) => {
    const labels = Array.isArray(t.labels) ? t.labels : [];
    const isOpen = t.state === undefined || t.state === 'open';
    return (
      isOpen &&
      (labels.includes(TYPE_LABELS.FEATURE) ||
        labels.includes(TYPE_LABELS.STORY))
    );
  });

  if (openChildren.length > 0) {
    const summary = openChildren
      .slice(0, 10)
      .map((t) => `  - #${t.id} ${t.title}`)
      .join('\n');
    const more =
      openChildren.length > 10
        ? `\n  …and ${openChildren.length - 10} more`
        : '';
    throw new Error(
      `[epic-plan-decompose] Epic #${epicId} already has ` +
        `${openChildren.length} open Feature/Story child ticket(s):\n${summary}${more}\n\n` +
        `Persisting now would duplicate the breakdown. Re-run with --force to ` +
        `close the existing tree and re-decompose, or close the stale children ` +
        `by hand first.`,
    );
  }

  return { openChildren: [] };
}
