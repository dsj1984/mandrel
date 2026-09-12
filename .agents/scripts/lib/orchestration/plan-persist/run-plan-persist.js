/**
 * run-plan-persist.js — flat Story persist for the v2 `/mandrel-plan` collapse
 * (Stage 3 — `docs/roadmap.md`).
 *
 * Ordered pipeline — hard gates refuse, everything else is a **warning** the
 * dry-run lists (Story #5312):
 *
 *   1. `changes[]` repair + ticket validator + file-assumption + DAG
 *   2. Draft reachability (named soft failure, exit 3)
 *   3. Split-policy partition (`assertAcceptancePartition`) + spec fold
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
import { getPaths, PROJECT_ROOT } from '../../config-resolver.js';
import { Logger } from '../../Logger.js';
import { sweepTempRetention } from '../../temp-retention.js';
import {
  concurrentMap,
  FANOUT_CONCURRENCY,
} from '../../util/concurrent-map.js';
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
import { evaluateTextHygiene } from '../plan-text-hygiene.js';
import {
  computeAssembledConflictFindings,
  conflictFindingKey,
} from '../ticket-validator-conflicts.js';
import { upsertStructuredComment } from '../ticketing.js';
import { recordAuditFilings, withAuditLabels } from './audit-provenance.js';
import { renderChangeRepair } from './changes-repair.js';
import {
  resolveContainerEpic,
  resolveCrossPlanLinks,
} from './cross-plan-links.js';
import { validateTickets } from './persist-helpers.js';
import { surfaceSoftConflictFindings } from './soft-findings.js';
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
 * Enforce the ticket validator's hard errors and collect its warnings.
 *
 * Since Story #5312 the only hard refusal the validator batches into
 * `errors[]` is a `deletes` naming a path absent at base; every other
 * footprint probe — a `creates` / `refactors-existing` mismatch, a goal,
 * acceptance or verify path absent at base — lands on `warnings[]`, which
 * the dry-run prints and the persist proceeds past. The `changes[]` repairs
 * the helper applied are reported alongside so the operator sees what was
 * rewritten.
 *
 * The returned freshness counts feed the posted `plan-summary`'s freshness
 * line: every warning is a reference the base branch disagreed with, so it
 * counts as `stale` there rather than the comment reading "clean" on a run
 * that had something to say.
 *
 * @returns {{ warnings: string[], freshness: { stale: number, ambiguous: number } }}
 */
function enforceTicketValidation(validated) {
  const errors = validated.errors ?? [];
  if (errors.length > 0) {
    throw new Error(
      `[plan-persist] ticket validation failed with ${errors.length} ` +
        `hard error(s):\n${errors.map((error) => `  - ${error}`).join('\n')}`,
    );
  }
  const warnings = [
    ...(validated.repairs ?? []).map((repair) => renderChangeRepair(repair)),
    ...(validated.warnings ?? []),
  ];
  return {
    warnings,
    freshness: freshnessCounts(validated.probeRef, validated.warnings ?? []),
  };
}

/**
 * Freshness counts for the posted plan summary. Every validator warning is
 * a reference the base branch disagreed with — `stale` when a base ref was
 * actually read, `ambiguous` when none resolved in this checkout and the
 * probes were skipped, since nothing was verified either way.
 *
 * @param {string|null} probeRef
 * @param {string[]} warnings
 * @returns {{ stale: number, ambiguous: number }}
 */
function freshnessCounts(probeRef, warnings) {
  if (probeRef === null) return { stale: 0, ambiguous: warnings.length };
  return { stale: warnings.length, ambiguous: 0 };
}

/**
 * The `open-question` lint over the draft bodies (Story #5312) — an
 * operator-directed question persisted into a Story a non-interactive
 * sub-agent executes. A warning the dry-run lists, never a refusal.
 *
 * @param {object[]} rawStories
 * @returns {string[]}
 */
function collectOpenQuestionWarnings(rawStories) {
  return evaluateTextHygiene({ draftStories: rawStories }).findings.map(
    (finding) =>
      `Story "${finding.slug}": open question in body — "${finding.evidence}". ${finding.message}`,
  );
}

/**
 * Print every warning the run collected under one heading. The dry-run is
 * where an operator reads these; the persist prints the same list so a
 * `--chain-on-clean` run loses nothing.
 *
 * @param {string[]} warnings
 * @returns {void}
 */
