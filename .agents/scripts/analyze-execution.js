#!/usr/bin/env node

/**
 * analyze-execution.js — single writer of the structured perf-summary
 * comments (Epic #1030 / Story #1123).
 *
 * Reads NDJSON from `temp/epic-<eid>/stories/story-<sid>/signals.ndjson` and
 * upserts one of two structured comments:
 *
 *   - `--story <sid> --epic <eid>` (Story mode): posts
 *     `<!-- structured:story-perf-summary -->` on the Story ticket. The
 *     payload combines the Story's NDJSON signals with the timing
 *     summary written by `post-merge-close.js` to
 *     `temp/epic-<eid>/stories/story-<sid>/phase-timings.json` (path overridable
 *     via `--phase-timings <path>`).
 *
 *   - `--epic <eid>` (Epic mode): rolls up every Story under the Epic by
 *     fetching each `story-perf-summary` structured comment from the
 *     ticketing provider. Posts the
 *     `<!-- structured:epic-perf-report -->` comment on the Epic ticket.
 *     Run from the retro composer / `/deliver` Phase 6.0.
 *
 * Both modes are idempotent: `upsertStructuredComment` deletes the prior
 * marker before posting the new one.
 *
 * Exit code is `0` on success, `0` on tolerated soft failures (missing
 * NDJSON for a Story, no children for an Epic) so the close pipelines
 * never block on observability output. Hard failures (bad CLI args,
 * provider error, schema-violating payload) exit non-zero — the call
 * sites in post-merge-pipeline / `/deliver` Phase 5 treat that
 * as a non-fatal warning.
 *
 * This file is a thin CLI: it wires the I/O readers from
 * `lib/observability/perf-report-readers.js` to the pure renderers in
 * `lib/observability/perf-report-render.js` inside `runStoryMode` /
 * `runEpicMode`, then parses argv and dispatches. The report-formatting
 * and signal-reading logic live in those two modules so report formatting
 * is unit-testable without fixtures (Story #3350).
 *
 * Usage:
 *   node .agents/scripts/analyze-execution.js --story <sid> --epic <eid> \
 *       [--phase-timings <path>]
 *   node .agents/scripts/analyze-execution.js --epic <eid>
 *
 * @see docs/data-dictionary.md §StoryPerfSummary, §EpicPerfReport
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { signalsFile } from './lib/config/temp-paths.js';
import { PROJECT_ROOT, resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { computeBaselineRefreshRate } from './lib/observability/baseline-refresh-rate.js';
import {
  computeEpicPerfReport,
  computeStoryPerfSummary,
} from './lib/observability/perf-aggregator.js';
import {
  aggregateBaselineFrictionFromSignals,
  collectStorySummaries,
  gatherEpicCommitsFromGit,
  readEpicLifecycleEvents,
  readGhSpawnCount,
  readPhaseTimings,
  readStorySignals,
} from './lib/observability/perf-report-readers.js';
import {
  EPIC_PERF_TYPE,
  renderEpicBody,
  renderStoryBody,
  STORY_PERF_TYPE,
} from './lib/observability/perf-report-render.js';
import { upsertStructuredComment } from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';

// Re-exported so existing importers (tests, retro composer) keep a stable
// entry point after the read/render split (Story #3350).
export { extractStoryPerfSummaryFromComment } from './lib/observability/perf-report-render.js';

/**
 * Resolve the wave-execution concurrency cap from the resolved config
 * (`delivery.deliverRunner.concurrencyCap`), falling back to the
 * dispatcher's safe default of 2. Story #3025 / Task #3030.
 */
function resolveConcurrencyCap(config) {
  const cap = config?.delivery?.deliverRunner?.concurrencyCap;
  return Number.isInteger(cap) && cap >= 1 ? cap : 2;
}

/**
 * Resolve the verify-results concurrency cap from the resolved config
 * (`delivery.deliverRunner.verifyConcurrencyCap`), falling back to 4.
 * Story #3025 / Task #3030.
 */
function resolveVerifyConcurrencyCap(config) {
  const cap = config?.delivery?.deliverRunner?.verifyConcurrencyCap;
  return Number.isInteger(cap) && cap >= 1 ? cap : 4;
}

