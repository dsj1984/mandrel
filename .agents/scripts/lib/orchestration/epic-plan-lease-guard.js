/**
 * epic-plan-lease-guard.js — `/plan` workflow guards (Story #3481,
 * Epic #3457).
 *
 * Wires the assignee-as-lease primitive (`ticket-lease.js`, Story #3480) and a
 * decompose-idempotency guard into the split planning flow so two concurrent
 * `/plan` runs cannot both drive the same Epic, and so a re-run does not
 * silently duplicate the Feature/Story tree:
 *
 *   - `acquireEpicPlanLease`   — claim the Epic before Phase 7 (spec). Refuses
 *                                (throws, exit non-zero) when a live foreign
 *                                claim already holds the Epic, naming the
 *                                current owner. **Claim-time liveness
 *                                (Story #4019):** `/plan` emits no
 *                                `story.heartbeat`, so the lease records its
 *                                own claim-time in a `plan-lease` structured
 *                                comment on the Epic at acquire time. A
 *                                foreign claim fresher than the lease TTL
 *                                refuses (unless `--steal`); a stale or
 *                                record-less claim is reclaimed
 *                                automatically. An unassigned or self-held
 *                                Epic still proceeds.
 *   - `releaseEpicPlanLease`   — release the claim after Phase 8 (decompose).
 *                                Best-effort and self-scoped: a no-op once the
 *                                Epic was reassigned elsewhere.
 *   - `assertNoOpenPlanChildren` — refuse Phase 8 persist when the Epic already
 *                                has open Story children, unless the
 *                                operator passed `--force` (a deliberate
 *                                re-decompose that closes the old tree).
 *
 * The PRD / Tech Spec find-or-create idempotency already lives in
 * `phases/plan-epic.js` (keyed on `epic.linkedIssues`); these guards add the
 * cross-run mutual exclusion and the child-duplication refusal around it.
 */

import { getGitHub } from '../config/github.js';
import { resolveLeaseTtlMs } from '../config/limits.js';
import { Logger } from '../Logger.js';
import { TYPE_LABELS } from '../label-constants.js';
import {
  acquireLeaseFailClosed,
  resolveOperatorFromCandidates,
} from './lease-guard-shared.js';
import { currentOwner, releaseLease } from './ticket-lease.js';
import { findStructuredComment, upsertStructuredComment } from './ticketing.js';

/**
 * Resolve the operator handle that owns this `/plan` run from
 * `github.operatorHandle`. The assignee-as-lease primitive is single-holder
 * keyed on a non-empty string; when no operator is configured (unset, or the
 * shipped `@[USERNAME]` placeholder, both of which `normalizeOperatorHandle`
 * maps to `null`) the lease cannot be keyed. This returns `null`; the caller
 * (`acquireEpicPlanLease`) then fails closed by throwing rather than running an
 * ownerless, unguarded plan.
 *
 * The `@`-prefix some operators carry on `operatorHandle` is stripped (via
 * the shared lease-guard kernel) so the value matches the bare login GitHub
 * writes to (and returns from) a ticket's `assignees` — otherwise the
 * assignee PATCH is rejected (HTTP 422, invalid assignee) and the
 * self-held-claim comparison (`owner === operator`) never matches.
 *
 * The plan surface's missing-handle policy is `'null'` (intentional
 * divergence from the standalone path's `'throw'`): `releaseEpicPlanLease`
 * is best-effort and must degrade to a `no-operator` no-op rather than
 * throw, so the throw-on-missing decision lives in `acquireEpicPlanLease`.
 *
 * @param {object} config Resolved config bag.
 * @returns {string|null}
 */
export function resolveOperator(config) {
  return resolveOperatorFromCandidates({
    candidates: [getGitHub(config).operatorHandle],
  });
}

/**
 * Structured-comment type carrying the plan-lease claim-time record.
 * Registered in `ticketing/reads.js` `STRUCTURED_COMMENT_TYPES`.
 */
export const PLAN_LEASE_COMMENT_TYPE = 'plan-lease';

