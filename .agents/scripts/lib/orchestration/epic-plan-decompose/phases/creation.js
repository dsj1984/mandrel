/**
 * creation.js — Phase 4 shared infrastructure for the two creation flows
 * (`decompose-legacy.js` direct-create + `persist.js` reconciler-based).
 *
 * Exports: `reconcileSubIssueLinks`, `setEpicLabel`, `resolveChildIndex`,
 * `runStagedPasses` (three-pass driver with adaptive RL degrade),
 * `assertEpicHasPlanningArtifacts`, `warnTicketCapNearLimit`.
 *
 * @module lib/orchestration/epic-plan-decompose/phases/creation
 */

import { Logger } from '../../../Logger.js';
import { AGENT_LABELS, TYPE_LABELS } from '../../../label-constants.js';
import { concurrentMap } from '../../../util/concurrent-map.js';
import { runCreationPass } from './creation-pass.js';

const TYPE_LABEL_TO_TYPE = {
  [TYPE_LABELS.FEATURE]: 'feature',
  [TYPE_LABELS.STORY]: 'story',
};

function indexExistingChildren(existing) {
  const childTypes = new Set([TYPE_LABELS.FEATURE, TYPE_LABELS.STORY]);
  const byTitle = new Map();
  for (const child of existing) {
    const typeLabel = (child.labels || []).find((l) => childTypes.has(l));
    if (!typeLabel) continue;
    byTitle.set(child.title, {
      id: child.id,
      state: child.state,
      type: TYPE_LABEL_TO_TYPE[typeLabel],
    });
  }
  return byTitle;
}

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

async function loadExistingChildren(provider, epicId) {
  const existing =
    typeof provider.getTickets === 'function'
      ? await provider.getTickets(epicId)
      : [];
  if (existing.length > 0 && typeof provider.primeTicketCache === 'function') {
    provider.primeTicketCache(existing);
  }
  return (existing || []).filter((t) =>
    (t.labels || []).some((l) =>
      [TYPE_LABELS.FEATURE, TYPE_LABELS.STORY].includes(l),
    ),
  );
}

async function forceCloseExistingChildren(existingChildren, provider) {
  Logger.info('[Decomposer] --force: Closing existing child tickets...');
  const openChildren = existingChildren.filter((c) => c.state !== 'closed');
  await concurrentMap(
    openChildren,
    async (child) => {
      await provider.updateTicket(child.id, {
        state: 'closed',
        state_reason: 'not_planned',
      });
      Logger.info(`[Decomposer]   Closed #${child.id}: ${child.title}`);
    },
    { concurrency: 3 },
  );
  Logger.info(
    `[Decomposer]   Closed ${existingChildren.length} old ticket(s).`,
  );
}

export async function resolveChildIndex({ force, resume, provider, epicId }) {
  const existingChildren = await loadExistingChildren(provider, epicId);
  if (force) await forceCloseExistingChildren(existingChildren, provider);
  const childIndex = force
    ? new Map()
    : indexExistingChildren(existingChildren);
  if (resume && childIndex.size === 0) {
    throw new Error(
      `[Decomposer] --resume requires existing child tickets under Epic #${epicId}, but none were found. Run without --resume to perform a fresh decomposition.`,
    );
  }
  return childIndex;
}

/**
 * Run the staged feature → story → task creation passes against `provider`.
 *
 * 3-tier (Epic #3078): when the backlog carries no `type === 'task'`
 * tickets — the canonical 3-tier shape where Stories carry inline
 * `acceptance[]` + `verify[]` — the task pass is skipped via the
 * empty-bucket `continue` below. No "missing tasks" warning is emitted;
 * the 3-tier shape is a first-class backlog, validated upstream by
 * `assertEachTypePresent` / `assertEveryStoryHasTasks` in
 * `lib/orchestration/ticket-validator.js`.
 *
 * 4-tier (legacy): all three passes fire in feature → story → task order;
 * the slugMap propagates across passes so the task pass's
 * `parent_slug` → Story-issue-number resolution succeeds.
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
    for (const passType of ['feature', 'story', 'task']) {
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

export function assertEpicHasPlanningArtifacts(epic, epicId) {
  if (!epic?.linkedIssues?.prd || !epic.linkedIssues.techSpec) {
    throw new Error(
      `[Decomposer] Epic #${epicId} is missing linked PRD or Tech Spec. Run the Epic Planner first.`,
    );
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
    `[${tag}] ⚠️  Received ${tickets.length} tickets against a reviewability budget of ${maxTickets}. Verify every Story still has child Tasks; over-budget persistence requires --allow-over-budget.`,
  );
}
