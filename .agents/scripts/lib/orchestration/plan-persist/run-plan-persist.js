/**
 * run-plan-persist.js — single GitHub-write surface for the /plan collapse
 * (Epic #4474, PR3 + PR4 modes).
 *
 * Implements the ordered, fail-closed superset persist that replaced the
 * retired 12-phase pipeline's separate persist halves
 * (design §1 Step 3 + §2 mode matrix, issue #4474):
 *
 *    1. args (owned by the `plan-persist.js` CLI shell)
 *    2. section gate — `validateSpecSections` runs BEFORE the lease and
 *       BEFORE any provider call; a rejection makes zero GitHub calls.
 *    3. risk-verdict validation (CLI-owned `loadRiskVerdict`) +
 *       mode-coherence hard error (`resolveDeliveryMode`): fan-out requires
 *       tickets; `deliveryShape: "single"` refuses any tickets payload —
 *       the single mode's validator/DAG skip is fenced by construction,
 *       unreachable when tickets are present; `--amend` requires tickets
 *       carrying `op` fields and refuses the single shape.
 *    4. ticket validator + file-assumption gate + DAG + sizing + budget
 *       (fan-out and amend; amend validates the MERGED set — existing
 *       keeps + adds + modifies, closes excluded; all git-local, still
 *       zero provider calls). Skipped entirely in single mode (no tickets
 *       exist to validate).
 *    4.5. deterministic draft reachability (Epic #4474 PR6, design §4 —
 *       the 8.4 critic demoted into persist): route-glob scan of the
 *       draft set vs `planning.navigation.navRegistry`, mirroring the
 *       `--paranoid` F7 healthcheck mechanics. Orphan surfaces are a
 *       NAMED SOFT FAILURE (`code: PLAN_REACHABILITY_ORPHANS`, CLI exit
 *       3) raised before any provider call — the author appends the
 *       single reachability Story in one targeted amend and re-runs the
 *       persist once. Silent no-op when `planning.navigation` is
 *       unconfigured; skip decisions are appended to the plan-metrics
 *       ledger (`kind: critic-skip`) for audit.
 *    5. ideation fold — `renderEpicBody` / `openEpicFromOnePager` create
 *       the Epic when the run starts from a one-pager (the first provider
 *       call of the run). Amend additionally resolves every
 *       modify/keep/close slug to its live issue and enforces the close-op
 *       confirmation gate (exit 2 without `--explicit-delete`) BEFORE the
 *       lease and before any mutation.
 *    6. Epic lease (KEEP — documented double-create at ~80 creations).
 *       From here the lease is released on EVERY exit path (success, gate
 *       failure, throw) via try/finally.
 *    7. managed Tech Spec / Acceptance Table sections + risk-verdict
 *       structured comment + spec-freshness advisory.
 *    8. mode-split mutation:
 *       - fan-out: story creation via the structural reconciler
 *         (idempotent per-slug creation; the reconciler's state file is
 *         the per-slug resume ledger), bracketed by checkpoint-v2 writes
 *         so a rate-limit crash resumes losslessly with `--resume`;
 *       - single: NO story tree — the `delivery::single` routing marker is
 *         applied instead (inert until #4475 lands the deliver-side
 *         reader), and `decompose = { ticketCount: 0, shape: "single" }`
 *         is checkpointed so delivery-time consumers never misread absence
 *         as unplanned;
 *       - amend: op-mapped delta — close ops close, modify ops
 *         close-and-recreate, add ops create, keep ops are untouched by
 *         construction; the state ledger and blocked-by edges are rebuilt
 *         over the merged set.
 *    9. inline post-plan healthcheck (the `agent::ready` exit condition,
 *       Story #2921).
 *   10. single terminal `agent::ready` flip — the intermediate
 *       `agent::review-spec` flip is retired on this surface (its readers
 *       were visibility-only; the /deliver start gate needs only
 *       `agent::ready`).
 *   11. checkpoint v2 + single `plan-summary` comment carrying the dry-run
 *       wave table as closing text (replaces the Phase 9 dispatcher
 *       round-trip and the Phase 12 notify). The single-mode summary
 *       records `{ deliveryShape: "single", sliceCount, routingReasons }`.
 *   12. temp cleanup ONLY at terminal success — a failed run leaves
 *       techspec/acceptance/risk-verdict/tickets artifacts on disk so a
 *       `--force`/`--resume` re-persist reuses them (fixes the
 *       `plan-phase-cleanup.js` mid-pipeline deletion defect).
 *
 * Checkpoint v2: same `epic-plan-state` structured comment, `version: 2`,
 * with the `planningRisk` / `riskVerdict` / `reviewRouting` / `spec` /
 * `decompose` fields byte-compatible with v1 so the four delivery-time
 * consumers — `lib/orchestration/code-review.js` (review depth),
 * `epic-audit-prepare.js` (audit-lens routing),
 * `story-close/phases/locked-pipeline.js` (parent-risk inheritance), and
 * the decompose context reader — read it without modification. The only
 * additions are the `version` bump and the additive `persist` progress
 * block; consumers key on field presence, never on `version`.
 *
 * @module lib/orchestration/plan-persist/run-plan-persist
 */

