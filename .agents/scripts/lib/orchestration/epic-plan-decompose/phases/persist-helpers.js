/**
 * persist-helpers.js — pure helpers split out of `persist.js` so the
 * orchestrator stays under Story #2466's 200-LOC ceiling.
 *
 * Exports:
 *   - `assertDecomposeInputs(epic, epicId, tickets)` — entry guards.
 *   - `buildEpicSpecInput(epic, epicId)` — projection used by
 *     `renderSpec`; the Epic body already carries the folded planning
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

import { hasTechSpecContent } from '../../../epic-body-sections.js';
import { gitSpawn } from '../../../git-utils.js';
import { Logger } from '../../../Logger.js';
import { TYPE_LABELS } from '../../../label-constants.js';
import {
  initialize as initializePlanState,
  read as readPlanState,
  write as writePlanState,
} from '../../epic-plan-state-store.js';
import { validateTaskBodies } from '../../task-body-validator.js';
import { validateAndNormalizeTickets } from '../../ticket-validator.js';
import { resolveConflictPolicy } from './planning-artifacts.js';

export function assertDecomposeInputs(epic, epicId, tickets) {
  if (!epic) {
    throw new Error(`[epic-plan-decompose] Epic #${epicId} not found.`);
  }
  if (!epic.labels?.includes(TYPE_LABELS.EPIC)) {
    throw new Error(
      `[epic-plan-decompose] Ticket #${epicId} is not a ${TYPE_LABELS.EPIC}.`,
    );
  }
  if (!hasTechSpecContent(epic.body ?? '')) {
    throw new Error(
      `[epic-plan-decompose] Epic #${epicId} body carries no Tech Spec sections (no ## Delivery Slicing). Run /plan Phase 7 first.`,
    );
  }
  if (!Array.isArray(tickets)) {
    throw new Error(
      `[epic-plan-decompose] tickets must be an array (got ${typeof tickets}).`,
    );
  }
}

export function buildEpicSpecInput(epic, epicId) {
  const epicBody = epic.body ?? '';
  const epicSpecInput = { id: epicId, title: epic.title };
  if (epicBody.length > 0) epicSpecInput.body = epicBody;
  return epicSpecInput;
}

/**
 * Default fan-out counter — counts distinct files at `baseBranchRef` that
 * reference the basename (without extension) of the deleted path. Uses
 * `git grep -l` for a streaming-friendly probe; an empty grep returns
 * exit code 1 which we map to a count of 0.
 *
 * Story #2962. Injected via opts in tests; this default runs in production.
 */
export function makeDefaultFanOutCounter({ baseBranchRef, cwd }) {
  return ({ path }) => {
    const lastSlash = path.lastIndexOf('/');
    const base = lastSlash === -1 ? path : path.slice(lastSlash + 1);
    const dotIdx = base.lastIndexOf('.');
    const stem = dotIdx > 0 ? base.slice(0, dotIdx) : base;
    if (stem.length < 3) return 0;
    const result = gitSpawn(
      cwd ?? process.cwd(),
      'grep',
      '-l',
      '--fixed-strings',
      stem,
      baseBranchRef,
    );
    if (result.status !== 0) return 0;
    const lines = result.stdout.split('\n').filter((l) => l.trim().length > 0);
    // Exclude the deleted file itself from the call-site count.
    return lines.filter((l) => !l.endsWith(`:${path}`)).length;
  };
}

export function validateTickets(tickets, config, opts = {}) {
  const baseBranchRef = config?.baseBranch ?? 'main';
  const conflictPolicy = resolveConflictPolicy(config);
  if (typeof opts.fanOutCounter === 'function') {
    conflictPolicy.fanOutCounter = opts.fanOutCounter;
  } else if (!conflictPolicy.fanOutCounter) {
    conflictPolicy.fanOutCounter = makeDefaultFanOutCounter({
      baseBranchRef,
      cwd: opts.cwd,
    });
  }
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
        techSpecPersisted: hasTechSpecContent(epic.body ?? ''),
        completedAt: null,
      },
    },
  });
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
