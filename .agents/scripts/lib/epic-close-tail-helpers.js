// .agents/scripts/lib/epic-close-tail-helpers.js
/**
 * Epic close-tail helpers (Story #2319 / Task #2329).
 *
 * `closePlanningArtifacts` and `verifyAndRecoverEpicClose` were lifted
 * out of the 1075-line `epic-deliver-finalize.js` legacy CLI when that
 * file collapsed to an emit shim. They are still consumed by
 * `epic-close.js` (the post-merge close-tail entry point) and are
 * tested in tree under `tests/epic-close-preflight.test.js` and
 * `tests/scripts/epic-close-planning-artifacts.test.js`.
 *
 * The functions are not lifecycle-bus listeners — they are ordinary
 * provider-driven helpers that the `epic-close` CLI invokes after
 * the operator merges the Epic PR. The lifecycle-bus close-tail
 * chain (`Finalizer`, `Watcher`, `AutomergePredicate`,
 * `AutomergeArmer`, `Cleaner`) runs earlier and owns its own
 * side effects.
 */

import { Logger } from './Logger.js';
import {
  STATE_LABELS,
  transitionTicketState,
} from './orchestration/ticketing.js';

/**
 * Close the Epic's linked PRD and Tech Spec planning artifacts.
 *
 * The cascade walker in `lib/orchestration/ticketing/bulk.js` does not
 * recurse upward into the Epic (and historically excluded planning
 * tickets), so without this helper the PRD / Tech Spec stay
 * `agent::executing` (or whatever they were set to during planning)
 * forever. Beyond cosmetics, leaving planning tickets open as native
 * sub-issues of the Epic suppresses GitHub's PR-driven auto-close on
 * the Epic itself when sub-issue parent-close rules apply — closing
 * them here is what lets the `Closes #${epicId}` footer actually fire.
 *
 * Best-effort: a failure on one ticket logs a warn and is reported in
 * the result envelope; it never blocks the PR from opening.
 *
 * @param {{
 *   epicId: number,
 *   epic: { linkedIssues?: { prd?: number|null, techSpec?: number|null, acceptanceSpec?: number|null } } | null,
 *   provider: object,
 *   logger?: object,
 *   transitionFn?: typeof transitionTicketState,
 * }} args
 * @returns {Promise<{
 *   prd: { id: number|null, status: 'closed'|'skipped'|'failed', detail?: string },
 *   techSpec: { id: number|null, status: 'closed'|'skipped'|'failed', detail?: string },
 *   acceptanceSpec: { id: number|null, status: 'closed'|'skipped'|'failed', detail?: string },
 * }>}
 */
export async function closePlanningArtifacts({
  epicId,
  epic,
  provider,
  logger = Logger,
  transitionFn = transitionTicketState,
} = {}) {
  const result = {
    prd: { id: null, status: 'skipped' },
    techSpec: { id: null, status: 'skipped' },
    acceptanceSpec: { id: null, status: 'skipped' },
  };
  const prdId = epic?.linkedIssues?.prd ?? null;
  const techSpecId = epic?.linkedIssues?.techSpec ?? null;
  const acceptanceSpecId = epic?.linkedIssues?.acceptanceSpec ?? null;

  for (const [kind, id] of [
    ['prd', prdId],
    ['techSpec', techSpecId],
    ['acceptanceSpec', acceptanceSpecId],
  ]) {
    if (!Number.isInteger(id) || id <= 0) {
      result[kind] = { id: null, status: 'skipped', detail: 'no-link' };
      continue;
    }
    try {
      // cascade:false avoids walking up the parent chain — the Epic is
      // closed by GitHub when the operator merges the PR (or by the
      // recovery path below), not by a cascade.
      await transitionFn(provider, id, STATE_LABELS.DONE, { cascade: false });
      result[kind] = { id, status: 'closed' };
      logger.info?.(
        `[epic-close-tail] Closed planning artifact ${kind} #${id} for Epic #${epicId}.`,
      );
    } catch (err) {
      const detail = err?.message ?? String(err);
      result[kind] = { id, status: 'failed', detail };
      logger.warn?.(
        `[epic-close-tail] Failed to close planning artifact ${kind} #${id}: ${detail}`,
      );
    }
  }
  return result;
}

/**
 * Verify the Epic ticket reached `state: 'closed'` after the PR-driven
 * auto-close window. If it is still open, transition it explicitly via
 * `transitionTicketState`. Returns a structured envelope so callers can
 * surface "primary auto-close worked" vs "recovery fired" in audit logs.
 *
 * Failures are non-fatal — a recovery attempt that throws leaves the
 * Epic open and is reported in the envelope; the operator can re-run
 * `/epic-close` or close manually.
 *
 * @param {{
 *   epicId: number,
 *   provider: object,
 *   logger?: object,
 *   transitionFn?: typeof transitionTicketState,
 * }} args
 * @returns {Promise<{
 *   status: 'already-closed'|'recovered'|'still-open'|'check-failed',
 *   priorState?: string,
 *   detail?: string,
 * }>}
 */
export async function verifyAndRecoverEpicClose({
  epicId,
  provider,
  logger = Logger,
  transitionFn = transitionTicketState,
} = {}) {
  let snapshot;
  try {
    if (typeof provider.invalidateTicket === 'function') {
      try {
        provider.invalidateTicket(epicId);
      } catch {
        // best-effort cache invalidation
      }
    }
    snapshot = await provider.getTicket(epicId);
  } catch (err) {
    const detail = err?.message ?? String(err);
    logger.warn?.(
      `[epic-close-tail] Epic #${epicId} close-verify read failed: ${detail}`,
    );
    return { status: 'check-failed', detail };
  }
  if (snapshot?.state === 'closed') {
    return { status: 'already-closed', priorState: 'closed' };
  }
  logger.warn?.(
    `[epic-close-tail] Epic #${epicId} still open after PR finalize — applying recovery transition to agent::done.`,
  );
  try {
    await transitionFn(provider, epicId, STATE_LABELS.DONE, { cascade: false });
    return { status: 'recovered', priorState: snapshot?.state ?? 'open' };
  } catch (err) {
    const detail = err?.message ?? String(err);
    logger.warn?.(
      `[epic-close-tail] Epic #${epicId} recovery transition failed: ${detail}`,
    );
    return {
      status: 'still-open',
      priorState: snapshot?.state ?? 'open',
      detail,
    };
  }
}
