/**
 * phases/plan-epic.js — PRD / Tech Spec / Acceptance Spec persistence phase.
 *
 * Heals any prior planning artifacts (PRD / Tech Spec issues, "Planning
 * Artifacts" body section, lifecycle labels) before writing the new issues.
 * Idempotent against partial state: when the Epic already has a PRD but no
 * Tech Spec, the existing PRD is reused. Pass `force: true` to force a full
 * regeneration (close prior PRD/Tech Spec and re-create both).
 */

import { Logger } from '../../../Logger.js';
import { ACCEPTANCE_NA } from '../../../label-constants.js';
import { classifyPlanningRisk } from '../../planning-risk.js';
import { PlanningStateManager } from '../../planning-state-manager.js';

/**
 * Resolve whether Phase 7 should persist an acceptance-spec ticket or apply
 * the existing `acceptance::n-a` waiver from {@link classifyPlanningRisk}.
 *
 * @param {{ title?: string, body?: string, labels?: string[] }} epic
 * @param {string|null} acceptanceSpecContent
 * @returns {{ planningRisk: import('../../planning-risk.js').PlanningRiskEnvelope, wantsAcceptanceSpec: boolean, applyAcceptanceWaiver: boolean }}
 */
export function resolveAcceptancePersistence(epic, acceptanceSpecContent) {
  const planningRisk = classifyPlanningRisk({
    title: epic.title,
    body: epic.body ?? '',
    labels: epic.labels ?? [],
  });

  const hasAcceptanceContent =
    typeof acceptanceSpecContent === 'string' &&
    acceptanceSpecContent.trim() !== '';

  if (planningRisk.acceptanceDisposition === 'not-applicable') {
    return {
      planningRisk,
      wantsAcceptanceSpec: false,
      applyAcceptanceWaiver: true,
    };
  }

  return {
    planningRisk,
    wantsAcceptanceSpec: hasAcceptanceContent,
    applyAcceptanceWaiver: false,
  };
}

/**
 * Persist the host-authored PRD and Tech Spec under the Epic.
 */