/**
 * Story mode: read NDJSON + phase-timings, build the payload, upsert.
 *
 * @param {{
 *   storyId: number,
 *   epicId: number,
 *   phaseTimingsPath?: string|null,
 *   provider: object,
 *   config: object,
 *   logger?: object,
 *   now?: () => Date,
 * }} ctx
 * @returns {Promise<{ commentId: number, payload: object }>}
 */
export async function runStoryMode(ctx) {
  const { storyId, epicId, provider, config } = ctx;
  const logger = ctx.logger ?? Logger;
  const now = ctx.now ?? (() => new Date());

  logger.info?.(
    `[analyze-execution] story-mode story=#${storyId} epic=#${epicId}`,
  );

  const events = await readStorySignals(epicId, storyId, config);
  const phaseTiming = await readPhaseTimings(
    epicId,
    storyId,
    config,
    ctx.phaseTimingsPath ?? null,
  );
  const ghSpawnCount = await readGhSpawnCount(epicId, storyId, config);

  const payload = computeStoryPerfSummary(events, {
    storyId,
    epicId,
    closedAt: now().toISOString(),
    phaseTiming,
  });
  if (ghSpawnCount !== null) {
    // Throw-away measurement field (Story #1795). Surfaces the in-process
    // `gh-exec.getSpawnCount()` snapshot captured at the end of close
    // validation so the Story-close structured comment can be diffed
    // against the baseline recorded under `temp/epic-1788/` for the
    // "≥100 fewer spawns" acceptance criterion.
    payload.ghSpawnCount = ghSpawnCount;
  }

  const body = renderStoryBody(payload);
  const result = await upsertStructuredComment(
    provider,
    storyId,
    STORY_PERF_TYPE,
    body,
  );
  logger.info?.(
    `[analyze-execution] story-perf-summary upserted on Story #${storyId} (commentId=${result.commentId})`,
  );
  return { commentId: result.commentId, payload };
}

/**
 * Epic mode: collect every Story's perf summary, roll them up, upsert
 * the epic-perf-report comment.
 *
 * @param {{
 *   epicId: number,
 *   provider: object,
 *   config?: object,
 *   cwd?: string,
 *   windowDays?: number,
 *   logger?: object,
 *   now?: () => Date,
 *   collectSummariesFn?: typeof collectStorySummaries,
 *   gatherEpicCommitsFn?: typeof gatherEpicCommitsFromGit,
 *   aggregateFrictionFn?: typeof aggregateBaselineFrictionFromSignals,
 * }} ctx
 * @returns {Promise<{ commentId: number, payload: object, baselineRefreshRate: object | null, qualityGateFriction: object | null }>}
 */