import { spawnSync as defaultSpawnSync } from 'node:child_process';
import path from 'node:path';

import { runPlanHealthcheck as defaultRunPlanHealthcheck } from '../../../epic-plan-healthcheck.js';
import { verifyBddRunnerPendingTag } from '../../bdd-runner-detect.js';
import { getLimits, PROJECT_ROOT } from '../../config-resolver.js';
import { openEpicFromOnePager } from '../../epic-plan-ideation.js';
import { gitSpawn } from '../../git-utils.js';
import { Logger } from '../../Logger.js';
import {
  AGENT_LABELS,
  DELIVERY_LABELS,
  TYPE_LABELS,
} from '../../label-constants.js';
import { cleanupPhaseTempFiles } from '../../plan-phase-cleanup.js';
import { loadState, writeSpec, writeState } from '../../spec/index.js';
import {
  reconcileSubIssueLinks,
  setBlockedByDependencies,
  setEpicLabel,
  warnTicketCapNearLimit,
} from '../epic-plan-decompose/phases/creation.js';
import {
  enforceFanOutGate,
  runHealthcheckGate,
  surfaceSoftConflictFindings,
} from '../epic-plan-decompose/phases/persist.js';
import {
  buildEpicSpecInput,
  validateTickets,
} from '../epic-plan-decompose/phases/persist-helpers.js';
import {
  RECONCILE_CLI,
  spawnReconcilerApply,
} from '../epic-plan-decompose/phases/reconcile-spawn.js';
import {
  acquireEpicPlanLease,
  assertNoOpenPlanChildren,
  releaseEpicPlanLease,
} from '../epic-plan-lease-guard.js';
import { planEpic } from '../epic-plan-spec/phases/plan-epic.js';
import { runSpecFreshnessCheck } from '../epic-plan-spec/phases/spec-freshness.js';
import {
  initialize as initializePlanState,
  read as readPlanState,
  write as writePlanState,
} from '../epic-plan-state-store.js';
import {
  appendCriticSkip,
  readPlanMetrics,
  renderPlanMetricsSummaryLine,
  summarizePlanMetrics,
} from '../plan-metrics.js';
import {
  evaluateDraftReachability,
  renderReachabilityOrphans,
} from '../plan-reachability.js';
import { resolveReviewRouting } from '../plan-review-routing.js';
import { deriveRiskEnvelope } from '../planning-risk.js';
import { renderSpec } from '../spec-renderer.js';
import {
  formatMissingSectionMessage,
  validateSpecSections,
} from '../spec-section-validator.js';
import { upsertStructuredComment } from '../ticketing.js';
import {
  applyAmendOps,
  buildMergedTicketSet,
  enforceAmendCloseGate,
  partitionAmendTickets,
  renderAmendPlanDiff,
  resolveAmendTargets,
} from './amend.js';
import { countDeliverySlices, resolveDeliveryMode } from './delivery-mode.js';
import {
  buildPlanSummaryCommentBody,
  buildWaveTable,
  PLAN_SUMMARY_COMMENT_TYPE,
} from './summary.js';

/** Checkpoint schema version written by this surface. */
export const PLAN_CHECKPOINT_SCHEMA_VERSION_V2 = 2;

// Mode-coherence resolution (design §1 Step 3 item 3 + §2 mode matrix)
// lives in `delivery-mode.js`; re-exported here so the CLI's stable public
// API keeps a single import root for the persist surface.
export { resolveDeliveryMode };

/**
 * Merge-write the epic-plan-state checkpoint at schema v2. Reads the
 * current checkpoint (or initializes a fresh skeleton), shallow-merges
 * `patch`, and stamps `version: 2`. Field shapes for `planningRisk`,
 * `riskVerdict`, `reviewRouting`, `spec`, and `decompose` are byte-compatible
 * with v1 — v2 is additive only.
 *
 * @param {object} provider
 * @param {number} epicId
 * @param {object} patch
 * @returns {Promise<object>} the written checkpoint payload
 */