export async function planEpic(
  epicId,
  provider,
  { prdContent, techSpecContent, acceptanceSpecContent = null },
  _settings = {},
  { force = false } = {},
) {
  if (typeof prdContent !== 'string' || prdContent.trim() === '') {
    throw new Error(
      '[Epic Planner] prdContent is required and must be non-empty.',
    );
  }
  if (typeof techSpecContent !== 'string' || techSpecContent.trim() === '') {
    throw new Error(
      '[Epic Planner] techSpecContent is required and must be non-empty.',
    );
  }
  if (
    acceptanceSpecContent !== null &&
    (typeof acceptanceSpecContent !== 'string' ||
      acceptanceSpecContent.trim() === '')
  ) {
    throw new Error(
      '[Epic Planner] acceptanceSpecContent, when provided, must be a non-empty string.',
    );
  }

  Logger.info(`[Epic Planner] Fetching Epic #${epicId}...`);
  const epic = await provider.getEpic(epicId);

  if (!epic) {
    throw new Error(`Epic #${epicId} not found.`);
  }

  const stateManager = new PlanningStateManager(provider);
  await stateManager.healAndCleanupArtifacts(epic, force);

  const { planningRisk, wantsAcceptanceSpec, applyAcceptanceWaiver } =
    resolveAcceptancePersistence(epic, acceptanceSpecContent);

  Logger.info(
    `[Epic Planner] Acceptance disposition: ${planningRisk.acceptanceDisposition}` +
      (applyAcceptanceWaiver
        ? ` — applying ${ACCEPTANCE_NA} waiver (no acceptance-spec ticket).`
        : wantsAcceptanceSpec
          ? ' — persisting context::acceptance-spec.'
          : ' — no acceptance-spec content supplied.'),
  );

  // M-8: Resumable planning — if all artifacts exist, abort to prevent dupes.
  const hasPrd = Boolean(epic.linkedIssues?.prd);
  const hasTechSpec = Boolean(epic.linkedIssues?.techSpec);
  const hasAcceptanceSpec = Boolean(epic.linkedIssues?.acceptanceSpec);
  const allLinked =
    hasPrd && hasTechSpec && (wantsAcceptanceSpec ? hasAcceptanceSpec : true);
  if (!force && allLinked) {
    Logger.warn(
      `[Epic Planner] Epic #${epicId} already has all requested planning artifacts. Aborting to prevent duplicates. Use --force to re-plan.`,
    );
    return;
  }
  const existingPrdId = force ? null : (epic.linkedIssues?.prd ?? null);
  const existingTechSpecId = force
    ? null
    : (epic.linkedIssues?.techSpec ?? null);
  const existingAcceptanceSpecId = force
    ? null
    : (epic.linkedIssues?.acceptanceSpec ?? null);

  let prdId;
  if (existingPrdId) {
    Logger.info(
      `[Epic Planner] Reusing existing PRD #${existingPrdId}. Skipping PRD creation.`,
    );
    prdId = existingPrdId;
  } else {
    Logger.info(`[Epic Planner] Creating PRD issue for "${epic.title}"...`);
    const prdTicket = await provider.createTicket(epicId, {
      title: `[PRD] ${epic.title}`,
      body: prdContent,
      labels: ['context::prd'],
      dependencies: [],
    });
    Logger.info(
      `[Epic Planner] Created PRD Issue #${prdTicket.id} (${prdTicket.url})`,
    );
    prdId = prdTicket.id;
  }

  let techSpecId;
  if (existingTechSpecId) {
    Logger.info(
      `[Epic Planner] Reusing existing Tech Spec #${existingTechSpecId}. Skipping Tech Spec creation.`,
    );
    techSpecId = existingTechSpecId;
  } else {
    Logger.info(
      `[Epic Planner] Creating Tech Spec issue linking to PRD #${prdId}...`,
    );
    const techSpecTicket = await provider.createTicket(epicId, {
      title: `[Tech Spec] ${epic.title}`,
      body: techSpecContent,
      labels: ['context::tech-spec'],
      dependencies: [prdId],
    });
    Logger.info(
      `[Epic Planner] Created Tech Spec Issue #${techSpecTicket.id} (${techSpecTicket.url})`,
    );
    techSpecId = techSpecTicket.id;
  }

  let acceptanceSpecId = null;
  if (wantsAcceptanceSpec) {
    if (existingAcceptanceSpecId) {
      Logger.info(
        `[Epic Planner] Reusing existing Acceptance Spec #${existingAcceptanceSpecId}. Skipping Acceptance Spec creation.`,
      );
      acceptanceSpecId = existingAcceptanceSpecId;
    } else {
      Logger.info(
        `[Epic Planner] Creating Acceptance Spec issue linking to Tech Spec #${techSpecId}...`,
      );
      const acceptanceTicket = await provider.createTicket(epicId, {
        title: `[Acceptance Spec] ${epic.title}`,
        body: acceptanceSpecContent,
        labels: ['context::acceptance-spec'],
        dependencies: [techSpecId],
      });
      Logger.info(
        `[Epic Planner] Created Acceptance Spec Issue #${acceptanceTicket.id} (${acceptanceTicket.url})`,
      );
      acceptanceSpecId = acceptanceTicket.id;
    }
  }

  Logger.info(
    `[Epic Planner] Updating Epic #${epicId} with linked documents...`,
  );

  // Format exactly so the issue-link-parser regexes still catch each line.
  // The parser is the source of truth for which prefixes are accepted; we
  // emit the canonical "PRD: #N" / "Tech Spec: #N" / "Acceptance Spec: #N"
  // shape so the epic-deliver finalize/cascade-close call shape and the
  // Phase 2 decomposer-context picker both see the third link.
  const artifactLines = [
    `- [ ] PRD: #${prdId}`,
    `- [ ] Tech Spec: #${techSpecId}`,
  ];
  if (acceptanceSpecId !== null) {
    artifactLines.push(`- [ ] Acceptance Spec: #${acceptanceSpecId}`);
  }
  const appendBody = `\n\n## Planning Artifacts\n${artifactLines.join('\n')}\n`;
  const newBody = epic.body + appendBody;

  /** @type {{ add?: string[], remove?: string[] }} */
  const labelMutations = {};
  if (applyAcceptanceWaiver) {
    labelMutations.add = [ACCEPTANCE_NA];
  } else if (
    wantsAcceptanceSpec &&
    (epic.labels ?? []).includes(ACCEPTANCE_NA)
  ) {
    labelMutations.remove = [ACCEPTANCE_NA];
  }

  await provider.updateTicket(epicId, {
    body: newBody,
    ...(labelMutations.add || labelMutations.remove
      ? { labels: labelMutations }
      : {}),
  });

  Logger.info(`[Epic Planner] Epic #${epicId} updated successfully.`);
  Logger.info(`[Epic Planner] Planning pipeline complete!`);
}
