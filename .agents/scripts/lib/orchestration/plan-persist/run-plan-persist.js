/**
 * run-plan-persist.js — flat Story persist for the v2 `/mandrel-plan` collapse
 * (Stage 3 — `docs/roadmap.md`).
 *
 * Ordered, fail-closed pipeline:
 *
 *   1. Ticket validator + file-assumption + DAG + capacity + budget
 *   2. Draft reachability (named soft failure, exit 3)
 *   3. Split-policy partition (`assertAcceptancePartition`) + spec fold/spill
 *   4. Create Story issues (`type::story` + sanitized authored labels —
 *      deliberately NOT `agent::ready`), resumably via a plan fingerprint
 *   5. Upsert `story-plan-state` on every created Story; upsert `plan-summary`
 *      on the primary Story
 *   6. Flip every Story to `agent::ready` — the terminal step, so `ready`
 *      always implies "checkpoints written"
 *   7. Comment on + close the superseded `--tickets` source issues
 *      (Story #4535) — bookkeeping only; never fails the run
 *   8. Temp cleanup at terminal success + a stale-plan-dir reap
 *
 * **Why `agent::ready` moved to the end (Story #4541).** Issues used to be
 * born `agent::ready` in the creating POST while the checkpoints were
 * written afterwards. Anything picking a Story up in that window — or after
 * a comment failure aborted the loop — read the checkpoint as `null`
 * (`story-plan-state.js` degrades missing/malformed to `null`). Creating
 * unlabelled, writing checkpoints, then flipping closes that race.
 *
 * **No authored risk artifact (Story #4542).** Persist neither requires nor
 * accepts a risk verdict, derives no envelope from one, and computes no
 * review routing. Review depth and the acceptance-critic mode are derived from
 * the diff at close time (`review-depth.js#deriveChangeLevel`); `--force-review`
 * is an explicit operator flag, recorded here as a receipt and never inferred.
 *
 * Hard cutover: no Epic parent, no reconciler, no `deliveryShape`, no
 * `--amend` tree cascades. Those surfaces die with Stages 4–5 for any
 * remaining epic-delivery readers.
 *
 * @module lib/orchestration/plan-persist/run-plan-persist
 */

import { rm } from 'node:fs/promises';
import { getLimits, getPaths, PROJECT_ROOT } from '../../config-resolver.js';
import { gitSpawn } from '../../git-utils.js';
import { Logger } from '../../Logger.js';
import { sweepTempRetention } from '../../temp-retention.js';
import {
  concurrentMap,
  FANOUT_CONCURRENCY,
} from '../../util/concurrent-map.js';
import {
  deriveStoryShape,
  LITE_ROUTE_LABEL,
  resolveComplexityGate,
  resolvePlannerRouteVerdict,
} from '../complexity-gate.js';
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
import {
  computeAssembledConflictFindings,
  conflictFindingKey,
  renderHardConflictError,
} from '../ticket-validator-conflicts.js';
import { upsertStructuredComment } from '../ticketing.js';
import {
  resolveContainerEpic,
  resolveCrossPlanLinks,
} from './cross-plan-links.js';
import {
  enforceFanOutGate,
  surfaceSoftConflictFindings,
} from './fan-out-gate.js';
import { resolveBaseBranchRef, validateTickets } from './persist-helpers.js';
import {
  assemblePlanStories,
  createStoryIssues,
  markStoriesReady,
} from './story-ops.js';
import {
  buildPlanSummaryCommentBody,
  buildWaveTable,
  PLAN_SUMMARY_COMMENT_TYPE,
} from './summary.js';
import { closeSupersededTickets } from './supersede-ops.js';
import { predictWaveSerialisation } from './wave-serialisation.js';

/** Checkpoint schema version written on each Story's story-plan-state. */
const PLAN_CHECKPOINT_SCHEMA_VERSION_V2 = 2;

/** Structured-comment type for the per-plan Story checkpoint. */
const STORY_PLAN_STATE_TYPE = 'story-plan-state';

/**
 * Write the `story-plan-state` checkpoint on a Story.
 *
 * @param {object} provider
 * @param {number} storyId
 * @param {object} state
 */
