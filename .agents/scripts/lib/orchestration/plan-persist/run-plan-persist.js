/**
 * run-plan-persist.js — flat Story persist for the v2 `/plan` collapse
 * (Stage 3 — `docs/roadmap.md`).
 *
 * Ordered, fail-closed pipeline:
 *
 *   1. Risk-verdict presence (schema validation is CLI-owned)
 *   2. Ticket validator + file-assumption + DAG + capacity + budget
 *   3. Draft reachability (named soft failure, exit 3)
 *   4. Split-policy partition (`assertAcceptancePartition`) + spec fold/spill
 *   5. Create Story issues (`type::story` + `agent::ready`; `plan-run::`
 *      label when N>1)
 *   6. Upsert `risk-verdict` + `story-plan-state` on every created Story;
 *      upsert `plan-summary` on the primary Story
 *   7. Temp cleanup at terminal success only
 *
 * Hard cutover: no Epic parent, no reconciler, no `deliveryShape`, no
 * `--amend` tree cascades. Those surfaces die with Stages 4–5 for any
 * remaining epic-delivery readers.
 *
 * @module lib/orchestration/plan-persist/run-plan-persist
 */

import { rm } from 'node:fs/promises';

import { getLimits, PROJECT_ROOT } from '../../config-resolver.js';
import { gitSpawn } from '../../git-utils.js';
import { Logger } from '../../Logger.js';
import { evaluatePlanCritics } from '../plan-critics-evaluate.js';
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
import { upsertStructuredComment } from '../ticketing.js';
import {
  enforceFanOutGate,
  surfaceSoftConflictFindings,
} from './fan-out-gate.js';
import { validateTickets } from './persist-helpers.js';
import { assemblePlanStories, createStoryIssues } from './story-ops.js';
import {
  buildPlanSummaryCommentBody,
  buildWaveTable,
  PLAN_SUMMARY_COMMENT_TYPE,
} from './summary.js';

/** Checkpoint schema version written on the primary Story. */
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
  if (assumptionFailures.length === 0) return;
  const gateBaseRef = config?.baseBranch ?? settings?.baseBranch ?? 'main';
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
}

function riskVerdictCommentBody(riskVerdict) {
  return [
    '### risk-verdict',
    '',
    '```json',
    JSON.stringify(riskVerdict, null, 2),
    '```',
  ].join('\n');
}

