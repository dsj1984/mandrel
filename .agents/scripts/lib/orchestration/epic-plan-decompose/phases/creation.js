/**
 * creation.js — sub-issue link reconciliation, Epic label transitions, and
 * the advisory ticket-cap warning used by the reconciler-based persist flow
 * (`persist.js`).
 *
 * Exports: `reconcileSubIssueLinks`, `setEpicLabel`,
 * `warnTicketCapNearLimit`.
 *
 * @module lib/orchestration/epic-plan-decompose/phases/creation
 */

import { Logger } from '../../../Logger.js';
import { AGENT_LABELS } from '../../../label-constants.js';

export async function reconcileSubIssueLinks(epicId, provider) {
  if (typeof provider.reconcileSubIssueLinks !== 'function') return;
  Logger.info(
    `[Decomposer] Reconciling sub-issue API links for Epic #${epicId}...`,
  );
  const result = await provider.reconcileSubIssueLinks(epicId);
  const { totalExpected, alreadyLinked, reconciled, failed, failures } = result;
  if (failed === 0) {
    const reconciledNote = reconciled > 0 ? ` (${reconciled} reconciled)` : '';
    Logger.info(
      `[Decomposer] linked ${alreadyLinked + reconciled}/${totalExpected} sub-issues${reconciledNote}`,
    );
    return;
  }
  for (const failure of failures) {
    Logger.error(
      `[Decomposer] sub-issue link gap: parent #${failure.parentId} ← child #${failure.childId}: ${failure.reason}`,
    );
  }
  throw new Error(
    `[Decomposer] Sub-issue reconciliation incomplete: ${failed}/${totalExpected} links could not be established (linked=${alreadyLinked}, reconciled=${reconciled}). See log for per-child reasons.`,
  );
}

export async function setEpicLabel(provider, epicId, targetLabel) {
  const planningLabels = [AGENT_LABELS.REVIEW_SPEC, AGENT_LABELS.READY];
  await provider.updateTicket(epicId, {
    labels: {
      add: [targetLabel],
      remove: planningLabels.filter((l) => l !== targetLabel),
    },
  });
}

/**
 * Advisory-only ticket-count check (Story #2798).
 *
 * `maxTickets` is a **reviewability budget**, not a hard authoring cap.
 * This helper emits a non-destructive warning when a decomposition meets
 * or exceeds the budget so the operator can spot over-budget plans early
 * in the persist flow. It never blocks — the hard gate lives in the
 * `runDecomposePhase` over-budget check, which requires an explicit
 * `allowOverBudget` (CLI: `--allow-over-budget`) override.
 *
 * @param {Array} tickets
 * @param {number} maxTickets — the reviewability budget
 * @param {string} [tag] — log prefix
 * @param {{ logger?: Pick<typeof Logger, 'warn'> }} [opts]
 */
export function warnTicketCapNearLimit(
  tickets,
  maxTickets,
  tag = 'epic-plan-decompose',
  { logger = Logger } = {},
) {
  if (tickets.length < maxTickets) return;
  logger.warn(
    `[${tag}] ⚠️  Received ${tickets.length} tickets against a reviewability budget of ${maxTickets}. Review the Story decomposition before persisting; over-budget persistence requires --allow-over-budget.`,
  );
}