export async function runEpicMode(ctx) {
  const { epicId, provider } = ctx;
  const logger = ctx.logger ?? Logger;
  const now = ctx.now ?? (() => new Date());
  const windowDays =
    Number.isFinite(ctx.windowDays) && ctx.windowDays > 0
      ? Math.floor(ctx.windowDays)
      : 28;
  const collectFn = ctx.collectSummariesFn ?? collectStorySummaries;
  const gatherCommitsFn = ctx.gatherEpicCommitsFn ?? gatherEpicCommitsFromGit;
  const aggregateFrictionFn =
    ctx.aggregateFrictionFn ?? aggregateBaselineFrictionFromSignals;

  logger.info?.(`[analyze-execution] epic-mode epic=#${epicId}`);

  const summaries = await collectFn(provider, epicId, logger);

  // Story #3025 / Task #3030 — forward lifecycle events to the
  // aggregator so the report's `waveParallelism` array is populated
  // (the analyzer used to omit the field, leaving the report at `[]`).
  const readLifecycleEventsFn =
    ctx.readLifecycleEventsFn ?? readEpicLifecycleEvents;
  const lifecycleEvents = ctx.config
    ? await readLifecycleEventsFn(epicId, ctx.config, logger)
    : [];
  const concurrencyCap = resolveConcurrencyCap(ctx.config);
  const verifyConcurrencyCap = resolveVerifyConcurrencyCap(ctx.config);

  // Only forward `events` when we actually have something — passing an
  // empty array suppresses the friction-from-summaries fallback in
  // `computeEpicPerfReport.buildSignalCounts`, which would zero the
  // counts for callers that have summaries but no lifecycle stream
  // (e.g. legacy/test paths without a `config`).
  const reportOpts = {
    epicId,
    generatedAt: now().toISOString(),
    concurrencyCap,
    verifyConcurrencyCap,
  };
  if (lifecycleEvents.length > 0) {
    reportOpts.events = lifecycleEvents;
  }

  const payload = computeEpicPerfReport(summaries, reportOpts);

  // Story #1400 / Task #1427 — baseline-refresh-rate row. Pure reporter
  // operates on a fixture of git-log records gathered by the injected
  // `gatherEpicCommitsFn`. A spawn failure surfaces as `[]` and degrades
  // to the "no Story merges in window" line in the rendered body.
  let baselineRefreshRate = null;
  try {
    const commits = await gatherCommitsFn({
      epicId,
      windowDays,
      cwd: ctx.cwd ?? process.cwd(),
      logger,
    });
    baselineRefreshRate = computeBaselineRefreshRate(commits, {
      windowDays,
      now,
    });
  } catch (err) {
    logger.warn?.(
      `[analyze-execution] baseline-refresh-rate gather failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Story #1400 / Task #1429 — Quality gate friction block. Aggregates
  // `baseline-refresh-regression` records from the existing
  // signals.ndjson stream (no new file format).
  let qualityGateFriction = null;
  if (ctx.config) {
    try {
      const storyIds = (summaries ?? [])
        .map((s) => s?.storyId)
        .filter((n) => Number.isInteger(n) && n > 0);
      qualityGateFriction = await aggregateFrictionFn({
        epicId,
        storyIds,
        config: ctx.config,
        windowDays,
        now,
      });
    } catch (err) {
      logger.warn?.(
        `[analyze-execution] quality-gate-friction aggregate failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const body = renderEpicBody(payload, {
    baselineRefreshRate,
    qualityGateFriction,
  });
  const result = await upsertStructuredComment(
    provider,
    epicId,
    EPIC_PERF_TYPE,
    body,
  );
  logger.info?.(
    `[analyze-execution] epic-perf-report upserted on Epic #${epicId} (commentId=${result.commentId}, stories=${summaries.length})`,
  );
  return {
    commentId: result.commentId,
    payload,
    baselineRefreshRate,
    qualityGateFriction,
  };
}

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      story: { type: 'string' },
      epic: { type: 'string' },
      'phase-timings': { type: 'string' },
      'window-days': { type: 'string' },
      cwd: { type: 'string' },
    },
    strict: false,
  });
  const story = values.story != null ? Number.parseInt(values.story, 10) : null;
  const epic = values.epic != null ? Number.parseInt(values.epic, 10) : null;
  const windowDays =
    values['window-days'] != null
      ? Number.parseInt(values['window-days'], 10)
      : null;
  return {
    storyId: Number.isInteger(story) && story > 0 ? story : null,
    epicId: Number.isInteger(epic) && epic > 0 ? epic : null,
    phaseTimingsPath: values['phase-timings'] ?? null,
    windowDays:
      Number.isInteger(windowDays) && windowDays > 0 ? windowDays : null,
    cwd: values.cwd ?? null,
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseCli(argv);

  if (!args.epicId) {
    throw new Error(
      'Usage: analyze-execution.js --epic <eid> [--story <sid>] [--phase-timings <path>]',
    );
  }

  const cwd = path.resolve(args.cwd ?? PROJECT_ROOT);
  const config = resolveConfig({ cwd });
  const provider = createProvider(config);

  if (args.storyId) {
    // Existence guard: surface a clear log when the Story has no signals
    // yet, but still post the comment with empty arrays so the marker
    // exists for idempotence checks downstream.
    const sigPath = signalsFile(args.epicId, args.storyId, config);
    try {
      await fs.access(sigPath);
    } catch {
      Logger.info?.(
        `[analyze-execution] no signals.ndjson at ${sigPath} — posting empty story-perf-summary`,
      );
    }
    const result = await runStoryMode({
      storyId: args.storyId,
      epicId: args.epicId,
      phaseTimingsPath: args.phaseTimingsPath,
      provider,
      config,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  const result = await runEpicMode({
    epicId: args.epicId,
    provider,
    config,
    cwd,
    windowDays: args.windowDays ?? undefined,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

runAsCli(import.meta.url, main, { source: 'analyze-execution' });
