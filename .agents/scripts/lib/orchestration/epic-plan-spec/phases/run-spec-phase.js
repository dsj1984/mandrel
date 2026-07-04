/**
 * phases/run-spec-phase.js — orchestrator for Phase 7 (spec).
 *
 * Wires the planEpic persist phase, the Tech Spec freshness advisory, the
 * `agent::review-spec` label flip, the planning-state checkpoint upsert, and
 * the temp-file cleanup into a single sequential flow.
 */

import path from 'node:path';
import { verifyBddRunnerPendingTag } from '../../../bdd-runner-detect.js';
import { Logger } from '../../../Logger.js';
import { AGENT_LABELS, TYPE_LABELS } from '../../../label-constants.js';
import { cleanupPhaseTempFiles } from '../../../plan-phase-cleanup.js';
import { PROJECT_ROOT } from '../../../project-root.js';
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
  // Story #4145 — when the disposition was forced to not-applicable because
  // no BDD runner exists, make the waiver operator-visible in the rendered
  // comment (not just the fenced JSON record) so a reviewer sees why an
  // otherwise-required AC table was waived.
  const waiverNote = planningRisk.acceptanceWaivedReason
    ? ['', `> ⚠️ **Acceptance waived** — ${planningRisk.acceptanceWaivedReason}`]
    : [];
  return [
    `### 🧭 Planning Risk Verdict — ${planningRisk.overallLevel} · ${planningRisk.gateDecision}`,
    '',
    riskVerdict.summary,
    '',
    ...axisTable,
    ...waiverNote,
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
 * @param {{ techSpecContent: string, acceptanceSpecContent?: string|null }} artifacts
 * @param {object} settings
 * @param {{ force?: boolean, forceReview?: boolean, steal?: boolean, config?: object, riskVerdict?: import('../../planning-risk.js').RiskVerdict }} [opts]
 * @returns {Promise<{ epicId: number, techSpecPersisted: boolean, acceptanceTable: 'persisted'|'waived'|'none', checkpoint: object, planningRisk: import('../../planning-risk.js').PlanningRiskEnvelope, reviewRouting: import('../../plan-review-routing.js').ReviewRoutingEnvelope }>}
 */
export async function runSpecPhase(
  epicId,
  provider,
  { techSpecContent, acceptanceSpecContent = null },
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

  // Story #4145 — probe the project's BDD runner. When none is detected
  // (`fallback === true`, e.g. a node:test repo with no tests/features/**),
  // the acceptance disposition is forced to not-applicable inside
  // deriveRiskEnvelope: an authored AC table could never be reconciled by
  // `@epic-<id>-ac-*` feature tags, so /deliver finalize would otherwise
  // abort and require a manual `acceptance::n-a`. The probe is static and
  // best-effort — a detection failure degrades to "runner present" (no
  // forced waiver), preserving the BDD-repo path, and never blocks Phase 7.
  let bddRunner = null;
  try {
    bddRunner = await verifyBddRunnerPendingTag({ cwd: PROJECT_ROOT });
  } catch (err) {
    Logger.warn(
      `[epic-plan-spec] BDD runner probe skipped (${err.message}); acceptance disposition derived from risk axes only.`,
    );
  }
  const planningRisk = deriveRiskEnvelope(riskVerdict, { bddRunner });
  if (planningRisk.acceptanceWaivedReason) {
    Logger.info(
      `[epic-plan-spec] Acceptance disposition forced to not-applicable for Epic #${epicId}: ${planningRisk.acceptanceWaivedReason}`,
    );
  }

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
  // mutation so two concurrent /plan runs cannot both drive this Epic. The
  // guard fails closed (audit #3513) — any foreign assignee refuses here and
  // the CLI exits non-zero naming the owner, unless `--steal` transfers it.
  await acquireEpicPlanLease({ provider, epicId, config, steal });

  await initializePlanState({ provider, epicId });

  const planResult = await planEpic(
    epicId,
    provider,
    { techSpecContent, acceptanceSpecContent },
    settings,
    {
      force,
      planningRisk,
    },
  );
  const specChanged = planResult?.persisted !== false;

  const afterPlan = await provider.getEpic(epicId);

  // Story #2635 — cross-validate the authored Tech Spec body against the
  // base branch and surface any stale path-shaped references. Story #4324:
  // with the Tech Spec folded into the Epic body, the advisory comment
  // lands on the Epic itself. Non-blocking: a missing base ref, an
  // unreadable temp directory, or a provider failure downgrades to a
  // warning so Phase 7 never fails on the advisory check.
  const baseBranchRef = settings?.baseBranch ?? 'main';
  const tempRoot = path.resolve(
    PROJECT_ROOT,
    settings?.paths?.tempRoot ?? 'temp',
  );
  const freshness = await runSpecFreshnessCheck({
    epicId,
    techSpecContent,
    baseBranchRef,
    tempRoot,
    provider,
  });

  // Story #1585 (Epic #1471): the baseline-snapshot fork was previously
  // performed here at plan-time. It now runs at first-story-init time
  // inside `lib/story-init/branch-initializer.js#bootstrapWorktree` so
  // `/plan` remains git-state-free. `forkAndCommitEpicSnapshot` and
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
        techSpecPersisted: planResult?.techSpecPersisted === true,
        acceptanceTable: planResult?.acceptanceTable ?? 'none',
        completedAt: new Date().toISOString(),
      },
    },
  });

  Logger.info(`[epic-plan-spec] Review routing: ${reviewRouting.decision}.`);
  Logger.info(`[epic-plan-spec] ${reviewRouting.operatorMessage}`);

  // Story #4019 (refining #3905): a spec-phase rerun that changed nothing
  // (planEpic short-circuited on `already-planned`) MUST NOT demote a
  // fully-decomposed `agent::ready` Epic back to `agent::review-spec` —
  // there is no new spec content to review. The demotion fires only when
  // the spec actually persisted/changed, or when the Epic is not at
  // `agent::ready` (where the flip is the normal forward transition).
  const epicLabels = afterPlan.labels ?? [];
  const skipDemotion = !specChanged && epicLabels.includes(AGENT_LABELS.READY);
  let labelTransition;
  if (skipDemotion) {
    labelTransition = 'kept-ready';
    Logger.info(
      `[epic-plan-spec] Spec unchanged (${planResult?.reason ?? 'already-planned'}) and Epic #${epicId} is ${AGENT_LABELS.READY} — keeping ${AGENT_LABELS.READY} (no demotion to ${AGENT_LABELS.REVIEW_SPEC}).`,
    );
  } else {
    labelTransition = 'review-spec';
    Logger.info(
      `[epic-plan-spec] Flipping Epic #${epicId} to ${AGENT_LABELS.REVIEW_SPEC}...`,
    );
    await setEpicLabel(provider, epicId, AGENT_LABELS.REVIEW_SPEC);
  }

  const cleanup = await cleanupPhaseTempFiles({ phase: 'spec', epicId });

  const acceptanceSummary =
    planResult?.acceptanceTable === 'persisted'
      ? ' + ## Acceptance Table section'
      : planResult?.acceptanceTable === 'waived'
        ? ' (acceptance waived)'
        : '';
  const freshnessSummary =
    freshness.stale > 0 || freshness.ambiguous > 0
      ? ` ⚠️ Spec freshness: ${freshness.stale} stale / ${freshness.ambiguous} ambiguous reference(s) — see ${freshness.reportPath ?? 'report'}.`
      : '';
  Logger.info(
    `[epic-plan-spec] ✅ Spec phase complete for Epic #${epicId}. Tech Spec sections folded into the Epic body${acceptanceSummary}.${freshnessSummary}`,
  );
  if (cleanup.deleted.length > 0) {
    Logger.info(
      `[epic-plan-spec] 🧹 Cleaned up ${cleanup.deleted.length} temp file(s).`,
    );
  }

  return {
    epicId,
    techSpecPersisted: planResult?.techSpecPersisted === true,
    acceptanceTable: planResult?.acceptanceTable ?? 'none',
    checkpoint,
    cleanup,
    freshness,
    planningRisk,
    reviewRouting,
    specChanged,
    labelTransition,
  };
}
