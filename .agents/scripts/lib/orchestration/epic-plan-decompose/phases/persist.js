/**
 * persist.js — Phase 5 of the epic-plan-decompose pipeline (Story #2466).
 *
 * Owns the reconciler-based persist flow:
 *   1. validate + normalise the ticket array
 *   2. render the structural spec
 *   3. write the YAML spec under `.agents/epics/<epicId>.yaml`
 *   4. spawn `epic-reconcile.js --apply --yes`
 *   5. run the sub-issue link safety net
 *   6. update the `epic-plan-state` checkpoint
 *   7. flip the Epic to `agent::ready`
 *   8. clean up phase temp files
 *
 * Pure helpers (input guards, spec input projection, validation, state
 * seed/checkpoint, cleanup logging) live in the sibling
 * `persist-helpers.js` module so this orchestrator stays under Story
 * #2466's 200-LOC ceiling.
 *
 * @module lib/orchestration/epic-plan-decompose/phases/persist
 */

import { spawnSync as defaultSpawnSync } from 'node:child_process';

import { getLimits, PROJECT_ROOT } from '../../../config-resolver.js';
import { Logger } from '../../../Logger.js';
import { AGENT_LABELS } from '../../../label-constants.js';
import { cleanupPhaseTempFiles } from '../../../plan-phase-cleanup.js';
import { writeSpec } from '../../../spec/index.js';
import {
  PLAN_PHASES,
  setPhase as setPlanPhase,
} from '../../epic-plan-state-store.js';
import { renderSpec } from '../../spec-renderer.js';
import {
  reconcileSubIssueLinks,
  setEpicLabel,
  warnTicketCapNearLimit,
} from './creation.js';
import {
  assertDecomposeInputs,
  buildEpicSpecInput,
  logCleanupSummary,
  recordCheckpoint,
  seedPlanState,
  validateTickets,
} from './persist-helpers.js';
import { RECONCILE_CLI, spawnReconcilerApply } from './reconcile-spawn.js';

/**
 * Execute the decompose phase end to end. See module-doc for the 8-step
 * flow.
 *
 * @param {number} epicId
 * @param {import('../../../ITicketingProvider.js').ITicketingProvider} provider
 * @param {{ tickets: Array<object> }} payload
 * @param {object} config
 * @param {{ force?: boolean, resume?: boolean, allowOverBudget?: boolean, spawnSync?: typeof defaultSpawnSync, reconcileCli?: string, writeSpecFn?: typeof writeSpec, renderSpecFn?: typeof renderSpec, cwd?: string }} [opts]
 */
export async function runDecomposePhase(
  epicId,
  provider,
  { tickets },
  config = {},
  {
    force = false,
    resume = false,
    allowOverBudget = false,
    spawnSync = defaultSpawnSync,
    reconcileCli = RECONCILE_CLI,
    writeSpecFn = writeSpec,
    renderSpecFn = renderSpec,
    cwd = PROJECT_ROOT,
  } = {},
) {
  if (force && resume) {
    throw new Error(
      '[epic-plan-decompose] --force and --resume are mutually exclusive.',
    );
  }
  const epic = await provider.getEpic(epicId);
  assertDecomposeInputs(epic, epicId, tickets);
  const maxTickets = getLimits(config).maxTickets;
  // Story #2798 — `maxTickets` is a reviewability budget. Over-budget
  // persistence requires an explicit `--allow-over-budget` override so
  // an accidental over-budget plan does not silently land.
  if (tickets.length > maxTickets && !allowOverBudget) {
    throw new Error(
      `[epic-plan-decompose] Tickets (${tickets.length}) exceed the reviewability budget (${maxTickets}). ` +
        `Re-scope the Epic into a smaller plan, or rerun with --allow-over-budget after confirming the over-budget rationale on the Epic.`,
    );
  }
  warnTicketCapNearLimit(tickets, maxTickets);
  if (tickets.length > maxTickets && allowOverBudget) {
    Logger.warn(
      `[epic-plan-decompose] Persisting an over-budget decomposition: ${tickets.length} tickets vs. budget ${maxTickets} (operator override --allow-over-budget).`,
    );
  }
  await seedPlanState(provider, epicId, epic);

  Logger.info(
    `[epic-plan-decompose] Running cross-validation on ${tickets.length} tickets...`,
  );
  const validated = validateTickets(tickets, config);

  Logger.info(
    `[epic-plan-decompose] Rendering spec for Epic #${epicId} (${validated.length} tickets)...`,
  );
  const spec = renderSpecFn(validated, {
    epic: buildEpicSpecInput(epic, epicId),
  });
  const specFilePath = writeSpecFn(epicId, spec, { epicsDir: undefined });
  Logger.info(`[epic-plan-decompose] Wrote spec → ${specFilePath}`);

  Logger.info(
    `[epic-plan-decompose] Spawning epic-reconcile.js --apply --yes for Epic #${epicId}...`,
  );
  const reconcile = spawnReconcilerApply({
    spawnSync,
    reconcileCli,
    epicId,
    cwd,
  });

  // Sub-issue link safety net — Story #2063. The reconciler's apply path
  // opportunistically calls `addSubIssue` and swallows transient failures;
  // re-establish missing native links before flipping the Epic to ready.
  await reconcileSubIssueLinks(epicId, provider);

  const checkpoint = await recordCheckpoint(provider, epicId, tickets);
  Logger.info(
    `[epic-plan-decompose] Flipping Epic #${epicId} to ${AGENT_LABELS.READY}...`,
  );
  await setEpicLabel(provider, epicId, AGENT_LABELS.READY);
  await setPlanPhase({ provider, epicId, nextPhase: PLAN_PHASES.READY });

  const cleanup = await cleanupPhaseTempFiles({ phase: 'decompose', epicId });
  logCleanupSummary(cleanup, epicId, tickets.length);
  return {
    epicId,
    ticketCount: tickets.length,
    checkpoint,
    cleanup,
    reconcile,
    specPath: specFilePath,
  };
}