/**
 * Render the `plan-lease` structured-comment body: a one-line human
 * summary plus the canonical fenced-JSON record `parsePlanLeaseClaim`
 * reads back.
 *
 * @param {{ epicId: number, owner: string, claimedAt: string }} input
 *   `claimedAt` is an ISO-8601 timestamp.
 * @returns {string}
 */
export function buildPlanLeaseCommentBody({ epicId, owner, claimedAt }) {
  const record = {
    kind: PLAN_LEASE_COMMENT_TYPE,
    epicId,
    owner,
    claimedAt,
  };
  return [
    `### 🔒 Plan Lease — claimed by \`${owner}\``,
    '',
    `This Epic is being planned by \`${owner}\` (claimed ${claimedAt}). A`,
    'concurrent `/plan` run refuses while this claim is fresher than the',
    'lease TTL, and reclaims automatically once it goes stale.',
    '',
    '```json',
    JSON.stringify(record, null, 2),
    '```',
  ].join('\n');
}

/**
 * Parse the claim record out of a `plan-lease` comment body. Returns
 * `{ owner, claimedAtMs }` or `null` when the body carries no readable
 * record — which callers treat as "no claim-time recorded" (stale,
 * reclaimable).
 *
 * @param {string|undefined|null} body
 * @returns {{ owner: string, claimedAtMs: number } | null}
 */
export function parsePlanLeaseClaim(body) {
  if (typeof body !== 'string') return null;
  const match = body.match(/```json\s*\n([\s\S]*?)\n\s*```/);
  if (!match) return null;
  let record;
  try {
    record = JSON.parse(match[1]);
  } catch (_err) {
    return null;
  }
  if (!record || record.kind !== PLAN_LEASE_COMMENT_TYPE) return null;
  const owner =
    typeof record.owner === 'string' && record.owner.length > 0
      ? record.owner
      : null;
  const claimedAtMs = Date.parse(record.claimedAt ?? '');
  if (owner === null || !Number.isFinite(claimedAtMs)) return null;
  return { owner, claimedAtMs };
}

/**
 * Acquire the Epic-lease before Phase 7.
 *
 * **Claim-time liveness (Story #4019, superseding the audit-#3513
 * fail-closed anchor).** `/plan` emits no `story.heartbeat`, so the
 * old guard treated EVERY foreign assignee as live — which made the
 * documented "`--steal` once you have confirmed the other run is dead"
 * contract undecidable (there was no in-band liveness signal to confirm
 * against). The lease now records its own claim-time: on every successful
 * acquire the guard upserts a `plan-lease` structured comment on the Epic
 * carrying `{ owner, claimedAt }`. A subsequent run judges a foreign
 * claim's liveness from that claim-time against the lease TTL
 * (`resolveLeaseTtlMs`):
 *
 *   - **Fresh foreign claim** (claim-time within TTL) → refuse, naming the
 *     owner and the claim age; `--steal` force-transfers.
 *   - **Stale foreign claim** (claim-time older than TTL) → reclaim
 *     automatically.
 *   - **No claim-time record** (foreign assignee but no readable
 *     `plan-lease` comment, or the comment names a different owner) →
 *     treated as stale and reclaimed — the assignee predates this
 *     mechanism or was set out-of-band, so there is nothing to wait on.
 *
 * An unassigned Epic (`unclaimed`) or a self-held claim (`already-held`)
 * proceeds; both refresh the claim-time record.
 *
 * A refused claim throws (caught at the CLI boundary → exit non-zero).
 *
 * @param {object} args
 * @param {import('../ITicketingProvider.js').ITicketingProvider} args.provider
 * @param {number} args.epicId
 * @param {object} [args.config]
 * @param {boolean} [args.steal=false]   Force-transfer a live foreign claim.
 * @param {number} [args.now]            Injectable clock (epoch ms; tests).
 * @returns {Promise<{ acquired: boolean, owner: string|null, previousOwner: string|null, reason: string }>}
 */
