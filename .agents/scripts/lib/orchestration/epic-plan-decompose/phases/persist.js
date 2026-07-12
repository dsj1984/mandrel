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
import { loadState, writeSpec } from '../../../spec/index.js';
import {
  assertNoOpenPlanChildren,
  releaseEpicPlanLease,
} from '../../epic-plan-lease-guard.js';
import { renderSpec } from '../../spec-renderer.js';
import { renderHardConflictError } from '../../ticket-validator-conflicts.js';
import {
  reconcileSubIssueLinks,
  setBlockedByDependencies,
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
 * @param {{ force?: boolean, resume?: boolean, allowOverBudget?: boolean, allowLargeFanOut?: boolean, fanOutCounter?: (arg: { path: string }) => number, spawnSync?: typeof defaultSpawnSync, reconcileCli?: string, writeSpecFn?: typeof writeSpec, renderSpecFn?: typeof renderSpec, loadStateFn?: typeof loadState, cwd?: string, runHealthcheckFn?: typeof defaultRunPlanHealthcheck, skipHealthcheck?: boolean }} [opts]
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
    allowLargeFanOut = false,
    fanOutCounter = undefined,
    spawnSync = defaultSpawnSync,
    reconcileCli = RECONCILE_CLI,
    writeSpecFn = writeSpec,
    renderSpecFn = renderSpec,
    loadStateFn = loadState,
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
  // Story #2962 — run cross-validation BEFORE the plan-state mutation so
  // the fan-out gate (and any future hard gate) can refuse persist
  // without leaving a half-initialised epic-plan-state behind.
  Logger.info(
    `[epic-plan-decompose] Running cross-validation on ${tickets.length} tickets...`,
  );
  const validated = validateTickets(tickets, config, { fanOutCounter, cwd });

  // Refuse to persist when any Task declares a deletion whose call-site
  // fan-out exceeds the configured threshold, unless the operator has
  // passed `--allow-large-fan-out`. The planner cannot reduce call sites
  // by re-prompting, so this gate sits at persist time (like
  // `--allow-over-budget`) rather than in the auto-redrive loop.
  enforceFanOutGate(validated.findings, allowLargeFanOut);

  // Story #3957 — surface soft cross-Story conflict findings on the
  // validator's warning channel. `failOnSharedEditors` defaults to `false`,
  // so a real shared-editor / implicit-dep hazard lands as `'soft'` and would
  // otherwise be invisible during the Phase-8 operator review. Logging each
  // soft finding here puts it in the same decompose output the operator reads
  // before approving the plan.
  surfaceSoftConflictFindings(validated.findings);

  // Workflow-guards (Story #3481): refuse to persist when the Epic already has
  // open Feature/Story children unless this is a deliberate re-decompose
  // (`--force` closes + recreates the tree; `--resume` continues a partial
  // persist). Sits immediately before the first plan-state mutation so a
  // refusal never leaves a half-initialised epic-plan-state behind.
  await assertNoOpenPlanChildren({
    provider,
    epicId,
    force: force || resume,
  });

  await seedPlanState(provider, epicId, epic);

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
  // Story #3905 — a `--force` re-plan with a changed ticket set produces
  // a plan carrying close ops for the dropped slugs. `epic-reconcile.js`
  // hard-exits 2 on close ops unless `--explicit-delete` is passed, so a
  // force re-decompose must thread the flag through or it fails *after*
  // the spec was already overwritten and plan-state flipped.
  const reconcile = spawnReconcilerApply({
    spawnSync,
    reconcileCli,
    epicId,
    cwd,
    explicitDelete: force,
  });

  // Sub-issue link safety net — Story #2063. The reconciler's apply path
  // opportunistically calls `addSubIssue` and swallows transient failures;
  // re-establish missing native links before flipping the Epic to ready.
  await reconcileSubIssueLinks(epicId, provider);

  // Story #4067 — translate `depends_on` edges into native GitHub "blocked
  // by" dependencies so maintainers see blocking relationships in the UI.
  // Best-effort and non-fatal: the reconciler has already written the state
  // file, so we load it here to get the authoritative slug→issueNumber map.
  const postReconcileState = loadStateFn(epicId);
  await setBlockedByDependencies(
    epicId,
    provider,
    spec,
    postReconcileState.mapping,
  );

  const checkpoint = await recordCheckpoint(provider, epicId, tickets);

  // Story #2921 (Epic #2880 F7) — `agent::ready` handoff gate. The
  // post-plan readiness healthcheck (`epic-plan-healthcheck.js`) is now
  // blocking: a failing healthcheck refuses the `agent::ready` flip
  // unless the operator has applied the `planning::healthcheck-waived`
  // label. See `.agents/docs/SDLC.md` § "`agent::ready` exit conditions" for
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

  const cleanup = await cleanupPhaseTempFiles({ phase: 'decompose', epicId });
  logCleanupSummary(cleanup, epicId, tickets.length);

  // Workflow-guards (Story #3481): release the Epic-lease now that Phase 8 has
  // persisted the plan. Best-effort — a release failure never fails decompose.
  await releaseEpicPlanLease({ provider, epicId, config });

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
export function enforceFanOutGate(
  findings,
  allowLargeFanOut,
  tag = 'epic-plan-decompose',
) {
  const fanOut = (findings ?? []).filter((f) => f.kind === 'fan-out-warning');
  if (fanOut.length === 0) return;
  if (allowLargeFanOut) {
    for (const f of fanOut) {
      Logger.warn(
        `[${tag}] Persisting a large-fan-out deletion: ` +
          `Task "${f.taskSlug}" deletes "${f.path}" with ${f.callSiteCount} ` +
          `call site(s) (threshold ${f.threshold}). Operator override --allow-large-fan-out.`,
      );
    }
    return;
  }
  const lines = fanOut
    .map(
      (f) =>
        `  - Task "${f.taskSlug}" (Story "${f.storySlug}") deletes "${f.path}" — ${f.callSiteCount} call site(s) (threshold ${f.threshold})`,
    )
    .join('\n');
  throw new Error(
    `[${tag}] ${fanOut.length} Task(s) declare large-fan-out deletions:\n${lines}\n\n` +
      `Split each deletion into a subsystem-by-subsystem migration across multiple Stories, ` +
      `or rerun --allow-large-fan-out after confirming the deletion is intentional.`,
  );
}

/**
 * Story #3957 — log every `'soft'` cross-Story conflict finding on the
 * validator's warning channel so it is visible during the Phase-8 operator
 * review even when its policy flag (e.g. `failOnSharedEditors`) is `false`
 * and the finding never reaches the AC-visible `errors[]` path.
 *
 * `fan-out-warning` findings are excluded: `enforceFanOutGate` already emits
 * a dedicated warn/throw line for those, and double-logging would be noise.
 * Hard findings are excluded too — they are already rendered into `errors[]`
 * and block the decompose, so they need no advisory echo here.
 *
 * Each line reuses `renderHardConflictError` for the message body (the
 * remediation hint is identical regardless of severity) under a `soft
 * conflict:` prefix so the operator can tell advisory findings apart from
 * blocking ones.
 *
 * @param {object[]} findings
 */
export function surfaceSoftConflictFindings(
  findings,
  tag = 'epic-plan-decompose',
) {
  const soft = (findings ?? []).filter(
    (f) => f?.severity === 'soft' && f?.kind !== 'fan-out-warning',
  );
  if (soft.length === 0) return;
  Logger.warn(
    `[${tag}] ${soft.length} soft cross-Story conflict finding(s) — review before approving the plan:`,
  );
  for (const finding of soft) {
    Logger.warn(`[${tag}] soft conflict: ${renderHardConflictError(finding)}`);
  }
}

export async function runHealthcheckGate({
  epicId,
  epic,
  runHealthcheckFn,
  tag = 'epic-plan-decompose',
}) {
  Logger.info(
    `[${tag}] Running post-plan readiness healthcheck for Epic #${epicId}...`,
  );
  let result;
  try {
    result = await runHealthcheckFn({ epicId });
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
      `[${tag}] Healthcheck failed for Epic #${epicId} but '${PLANNING_HEALTHCHECK_WAIVED}' is applied — proceeding with agent::ready handoff. Reason: ${result?.reason ?? '(no reason reported)'}`,
    );
    return { ok: false, waived: true, reason: result?.reason ?? null };
  }

  throw new Error(
    `[${tag}] Refusing agent::ready handoff for Epic #${epicId}: ` +
      `post-plan healthcheck failed (${result?.reason ?? '(no reason reported)'}). ` +
      `Resolve the failing check(s), or apply the '${PLANNING_HEALTHCHECK_WAIVED}' ` +
      `label to the Epic to override and rerun the persist phase.`,
  );
}