export async function writeCheckpointV2(provider, epicId, patch) {
  const current =
    (await readPlanState({ provider, epicId })) ??
    (await initializePlanState({ provider, epicId }));
  // One-level deep merge for object-valued blocks (`spec`, `decompose`,
  // `persist`, …) so a partial patch (e.g. `persist: { completedAt }`)
  // refines rather than replaces the block — same discipline the v1
  // writers applied by hand with `...currentState.decompose`.
  const merged = { ...current };
  for (const [key, value] of Object.entries(patch ?? {})) {
    const existing = merged[key];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      merged[key] = { ...existing, ...value };
    } else {
      merged[key] = value;
    }
  }
  return writePlanState({
    provider,
    epicId,
    state: {
      ...merged,
      version: PLAN_CHECKPOINT_SCHEMA_VERSION_V2,
    },
  });
}

/**
 * Resolve (or create) the Epic this persist run targets.
 *
 * Ideation mode (`onePagerContent` present): folds the former Phase 3/4
 * ideation steps in — `openEpicFromOnePager` renders the Epic body from the
 * one-pager via the canonical template and opens the Issue with the
 * `type::epic` label. This is deliberately the FIRST provider call of the
 * run (after every deterministic gate), so a gate rejection never leaves an
 * orphaned Epic behind.
 *
 * Existing-Epic mode: fetches and type-asserts the Epic.
 *
 * @returns {Promise<{ epicId: number, epic: object, created: boolean }>}
 */
async function resolveTargetEpic({
  epicId,
  onePagerContent,
  templateContent,
  provider,
}) {
  if (onePagerContent) {
    if (typeof provider.createIssue !== 'function') {
      throw new Error(
        '[plan-persist] provider does not expose createIssue; cannot open ' +
          'an Epic from a one-pager.',
      );
    }
    const created = await openEpicFromOnePager({
      onePager: onePagerContent,
      template: templateContent,
      createIssue: (payload) => provider.createIssue(payload),
    });
    Logger.info(
      `[plan-persist] Opened Epic #${created.id} from one-pager ("${created.title}").`,
    );
    const epic = await provider.getEpic(created.id);
    if (!epic) {
      throw new Error(
        `[plan-persist] Epic #${created.id} was created but could not be re-fetched.`,
      );
    }
    return { epicId: created.id, epic, created: true };
  }

  const epic = await provider.getEpic(epicId);
  if (!epic) {
    throw new Error(`[plan-persist] Epic #${epicId} not found.`);
  }
  if (!epic.labels?.includes(TYPE_LABELS.EPIC)) {
    throw new Error(
      `[plan-persist] Ticket #${epicId} is not a ${TYPE_LABELS.EPIC}.`,
    );
  }
  return { epicId, epic, created: false };
}

/**
 * Execute the collapsed persist end to end (module doc has the 12-step
 * order). Modes: fan-out (default), single (`deliveryShape: "single"`),
 * amend (`--amend`).
 *
 * @param {{
 *   epicId?: number|null,
 *   provider: import('../../ITicketingProvider.js').ITicketingProvider,
 *   artifacts: {
 *     techSpecContent: string,
 *     acceptanceSpecContent?: string|null,
 *     riskVerdict: import('../planning-risk.js').RiskVerdict,
 *     tickets?: Array<object>|null,
 *     onePagerContent?: string|null,
 *     templateContent?: string|null,
 *   },
 *   config?: object,
 *   settings?: { baseBranch?: string, paths?: { tempRoot?: string } },
 *   opts?: {
 *     force?: boolean,
 *     resume?: boolean,
 *     amend?: boolean,
 *     explicitDelete?: boolean,
 *     steal?: boolean,
 *     forceReview?: boolean,
 *     allowOverBudget?: boolean,
 *     allowLargeFanOut?: boolean,
 *     // test seams (production callers must not set these)
 *     skipHealthcheck?: boolean,
 *     skipCleanup?: boolean,
 *     spawnSync?: typeof defaultSpawnSync,
 *     reconcileCli?: string,
 *     writeSpecFn?: typeof writeSpec,
 *     renderSpecFn?: typeof renderSpec,
 *     loadStateFn?: typeof loadState,
 *     writeStateFn?: typeof writeState,
 *     runHealthcheckFn?: typeof defaultRunPlanHealthcheck,
 *     bddProbeFn?: typeof verifyBddRunnerPendingTag,
 *     fanOutCounter?: (arg: { path: string }) => number,
 *     cwd?: string,
 *   },
 * }} input
 */
