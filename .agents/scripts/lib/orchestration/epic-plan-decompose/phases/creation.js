/**
 * creation.js — Phase 4 staged-pass ticket-creation engine shared by the
 * reconciler-based persist flow (`persist.js`).
 *
 * Exports: `reconcileSubIssueLinks`, `setEpicLabel`,
 * `runStagedPasses` (two-pass driver with adaptive RL degrade),
 * `warnTicketCapNearLimit`.
 *
 * @module lib/orchestration/epic-plan-decompose/phases/creation
 */

import { Logger } from '../../../Logger.js';
import { AGENT_LABELS } from '../../../label-constants.js';
import { runCreationPass } from './creation-pass.js';

function attachAdaptiveConcurrencyHook(provider) {
  let observed = false;
  const http = provider?._http;
  if (!http || typeof http !== 'object' || !('onTransientFailure' in http)) {
    return { wasThrottled: () => false, detach: () => {} };
  }
  const prior = http.onTransientFailure;
  http.onTransientFailure = (info) => {
    if (info?.kind === 'secondary-rate-limit') observed = true;
    if (typeof prior === 'function') prior(info);
  };
  return {
    wasThrottled: () => observed,
    detach: () => {
      http.onTransientFailure = prior;
    },
  };
}

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
 * Run the staged feature → story creation passes against `provider`.
 *
 * 3-tier (Epic #3078 / #3238): the canonical shape carries only
 * `feature` and `story` tickets — Stories hold inline `acceptance[]` +
 * `verify[]` on their own bodies, so there is no separate task-creation
 * pass. The two passes fire in feature → story order; the slugMap
 * propagates across passes so the story pass's `parent_slug` →
 * Feature-issue-number resolution succeeds. The inline-contract
 * invariant is validated upstream by `assertEachTypePresent` /
 * `assertEveryStoryHasInlineContract` in
 * `lib/orchestration/ticket-validator.js`.
 */
export async function runStagedPasses({
  ordered,
  slugMap,
  epicId,
  provider,
  childIndex,
  configuredCap,
}) {
  let activeCap = configuredCap;
  const throttle = attachAdaptiveConcurrencyHook(provider);
  try {
    for (const passType of ['feature', 'story']) {
      const passTickets = ordered.filter((t) => t.type === passType);
      if (passTickets.length === 0) continue;
      if (throttle.wasThrottled() && activeCap > 1) {
        Logger.warn(
          `[Decomposer] secondary rate-limit observed — dropping concurrencyCap from ${activeCap} to 1 for remaining passes`,
        );
        activeCap = 1;
      }
      await runCreationPass(
        passTickets,
        slugMap,
        epicId,
        provider,
        activeCap,
        childIndex,
      );
    }
  } finally {
    throttle.detach();
  }
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
    `[${tag}] ⚠️  Received ${tickets.length} tickets against a reviewability budget of ${maxTickets}. Review the Feature/Story split before persisting; over-budget persistence requires --allow-over-budget.`,
  );
}