export async function writeCheckpointV2(provider, storyId, state) {
  if (!Number.isInteger(storyId)) {
    throw new TypeError('writeCheckpointV2 requires a numeric storyId');
  }
  const body = [
    '### story-plan-state',
    '',
    '```json',
    JSON.stringify(
      {
        version: PLAN_CHECKPOINT_SCHEMA_VERSION_V2,
        storyId,
        ...state,
      },
      null,
      2,
    ),
    '```',
  ].join('\n');
  await upsertStructuredComment(provider, storyId, STORY_PLAN_STATE_TYPE, body);
  return state;
}

/**
 * Enforce the ticket validator's findings and report what the file-assumption
 * gate actually concluded.
 *
 * The return value feeds the posted `plan-summary`'s freshness line, which
 * used to be hard-coded `{ stale: 0, ambiguous: 0 }` — so the comment read
 * "Spec freshness: clean" even on the one run where the gate had *given up*
 * (Story #4541's unresolvable-base-ref downgrade). The summary asserted a
 * clean result precisely when it had the least evidence for one.
 *
 * The mapping is deliberate. A confirmed mismatch is never reported here at
 * all — it throws, and the run posts no summary. The only findings that
 * survive to the summary are ones the gate could not *verify*, because the
 * base ref they were computed against does not resolve; unverifiable is
 * `ambiguous`, not `stale`.
 *
 * @returns {{ stale: number, ambiguous: number }} Freshness counts for the
 *   posted summary.
 */
function enforceTicketValidation(validated, { config, settings, cwd }) {
  const validationErrors = validated.errors ?? [];
  const assumptionFailures = validationErrors.filter((error) =>
    error.startsWith('File assumption mismatch:'),
  );
  const blockingErrors = validationErrors.filter(
    (error) => !error.startsWith('File assumption mismatch:'),
  );
  if (blockingErrors.length > 0) {
    throw new Error(
      `[plan-persist] ticket validation failed with ${blockingErrors.length} ` +
        `hard error(s):\n${blockingErrors.map((error) => `  - ${error}`).join('\n')}`,
    );
  }
  if (assumptionFailures.length === 0) return { stale: 0, ambiguous: 0 };
  // Story #4541: resolve through the canonical `project.baseBranch` (the
  // shape `config-resolver` actually emits) with the legacy settings bag as
  // a fallback — reading a bare `config.baseBranch` meant this probe always
  // targeted the literal `main`.
  const gateBaseRef =
    config?.project?.baseBranch ??
    settings?.baseBranch ??
    resolveBaseBranchRef(config);
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
        `mismatch(es):\n${assumptionFailures.map((error) => `  - ${error}`).join('\n')}`,
    );
  }
  Logger.warn(
    `[plan-persist] file-assumption gate skipped: base ref '${gateBaseRef}' ` +
      `does not resolve — ${assumptionFailures.length} finding(s) downgraded.`,
  );
  return { stale: 0, ambiguous: assumptionFailures.length };
}

/**
 * Run the supersede close phase behind a belt-and-braces guard.
 *
 * `closeSupersededTickets` already swallows per-ticket failures, but this
 * phase runs *after* `createIssue`, so an unexpected throw anywhere in it
 * would leave the run half-done with Stories already live. Degrade to a
 * reported failure instead.
 *
 * @returns {Promise<import('./supersede-ops.js').SupersedeReport>}
 */
async function runSupersedePhase(args) {
  try {
    return await closeSupersededTickets(args);
  } catch (err) {
    Logger.warn(
      `[plan-persist] supersede close phase failed: ${err.message} — ` +
        'Stories were created; close the source tickets by hand.',
    );
    return {
      enabled: true,
      dryRun: args.dryRun === true,
      reason: `phase-error: ${err.message}`,
      closed: [],
      planned: [],
      skipped: [],
      failed: (args.sourceTicketIds ?? []).map((ticket) => ({
        ticket,
        reason: err.message,
      })),
    };
  }
}