function logWarnings(warnings) {
  if (warnings.length === 0) return;
  Logger.warn(
    `[plan-persist] ${warnings.length} warning(s) — the persist proceeds; review before delivering:`,
  );
  for (const warning of warnings) {
    Logger.warn(`[plan-persist] warning: ${warning}`);
  }
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
      epicRollup: { closed: [], pending: [] },
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
 * Re-run the cross-Story conflict passes over the assembled bodies
 * (Story #5045).
 *
 * `validateTickets` runs before assembly, over the raw payload, so until now
 * plan-time conflict analysis judged an artifact that is not the one persist
 * writes — and the passes that scan `body.acceptance` / `body.verify` were
 * inert on the canonical top-level authoring shape as a result. Findings the
 * raw pass already reported are dropped so the same collision is not
 * announced twice per run; the rest are returned for the plan-summary
 * comment, which is where these findings stop being a stderr line nobody
 * keeps. Every finding is advisory (Story #5312).
 *
 * @param {{ stories: object[], rawFindings: object[] }} args
 * @returns {object[]} The assembled-pass findings, for the summary comment.
 */
function analyzeAssembledStories({ stories, rawFindings }) {
  const findings = computeAssembledConflictFindings({ stories });
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
 * Fail closed on a payload that cannot be persisted. Extracted from
 * `runPlanPersist` (Story #4926) so the entry point carries the flow, not the
 * guards. The reviewability budget that used to sit beside this check went
 * with Story #5312 — a plan is as many Stories as the split policy yields.
 *
 * @param {unknown} rawStories
 * @returns {void}
 * @throws {Error} On an empty payload.
 */
function assertPersistablePlan(rawStories) {
  if (!Array.isArray(rawStories) || rawStories.length === 0) {
    throw new Error(
      '[plan-persist] stories payload must be a non-empty array ' +
        '(--stories <file>). Default is one Story.',
    );
  }
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
 *   opts?: {
 *     forceReview?: boolean,
 *     skipCleanup?: boolean,
 *     dryRun?: boolean,
 *     planDir?: string,
 *     gitRunner?: Function,
 *     cwd?: string,
 *     sourceTicketIds?: number[],
 *     sourceTicketOrigin?: 'flag'|'envelope'|'none',
 *     closeSuperseded?: boolean,
 *   },
 * }} input
 */
export async function runPlanPersist({
  provider,
  artifacts,
  config = {},
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
    skipCleanup = false,
    dryRun = false,
    planDir = null,
    gitRunner = undefined,
    cwd = PROJECT_ROOT,
    sourceTicketIds = [],
    sourceTicketOrigin = 'none',
    closeSuperseded = true,
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

  assertPersistablePlan(rawStories);

  Logger.info(
    `[plan-persist] Running cross-validation on ${rawStories.length} Story ticket(s)...`,
  );
  const validated = validateTickets(rawStories, config, { cwd, gitRunner });
  surfaceSoftConflictFindings(validated.findings, 'plan-persist');
  const { warnings: validationWarnings, freshness } =
    enforceTicketValidation(validated);
  const warnings = [
    ...validationWarnings,
    ...collectOpenQuestionWarnings(rawStories),
  ];
  logWarnings(warnings);

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

  // Split policy + inline Spec fold (Specs stay inline, never under docs/).
  const seedContent = planContextEnvelope?.seed?.content ?? '';
  const { stories: assembled } = assemblePlanStories(rawStories, {
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
    provenanceSource: seedContent,
  });

  // Stamp the `audit::*` labels the dedup corpus is listed by. Without them a
  // Story this path files is absent from the pool an indexed sweep matches
  // against, and an indexed run answers exact lookups from that pool without
  // ever reaching the provider — so the provenance footers alone leave it
  // invisible (Story #5307). A non-audit seed carries none: a no-op there.
  const stories = withAuditLabels(assembled, seedContent);

  // Story #5045: the cross-Story conflict passes re-run over the assembled,
  // footer-stamped bodies — the artifact persist actually writes — before any
  // GitHub call, so a policy upgrade still refuses the plan pre-creation.
  const assembledConflicts = analyzeAssembledStories({
    stories,
    rawFindings: validated.findings,
  });

  const { created, planRunLabel, planRunLabelApplied } =
    await createStoryIssues({
      provider,
      stories,
      opts: { dryRun },
    });

  // What this run filed, recorded where the next audit sweep reads it
  // (Story #5307). A dry run created nothing, and the call knows it.
  recordAuditFilings({ stories, created, tickets: rawStories, dryRun });

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
    // Story #5280 — closing a source ticket is a child state change, so the
    // phase re-derives the container above it. It needs the config the rollup
    // reads its board and operator handle from.
    config,
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
    forceReview,
    reachability,
    freshness,
    // Story #5312: what the run rewrote and what it noticed. The dry-run is
    // the review surface now that the footprint probes warn instead of
    // refusing, so the list rides the result envelope, not just stderr.
    warnings,
    repairs: validated.repairs ?? [],
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
