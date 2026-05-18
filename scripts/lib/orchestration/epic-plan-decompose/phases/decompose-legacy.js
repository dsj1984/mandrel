/**
 * decompose-legacy.js — legacy direct-create flow split out of
 * `creation.js` for Story #2466's 200-LOC ceiling.
 *
 * Owns `decomposeEpic(...)`, the pre-reconciler direct-create path that
 * `tests/ticket-decomposer.test.js` still exercises. The reconciler-based
 * persist flow used by `/epic-plan` lives in `persist.js`.
 *
 * @module lib/orchestration/epic-plan-decompose/phases/decompose-legacy
 */

import { DEFAULT_DECOMPOSER } from '../../../config/runners.js';
import { getLimits, getRunners } from '../../../config-resolver.js';
import { Logger } from '../../../Logger.js';
import { validateTaskBodies } from '../../task-body-validator.js';
import { validateAndNormalizeTickets } from '../../ticket-validator.js';
import {
  assertEpicHasPlanningArtifacts,
  reconcileSubIssueLinks,
  resolveChildIndex,
  runStagedPasses,
  warnTicketCapNearLimit,
} from './creation.js';
import { orderTicketsForCreation } from './dag.js';
import { resolveConflictPolicy } from './planning-artifacts.js';

function assertNoCrossTypeCollisions(validated, childIndex) {
  const collisions = [];
  for (const t of validated) {
    const existingEntry = childIndex.get(t.title);
    if (existingEntry && existingEntry.type !== t.type) {
      collisions.push(
        `  - "${t.title}": planned ${t.type.toUpperCase()} but #${existingEntry.id} is a ${existingEntry.type.toUpperCase()}`,
      );
    }
  }
  if (collisions.length > 0) {
    throw new Error(
      `[Decomposer] Title collision across ticket types — refusing to auto-link:\n${collisions.join('\n')}\n\nRename the planned tickets or close the existing issues, then re-run.`,
    );
  }
}

function assertDecomposeArgs(tickets, force, resume) {
  if (!Array.isArray(tickets)) {
    throw new Error(
      `[Decomposer] tickets must be an array (got ${typeof tickets}).`,
    );
  }
  if (force && resume) {
    throw new Error(
      '[Decomposer] --force and --resume are mutually exclusive.',
    );
  }
}

/**
 * Legacy `decomposeEpic` flow — retained so `tests/ticket-decomposer.test.js`
 * keeps passing. The reconciler-based persist path is the canonical flow
 * used by `/epic-plan` today.
 */
export async function decomposeEpic(
  epicId,
  provider,
  { tickets },
  _config = {},
  { force = false, resume = false } = {},
) {
  assertDecomposeArgs(tickets, force, resume);
  Logger.info(`[Decomposer] Fetching Epic #${epicId}...`);
  const epic = await provider.getEpic(epicId);
  assertEpicHasPlanningArtifacts(epic, epicId);
  const childIndex = await resolveChildIndex({
    force,
    resume,
    provider,
    epicId,
  });
  warnTicketCapNearLimit(tickets, getLimits(_config).maxTickets, 'Decomposer');

  Logger.info(
    `[Decomposer] Running cross-validation on ${tickets.length} tickets...`,
  );
  const baseBranchRef = _config?.baseBranch ?? 'main';
  const conflictPolicy = resolveConflictPolicy(_config);
  const validated = validateAndNormalizeTickets(tickets, {
    baseBranchRef,
    conflictPolicy,
  });
  validateTaskBodies(validated);
  assertNoCrossTypeCollisions(validated, childIndex);

  const configuredCap =
    getRunners(_config).decomposer.concurrencyCap ??
    DEFAULT_DECOMPOSER.concurrencyCap;
  Logger.info(
    `[Decomposer] Identified ${validated.length} tickets. Starting creation (concurrencyCap=${configuredCap}${childIndex.size > 0 ? `, existing=${childIndex.size}` : ''})...`,
  );
  const slugMap = new Map();
  const ordered = orderTicketsForCreation(validated);
  await runStagedPasses({
    ordered,
    slugMap,
    epicId,
    provider,
    childIndex,
    configuredCap,
  });
  await reconcileSubIssueLinks(epicId, provider);
  Logger.info(
    `[Decomposer] Backlog for Epic #${epicId} populated successfully!`,
  );
}