/**
 * Render the plan-metrics line for the **posted** `plan-summary` comment,
 * scoped to this invocation.
 *
 * The ordering hazard this closes: the ledger record for the current run is
 * appended by `recordPlanInvocation`'s `finally`, which by construction only
 * fires once `runPlanPersist` has *resolved* — long after this comment body
 * is composed. A plain `since`-filtered ledger read therefore summarized
 * every run except the one being summarized, and on an otherwise-quiet
 * ledger it rendered "plan-metrics: no invocations recorded" onto the very
 * comment reporting the run. (The stdout envelope was always correct: its
 * `attachPlanMetrics` read runs after the wrapper returns.)
 *
 * **The `finally` stays where it is.** It is what guarantees a persist that
 * throws is still recorded, so moving the append earlier — or moving this
 * read later, past the GitHub writes it feeds — would trade a cosmetic bug
 * for a real one. Instead of racing it, fold in a synthetic record standing
 * for the in-flight invocation. It is the same record the wrapper is about to
 * write, minus a final duration; it cannot double-count, because the real one
 * does not exist yet at this point in the pipeline.
 *
 * `ok: true` is honest here: this line is only ever composed on the success
 * path, after `createStoryIssues` has returned.
 *
 * @param {{ config: object, since: string, startedAt: string, mode: string }} args
 * @returns {Promise<string|null>}
 */
async function renderRunScopedPlanMetricsLine({
  config,
  since,
  startedAt,
  mode,
}) {
  try {
    const ledger = await readPlanMetrics(null, config);
    const endedAt = new Date().toISOString();
    const inFlight = {
      v: 1,
      cli: 'plan-persist',
      mode,
      epicId: null,
      startedAt,
      endedAt,
      durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) || 0,
      ok: true,
    };
    const summary = summarizePlanMetrics(
      { ...ledger, entries: [...(ledger.entries ?? []), inFlight] },
      { since },
    );
    return renderPlanMetricsSummaryLine(summary);
  } catch (err) {
    Logger.warn(`[plan-persist] plan-metrics summary skipped: ${err.message}`);
    return null;
  }
}

/**
 * Resolve the plan's **effective** complexity route for persist
 * (Story #4722, superseding the envelope-verdict model of Story #4707).
 *
 * Two staged inputs, no word count anywhere:
 *
 *   1. **The planner's authored verdict** — `--route-downgrade-reason` is the
 *      lite claim's recorded reason (`resolvePlannerRouteVerdict`). No
 *      recorded reason means no claim: the plan persists as standard `full`
 *      and nothing is ledgered (`null`).
 *   2. **The deterministic shape backstop** — a lite claim is validated
 *      against every assembled Story's own shape (`deriveStoryShape` over its
 *      `changes[]`, acceptance count, creates-vs-refactors mix, and
 *      sensitive-path classes). Any Story exceeding the ceilings **fails the
 *      claim closed to `full`** — the honest gate: after authoring, the work
 *      has measurable shape, so complexity is read from the work, not guessed
 *      from the seed.
 *
 * The resolved route decides whether the created Stories carry the
 * {@link LITE_ROUTE_LABEL} **hint** (never the control signal — `/mandrel-deliver`
 * re-derives the route from the Story body's shape) and the `route` block
 * ledgered on their `story-plan-state` checkpoint, including the authored
 * verdict, its recorded reason, and the per-Story shape evidence. A refused
 * claim is ledgered too (route `full` with the refusal reasons), so the
 * judgment stays auditable either way.
 *
 * Module-private: reachable end to end through {@link runPlanPersist}
 * (whose result reports the resolved route), so there is no test-only
 * export to leave production-dead.
 *
 * @param {{
 *   stories: ReturnType<typeof assemblePlanStories>['stories'],
 *   routeDowngradeReason?: string|null,
 *   config?: object,
 *   injectedRules?: object,
 * }} args
 * @returns {{
 *   route: 'lite'|'full',
 *   reasons: string[],
 *   authored: { route: 'lite', reason: string },
 *   shape: Array<{ slug: string, route: string, reasons: string[], shape: object|null }>,
 * }|null} `null` when the planner authored no verdict (nothing to persist).
 */
