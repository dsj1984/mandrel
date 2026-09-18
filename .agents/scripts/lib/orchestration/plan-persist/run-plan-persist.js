/**
 * Flat Story persist. Hard gates refuse; everything else is a warning the
 * dry-run lists. Order: validate → reachability → wave-collision gate →
 * create (without `agent::ready`) → plan comment on every Story → flip to
 * `agent::ready` last, so `ready` implies "plan comments written" → close
 * superseded sources (never fails the run) → temp cleanup.
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
import { renderRepair } from './acceptance-handle-repair.js';
import { recordAuditFilings, withAuditLabels } from './audit-provenance.js';
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
import { buildPlanSummaryCommentBody, buildWaveTable } from './summary.js';
import { closeSupersededTickets } from './supersede-ops.js';
import { assertNoWaveCollisions } from './wave-collision-gate.js';

/** Marker that makes a re-persist upsert the comment in place. */
const STORY_PLAN_STATE_TYPE = 'story-plan-state';

/**
 * The one comment persist posts per Story, carrying the plan summary.
 *
 * @param {object} provider
 * @param {number} storyId
 * @param {string} summary Must be non-empty.
 * @returns {Promise<void>}
 */
export async function writePlanSummaryComment(provider, storyId, summary) {
  if (!Number.isInteger(storyId)) {
    throw new TypeError('writePlanSummaryComment requires a numeric storyId');
  }
  const body = summary?.trim();
  if (!body) {
    throw new TypeError(
      'writePlanSummaryComment requires a non-empty plan summary',
    );
  }
  await upsertStructuredComment(provider, storyId, STORY_PLAN_STATE_TYPE, body);
}

/**
 * Throw on validator hard errors; return warnings (with applied `changes[]`
 * repairs) and freshness counts for the summary.
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
    ...(validated.repairs ?? []).map(renderRepair),
    ...(validated.warnings ?? []),
  ];
  return {
    warnings,
    freshness: freshnessCounts(validated.probeRef, validated.warnings ?? []),
  };
}

/**
 * Every validator warning counts `stale` when a base ref was read, else
 * `ambiguous` (the probes were skipped, nothing was verified).
 *
 * @param {string|null} probeRef
 * @param {string[]} warnings
 * @returns {{ stale: number, ambiguous: number }}
 */
function freshnessCounts(probeRef, warnings) {
  if (probeRef === null) return { stale: 0, ambiguous: warnings.length };
  return { stale: warnings.length, ambiguous: 0 };
}

const TEXT_HYGIENE_LABELS = {
  'open-question': 'open question in body',
  'pinned-identifier': 'pinned identifier in acceptance[]',
};

/**
 * Advisory text-hygiene lints (warnings, never refusals).
 *
 * @param {object[]} rawStories
 * @returns {string[]}
 */
function collectTextHygieneWarnings(rawStories) {
  return evaluateTextHygiene({ draftStories: rawStories }).findings.map(
    (finding) =>
      `Story "${finding.slug}": ${
        TEXT_HYGIENE_LABELS[finding.kind] ?? finding.kind
      } — "${finding.evidence}". ${finding.message}`,
  );
}

/**
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
 * Runs after the Stories are live, so an unexpected throw degrades to a
 * reported failure rather than a half-done run.
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
 * Plan-metrics line for the posted summary, scoped to this invocation. The
 * run's own ledger record is appended by the wrapper's `finally` (which must
 * stay there so a throwing persist is still recorded) only after this
 * resolves, so fold in a synthetic in-flight record; it cannot double-count.
 * `ok: true` holds because this runs only on the success path.
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
 * Re-run the conflict passes over the assembled bodies — the artifact persist
 * actually writes (the body-scanning passes are inert on the raw payload).
 * Only findings the raw pass did not already report are surfaced; all are
 * advisory.
 *
 * @param {{ stories: object[], rawFindings: object[] }} args
 * @returns {object[]}
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
 * Reap abandoned `plan-*` directories (failed, abandoned, or dry-run plans)
 * via the shared temp-retention staleness floor, excluding this run's.
 * Best-effort hygiene.
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
 * Orphans throw; a skip is ledgered.
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
 * Plan comments fan out concurrently, but the whole fan-out is awaited before
 * the first `agent::ready` flip, so `ready` always means "fully persisted".
 * Never overlap the two phases.
 *
 * @param {object} args
 * @returns {Promise<void>}
 */