export async function acquireEpicPlanLease({
  provider,
  epicId,
  config,
  steal = false,
  now,
}) {
  const operator = resolveOperator(config);
  if (operator === null) {
    throw new Error(
      `[epic-plan] Refusing to plan Epic #${epicId}: no operator identity is ` +
        'configured. github.operatorHandle is unset or still the shipped ' +
        '`@[USERNAME]` placeholder, so the Epic-lease has no owner and ' +
        'concurrent /plan runs cannot be serialised. Set your own handle ' +
        'in .agentrc.local.json (e.g. { "github": { "operatorHandle": ' +
        '"@your-login" } }) and re-run.',
    );
  }

  const resolvedNow =
    typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  const ttlMs = resolveLeaseTtlMs(config);

  // Resolve the current assignee and the recorded claim-time. The
  // claim-time only counts when the `plan-lease` record names the same
  // owner as the assignee — a mismatched or missing record means the claim
  // has no liveness signal and is treated as stale (reclaimable).
  const ticket = await provider.getTicket(epicId);
  const owner = currentOwner(ticket?.assignees);
  let heartbeatAt = null;
  if (owner !== null && owner !== operator) {
    let claim = null;
    try {
      const comment = await findStructuredComment(
        provider,
        epicId,
        PLAN_LEASE_COMMENT_TYPE,
      );
      claim = comment ? parsePlanLeaseClaim(comment.body) : null;
    } catch (err) {
      Logger.warn(
        `[epic-plan] Could not read plan-lease claim record on #${epicId} ` +
          `(treating foreign claim as stale): ${err.message}`,
      );
    }
    if (claim && claim.owner === owner) {
      heartbeatAt = claim.claimedAtMs;
    }
  }

  const result = await acquireLeaseFailClosed({
    provider,
    ticketId: epicId,
    operator,
    heartbeatAt,
    steal,
    config,
    now: resolvedNow,
    renderRefusal: (refused) => {
      const ageMinutes =
        heartbeatAt !== null
          ? Math.round((resolvedNow - heartbeatAt) / 60000)
          : null;
      const ageNote =
        ageMinutes !== null
          ? `Its plan-lease claim is ~${ageMinutes} minute(s) old (TTL ${Math.round(ttlMs / 60000)} minute(s)), so the run is presumed live. `
          : '';
      return (
        `[epic-plan] Epic #${epicId} is currently claimed by '${refused.owner}'. ` +
        `Refusing to plan concurrently — another /plan run owns this Epic. ` +
        `${ageNote}Wait for that run to finish (the claim auto-expires at the ` +
        `lease TTL), or re-run with --steal to forcibly transfer the claim.`
      );
    },
  });

  // Record (or refresh) the claim-time so the next run can judge this
  // claim's liveness. Best-effort: a comment failure degrades to a
  // record-less claim (which a later run treats as stale) — it never
  // fails the plan.
  try {
    await upsertStructuredComment(
      provider,
      epicId,
      PLAN_LEASE_COMMENT_TYPE,
      buildPlanLeaseCommentBody({
        epicId,
        owner: operator,
        claimedAt: new Date(resolvedNow).toISOString(),
      }),
    );
  } catch (err) {
    Logger.warn(
      `[epic-plan] Failed to record plan-lease claim-time on #${epicId} ` +
        `(non-fatal; a later run will treat this claim as stale): ${err.message}`,
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
    // Any open typed plan ticket counts — `type::story` plus pre-v4
    // `type::feature` leftovers. The prefix check is legacy-data
    // detection, not compat support: the guard only refuses, it never
    // processes the legacy tier. Context tickets (`context::*`) are
    // untouched.
    return (
      isOpen &&
      labels.some((l) => typeof l === 'string' && l.startsWith('type::'))
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
    const legacyCount = openChildren.filter(
      (t) => !(t.labels ?? []).includes(TYPE_LABELS.STORY),
    ).length;
    const legacyHint =
      legacyCount > 0
        ? `\n${legacyCount} of these are not type::story — they look like ` +
          `legacy pre-v4 Feature tickets; migrate or close them per the ` +
          `v1.60.0 migration notes before re-planning.`
        : '';
    throw new Error(
      `[epic-plan-decompose] Epic #${epicId} already has ` +
        `${openChildren.length} open plan child ticket(s):\n${summary}${more}\n\n` +
        `Persisting now would duplicate the breakdown. Re-run with --force to ` +
        `close the existing tree and re-decompose, or close the stale children ` +
        `by hand first.${legacyHint}`,
    );
  }

  return { openChildren: [] };
}