function resolveEffectiveRoute({
  stories,
  routeDowngradeReason = null,
  config = {},
  injectedRules,
}) {
  const verdict = resolvePlannerRouteVerdict({ reason: routeDowngradeReason });
  if (verdict.route !== 'lite') return null;

  // The schema's documented contract: with the gate disabled
  // (`planning.complexityGate.enabled=false`), persist refuses lite claims —
  // the same switch dispatch reads (`resolveStoryDispatchMode` falls back to
  // sub-agent), so neither read point can honor a lite claim the operator
  // has switched off. The refusal is ledgered like any other, keeping the
  // judgment auditable.
  if (!resolveComplexityGate(config).enabled) {
    return {
      route: 'full',
      reasons: [
        'planner lite verdict refused: complexity routing is disabled ' +
          '(planning.complexityGate.enabled=false)',
      ],
      authored: verdict.authored,
      shape: [],
    };
  }

  const perStory = (Array.isArray(stories) ? stories : []).map((story) => {
    const derived = deriveStoryShape({
      changes: story.bodyObject?.changes,
      acceptance: story.acceptance,
      injectedRules,
    });
    return {
      slug: story.slug,
      route: derived.route,
      reasons: derived.reasons,
      shape: derived.shape,
    };
  });
  const offenders = perStory.filter((entry) => entry.route !== 'lite');
  if (offenders.length > 0) {
    return {
      route: 'full',
      reasons: [
        `planner lite verdict refused: ${offenders.length} of ${perStory.length} ` +
          'Story(ies) exceed the lite shape ceilings — failing closed to full',
        ...offenders.map((entry) => `${entry.slug}: ${entry.reasons[0]}`),
      ],
      authored: verdict.authored,
      shape: perStory,
    };
  }
  return {
    route: 'lite',
    reasons: [
      ...verdict.reasons,
      'shape backstop: every authored Story fits the lite shape ceilings',
    ],
    authored: verdict.authored,
    shape: perStory,
  };
}

/**
 * Re-run the cross-Story conflict passes over the assembled bodies and route
 * the result (Story #5045).
 *
 * `validateTickets` runs before assembly, over the raw payload, so until now
 * plan-time conflict analysis judged an artifact that is not the one persist
 * writes — and the passes that scan `body.acceptance` / `body.verify` were
 * inert on the canonical top-level authoring shape as a result.
 *
 * Three outcomes, in order:
 *
 * 1. **Hard findings throw.** Policy upgrades (`planning.failOnSharedEditors`,
 *    `planning.requireExplicitCrossStoryDeps`) are off by default; when an
 *    operator turns one on it must bite on the persisted artifact too, and it
 *    must bite **before** the first `createIssue`.
 * 2. **Soft findings the raw pass already reported are dropped**, so the same
 *    collision is not announced twice per run.
 * 3. **Everything else is returned** for the plan-summary comment, which is
 *    where these findings stop being a stderr line nobody keeps.
 *
 * @param {{ stories: object[], config: object, rawFindings: object[] }} args
 * @returns {object[]} The assembled-pass findings, for the summary comment.
 */
function analyzeAssembledStories({ stories, config, rawFindings }) {
  const findings = computeAssembledConflictFindings({ stories, config });
  const hard = findings.filter((finding) => finding.severity === 'hard');
  if (hard.length > 0) {
    throw new Error(
      `[plan-persist] ${hard.length} cross-Story conflict(s) in the assembled ` +
        `Story bodies:\n${hard.map((f) => `  - ${renderHardConflictError(f)}`).join('\n')}`,
    );
  }
  const alreadyReported = new Set(
    (rawFindings ?? []).map((finding) => conflictFindingKey(finding)),
  );
  surfaceSoftConflictFindings(
    findings.filter(
      (finding) => !alreadyReported.has(conflictFindingKey(finding)),
    ),
    'plan-persist/assembled',
  );
  return findings;
}

/**
 * Reap abandoned `plan-*` directories under the temp root (Story #4541).
 *
 * Terminal-success cleanup only ever removed the *current* run's `planDir`,
 * so every plan that failed a gate, was abandoned mid-authoring, or ran
 * `--dry-run` left its directory behind forever. This sweeps the stragglers
 * on each persist.
 *
 * Story #4794 folded the age-floored reap into the shared temp-retention
 * engine — `planDirs` is one of its declared classes, so the plan path and
 * the delivery path now converge on one classifier and one staleness floor
 * (`delivery.tempRetention.staleDays`, still 7 days by default) instead of
 * this module owning a private constant. Behaviour is unchanged: only
 * `plan-*` directories are considered, the age test is the directory's own
 * mtime, and the current run's `planDir` is excluded.
 *
 * Best-effort throughout: this is hygiene, never a reason to fail a run that
 * has already created Stories.
 *
 * @param {{ config?: object, keepDir?: string|null, now?: number }} args
 * @returns {Promise<{ reaped: string[] }>}
 */
