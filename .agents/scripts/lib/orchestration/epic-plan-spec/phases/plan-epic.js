/**
 * phases/plan-epic.js — PRD / Tech Spec / Acceptance Spec persistence phase.
 *
 * Heals any prior planning artifacts (PRD / Tech Spec issues, "Planning
 * Artifacts" body section, lifecycle labels) before writing the new issues.
 * Idempotent against partial state: when the Epic already has a PRD but no
 * Tech Spec, the existing PRD is reused. Pass `force: true` to re-plan: the
 * canonical context tickets (PRD / Tech Spec / Acceptance Spec) are
 * **overwritten in place** — same issue numbers, refreshed bodies, kept open,
 * with a one-line regeneration audit comment on each. Only redundant
 * duplicate artifacts are closed; Feature/Story child tickets retain
 * close-and-recreate behaviour (handled by the decomposer, not here).
 */

import { Logger } from '../../../Logger.js';
import { ACCEPTANCE_NA } from '../../../label-constants.js';
import { PlanningStateManager } from '../../planning-state-manager.js';

/**
 * Resolve whether Phase 7 should persist an acceptance-spec ticket or apply
 * the `acceptance::n-a` waiver, from the planningRisk envelope derived off
 * the planner-authored risk verdict (`deriveRiskEnvelope`, Epic #3865).
 *
 * @param {import('../../planning-risk.js').PlanningRiskEnvelope|null} planningRisk
 *   Derived envelope; `null` (direct invocations without a verdict) never
 *   applies the waiver.
 * @param {string|null} acceptanceSpecContent
 * @returns {{ planningRisk: import('../../planning-risk.js').PlanningRiskEnvelope|null, wantsAcceptanceSpec: boolean, applyAcceptanceWaiver: boolean }}
 */
export function resolveAcceptancePersistence(
  planningRisk,
  acceptanceSpecContent,
) {
  const hasAcceptanceContent =
    typeof acceptanceSpecContent === 'string' &&
    acceptanceSpecContent.trim() !== '';

  if (planningRisk?.acceptanceDisposition === 'not-applicable') {
    return {
      planningRisk,
      wantsAcceptanceSpec: false,
      applyAcceptanceWaiver: true,
    };
  }

  return {
    planningRisk: planningRisk ?? null,
    wantsAcceptanceSpec: hasAcceptanceContent,
    applyAcceptanceWaiver: false,
  };
}

/**
 * Overwrite an existing context ticket (PRD / Tech Spec / Acceptance Spec)
 * in place: push the freshly-authored body and refresh the title prefix so a
 * clarity-gate Epic rename does not strand a stale spec title, then post a
 * single one-line regeneration audit comment so the preserved discussion
 * history stays self-explanatory.
 *
 * The ticket keeps its issue number, its sub-issue link to the Epic, and all
 * pre-existing comments — only the body, title, and a new audit comment are
 * added.
 *
 * @param {import('../../../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} ticketId           Existing context-ticket issue number.
 * @param {{ title: string, body: string, artifact: string }} fields
 *   `title` is the refreshed `[PRD] <epic title>`-style prefix; `body` is the
 *   regenerated content; `artifact` is the human label used in the audit
 *   comment (`PRD`, `Tech Spec`, `Acceptance Spec`).
 * @returns {Promise<void>}
 */
export async function overwriteContextTicket(
  provider,
  ticketId,
  { title, body, artifact },
) {
  await provider.updateTicket(ticketId, { title, body });
  try {
    await provider.postComment(ticketId, {
      type: 'notification',
      body: `♻️ **Regeneration Audit**: This ${artifact} body was regenerated in place by a \`/plan --force\` re-plan. The issue number and prior discussion history are preserved.`,
    });
  } catch (_err) {
    // Audit comment is best-effort — never fail the overwrite on a comment
    // post error.
  }
}

export function validatePlanEpicInputs({
  prdContent,
  techSpecContent,
  acceptanceSpecContent,
}) {
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
}