export async function runPlanPersist({
  epicId: requestedEpicId = null,
  provider,
  artifacts,
  config = {},
  settings = {},
  opts = {},
}) {
  const {
    techSpecContent,
    acceptanceSpecContent = null,
    riskVerdict,
    tickets = null,
    onePagerContent = null,
    templateContent = null,
  } = artifacts ?? {};
  const {
    force = false,
    resume = false,
    amend = false,
    explicitDelete = false,
    steal = false,
    forceReview = false,
    allowOverBudget = false,
    allowLargeFanOut = false,
    skipHealthcheck = false,
    skipCleanup = false,
    spawnSync = defaultSpawnSync,
    reconcileCli = RECONCILE_CLI,
    writeSpecFn = writeSpec,
    renderSpecFn = renderSpec,
    loadStateFn = loadState,
    writeStateFn = writeState,
    runHealthcheckFn = defaultRunPlanHealthcheck,
    bddProbeFn = verifyBddRunnerPendingTag,
    fanOutCounter = undefined,
    cwd = PROJECT_ROOT,
  } = opts;

  // ---- Step 1: argument coherence (flag parsing itself is CLI-owned). ----
  if (force && resume) {
    throw new Error(
      '[plan-persist] --force and --resume are mutually exclusive.',
    );
  }
  if (amend && (force || resume)) {
    throw new Error(
      '[plan-persist] --amend is mutually exclusive with --force/--resume ' +
        '— the amend delta is already an incremental re-persist.',
    );
  }
  if (amend && onePagerContent) {
    throw new Error(
      '[plan-persist] --amend requires --epic <id> — there is no existing ' +
        'plan to amend in ideation mode.',
    );
  }
  if (onePagerContent && resume) {
    throw new Error(
      '[plan-persist] --resume requires --epic <id> — the Epic already ' +
        "exists after the first attempt (its number is in the failed run's " +
        'output); an ideation --resume would open a duplicate.',
    );
  }
  if (onePagerContent && !templateContent) {
    throw new Error(
      '[plan-persist] ideation mode requires the epic-from-idea template ' +
        'content (templateContent).',
    );
  }
  if (!onePagerContent && !Number.isInteger(requestedEpicId)) {
    throw new Error(
      '[plan-persist] either --epic <id> or --one-pager <path> is required.',
    );
  }

  // ---- Step 2: section gate — BEFORE the lease, BEFORE any provider call.
  // A rejection here has made zero GitHub calls (locked in by the
  // fail-closed-ordering test).
  const sectionCheck = validateSpecSections({ body: techSpecContent });
  if (!sectionCheck.ok) {
    throw new Error(
      formatMissingSectionMessage({
        techspecPath: 'authored Tech Spec (--tech-spec)',
        missing: sectionCheck.missing,
      }),
    );
  }

  // ---- Step 3: risk-verdict presence (schema validation is CLI-owned via
  // loadRiskVerdict) + mode-coherence hard error. ----
  if (!riskVerdict || !Array.isArray(riskVerdict.axes)) {
    throw new Error(
      '[plan-persist] risk verdict is required — author risk-verdict.json ' +
        'and pass it with --risk-verdict.',
    );
  }
  const mode = resolveDeliveryMode(riskVerdict, tickets, { amend });

  // ---- Step 4: ticket validator + file-assumption gate + DAG + sizing +
  // budget (fan-out and amend; git-local — still no provider call). In
  // amend mode every gate runs over the MERGED set — keeps + adds +
  // modifies, closes excluded — so the DAG is validated against the tree
  // that will actually exist post-amend. The skip branch below is fenced
  // by construction: `resolveDeliveryMode` hard-refuses `deliveryShape:
  // "single"` with any tickets payload, so single mode can only reach here
  // with no tickets to validate. ----
  let validated = null;
  let amendPartition = null;
  let reachability = null;
  if (mode !== 'single') {
    amendPartition = mode === 'amend' ? partitionAmendTickets(tickets) : null;
    const gateSet = mode === 'amend' ? buildMergedTicketSet(tickets) : tickets;
    const maxTickets = getLimits(config).maxTickets;
    if (gateSet.length > maxTickets && !allowOverBudget) {
      throw new Error(
        `[plan-persist] Tickets (${gateSet.length}) exceed the reviewability ` +
          `budget (${maxTickets}). Re-scope the Epic into a smaller plan, or ` +
          'rerun with --allow-over-budget after confirming the over-budget ' +
          'rationale on the Epic.',
      );
    }
    warnTicketCapNearLimit(gateSet, maxTickets, 'plan-persist');
    if (gateSet.length > maxTickets && allowOverBudget) {
      Logger.warn(
        `[plan-persist] Persisting an over-budget decomposition: ${gateSet.length} ` +
          `tickets vs. budget ${maxTickets} (operator override --allow-over-budget).`,
      );
    }
    Logger.info(
      `[plan-persist] Running cross-validation on ${gateSet.length} tickets` +
        `${mode === 'amend' ? ' (merged amend set)' : ''}...`,
    );
    validated = validateTickets(gateSet, config, { fanOutCounter, cwd });
    enforceFanOutGate(validated.findings, allowLargeFanOut, 'plan-persist');
    surfaceSoftConflictFindings(validated.findings, 'plan-persist');

    // File-assumption gate (#4474 PR7 — coverage regression fix). The
    // validator batches per-Story `{ path, assumption }` mismatches against
    // the base branch onto `validated.errors`; the retired 12-phase flow
    // gated that channel in the workflow's re-prompt loop, so the collapsed
    // CLI must gate it here or the check is silently advisory. Fan-out and
    // shared-editor findings keep their own policy channels above — this
    // rejects only the deterministic assumption mismatches, still before
    // any provider call. Guarded on ref resolvability: in a checkout where
    // the base branch ref does not resolve (shallow CI fetches, detached
    // test sandboxes) every path probes "absent" and the findings are
    // noise, so they downgrade to warnings instead of hard-failing.
    const assumptionFailures = (validated.errors ?? []).filter((e) =>
      e.startsWith('File assumption mismatch:'),
    );
    if (assumptionFailures.length > 0) {
      const gateBaseRef = config?.baseBranch ?? 'main';
      const refResolves =
        gitSpawn(
          cwd ?? process.cwd(),
          'rev-parse',
          '--verify',
          '--quiet',
          `${gateBaseRef}^{commit}`,
        ).status === 0;
      if (refResolves) {
        throw new Error(
          `[plan-persist] file-assumption gate: ${assumptionFailures.length} ` +
            `mismatch(es) between declared assumptions and the base branch:\n` +
            `${assumptionFailures.map((e) => `  - ${e}`).join('\n')}\n` +
            'Fix the Story change declarations (or the plan) and re-run the persist.',
        );
      }
      Logger.warn(
        `[plan-persist] file-assumption gate skipped: base ref '${gateBaseRef}' ` +
          `does not resolve in this checkout — ${assumptionFailures.length} ` +
          'finding(s) downgraded to warnings.',
      );
      for (const e of assumptionFailures) {
        Logger.warn(`[plan-persist] ${e}`);
      }
    }

    // ---- Step 4.5: deterministic draft reachability (#4474 PR6 — the 8.4
    // critic demoted into persist). Still git-local, zero provider calls,
    // so the one-targeted-amend recovery re-runs a clean persist. ----
    reachability = evaluateDraftReachability({ tickets: gateSet, config });
    if (reachability.status === 'orphans') {
      const err = new Error(renderReachabilityOrphans(reachability));
      err.code = 'PLAN_REACHABILITY_ORPHANS';
      err.orphans = reachability.orphans;
      throw err;
    }
    Logger.info(`[plan-persist] reachability: ${reachability.reasons[0]}`);
  } else {
    reachability = {
      status: 'skipped',
      reasons: [
        'single-delivery shape — no draft story tree to scan for orphan surfaces.',
      ],
      orphans: [],
      scanned: 0,
    };
  }
  if (reachability.status === 'skipped') {
    // Audit trail for the skip decision (#4474 PR6). Best-effort by
    // contract — a failed append never fails the persist. Logged before
    // the first provider call so even an ideation run that later fails
    // still records the decision (ideation has no Epic id yet, so the
    // record lands on the standalone stream).
    await appendCriticSkip(
      {
        critic: 'reachability',
        reasons: reachability.reasons,
        cli: 'plan-persist',
        epicId: requestedEpicId,
      },
      config,
    );
  }

  // ---- Step 5: ideation fold / Epic resolution (first provider call). ----
  const { epicId, epic, created } = await resolveTargetEpic({
    epicId: requestedEpicId,
    onePagerContent,
    templateContent,
    provider,
  });

  // Amend pre-mutation resolution: every modify/keep/close slug must
  // resolve to a live issue, and close ops require --explicit-delete
  // (exit 2 with the dry-run diff otherwise — the epic-reconcile.js
  // contract). Runs BEFORE the lease and before any mutation.
  let amendTargets = null;
  if (mode === 'amend') {
    const priorState = loadStateFn(epicId);
    amendTargets = await resolveAmendTargets({
      partition: amendPartition,
      stateMapping: priorState.mapping,
      provider,
    });
    enforceAmendCloseGate({
      epicId,
      targets: amendTargets,
      adds: amendPartition.add,
      explicitDelete,
    });
    Logger.info(
      renderAmendPlanDiff({
        epicId,
        targets: amendTargets,
        adds: amendPartition.add,
      }),
    );
  }

  // ---- Step 6: Epic lease. Every path after a successful acquire runs
  // through the finally below, so the lease is released on success, on a
  // gate failure, and on a throw alike. ----
  await acquireEpicPlanLease({ provider, epicId, config, steal });

  try {
    // Refuse a duplicate story tree unless this is a deliberate re-persist
    // (`--force` closes + recreates via the reconciler's close ops;
    // `--resume` continues a partial persist). Amend is exempt by
    // definition — its whole purpose is mutating the existing open tree.
    if (mode !== 'amend') {
      await assertNoOpenPlanChildren({
        provider,
        epicId,
        force: force || resume,
      });
    }

    await initializePlanState({ provider, epicId });

    // ---- Step 7: managed sections + risk comment + freshness advisory. ----
    // BDD-runner probe (Story #4145): best-effort; a probe failure degrades
    // to "runner present" and never blocks the persist.
    let bddRunner = null;
    try {
      bddRunner = await bddProbeFn({ cwd: PROJECT_ROOT });
    } catch (err) {
      Logger.warn(
        `[plan-persist] BDD runner probe skipped (${err.message}); ` +
          'acceptance disposition derived from risk axes only.',
      );
    }
    const planningRisk = deriveRiskEnvelope(riskVerdict, { bddRunner });
    if (planningRisk.acceptanceWaivedReason) {
      Logger.info(
        `[plan-persist] Acceptance disposition forced to not-applicable for ` +
          `Epic #${epicId}: ${planningRisk.acceptanceWaivedReason}`,
      );
    }

    // Amend always overwrites the managed sections — the amended Tech Spec
    // IS the delta's spec half (planEpic would otherwise short-circuit
    // `already-planned` on the pre-amend sections).
    const planResult = await planEpic(
      epicId,
      provider,
      { techSpecContent, acceptanceSpecContent },
      settings,
      { force: force || mode === 'amend', planningRisk },
    );

    const reviewRouting = resolveReviewRouting({ planningRisk, forceReview });
    Logger.info(`[plan-persist] Review routing: ${reviewRouting.decision}.`);

    await upsertStructuredComment(
      provider,
      epicId,
      'risk-verdict',
      buildRiskVerdictCommentBody({ epicId, riskVerdict, planningRisk }),
    );

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

    // Spec-half checkpoint (v2). A crash after this point resumes with the
    // sections already folded (planEpic short-circuits `already-planned`).
    await writeCheckpointV2(provider, epicId, {
      planningRisk,
      riskVerdict,
      reviewRouting: {
        decision: reviewRouting.decision,
        requiresStop: reviewRouting.requiresStop,
        forceReviewApplied: reviewRouting.forceReviewApplied,
      },
      spec: {
        techSpecPersisted:
          planResult?.techSpecPersisted === true ||
          planResult?.reason === 'already-planned',
        acceptanceTable: planResult?.acceptanceTable ?? 'none',
        completedAt: new Date().toISOString(),
      },
      persist: {
        mode,
        cli: 'plan-persist',
        startedAt: new Date().toISOString(),
        completedAt: null,
      },
    });

    // ---- Step 8: mode-split mutation. ----
    let reconcile = null;
    let specFilePath = null;
    let ticketCount = 0;
    let single = null;
    let amendSummary = null;

    if (mode === 'fan-out') {
      // Story creation via the structural reconciler.
      Logger.info(
        `[plan-persist] Rendering spec for Epic #${epicId} (${validated.length} tickets)...`,
      );
      const spec = renderSpecFn(validated, {
        epic: buildEpicSpecInput(epic, epicId),
      });
      specFilePath = writeSpecFn(epicId, spec, { epicsDir: undefined });
      Logger.info(`[plan-persist] Wrote spec → ${specFilePath}`);

      // Pre-creation checkpoint: marks creation in flight so a rate-limit
      // crash mid-creation leaves a checkpoint pointing at the spec + the
      // reconciler's per-slug state file (the resume ledger). `--resume`
      // re-runs the reconciler, which creates only the missing slugs.
      await writeCheckpointV2(provider, epicId, {
        decompose: { ticketCount: null, completedAt: null },
      });

      Logger.info(
        `[plan-persist] Spawning epic-reconcile.js --apply --yes for Epic #${epicId}...`,
      );
      reconcile = spawnReconcilerApply({
        spawnSync,
        reconcileCli,
        epicId,
        cwd,
        explicitDelete: force,
      });

      await reconcileSubIssueLinks(epicId, provider);

      const postReconcileState = loadStateFn(epicId);
      await setBlockedByDependencies(
        epicId,
        provider,
        spec,
        postReconcileState.mapping,
      );

      ticketCount = tickets.length;
      // Post-creation checkpoint (the former recordCheckpoint half).
      await writeCheckpointV2(provider, epicId, {
        decompose: {
          ticketCount,
          shape: 'fan-out',
          completedAt: new Date().toISOString(),
        },
      });

      // A force re-persist over a former single-delivery plan flips the
      // routing shape — drop the stale marker so #4475's reader never sees
      // a fan-out tree labelled single.
      await removeSingleDeliveryMarker(provider, epicId, epic);
    } else if (mode === 'single') {
      // Single-delivery: NO story tree. The delivery::single routing
      // marker (inert until #4475's deliver-side reader) plus the Delivery
      // Slicing table of the persisted Tech Spec are the plan.
      single = {
        deliveryShape: 'single',
        sliceCount: countDeliverySlices(techSpecContent),
        routingReasons: riskVerdict.deliveryShapeRationale
          ? [riskVerdict.deliveryShapeRationale]
          : [],
      };
      Logger.info(
        `[plan-persist] Single-delivery mode: applying ${DELIVERY_LABELS.SINGLE} ` +
          `to Epic #${epicId} (no story tree).`,
      );
      await provider.updateTicket(epicId, {
        labels: { add: [DELIVERY_LABELS.SINGLE], remove: [] },
      });
      // Explicit zero-ticket checkpoint so delivery-time consumers read a
      // deliberate single-shape plan, never an unplanned absence.
      await writeCheckpointV2(provider, epicId, {
        decompose: {
          ticketCount: 0,
          shape: 'single',
          completedAt: new Date().toISOString(),
        },
      });
    } else {
      // Amend delta: close-and-recreate is scoped to modify/close slugs
      // only; keeps are untouched by construction (no code path receives
      // them); adds are created fresh. The state ledger and blocked-by
      // edges are rebuilt over the merged set.
      const spec = renderSpecFn(validated, {
        epic: buildEpicSpecInput(epic, epicId),
      });
      specFilePath = writeSpecFn(epicId, spec, { epicsDir: undefined });
      Logger.info(`[plan-persist] Wrote amended spec → ${specFilePath}`);

      await writeCheckpointV2(provider, epicId, {
        decompose: { ticketCount: null, completedAt: null },
      });

      const validatedBySlug = new Map(validated.map((t) => [t.slug, t]));
      const applied = await applyAmendOps({
        epicId,
        provider,
        targets: amendTargets,
        validatedBySlug,
      });

      // Rebuild the state ledger over the merged set: prior mapping minus
      // closed/replaced slugs, plus the fresh create/recreate numbers.
      const priorState = loadStateFn(epicId);
      const mergedMapping = { ...(priorState.mapping ?? {}) };
      for (const slug of applied.closedSlugs) delete mergedMapping[slug];
      Object.assign(mergedMapping, applied.mapping);
      writeStateFn(epicId, {
        epicId,
        mapping: mergedMapping,
        lastReconciledAt: new Date().toISOString(),
      });

      await reconcileSubIssueLinks(epicId, provider);
      await setBlockedByDependencies(epicId, provider, spec, mergedMapping);

      ticketCount = validated.length;
      amendSummary = {
        closed: applied.closed,
        recreated: applied.recreated,
        created: applied.created,
        keptCount: amendTargets.keep.length,
      };
      await writeCheckpointV2(provider, epicId, {
        decompose: {
          ticketCount,
          shape: 'fan-out',
          completedAt: new Date().toISOString(),
        },
      });

      // An amended plan is fan-out-shaped; drop a stale single marker.
      await removeSingleDeliveryMarker(provider, epicId, epic);
    }

    // ---- Step 9: inline healthcheck — the agent::ready exit condition. ----
    const healthcheck = skipHealthcheck
      ? { ok: true, skipped: true }
      : await runHealthcheckGate({
          epicId,
          epic,
          runHealthcheckFn,
          tag: 'plan-persist',
        });

    // ---- Step 10: single terminal agent::ready flip. This surface never
    // writes agent::review-spec — the HITL review gate sits BEFORE persist
    // in the collapsed flow, so the intermediate label has no reader. ----
    Logger.info(
      `[plan-persist] Flipping Epic #${epicId} to ${AGENT_LABELS.READY}...`,
    );
    await setEpicLabel(provider, epicId, AGENT_LABELS.READY);

    // ---- Step 11: final checkpoint v2 + single plan-summary comment with
    // the dry-run wave table as closing text (single mode records the
    // { deliveryShape, sliceCount, routingReasons } routing record
    // instead). ----
    const waveTable = mode === 'single' ? [] : buildWaveTable(validated);
    const checkpoint = await writeCheckpointV2(provider, epicId, {
      persist: { completedAt: new Date().toISOString() },
    });
    // G2 measurement receipt (Epic #4474 PR7): roll the plan-metrics ledger
    // into the summary comment so turns-per-plan / per-mode counts / critic
    // skips are readable off the Epic. Best-effort — a missing ledger
    // yields no line. The in-flight persist invocation itself is stamped by
    // the CLI wrapper *after* this function returns, so it appears in the
    // stdout JSON (and any later re-persist), not in this comment.
    let planMetricsLine = null;
    try {
      const metricsSummary = summarizePlanMetrics(
        await readPlanMetrics(epicId, config),
      );
      if (metricsSummary) {
        planMetricsLine = renderPlanMetricsSummaryLine(metricsSummary);
      }
    } catch (err) {
      Logger.warn(
        `[plan-persist] plan-metrics summary line skipped: ${err.message}`,
      );
    }
    await upsertStructuredComment(
      provider,
      epicId,
      PLAN_SUMMARY_COMMENT_TYPE,
      buildPlanSummaryCommentBody({
        epicId,
        ticketCount,
        planningRisk,
        reviewRouting,
        freshness,
        healthcheck,
        waveTable,
        mode,
        planMetricsLine,
        single,
        amend: amendSummary,
      }),
    );

    // ---- Step 12: temp cleanup ONLY at terminal success. A failed run
    // leaves every authored artifact on disk for --force/--resume reuse. ----
    const cleanup = skipCleanup
      ? { deleted: [], missing: [], failed: [], skipped: true }
      : await cleanupPhaseTempFiles({ phase: 'persist', epicId });
    Logger.info(
      `[plan-persist] ✅ Persist complete for Epic #${epicId} (${mode}). ` +
        `${ticketCount} ticket(s) persisted; Epic is ${AGENT_LABELS.READY}.`,
    );
    if (cleanup.deleted.length > 0) {
      Logger.info(
        `[plan-persist] 🧹 Cleaned up ${cleanup.deleted.length} temp file(s).`,
      );
    }

    return {
      epicId,
      epicCreated: created,
      mode,
      ticketCount,
      checkpoint,
      planningRisk,
      reviewRouting,
      freshness,
      healthcheck,
      reachability,
      reconcile,
      specPath: specFilePath,
      waveTable,
      single,
      amend: amendSummary,
      cleanup,
      labelTransition: 'ready',
    };
  } finally {
    // Lease release on EVERY exit path (success, gate failure, throw).
    // Best-effort by contract — releaseEpicPlanLease never throws.
    await releaseEpicPlanLease({ provider, epicId, config });
  }
}