export async function reapStalePlanDirs({
  config = {},
  keepDir = null,
  now = Date.now(),
} = {}) {
  const result = await sweepTempRetention({
    config,
    only: ['planDirs'],
    excludePaths: keepDir ? [keepDir] : [],
    now,
    label: 'plan-persist',
  });
  return { reaped: result.purged.map((entry) => entry.path) };
}

/**
 * Fail closed on a payload that cannot be persisted, and warn on an
 * explicitly-authorized over-budget one. Extracted from `runPlanPersist`
 * (Story #4926) so the entry point carries the flow, not the guards.
 *
 * @param {unknown} rawStories
 * @param {{ maxTickets: number, allowOverBudget: boolean }} limits
 * @returns {void}
 * @throws {Error} On an empty payload or an unauthorized over-budget one.
 */
function assertPersistablePlan(rawStories, { maxTickets, allowOverBudget }) {
  if (!Array.isArray(rawStories) || rawStories.length === 0) {
    throw new Error(
      '[plan-persist] stories payload must be a non-empty array ' +
        '(--stories <file>). Default is one Story.',
    );
  }
  if (rawStories.length <= maxTickets) return;
  if (!allowOverBudget) {
    throw new Error(
      `[plan-persist] Stories (${rawStories.length}) exceed the reviewability ` +
        `budget (${maxTickets}). Re-scope, or rerun with --allow-over-budget.`,
    );
  }
  Logger.warn(
    `[plan-persist] Persisting an over-budget plan: ${rawStories.length} ` +
      `Stories vs. budget ${maxTickets} (--allow-over-budget).`,
  );
}

/**
 * Enforce the draft-reachability critic: orphans throw, a skip is ledgered.
 *
 * @param {{ status: string, reasons: string[], orphans?: object[] }} reachability
 * @param {object} config
 * @returns {Promise<void>}
 * @throws {Error} `PLAN_REACHABILITY_ORPHANS` when the draft orphans a Story.
 */
async function enforceReachability(reachability, config) {
  if (reachability.status === 'orphans') {
    const err = new Error(renderReachabilityOrphans(reachability));
    err.code = 'PLAN_REACHABILITY_ORPHANS';
    err.orphans = reachability.orphans;
    throw err;
  }
  Logger.info(`[plan-persist] reachability: ${reachability.reasons[0]}`);
  if (reachability.status === 'skipped') {
    await appendCriticSkip(
      {
        critic: 'reachability',
        reasons: reachability.reasons,
        cli: 'plan-persist',
      },
      config,
    );
  }
}

/**
 * Write the per-Story checkpoint, upsert the plan-summary comment, and flip
 * every created Story to `agent::ready`. Terminal ordering is load-bearing:
 * `agent::ready` lands last so it can honestly mean "fully persisted"
 * (Story #4541). A dry run performs none of it.
 *
 * **The checkpoints fan out; the phase boundary does not** (Story #4952). The
 * per-Story upserts are independent of one another and run under bounded
 * concurrency, but the `await` on that whole fan-out is what keeps the
 * Story #4541 invariant intact: *every* checkpoint is on its ticket before the
 * first `agent::ready` flip is issued, so `ready` still means "fully
 * persisted" and a `/mandrel-deliver` that picks a Story up cannot read a null
 * checkpoint. Concurrency inside the phase is safe; overlapping the phases is
 * the race this ordering exists to close.
 *
 * @param {object} args
 * @returns {Promise<void>}
 */
