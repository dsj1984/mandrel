/**
 * phases/plan-epic.js — Tech Spec / Acceptance Table persistence phase.
 *
 * Story #4324: the `context::tech-spec` / `context::acceptance-spec` ticket
 * classes are retired. The Epic body is the single planning document: this
 * phase upserts the authored Tech Spec (opening with `## Delivery Slicing`)
 * and the Acceptance Spec's AC-ID table (`## Acceptance Table`) as
 * marker-delimited managed sections of the Epic body — see
 * `lib/epic-body-sections.js`. Each write is **section-scoped**: only the
 * managed region is replaced; the rest of the body is byte-preserved.
 *
 * Idempotent against partial state: when the Epic body already carries all
 * requested sections, the phase short-circuits with `already-planned`.
 * Pass `force: true` to re-plan: the managed sections are overwritten in
 * place and a one-line regeneration audit comment lands on the Epic.
 *
 * The retired machine-managed `## Planning Artifacts` checklist (which
 * linked the old context tickets) is stripped on every persist so a
 * re-planned historical Epic stops advertising stale ticket links; the
 * legacy tickets themselves are ignored (forward-only cutover — no
 * backfill, no fetch).
 */

import {
  hasEpicSection,
  stripEpicSection,
  stripPlanningArtifactsSection,
  upsertEpicSection,
} from '../../../epic-body-sections.js';
import { Logger } from '../../../Logger.js';
import { ACCEPTANCE_NA } from '../../../label-constants.js';

/**
 * Resolve whether Phase 7 should persist an acceptance-table section or
 * apply the `acceptance::n-a` waiver, from the planningRisk envelope derived
 * off the planner-authored risk verdict (`deriveRiskEnvelope`, Epic #3865).
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

export function validatePlanEpicInputs({
  techSpecContent,
  acceptanceSpecContent,
}) {
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

/**
 * Snapshot which managed planning sections the Epic body already carries.
 *
 * @param {{ body?: string }} epic
 * @returns {{ techSpec: boolean, acceptanceTable: boolean }}
 */
export function getExistingSections(epic) {
  const body = epic?.body ?? '';
  return {
    techSpec: hasEpicSection(body, 'techSpec'),
    acceptanceTable: hasEpicSection(body, 'acceptanceTable'),
  };
}

export function hasAllRequestedSections({ existing, wantsAcceptanceSpec }) {
  return Boolean(
    existing.techSpec &&
      (wantsAcceptanceSpec ? existing.acceptanceTable : true),
  );
}

/**
 * Persist the host-authored Tech Spec (and optional Acceptance Table) as
 * managed sections of the Epic body.
 *
 * @returns {Promise<{
 *   persisted: boolean,
 *   reason: 'already-planned'|'persisted'|'force-replan',
 *   techSpecPersisted: boolean,
 *   acceptanceTable: 'persisted'|'waived'|'none',
 * }>}
 */
export async function planEpic(
  epicId,
  provider,
  { techSpecContent, acceptanceSpecContent = null },
  _settings = {},
  { force = false, planningRisk = null } = {},
) {
  validatePlanEpicInputs({
    techSpecContent,
    acceptanceSpecContent,
  });

  Logger.info(`[Epic Planner] Fetching Epic #${epicId}...`);
  const epic = await provider.getEpic(epicId);

  if (!epic) {
    throw new Error(`Epic #${epicId} not found.`);
  }

  const { wantsAcceptanceSpec, applyAcceptanceWaiver } =
    resolveAcceptancePersistence(planningRisk, acceptanceSpecContent);

  Logger.info(
    `[Epic Planner] Acceptance disposition: ${planningRisk?.acceptanceDisposition ?? 'unspecified'}` +
      (applyAcceptanceWaiver
        ? ` — applying ${ACCEPTANCE_NA} waiver (no acceptance-table section).`
        : wantsAcceptanceSpec
          ? ' — persisting the ## Acceptance Table section.'
          : ' — no acceptance-spec content supplied.'),
  );

  const existing = getExistingSections(epic);
  if (!force && hasAllRequestedSections({ existing, wantsAcceptanceSpec })) {
    Logger.warn(
      `[Epic Planner] Epic #${epicId} body already carries all requested planning sections. Aborting to prevent an unintended overwrite. Use --force to re-plan.`,
    );
    return {
      persisted: false,
      reason: 'already-planned',
      techSpecPersisted: existing.techSpec,
      acceptanceTable: existing.acceptanceTable ? 'persisted' : 'none',
    };
  }

  // Section-scoped writes: each upsert replaces only its own managed
  // region; the ideation sections and any operator-authored prose are
  // byte-preserved. The retired `## Planning Artifacts` checklist is
  // stripped so re-planned historical Epics stop advertising the old
  // context-ticket links (the legacy tickets themselves are ignored).
  let newBody = stripPlanningArtifactsSection(epic.body ?? '');
  newBody = upsertEpicSection(newBody, 'techSpec', techSpecContent);

  let acceptanceTable = 'none';
  if (wantsAcceptanceSpec) {
    newBody = upsertEpicSection(
      newBody,
      'acceptanceTable',
      acceptanceSpecContent,
    );
    acceptanceTable = 'persisted';
  } else if (applyAcceptanceWaiver) {
    // Acceptance transition: was present, now waived (acceptance::n-a).
    // Strip the stale table so the close-time reconciler cannot read a
    // section the planner no longer stands behind.
    if (existing.acceptanceTable) {
      Logger.info(
        `[Epic Planner] Acceptance disposition now waived — removing the stale ## Acceptance Table section from Epic #${epicId}.`,
      );
      newBody = stripEpicSection(newBody, 'acceptanceTable');
    }
    acceptanceTable = 'waived';
  }

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

  Logger.info(
    `[Epic Planner] Updating Epic #${epicId} body with the planning sections...`,
  );
  await provider.updateTicket(epicId, {
    body: newBody,
    ...(labelMutations.add || labelMutations.remove
      ? { labels: labelMutations }
      : {}),
  });

  if (force) {
    // Preserve the regeneration audit trail the retired per-ticket
    // overwrite used to leave. Best-effort — never fail the persist on a
    // comment post error.
    try {
      await provider.postComment(epicId, {
        type: 'notification',
        body: '♻️ **Regeneration Audit**: the Tech Spec / Acceptance Table sections of this Epic body were regenerated in place by a `/plan --force` re-plan. Content outside the managed sections was preserved.',
      });
    } catch (_err) {
      // Swallow: audit comment is advisory.
    }
  }

  Logger.info(`[Epic Planner] Epic #${epicId} updated successfully.`);
  Logger.info(`[Epic Planner] Planning pipeline complete!`);

  return {
    persisted: true,
    reason: force ? 'force-replan' : 'persisted',
    techSpecPersisted: true,
    acceptanceTable,
  };
}