/**
 * Drop a stale `delivery::single` marker when a fan-out-shaped persist
 * (full re-persist or amend) lands over a formerly single-delivery plan.
 * No-op — and no API call — when the fetched Epic never carried it.
 *
 * @param {object} provider
 * @param {number} epicId
 * @param {{ labels?: string[] }} epic the Epic as fetched at step 5
 */
async function removeSingleDeliveryMarker(provider, epicId, epic) {
  if (!epic?.labels?.includes(DELIVERY_LABELS.SINGLE)) return;
  Logger.info(
    `[plan-persist] Removing stale ${DELIVERY_LABELS.SINGLE} marker from ` +
      `Epic #${epicId} (plan is fan-out-shaped now).`,
  );
  await provider.updateTicket(epicId, {
    labels: { add: [], remove: [DELIVERY_LABELS.SINGLE] },
  });
}

/**
 * Render the `risk-verdict` structured-comment body. Lifted from
 * `epic-plan-spec/phases/run-spec-phase.js` so the collapsed surface posts
 * the byte-identical audit-trail comment (axis table + fenced-JSON record)
 * downstream tooling parses.
 *
 * @param {{ epicId: number, riskVerdict: import('../planning-risk.js').RiskVerdict, planningRisk: import('../planning-risk.js').PlanningRiskEnvelope }} input
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