async function persistStoryArtifacts({
  provider,
  created,
  primary,
  route,
  summaryBody,
}) {
  const cohort = created.map((createdStory) => ({
    slug: createdStory.slug,
    id: createdStory.id,
  }));
  await concurrentMap(
    created,
    (story) =>
      writeCheckpointV2(provider, story.id, {
        persist: {
          completedAt: new Date().toISOString(),
          storyCount: created.length,
          primaryStoryId: primary.id,
          stories: cohort,
        },
        // Ledger the authored route verdict — the recorded reason and the
        // per-Story shape evidence, including a shape-refused claim — on plan
        // state (Story #4722). No authored verdict writes no block: absence
        // is the standard full path.
        ...(route ? { route } : {}),
      }),
    // The per-Story checkpoint upserts (Story #4952): each targets a
    // different issue and reads nothing another writes, so this loop was
    // serial only by construction — but see {@link persistStoryArtifacts}
    // for the phase ordering that is *not* incidental.
    { concurrency: FANOUT_CONCURRENCY },
  );
  await upsertStructuredComment(
    provider,
    primary.id,
    PLAN_SUMMARY_COMMENT_TYPE,
    summaryBody,
  );
  await markStoriesReady({ provider, created });
}

/**
 * Remove this run's plan directory on terminal success, then sweep the
 * abandoned ones terminal-success cleanup can never reach (Story #4541).
 *
 * @param {{ config: object, planDir: string|null, skipCleanup: boolean }} args
 * @returns {Promise<void>}
 */
async function cleanupPlanDirs({ config, planDir, skipCleanup }) {
  if (!skipCleanup && planDir) {
    try {
      await rm(planDir, { recursive: true, force: true });
    } catch (err) {
      Logger.warn(`[plan-persist] temp cleanup skipped: ${err.message}`);
    }
  }
  await reapStalePlanDirs({ config, keepDir: skipCleanup ? planDir : null });
}

/**
 * Log the effective complexity route (Story #4722). Lite is upheld by the
 * shape backstop; anything else reports why it fell back to full.
 *
 * @param {object|null} route
 * @param {boolean} isLiteRoute
 * @returns {void}
 */
function logEffectiveRoute(route, isLiteRoute) {
  if (isLiteRoute) {
    Logger.info(
      `[plan-persist] ceremony-lite route upheld by the shape backstop: ` +
        `created Stories carry the ${LITE_ROUTE_LABEL} hint ` +
        `(recorded reason: ${route.authored.reason}). /mandrel-deliver re-derives ` +
        'the route from each Story body — the label is never the control signal.',
    );
    return;
  }
  if (route) {
    Logger.warn(
      `[plan-persist] ${route.reasons.join('; ')} — persisting as full ` +
        '(no route hint label).',
    );
  }
}

/**
 * Log the operator-facing persist epilogue: adoption, the ready primary, the
 * deliver command, and the cohort grouping label.
 *
 * @param {{
 *   created: object[],
 *   primary: object,
 *   planRunLabel: string,
 *   planRunLabelApplied: boolean,
 * }} args
 * @returns {void}
 */
function logPersistEpilogue({
  created,
  primary,
  planRunLabel,
  planRunLabelApplied,
}) {
  const adopted = created.filter((story) => story.adopted);
  if (adopted.length > 0) {
    Logger.info(
      `[plan-persist] resumed ${adopted.length} of ${created.length} Story(ies) ` +
        `from a previous persist: ${adopted.map((s2) => `#${s2.id}`).join(', ')}.`,
    );
  }
  Logger.info(
    `[plan-persist] Persisted ${created.length} Story(ies)` +
      `; primary #${primary.id} is agent::ready.`,
  );
  Logger.info(
    `[plan-persist] Deliver with: /mandrel-deliver ${created.map((s2) => s2.id).join(' ')}`,
  );
  // Metadata only — a GitHub filter for the cohort this run authored, never
  // a delivery-resolution input (/mandrel-deliver stays ids-only, Story #4540).
  // Gated on the ensure result: the label ensure degrades non-fatally, and
  // advertising a filter GitHub just refused to create is worse than saying
  // nothing (Story #5201). The derived id survives in the result envelope.
  if (planRunLabelApplied) {
    Logger.info(
      `[plan-persist] Cohort grouping label: ${planRunLabel} — filter with ` +
        `label:${planRunLabel}`,
    );
  }
}

