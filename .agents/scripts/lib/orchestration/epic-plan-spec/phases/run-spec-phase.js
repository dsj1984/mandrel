/**
 * phases/run-spec-phase.js — orchestrator for Phase 7 (spec).
 *
 * Wires the planEpic persist phase, the Tech Spec freshness advisory, the
 * `agent::review-spec` label flip, the planning-state checkpoint upsert, and
 * the temp-file cleanup into a single sequential flow.
 */

import path from 'node:path';
import { PROJECT_ROOT } from '../../../config-resolver.js';
import { Logger } from '../../../Logger.js';
import { AGENT_LABELS, TYPE_LABELS } from '../../../label-constants.js';
import { cleanupPhaseTempFiles } from '../../../plan-phase-cleanup.js';
import {
  initialize as initializePlanState,
  PLAN_PHASES,
  read as readPlanState,
  setPhase as setPlanPhase,
  write as writePlanState,
} from '../../epic-plan-state-store.js';
import { resolveReviewRouting } from '../../plan-review-routing.js';
import { classifyPlanningRisk } from '../../planning-risk.js';
import { planEpic } from './plan-epic.js';
import { runSpecFreshnessCheck } from './spec-freshness.js';

async function setEpicLabel(provider, epicId, targetLabel) {
  const planningLabels = [AGENT_LABELS.REVIEW_SPEC, AGENT_LABELS.READY];
  await provider.updateTicket(epicId, {
    labels: {
      add: [targetLabel],
      remove: planningLabels.filter((l) => l !== targetLabel),
    },
  });
}

/**
 * Execute the spec phase end to end.
 *
 * @param {number} epicId
 * @param {import('../../../ITicketingProvider.js').ITicketingProvider} provider
 * @param {{ prdContent: string, techSpecContent: string, acceptanceSpecContent?: string|null }} artifacts
 * @param {object} settings
 * @param {{ force?: boolean, forceReview?: boolean }} [opts]
 * @returns {Promise<{ epicId: number, prdId: number|null, techSpecId: number|null, acceptanceSpecId: number|null, checkpoint: object, planningRisk: import('../../planning-risk.js').PlanningRiskEnvelope, reviewRouting: import('../../plan-review-routing.js').ReviewRoutingEnvelope }>}
 */
export async function runSpecPhase(
  epicId,
  provider,
  { prdContent, techSpecContent, acceptanceSpecContent = null },
  settings = {},
  { force = false, forceReview = false } = {},
) {
  const epic = await provider.getEpic(epicId);
  if (!epic) {
    throw new Error(`[epic-plan-spec] Epic #${epicId} not found.`);
  }
  if (!epic.labels?.includes(TYPE_LABELS.EPIC)) {
    throw new Error(
      `[epic-plan-spec] Ticket #${epicId} is not a ${TYPE_LABELS.EPIC}.`,
    );
  }

  await initializePlanState({ provider, epicId });
  await setPlanPhase({
    provider,
    epicId,
    nextPhase: PLAN_PHASES.PLANNING,
  });

  await planEpic(
    epicId,
    provider,
    { prdContent, techSpecContent, acceptanceSpecContent },
    settings,
    {
      force,
    },
  );

  const afterPlan = await provider.getEpic(epicId);
  const prdId = afterPlan.linkedIssues?.prd ?? null;
  const techSpecId = afterPlan.linkedIssues?.techSpec ?? null;
  const acceptanceSpecId = afterPlan.linkedIssues?.acceptanceSpec ?? null;

  // Story #2635 — cross-validate the authored Tech Spec body against the
  // base branch and surface any stale path-shaped references on the Tech
  // Spec issue. Non-blocking: a missing base ref, an unreadable temp
  // directory, or a provider failure downgrades to a warning so Phase 7
  // never fails on the advisory check.
  const baseBranchRef = settings?.baseBranch ?? 'main';
  const tempRoot = path.resolve(
    PROJECT_ROOT,
    settings?.paths?.tempRoot ?? 'temp',
  );
  const freshness = await runSpecFreshnessCheck({
    epicId,
    techSpecId,
    techSpecContent,
    baseBranchRef,
    tempRoot,
    provider,
  });

  // Story #1585 (Epic #1471): the baseline-snapshot fork was previously
  // performed here at plan-time. It now runs at first-story-init time
  // inside `lib/story-init/branch-initializer.js#bootstrapWorktree` so
  // `/epic-plan` remains git-state-free. `forkAndCommitEpicSnapshot` and
  // `forkMainToEpic` remain exported for that caller.

  const planningRisk = classifyPlanningRisk({
    title: afterPlan.title,
    body: afterPlan.body ?? '',
    labels: afterPlan.labels ?? [],
  });
  const reviewRouting = resolveReviewRouting({ planningRisk, forceReview });

  const currentState =
    (await readPlanState({ provider, epicId })) ??
    (await initializePlanState({ provider, epicId }));
  const checkpoint = await writePlanState({
    provider,
    epicId,
    state: {
      ...currentState,
      planningRisk,
      reviewRouting: {
        decision: reviewRouting.decision,
        requiresStop: reviewRouting.requiresStop,
        forceReviewApplied: reviewRouting.forceReviewApplied,
      },
      spec: {
        ...currentState.spec,
        prdId,
        techSpecId,
        acceptanceSpecId,
        completedAt: new Date().toISOString(),
      },
    },
  });

  Logger.info(`[epic-plan-spec] Review routing: ${reviewRouting.decision}.`);
  Logger.info(`[epic-plan-spec] ${reviewRouting.operatorMessage}`);

  Logger.info(
    `[epic-plan-spec] Flipping Epic #${epicId} to ${AGENT_LABELS.REVIEW_SPEC}...`,
  );
  await setEpicLabel(provider, epicId, AGENT_LABELS.REVIEW_SPEC);
  await setPlanPhase({
    provider,
    epicId,
    nextPhase: PLAN_PHASES.REVIEW_SPEC,
  });

  const cleanup = await cleanupPhaseTempFiles({ phase: 'spec', epicId });

  const acceptanceSummary =
    acceptanceSpecId !== null ? `, Acceptance Spec #${acceptanceSpecId}` : '';
  const freshnessSummary =
    freshness.stale > 0 || freshness.ambiguous > 0
      ? ` ⚠️ Spec freshness: ${freshness.stale} stale / ${freshness.ambiguous} ambiguous reference(s) — see ${freshness.reportPath ?? 'report'}.`
      : '';
  Logger.info(
    `[epic-plan-spec] ✅ Spec phase complete for Epic #${epicId}. PRD #${prdId}, Tech Spec #${techSpecId}${acceptanceSummary}.${freshnessSummary}`,
  );
  if (cleanup.deleted.length > 0) {
    Logger.info(
      `[epic-plan-spec] 🧹 Cleaned up ${cleanup.deleted.length} temp file(s).`,
    );
  }

  return {
    epicId,
    prdId,
    techSpecId,
    acceptanceSpecId,
    checkpoint,
    cleanup,
    freshness,
    planningRisk,
    reviewRouting,
  };
}