export function getExistingArtifactIds(epic) {
  return {
    prd: epic.linkedIssues?.prd ?? null,
    techSpec: epic.linkedIssues?.techSpec ?? null,
    acceptanceSpec: epic.linkedIssues?.acceptanceSpec ?? null,
  };
}

export function hasAllRequestedArtifacts({ existing, wantsAcceptanceSpec }) {
  return Boolean(
    existing.prd &&
      existing.techSpec &&
      (wantsAcceptanceSpec ? existing.acceptanceSpec : true),
  );
}

async function persistPrd({
  provider,
  epicId,
  epic,
  prdContent,
  existingId,
  force,
}) {
  if (existingId) {
    if (force) {
      Logger.info(
        `[Epic Planner] --force: Overwriting PRD #${existingId} in place.`,
      );
      await overwriteContextTicket(provider, existingId, {
        title: `[PRD] ${epic.title}`,
        body: prdContent,
        artifact: 'PRD',
      });
    } else {
      Logger.info(
        `[Epic Planner] Reusing existing PRD #${existingId}. Skipping PRD creation.`,
      );
    }
    return existingId;
  }

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
  return prdTicket.id;
}

async function persistTechSpec({
  provider,
  epicId,
  epic,
  techSpecContent,
  prdId,
  existingId,
  force,
}) {
  if (existingId) {
    if (force) {
      Logger.info(
        `[Epic Planner] --force: Overwriting Tech Spec #${existingId} in place.`,
      );
      await overwriteContextTicket(provider, existingId, {
        title: `[Tech Spec] ${epic.title}`,
        body: techSpecContent,
        artifact: 'Tech Spec',
      });
    } else {
      Logger.info(
        `[Epic Planner] Reusing existing Tech Spec #${existingId}. Skipping Tech Spec creation.`,
      );
    }
    return existingId;
  }

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
  return techSpecTicket.id;
}

async function persistAcceptanceSpec({
  provider,
  epicId,
  epic,
  acceptanceSpecContent,
  techSpecId,
  existingId,
  force,
}) {
  if (existingId) {
    if (force) {
      Logger.info(
        `[Epic Planner] --force: Overwriting Acceptance Spec #${existingId} in place.`,
      );
      await overwriteContextTicket(provider, existingId, {
        title: `[Acceptance Spec] ${epic.title}`,
        body: acceptanceSpecContent,
        artifact: 'Acceptance Spec',
      });
    } else {
      Logger.info(
        `[Epic Planner] Reusing existing Acceptance Spec #${existingId}. Skipping Acceptance Spec creation.`,
      );
    }
    return existingId;
  }

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
  return acceptanceTicket.id;
}

async function closeWaivedAcceptanceSpec({
  provider,
  epicId,
  epic,
  existingAcceptanceSpecId,
}) {
  Logger.info(
    `[Epic Planner] Acceptance disposition now waived — closing existing Acceptance Spec #${existingAcceptanceSpecId}.`,
  );
  try {
    await provider.updateTicket(existingAcceptanceSpecId, {
      state: 'closed',
      state_reason: 'not_planned',
    });
  } catch (err) {
    if (!err.message.includes('404') && !err.message.includes('410')) {
      throw err;
    }
  }
  try {
    await provider.removeSubIssue(epicId, existingAcceptanceSpecId);
  } catch (_err) {
    // Already detached or unsupported — safe to ignore.
  }
  if (epic.linkedIssues) epic.linkedIssues.acceptanceSpec = null;
}

/**
 * Persist the host-authored PRD and Tech Spec under the Epic.
 */