/**
 * Execute the flat Story persist end to end.
 *
 * @param {{
 *   provider: object,
 *   artifacts: {
 *     stories: Array<object>,
 *     techSpecContent?: string|null,
 *     planAcceptance?: string[]|null,
 *     planContextEnvelope?: object|null,
 *   },
 *   config?: object,
 *   settings?: object,
 *   opts?: {
 *     forceReview?: boolean,
 *     allowOverBudget?: boolean,
 *     allowLargeFanOut?: boolean,
 *     skipCleanup?: boolean,
 *     dryRun?: boolean,
 *     planDir?: string,
 *     fanOutCounter?: Function,
 *     cwd?: string,
 *     sourceTicketIds?: number[],
 *     sourceTicketOrigin?: 'flag'|'envelope'|'none',
 *     closeSuperseded?: boolean,
 *     routeDowngradeReason?: string|null,
 *     injectedRules?: object,
 *   },
 * }} input
 */
export async function runPlanPersist({
  provider,
  artifacts,
  config = {},
  settings = {},
  opts = {},
}) {
  const {
    stories: rawStories = null,
    techSpecContent = null,
    planAcceptance = null,
    planContextEnvelope = null,
  } = artifacts ?? {};
  const {
    forceReview = false,
    allowOverBudget = false,
    allowLargeFanOut = false,
    skipCleanup = false,
    dryRun = false,
    planDir = null,
    fanOutCounter = undefined,
    cwd = PROJECT_ROOT,
    sourceTicketIds = [],
    sourceTicketOrigin = 'none',
    closeSuperseded = true,
    routeDowngradeReason = null,
    injectedRules = undefined,
    // Story #5139 — the optional container Epic. `null` (the default) is the
    // ordinary shape: no Epic is created unless `/mandrel-plan` offered one
    // above the threshold and the operator confirmed it.
    epic = null,
  } = opts;

  // Boundary for the plan-metrics summary below: everything this invocation
  // appends to the ledger is stamped at or after this instant, so filtering
  // on it scopes the counts to *this* run rather than every plan ever run
  // through the shared standalone ledger (Story #4541).
  const runStartedAt = opts.metricsSince ?? new Date().toISOString();

  assertPersistablePlan(rawStories, {
    maxTickets: getLimits(config).maxTickets,
    allowOverBudget,
  });

  Logger.info(
    `[plan-persist] Running cross-validation on ${rawStories.length} Story ticket(s)...`,
  );
  const validated = validateTickets(rawStories, config, {
    fanOutCounter,
    cwd,
    modelCapacity: opts.modelCapacity,
  });
  enforceFanOutGate(validated.findings, allowLargeFanOut, 'plan-persist');
  surfaceSoftConflictFindings(validated.findings, 'plan-persist');
  const freshness = enforceTicketValidation(validated, {
    config,
    settings,
    cwd,
  });

  const reachability = evaluateDraftReachability({
    tickets: rawStories,
    config,
  });
  await enforceReachability(reachability, config);

  // Story #5155 — the plan's outward references (`--epic <id>`, and any
  // `#<id>` blocker) resolve BEFORE the first create, dry run included.
  const adoptionTarget = await resolveCrossPlanLinks({
    provider,
    stories: rawStories,
    epicId: opts.adoptEpicId ?? null,
  });

  // Split policy + inline Spec fold (over-budget Specs fail closed — no docs/).
  const { stories } = assemblePlanStories(rawStories, {
    sharedSpec: techSpecContent,
    planAcceptance: planAcceptance ?? undefined,
    sourceTicketIds,
    // The seed this plan was authored from: an audit sweep's Single-plan seed
    // carries the `audit-fingerprints` / `audit-semantic-keys` footers, and
    // assembly copies them into the persisted Story bodies so the next sweep
    // recognises what it already planned (Story #4877). Since Story #5045 this
    // is the **fallback** — it is carried onto every Story that did not
    // attribute its own `provenance`, which keeps an un-attributed plan exactly
    // as recall-safe as it was. Empty for a `--tickets` run, a no-op there.
    provenanceSource: planContextEnvelope?.seed?.content ?? '',
  });

  // Story #5045: the cross-Story conflict passes re-run over the assembled,
  // footer-stamped bodies — the artifact persist actually writes — before any
  // GitHub call, so a policy upgrade still refuses the plan pre-creation.
  const assembledConflicts = analyzeAssembledStories({
    stories,
    config,
    rawFindings: validated.findings,
  });

  // Effective complexity route (Story #4722): the planner's authored lite
  // verdict (recorded reason), validated against every assembled Story's own
  // shape — a claim exceeding the shape ceilings fails closed to full. Lite
  // persists the `route::lite` HINT label + a checkpoint route block; a
  // refused claim ledgers the refusal (no label); no claim persists nothing.
  const route = resolveEffectiveRoute({
    stories,
    routeDowngradeReason,
    config,
    injectedRules,
  });
  const isLiteRoute = route?.route === 'lite';
  logEffectiveRoute(route, isLiteRoute);

  const { created, planRunLabel, planRunLabelApplied } =
    await createStoryIssues({
      provider,
      stories,
      opts: { dryRun, routeLabel: isLiteRoute ? LITE_ROUTE_LABEL : null },
    });

  const primary = created[0];
  const waveTable = buildWaveTable(
    stories.map((s) => ({
      slug: s.slug,
      title: s.title,
      depends_on: s.depends_on,
    })),
  );

  // Story #5265: the table says which Stories share an order; the dispatcher
  // decides which of those actually run together, and it decides on the
  // evidence-widened footprint. Run its own predicate over the assembled
  // bodies — the exact artifact the tick will read back off GitHub — so the
  // comment names the serialisation instead of promising parallelism the
  // next tick refuses. `tempRoot` is threaded for the same reason the tick
  // threads it: the scrape must ignore this project's scratch root.
  const waveCollisions = predictWaveSerialisation(waveTable, stories, {
    tempRoot: getPaths(config).tempRoot,
  });

  // Story #4541: `readPlanMetrics` is declared `(epicId, config)` but was
  // called with `config` first, so the ledger path resolver received the
  // config object as an `epicId` and threw its guard on every single run —
  // a throw this try/catch then swallowed into a silently absent summary.
  // v2 persist is always Epic-less, hence the explicit `null`. The `since`
  // filter keeps the counts about this invocation, and the in-flight record
  // is folded in because the wrapper has not written it yet — see
  // `renderRunScopedPlanMetricsLine`.
  const planMetricsLine = await renderRunScopedPlanMetricsLine({
    config,
    since: runStartedAt,
    startedAt: runStartedAt,
    mode: dryRun ? 'dry-run' : 'persist',
  });

  const summaryBody = buildPlanSummaryCommentBody({
    epicId: primary.id,
    ticketCount: created.length,
    forceReview,
    freshness,
    healthcheck: { skipped: true },
    waveTable,
    mode: 'stories',
    planMetricsLine,
    stories: created,
    // Story #5045: the wave table promises what can run in parallel; the
    // collisions the conflict passes found belong on the same surface, or the
    // promise is the only half anyone reads.
    conflictFindings: assembledConflicts,
    waveCollisions,
  });

  if (!dryRun) {
    await persistStoryArtifacts({
      provider,
      created,
      primary,
      route,
      summaryBody,
    });
  }

  // Story #5139 — the container Epic is created LAST among the writes: its
  // body embeds the child issue numbers and its sub-issue edges need their
  // database ids, neither of which exists until the Stories are live. It is
  // never load-bearing, so a failure here degrades to "no container" and the
  // Stories still deliver by id.
  const containerEpic = await resolveContainerEpic({
    provider,
    adoptionTarget,
    epic,
    created,
    opts: { dryRun },
  });

  const supersede = await runSupersedePhase({
    provider,
    stories,
    created,
    sourceTicketIds,
    dryRun,
    closeSuperseded,
  });
  // Record which channel the ids came from so a run that superseded nothing
  // says *why* (`none` = neither the envelope nor --source-tickets carried
  // any) rather than reading as a clean no-op — Story #4554.
  supersede.sourceTicketOrigin = sourceTicketOrigin;

  await cleanupPlanDirs({ config, planDir, skipCleanup });
  logPersistEpilogue({
    created,
    primary,
    planRunLabel,
    planRunLabelApplied,
  });

  return {
    stories: created,
    primaryStoryId: primary.id,
    planRunLabel,
    route,
    forceReview,
    reachability,
    freshness,
    waveTable,
    // Story #5265 AC-2/AC-4: both halves of what persist concluded but used
    // to keep to itself — the `refactors-existing` declarations it rewrote,
    // and the same-order pairs the dispatcher will serialize.
    assumptionNormalizations: validated.normalizations ?? [],
    waveCollisions,
    supersede,
    epic: containerEpic,
  };
}
