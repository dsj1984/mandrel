// .agents/scripts/lib/orchestration/finalize/close-planning-tickets.js
/**
 * close-planning-tickets.js — finalize helper that closes the three
 * planning context tickets (PRD / Tech Spec / Acceptance Spec) linked
 * from the Epic body's `## Planning Artifacts` section.
 *
 * Extracted from `/deliver` Phase 7.1 prose (the `gh issue close`
 * sequence) so the lifecycle Finalizer listener has a single async
 * helper to call. Reuses `parseLinkedIssues` so the three planning ids
 * are read from the same canonical body shape that `epic-plan` writes
 * via `ensurePlanningArtifacts` and that `closePlanningArtifacts` (the
 * existing post-merge close-tail helper) consumes.
 *
 * Story #2894 / Task #2904 (Epic #2880).
 *
 * Contract:
 *   - Input:  { epicId, provider, transitionFn?, logger? }
 *   - Output: { closed, alreadyClosed, failed, details[] }
 *
 * Idempotency: a planning ticket that is already closed (provider
 * `state === 'closed'`) is counted under `alreadyClosed` and not
 * re-transitioned. A failed close on one ticket records a `failed`
 * entry and the helper continues with the remaining tickets — finalize
 * surfaces the count and the listener decides whether to escalate via
 * `agent::blocked`.
 */

import { parseLinkedIssues } from '../../issue-link-parser.js';
import { Logger } from '../../Logger.js';
import { STATE_LABELS, transitionTicketState } from '../ticketing.js';

/**
 * @param {object} args
 * @param {number} args.epicId — numeric Epic ticket id.
 * @param {object} args.provider — ITicketingProvider. Must implement
 *   `getTicket(id)` returning at least `{ body, state, linkedIssues? }`.
 * @param {Function} [args.transitionFn] — override of
 *   `transitionTicketState` for tests.
 * @param {object} [args.logger] — { info, warn, debug } surface.
 * @returns {Promise<{
 *   closed: number,
 *   alreadyClosed: number,
 *   failed: number,
 *   details: Array<{ kind: 'prd'|'techSpec'|'acceptanceSpec', id: number|null, status: 'closed'|'already-closed'|'failed'|'skipped', detail?: string }>,
 * }>}
 */
export async function closePlanningTickets({
  epicId,
  provider,
  transitionFn = transitionTicketState,
  logger = Logger,
} = {}) {
  if (!Number.isInteger(epicId) || epicId < 1) {
    throw new TypeError(
      'closePlanningTickets: epicId must be a positive integer',
    );
  }
  if (!provider || typeof provider.getTicket !== 'function') {
    throw new TypeError(
      'closePlanningTickets: provider must implement getTicket()',
    );
  }

  const epic = await provider.getTicket(epicId);
  const linked = epic?.linkedIssues ?? parseLinkedIssues(epic?.body ?? '');

  const kinds = /** @type {const} */ ([
    ['prd', linked?.prd ?? null],
    ['techSpec', linked?.techSpec ?? null],
    ['acceptanceSpec', linked?.acceptanceSpec ?? null],
  ]);

  const settled = await Promise.all(
    kinds.map(async ([kind, id]) => {
      if (!Number.isInteger(id) || id <= 0) {
        return { kind, id: null, status: 'skipped', detail: 'no-link' };
      }
      let snapshot;
      try {
        snapshot = await provider.getTicket(id);
      } catch (err) {
        const detail = err?.message ?? String(err);
        logger.warn?.(
          `[finalize/close-planning-tickets] read of ${kind} #${id} failed: ${detail}`,
        );
        return { kind, id, status: 'failed', detail };
      }
      if (snapshot?.state === 'closed') {
        return { kind, id, status: 'already-closed' };
      }
      try {
        await transitionFn(provider, id, STATE_LABELS.DONE, { cascade: false });
        logger.info?.(
          `[finalize/close-planning-tickets] closed ${kind} #${id} for Epic #${epicId}`,
        );
        return { kind, id, status: 'closed' };
      } catch (err) {
        const detail = err?.message ?? String(err);
        logger.warn?.(
          `[finalize/close-planning-tickets] close of ${kind} #${id} failed: ${detail}`,
        );
        return { kind, id, status: 'failed', detail };
      }
    }),
  );

  let closed = 0;
  let alreadyClosed = 0;
  let failed = 0;
  for (const row of settled) {
    if (row.status === 'closed') closed += 1;
    else if (row.status === 'already-closed') alreadyClosed += 1;
    else if (row.status === 'failed') failed += 1;
  }
  return { closed, alreadyClosed, failed, details: settled };
}