export async function planEpic(
  epicId,
  provider,
  { prdContent, techSpecContent, acceptanceSpecContent = null },
  _settings = {},
  { force = false, planningRisk = null } = {},
) {
  validatePlanEpicInputs({
    prdContent,
    techSpecContent,
    acceptanceSpecContent,
  });

  Logger.info(`[Epic Planner] Fetching Epic #${epicId}...`);
  const epic = await provider.getEpic(epicId);

  if (!epic) {
    throw new Error(`Epic #${epicId} not found.`);
  }

  const stateManager = new PlanningStateManager(provider);
  await stateManager.healAndCleanupArtifacts(epic, force);

  const { wantsAcceptanceSpec, applyAcceptanceWaiver } =
    resolveAcceptancePersistence(planningRisk, acceptanceSpecContent);

  Logger.info(
    `[Epic Planner] Acceptance disposition: ${planningRisk?.acceptanceDisposition ?? 'unspecified'}` +
      (applyAcceptanceWaiver
        ? ` — applying ${ACCEPTANCE_NA} waiver (no acceptance-spec ticket).`
        : wantsAcceptanceSpec
          ? ' — persisting context::acceptance-spec.'
          : ' — no acceptance-spec content supplied.'),
  );

  const existing = getExistingArtifactIds(epic);
  if (!force && hasAllRequestedArtifacts({ existing, wantsAcceptanceSpec })) {
    Logger.warn(
      `[Epic Planner] Epic #${epicId} already has all requested planning artifacts. Aborting to prevent duplicates. Use --force to re-plan.`,
    );
    return {
      persisted: false,
      reason: 'already-planned',
      prdId: existing.prd,
      techSpecId: existing.techSpec,
      acceptanceSpecId: existing.acceptanceSpec,
    };
  }
  // Under --force we now OVERWRITE the canonical context tickets in place
  // (same issue numbers, refreshed bodies) rather than closing + recreating
  // them. `healAndCleanupArtifacts(epic, force=true)` preserved the canonical
  // IDs on `epic.linkedIssues`, so reuse them in both the force and non-force
  // paths. The difference: under force we push the freshly-authored body via
  // `provider.updateTicket`, whereas the non-force partial-state reuse keeps
  // the existing body untouched.
  const prdId = await persistPrd({
    provider,
    epicId,
    epic,
    prdContent,
    existingId: existing.prd,
    force,
  });
  const techSpecId = await persistTechSpec({
    provider,
    epicId,
    epic,
    techSpecContent,
    prdId,
    existingId: existing.techSpec,
    force,
  });

  let acceptanceSpecId = null;
  if (wantsAcceptanceSpec) {
    acceptanceSpecId = await persistAcceptanceSpec({
      provider,
      epicId,
      epic,
      acceptanceSpecContent,
      techSpecId,
      existingId: existing.acceptanceSpec,
      force,
    });
  } else if (applyAcceptanceWaiver && existing.acceptanceSpec) {
    // Acceptance-spec transition: was present, now waived (acceptance::n-a).
    // This is a genuine close — there is no longer an acceptance spec to
    // overwrite — and the stale ticket must be detached so the Epic body's
    // Planning Artifacts section stops referencing it.
    await closeWaivedAcceptanceSpec({
      provider,
      epicId,
      epic,
      existingAcceptanceSpecId: existing.acceptanceSpec,
    });
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
  // Idempotent append (Story #4019): strip any pre-existing
  // `## Planning Artifacts` section before re-appending. The `--force`
  // path already stripped it in `healAndCleanupArtifacts`, but the
  // partial-recovery rerun (e.g. PRD present, Tech Spec missing) reaches
  // here with a body that may still carry a stale section — without the
  // strip, every rerun stacked a duplicate section onto the Epic body.
  const appendBody = `\n\n## Planning Artifacts\n${artifactLines.join('\n')}\n`;
  const strippedBody = epic.body.replace(
    /\n*## Planning Artifacts[\s\S]*$/,
    '',
  );
  const newBody = strippedBody + appendBody;

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

  return {
    persisted: true,
    reason: force ? 'force-replan' : 'persisted',
    prdId,
    techSpecId,
    acceptanceSpecId,
  };
}
