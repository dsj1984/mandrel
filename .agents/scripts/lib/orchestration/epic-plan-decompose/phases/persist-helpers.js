/**
 * persist-helpers.js — pure helpers split out of `persist.js` so the
 * orchestrator stays under Story #2466's 200-LOC ceiling.
 *
 * Exports:
 *   - `assertDecomposeInputs(epic, epicId, tickets)` — entry guards.
 *   - `buildEpicSpecInput(epic, epicId)` — projection used by
 *     `renderSpec`; runs `ensurePlanningArtifacts` defensively so the
 *     spec body carries the `## Planning Artifacts` section the
 *     cascade-close path depends on.
 *   - `validateTickets(tickets, config)` — runs the cross-link / freshness
 *     normaliser and the task-body validator in one pass.
 *   - `seedPlanState(provider, epicId, epic)` — initialise + flip the
 *     `epic-plan-state` checkpoint to the decomposing phase.
 *   - `recordCheckpoint(provider, epicId, tickets)` — write the final
 *     `decompose.completedAt` + `ticketCount` checkpoint after apply.
 *   - `logCleanupSummary(cleanup, epicId, ticketCount)` — terminal log.
 *
 * @module lib/orchestration/epic-plan-decompose/phases/persist-helpers
 */

import { Logger } from '../../../Logger.js';
import { TYPE_LABELS } from '../../../label-constants.js';
import {
  initialize as initializePlanState,
  PLAN_PHASES,
  read as readPlanState,
  setPhase as setPlanPhase,
  write as writePlanState,
} from '../../epic-plan-state-store.js';
import { validateTaskBodies } from '../../task-body-validator.js';
import { validateAndNormalizeTickets } from '../../ticket-validator.js';
import {
  ensurePlanningArtifacts,
  resolveConflictPolicy,
} from './planning-artifacts.js';

export function assertDecomposeInputs(epic, epicId, tickets) {
  if (!epic) {
    throw new Error(`[epic-plan-decompose] Epic #${epicId} not found.`);
  }
  if (!epic.labels?.includes(TYPE_LABELS.EPIC)) {
    throw new Error(
      `[epic-plan-decompose] Ticket #${epicId} is not a ${TYPE_LABELS.EPIC}.`,
    );
  }
  if (!epic.linkedIssues?.prd || !epic.linkedIssues?.techSpec) {
    throw new Error(
      `[epic-plan-decompose] Epic #${epicId} is missing a linked PRD or Tech Spec. Run /epic-plan-spec first.`,
    );
  }
  if (!Array.isArray(tickets)) {
    throw new Error(
      `[epic-plan-decompose] tickets must be an array (got ${typeof tickets}).`,
    );
  }
}

export function buildEpicSpecInput(epic, epicId) {
  const epicBody = ensurePlanningArtifacts(epic.body ?? '', epic.linkedIssues);
  const epicSpecInput = { id: epicId, title: epic.title };
  if (epicBody.length > 0) epicSpecInput.body = epicBody;
  return epicSpecInput;
}

export function validateTickets(tickets, config) {
  const baseBranchRef = config?.baseBranch ?? 'main';
  const conflictPolicy = resolveConflictPolicy(config);
  const validated = validateAndNormalizeTickets(tickets, {
    baseBranchRef,
    conflictPolicy,
  });
  validateTaskBodies(validated);
  return validated;
}

export async function seedPlanState(provider, epicId, epic) {
  await initializePlanState({
    provider,
    epicId,
    seed: {
      spec: {
        prdId: epic.linkedIssues.prd,
        techSpecId: epic.linkedIssues.techSpec,
        completedAt: null,
      },
    },
  });
  await setPlanPhase({ provider, epicId, nextPhase: PLAN_PHASES.DECOMPOSING });
}

export async function recordCheckpoint(provider, epicId, tickets) {
  const currentState =
    (await readPlanState({ provider, epicId })) ??
    (await initializePlanState({ provider, epicId }));
  return writePlanState({
    provider,
    epicId,
    state: {
      ...currentState,
      decompose: {
        ...currentState.decompose,
        ticketCount: tickets.length,
        completedAt: new Date().toISOString(),
      },
    },
  });
}

export function logCleanupSummary(cleanup, epicId, ticketCount) {
  Logger.info(
    `[epic-plan-decompose] ✅ Decompose phase complete for Epic #${epicId}. ${ticketCount} ticket(s) persisted via reconciler.`,
  );
  if (cleanup.deleted.length > 0) {
    Logger.info(
      `[epic-plan-decompose] 🧹 Cleaned up ${cleanup.deleted.length} temp file(s).`,
    );
  }
}
