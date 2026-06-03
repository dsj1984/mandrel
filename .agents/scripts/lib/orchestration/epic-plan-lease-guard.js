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

import { getGitHub } from '../config/github.js';
import { Logger } from '../Logger.js';
import { TYPE_LABELS } from '../label-constants.js';
import {
  acquireLease,
  latestHeartbeatForOwner,
  normalizeOperatorHandle,
  releaseLease,
} from './ticket-lease.js';

// Re-exported for callers/tests that import the heartbeat resolver from this
// guard's historical location. The implementation now lives in
// `ticket-lease.js` so `/epic-deliver` and `/story-deliver` can share it.
export { latestHeartbeatForOwner };

/**
 * Resolve the operator handle that owns this `/epic-plan` run from
 * `github.operatorHandle`. The assignee-as-lease primitive is single-holder
 * keyed on a non-empty string; when no operator is configured the lease cannot
 * be keyed, so this returns `null` and the preflight degrades to a no-op rather
 * than wedging every plan run in a repo that has not set the handle.
 *
 * The `@`-prefix some operators carry on `operatorHandle` is stripped so the
 * value matches the bare login GitHub writes to (and returns from) a ticket's
 * `assignees` — otherwise the assignee PATCH is rejected (HTTP 422, invalid
 * assignee) and the self-held-claim comparison (`owner === operator`) never
 * matches. This mirrors the sibling lease guards
 * (`single-story-lease-guard.js`, `epic-deliver-lease-guard.js`).
 *
 * @param {object} config Resolved config bag.
 * @returns {string|null}
 */
export function resolveOperator(config) {
  return normalizeOperatorHandle(getGitHub(config).operatorHandle);
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
