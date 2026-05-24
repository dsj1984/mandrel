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

import { runPlanHealthcheck as defaultRunPlanHealthcheck } from '../../../../epic-plan-healthcheck.js';
import { getLimits, PROJECT_ROOT } from '../../../config-resolver.js';
import { Logger } from '../../../Logger.js';
import {
  AGENT_LABELS,
  PLANNING_HEALTHCHECK_WAIVED,
} from '../../../label-constants.js';
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
 * @param {{ force?: boolean, resume?: boolean, allowOverBudget?: boolean, spawnSync?: typeof defaultSpawnSync, reconcileCli?: string, writeSpecFn?: typeof writeSpec, renderSpecFn?: typeof renderSpec, cwd?: string, runHealthcheckFn?: typeof defaultRunPlanHealthcheck, skipHealthcheck?: boolean }} [opts]
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
    runHealthcheckFn = defaultRunPlanHealthcheck,
    skipHealthcheck = false,
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

  // Story #2921 (Epic #2880 F7) — `agent::ready` handoff gate. The
  // post-plan readiness healthcheck (`epic-plan-healthcheck.js`) is now
  // blocking: a failing healthcheck refuses the `agent::ready` flip
  // unless the operator has applied the `planning::healthcheck-waived`
  // label. See `.agents/SDLC.md` § "`agent::ready` exit conditions" for
  // the full contract. Tests inject `skipHealthcheck: true` to bypass
  // the network-bound check; production callers must not set this.
  const healthcheck = skipHealthcheck
    ? { ok: true, skipped: true }
    : await runHealthcheckGate({
        epicId,
        epic,
        runHealthcheckFn,
      });

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
    healthcheck,
  };
}

/**
 * Run the post-plan readiness healthcheck and enforce the
 * `agent::ready` handoff gate. Returns the healthcheck result on
 * success (either `ok: true` or `ok: false` with the waiver label
 * applied). Throws when the healthcheck failed and the operator has
 * not applied `planning::healthcheck-waived` to the Epic.
 *
 * Extracted from `runDecomposePhase` so the gate is a single named
 * code path the contract tests can target.
 *
 * @param {object} args
 * @param {number} args.epicId
 * @param {{ labels?: string[] }} args.epic
 * @param {typeof defaultRunPlanHealthcheck} args.runHealthcheckFn
 * @returns {Promise<{ ok: boolean, waived?: boolean, reason?: string|null }>}
 */
async function runHealthcheckGate({ epicId, epic, runHealthcheckFn }) {
  Logger.info(
    `[epic-plan-decompose] Running post-plan readiness healthcheck for Epic #${epicId}...`,
  );
  let result;
  try {
    result = await runHealthcheckFn({ epicId, fast: true });
  } catch (err) {
    // A throwing healthcheck is itself a failure — surface it as the
    // gate reason rather than letting the throw propagate raw, so the
    // operator sees a uniform "handoff refused" diagnostic.
    result = { ok: false, reason: `healthcheck threw: ${err.message}` };
  }

  if (result?.ok) {
    return { ok: true };
  }

  const labels = Array.isArray(epic?.labels) ? epic.labels : [];
  const waived = labels.includes(PLANNING_HEALTHCHECK_WAIVED);
  if (waived) {
    Logger.warn(
      `[epic-plan-decompose] Healthcheck failed for Epic #${epicId} but '${PLANNING_HEALTHCHECK_WAIVED}' is applied — proceeding with agent::ready handoff. Reason: ${result?.reason ?? '(no reason reported)'}`,
    );
    return { ok: false, waived: true, reason: result?.reason ?? null };
  }

  throw new Error(
    `[epic-plan-decompose] Refusing agent::ready handoff for Epic #${epicId}: ` +
      `post-plan healthcheck failed (${result?.reason ?? '(no reason reported)'}). ` +
      `Resolve the failing check(s), or apply the '${PLANNING_HEALTHCHECK_WAIVED}' ` +
      `label to the Epic to override and rerun the persist phase.`,
  );
}