async function persistStoryArtifacts({ provider, created, summaryBody }) {
  await concurrentMap(
    created,
    (story) => writePlanSummaryComment(provider, story.id, summaryBody),
    { concurrency: FANOUT_CONCURRENCY },
  );
  await markStoriesReady({ provider, created });
}

/**
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
  // Never advertise a filter for a label the ensure failed to create.
  if (planRunLabelApplied) {
    Logger.info(
      `[plan-persist] Cohort grouping label: ${planRunLabel} — filter with ` +
        `label:${planRunLabel}`,
    );
  }
}

/**
 * @param {{
 *   provider: object,
 *   artifacts: {
 *     stories: Array<object>,
 *     techSpecContent?: string|null,
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
    // Optional container Epic; only set when the operator confirmed one.
    epic = null,
  } = opts;

  // Scopes the plan-metrics summary to this run's ledger entries.
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
    ...collectTextHygieneWarnings(rawStories),
  ];
  logWarnings(warnings);

  const reachability = evaluateDraftReachability({
    tickets: rawStories,
    config,
  });
  await enforceReachability(reachability, config);

  // Outward references (`--epic <id>`, `#<id>` blockers) resolve before the
  // first create, dry run included.
  const adoptionTarget = await resolveCrossPlanLinks({
    provider,
    stories: rawStories,
    epicId: opts.adoptEpicId ?? null,
  });

  const seedContent = planContextEnvelope?.seed?.content ?? '';
  const { stories: assembled, warnings: supersedeWarnings } =
    assemblePlanStories(rawStories, {
      sharedSpec: techSpecContent,
      sourceTicketIds,
      // Audit footers carried onto every Story that did not attribute its own
      // `provenance`; empty for a `--tickets` run.
      provenanceSource: seedContent,
    });

  warnings.push(...supersedeWarnings);
  logWarnings(supersedeWarnings);

  // The dedup corpus is listed by `audit::*` label; footers alone leave the
  // Story invisible to an indexed sweep.
  const stories = withAuditLabels(assembled, seedContent);

  const assembledConflicts = analyzeAssembledStories({
    stories,
    rawFindings: validated.findings,
  });

  // The split gate runs before the first create; the same values feed the
  // summary so the refusal and the receipt cannot disagree.
  const waveTable = buildWaveTable(
    stories.map((s) => ({
      slug: s.slug,
      title: s.title,
      depends_on: s.depends_on,
    })),
  );

  // The dispatcher's own predicate over the assembled bodies, so a draft it
  // would serialize is refused here rather than promised as parallel.
  const waveCollisions = assertNoWaveCollisions(waveTable, stories, {
    tempRoot: getPaths(config).tempRoot,
  });

  const { created, planRunLabel, planRunLabelApplied } =
    await createStoryIssues({
      provider,
      stories,
      opts: { dryRun },
    });

  recordAuditFilings({ stories, created, tickets: rawStories, dryRun });

  const primary = created[0];

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
    conflictFindings: assembledConflicts,
    waveCollisions,
  });

  if (!dryRun) {
    await persistStoryArtifacts({ provider, created, summaryBody });
  }

  // Last among the writes: the Epic needs the children's numbers and database
  // ids. Never load-bearing — a failure degrades to "no container".
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
    // Closing a source ticket re-derives its container Epic's rollup.
    config,
    dryRun,
    closeSuperseded,
  });
  // Lets a run that superseded nothing say why.
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
    warnings,
    repairs: validated.repairs ?? [],
    waveTable,
    assumptionNormalizations: validated.normalizations ?? [],
    waveCollisions,
    supersede,
    epic: containerEpic,
  };
}