/**
 * Execute the flat Story persist end to end.
 *
 * @param {{
 *   provider: object,
 *   artifacts: {
 *     stories: Array<object>,
 *     riskVerdict: object,
 *     techSpecContent?: string|null,
 *     planAcceptance?: string[]|null,
 *   },
 *   config?: object,
 *   settings?: object,
 *   opts?: {
 *     forceReview?: boolean,
 *     allowOverBudget?: boolean,
 *     allowLargeFanOut?: boolean,
 *     skipCleanup?: boolean,
 *     dryRun?: boolean,
 *     personaLabel?: string,
 *     planRunId?: string,
 *     planDir?: string,
 *     fanOutCounter?: Function,
 *     cwd?: string,
 *     spillFs?: object,
 *     writeSpill?: boolean,
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
    riskVerdict,
    techSpecContent = null,
    planAcceptance = null,
  } = artifacts ?? {};
  const {
    forceReview = false,
    allowOverBudget = false,
    allowLargeFanOut = false,
    skipCleanup = false,
    dryRun = false,
    personaLabel,
    planRunId,
    planDir = null,
    fanOutCounter = undefined,
    cwd = PROJECT_ROOT,
    spillFs = undefined,
    writeSpill = !dryRun,
  } = opts;

  if (!riskVerdict || !Array.isArray(riskVerdict.axes)) {
    throw new Error(
      '[plan-persist] risk verdict is required — author risk-verdict.json ' +
        'and pass it with --risk-verdict.',
    );
  }
  if ('deliveryShape' in (riskVerdict ?? {})) {
    throw new Error(
      '[plan-persist] risk-verdict.deliveryShape was removed in v2 Stage 3 — ' +
        'delete the field; persist always creates Story issue(s).',
    );
  }
  if (!Array.isArray(rawStories) || rawStories.length === 0) {
    throw new Error(
      '[plan-persist] stories payload must be a non-empty array ' +
        '(--stories <file>). Default is one Story.',
    );
  }

  const maxTickets = getLimits(config).maxTickets;
  if (rawStories.length > maxTickets && !allowOverBudget) {
    throw new Error(
      `[plan-persist] Stories (${rawStories.length}) exceed the reviewability ` +
        `budget (${maxTickets}). Re-scope, or rerun with --allow-over-budget.`,
    );
  }
  if (rawStories.length > maxTickets && allowOverBudget) {
    Logger.warn(
      `[plan-persist] Persisting an over-budget plan: ${rawStories.length} ` +
        `Stories vs. budget ${maxTickets} (--allow-over-budget).`,
    );
  }

  Logger.info(
    `[plan-persist] Running cross-validation on ${rawStories.length} Story ticket(s)...`,
  );
  const validated = validateTickets(rawStories, config, {
    fanOutCounter,
    cwd,
    modelCapacity: config?.planning?.modelCapacity,
    maxTokenBudget: getLimits(config).maxTokenBudget,
  });
  enforceFanOutGate(validated.findings, allowLargeFanOut, 'plan-persist');
  surfaceSoftConflictFindings(validated.findings, 'plan-persist');
  enforceTicketValidation(validated, { config, settings, cwd });

  const reachability = evaluateDraftReachability({
    tickets: rawStories,
    config,
  });
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

  const critics = evaluatePlanCritics({
    techSpecContent: techSpecContent ?? '',
    riskVerdict,
    tickets: rawStories,
    config,
  });
  for (const decision of [critics.consolidation, critics.premortem]) {
    Logger.info(
      `[plan-persist] critic ${decision.critic}: ` +
        `${decision.dispatch ? 'dispatch' : 'skip'} — ` +
        decision.reasons.join('; '),
    );
    if (!decision.dispatch) {
      await appendCriticSkip(
        {
          critic: decision.critic,
          reasons: decision.reasons,
          cli: 'plan-persist',
        },
        config,
      );
    }
  }

  // Split policy + folded spec (spill) — still before any provider call when
  // writeSpill is false; production writes spilled docs just before create.
  const { stories, spills } = assemblePlanStories(rawStories, {
    sharedSpec: techSpecContent,
    planAcceptance: planAcceptance ?? undefined,
    repoRoot: cwd,
    write: writeSpill,
    fs: spillFs,
  });

  const planningRisk = deriveRiskEnvelope(riskVerdict);
  const reviewRouting = resolveReviewRouting({
    planningRisk,
    forceReview,
  });

  const { created, planRunLabel } = await createStoryIssues({
    provider,
    stories,
    opts: { personaLabel, planRunId, dryRun },
  });

  const primary = created[0];
  const waveTable = buildWaveTable(
    stories.map((s) => ({
      slug: s.slug,
      title: s.title,
      depends_on: s.depends_on,
    })),
  );

  let planMetricsLine = null;
  try {
    const metrics = summarizePlanMetrics(await readPlanMetrics(config));
    planMetricsLine = renderPlanMetricsSummaryLine(metrics);
  } catch {
    planMetricsLine = null;
  }

  const summaryBody = buildPlanSummaryCommentBody({
    epicId: primary.id,
    ticketCount: created.length,
    planningRisk,
    reviewRouting,
    freshness: { stale: 0, ambiguous: 0 },
    healthcheck: { skipped: true },
    waveTable,
    mode: 'stories',
    planMetricsLine,
    stories: created,
    planRunLabel,
  });

  if (!dryRun) {
    for (const story of created) {
      await upsertStructuredComment(
        provider,
        story.id,
        'risk-verdict',
        riskVerdictCommentBody(riskVerdict),
      );
      await writeCheckpointV2(provider, story.id, {
        planningRisk,
        riskVerdict,
        reviewRouting,
        persist: {
          completedAt: new Date().toISOString(),
          storyCount: created.length,
          planRunLabel,
          primaryStoryId: primary.id,
          stories: created.map((createdStory) => ({
            slug: createdStory.slug,
            id: createdStory.id,
          })),
          spills: spills.map((spill) => ({
            slug: spill.slug,
            spilled: spill.spill.spilled,
            docPath: spill.spill.docPath,
          })),
        },
      });
    }
    await upsertStructuredComment(
      provider,
      primary.id,
      PLAN_SUMMARY_COMMENT_TYPE,
      summaryBody,
    );
  }

  if (!skipCleanup && planDir) {
    try {
      await rm(planDir, { recursive: true, force: true });
    } catch (err) {
      Logger.warn(`[plan-persist] temp cleanup skipped: ${err.message}`);
    }
  }

  Logger.info(
    `[plan-persist] Persisted ${created.length} Story(ies)` +
      (planRunLabel ? ` under ${planRunLabel}` : '') +
      `; primary #${primary.id} is agent::ready.`,
  );

  return {
    stories: created,
    primaryStoryId: primary.id,
    planRunLabel,
    planningRisk,
    reviewRouting,
    critics,
    reachability,
    spills,
    waveTable,
  };
}
