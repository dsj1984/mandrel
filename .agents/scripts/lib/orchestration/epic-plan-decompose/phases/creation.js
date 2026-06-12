/**
 * creation.js — sub-issue link reconciliation, Epic label transitions,
 * the advisory ticket-cap warning, and the blocked-by dependency wiring
 * used by the reconciler-based persist flow (`persist.js`).
 *
 * Exports: `reconcileSubIssueLinks`, `setBlockedByDependencies`,
 * `setEpicLabel`, `warnTicketCapNearLimit`.
 *
 * @module lib/orchestration/epic-plan-decompose/phases/creation
 */

import { applyBlockedByDependencies } from '../../../../providers/github/blocked-by-add.js';
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

/**
 * Translate each Story's `dependsOn` slug list into native GitHub "blocked
 * by" dependency edges. Best-effort and non-fatal: individual edge failures
 * are logged as warnings and do not abort the decompose phase.
 *
 * Requires the provider to expose `owner`, `repo`, `_gh`, and `getTicket`.
 * No-ops silently when any required surface is absent so callers remain
 * safe across provider stubs.
 *
 * @param {number} epicId
 * @param {import('../../../ITicketingProvider.js').ITicketingProvider} provider
 * @param {object} spec — the parsed YAML spec (has `.stories[*].dependsOn`).
 * @param {object} stateMapping — slug → `{ issueNumber }` from the reconciler state.
 */
export async function setBlockedByDependencies(
  epicId,
  provider,
  spec,
  stateMapping,
) {
  const stories = Array.isArray(spec?.stories) ? spec.stories : [];
  const hasDeps = stories.some(
    (s) => Array.isArray(s.dependsOn) && s.dependsOn.length > 0,
  );
  if (!hasDeps) return;

  if (
    !provider?.owner ||
    !provider?.repo ||
    !provider?._gh ||
    typeof provider.getTicket !== 'function'
  ) {
    Logger.warn(
      `[Decomposer] setBlockedByDependencies: provider missing required surface (owner/repo/_gh/getTicket); skipping.`,
    );
    return;
  }

  Logger.info(
    `[Decomposer] Setting native blocked-by dependency edges for Epic #${epicId}...`,
  );

  // Build a slug → issueNumber map from the reconciler state mapping.
  const slugToIssueNumber = {};
  for (const [slug, entry] of Object.entries(stateMapping ?? {})) {
    if (typeof entry?.issueNumber === 'number') {
      slugToIssueNumber[slug] = entry.issueNumber;
    }
  }

  const result = await applyBlockedByDependencies({
    stories,
    slugToIssueNumber,
    getTicket: (n) => provider.getTicket(n),
    owner: provider.owner,
    repo: provider.repo,
    gh: provider._gh,
  });

  const { edgesAdded, edgesSkipped, edgesFailed, storiesProcessed } = result;
  Logger.info(
    `[Decomposer] blocked-by edges: ${edgesAdded} added, ${edgesSkipped} already present, ${edgesFailed} failed (${storiesProcessed} stories with deps processed).`,
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
