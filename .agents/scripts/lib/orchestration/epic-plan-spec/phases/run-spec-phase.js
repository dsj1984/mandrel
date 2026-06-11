/**
 * phases/run-spec-phase.js — orchestrator for Phase 7 (spec).
 *
 * Wires the planEpic persist phase, the Tech Spec freshness advisory, the
 * `agent::review-spec` label flip, the planning-state checkpoint upsert, and
 * the temp-file cleanup into a single sequential flow.
 */

import path from 'node:path';
import { PROJECT_ROOT } from '../../../project-root.js';
import { Logger } from '../../../Logger.js';
import { AGENT_LABELS, TYPE_LABELS } from '../../../label-constants.js';
import { cleanupPhaseTempFiles } from '../../../plan-phase-cleanup.js';
import { acquireEpicPlanLease } from '../../epic-plan-lease-guard.js';
import {
  initialize as initializePlanState,
  read as readPlanState,
  write as writePlanState,
} from '../../epic-plan-state-store.js';
import { resolveReviewRouting } from '../../plan-review-routing.js';
import { deriveRiskEnvelope } from '../../planning-risk.js';
import { upsertStructuredComment } from '../../ticketing.js';
import { planEpic } from './plan-epic.js';
import { runSpecFreshnessCheck } from './spec-freshness.js';

/**
 * Render the `risk-verdict` structured-comment body: a reviewer-readable
 * axis table plus the canonical fenced-JSON record (verdict + derived
 * envelope) downstream tooling parses.
 *
 * @param {{ epicId: number, riskVerdict: import('../../planning-risk.js').RiskVerdict, planningRisk: import('../../planning-risk.js').PlanningRiskEnvelope }} input
 * @returns {string}
 */
function buildRiskVerdictCommentBody({ epicId, riskVerdict, planningRisk }) {
  const axisRows = planningRisk.axes.map(
    (entry) => `| ${entry.axis} | ${entry.level} | ${entry.rationale} |`,
  );
  const axisTable =
    axisRows.length > 0
      ? ['| Axis | Level | Rationale |', '| --- | --- | --- |', ...axisRows]
      : ['_No risk axes apply (planner-asserted)._'];
  const record = {
    kind: 'risk-verdict',
    epicId,
    verdict: riskVerdict,
    planningRisk,
  };
  return [
    `### 🧭 Planning Risk Verdict — ${planningRisk.overallLevel} · ${planningRisk.gateDecision}`,
    '',
    riskVerdict.summary,
    '',
    ...axisTable,
    '',
    '```json',
    JSON.stringify(record, null, 2),
    '```',
  ].join('\n');
}

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
 * @param {{ force?: boolean, forceReview?: boolean, steal?: boolean, config?: object, riskVerdict?: import('../../planning-risk.js').RiskVerdict }} [opts]
 * @returns {Promise<{ epicId: number, prdId: number|null, techSpecId: number|null, acceptanceSpecId: number|null, checkpoint: object, planningRisk: import('../../planning-risk.js').PlanningRiskEnvelope, reviewRouting: import('../../plan-review-routing.js').ReviewRoutingEnvelope }>}
 */
export async function runSpecPhase(
  epicId,
  provider,
  { prdContent, techSpecContent, acceptanceSpecContent = null },
  settings = {},
  {
    force = false,
    forceReview = false,
    steal = false,
    config,
    riskVerdict,
  } = {},
) {
  // Hard cutover (Epic #3865): the planner-authored risk verdict is the
  // sole risk source. Derive the envelope up front so a missing verdict
  // fails closed before any GitHub mutation.
  if (!riskVerdict || !Array.isArray(riskVerdict.axes)) {
    throw new Error(
      '[epic-plan-spec] risk verdict is required — author risk-verdict.json via the epic-plan-spec-author Skill and pass it with --risk-verdict.',
    );
  }
  const planningRisk = deriveRiskEnvelope(riskVerdict);

  const epic = await provider.getEpic(epicId);
  if (!epic) {
    throw new Error(`[epic-plan-spec] Epic #${epicId} not found.`);
  }
  if (!epic.labels?.includes(TYPE_LABELS.EPIC)) {
    throw new Error(
      `[epic-plan-spec] Ticket #${epicId} is not a ${TYPE_LABELS.EPIC}.`,
    );
  }

  // Workflow-guards (Story #3481): acquire the Epic-lease before any Phase 7
  // mutation so two concurrent /epic-plan runs cannot both drive this Epic. The
  // guard fails closed (audit #3513) — any foreign assignee refuses here and
  // the CLI exits non-zero naming the owner, unless `--steal` transfers it.
  await acquireEpicPlanLease({ provider, epicId, config, steal });

  await initializePlanState({ provider, epicId });

  await planEpic(
    epicId,
    provider,
    { prdContent, techSpecContent, acceptanceSpecContent },
    settings,
    {
      force,
      planningRisk,
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

  const reviewRouting = resolveReviewRouting({ planningRisk, forceReview });

  // Record the planner-authored verdict as a structured artifact — the
  // audit trail the retired regex classifier never produced (Epic #3865).
  await upsertStructuredComment(
    provider,
    epicId,
    'risk-verdict',
    buildRiskVerdictCommentBody({ epicId, riskVerdict, planningRisk }),
  );

  const currentState =
    (await readPlanState({ provider, epicId })) ??
    (await initializePlanState({ provider, epicId }));
  const checkpoint = await writePlanState({
    provider,
    epicId,
    state: {
      ...currentState,
      planningRisk,
      riskVerdict,
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
