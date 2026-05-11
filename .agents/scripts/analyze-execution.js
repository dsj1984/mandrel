#!/usr/bin/env node

/**
 * analyze-execution.js — single writer of the structured perf-summary
 * comments (Epic #1030 / Story #1123).
 *
 * Reads NDJSON from `temp/epic-<eid>/story-<sid>/signals.ndjson` and
 * upserts one of two structured comments:
 *
 *   - `--story <sid> --epic <eid>` (Story mode): posts
 *     `<!-- structured:story-perf-summary -->` on the Story ticket. The
 *     payload combines the Story's NDJSON signals with the timing
 *     summary written by `post-merge-close.js` to
 *     `temp/epic-<eid>/story-<sid>/phase-timings.json` (path overridable
 *     via `--phase-timings <path>`).
 *
 *   - `--epic <eid>` (Epic mode): rolls up every Story under the Epic by
 *     fetching each `story-perf-summary` structured comment from the
 *     ticketing provider. Posts the
 *     `<!-- structured:epic-perf-report -->` comment on the Epic ticket.
 *     Run from the retro composer / `/epic-deliver` Phase 6.0.
 *
 * Both modes are idempotent: `upsertStructuredComment` deletes the prior
 * marker before posting the new one.
 *
 * Exit code is `0` on success, `0` on tolerated soft failures (missing
 * NDJSON for a Story, no children for an Epic) so the close pipelines
 * never block on observability output. Hard failures (bad CLI args,
 * provider error, schema-violating payload) exit non-zero — the call
 * sites in post-merge-pipeline / `/epic-deliver` Phase 5 treat that
 * as a non-fatal warning.
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
import { signalsFile, storyArtifactPath } from './lib/config/temp-paths.js';
import { PROJECT_ROOT, resolveConfig } from './lib/config-resolver.js';
import { gitSpawn } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import { computeBaselineRefreshRate } from './lib/observability/baseline-refresh-rate.js';
import {
  computeEpicPerfReport,
  computeStoryPerfSummary,
} from './lib/observability/perf-aggregator.js';
import { forEachLine } from './lib/observability/signals-writer.js';
import { upsertStructuredComment } from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';

const STORY_PERF_TYPE = 'story-perf-summary';
const EPIC_PERF_TYPE = 'epic-perf-report';
// Marker emitted by `upsertStructuredComment` for the story-perf-summary
// type. Mirrors `structuredCommentMarker(STORY_PERF_TYPE)` so the Epic
// rollup can detect summary comments without importing the renderer.
const STORY_PERF_MARKER = `<!-- ap:structured-comment type="${STORY_PERF_TYPE}" -->`;

/**
 * Read every NDJSON line from a Story's signals stream into an array.
 * Missing files resolve to `[]` so callers can treat absence as
 * "no signals yet" without a try/catch.
 */
async function readStorySignals(epicId, storyId, config) {
  const events = [];
  await forEachLine(
    epicId,
    storyId,
    (parsed) => {
      if (parsed && typeof parsed === 'object') events.push(parsed);
    },
    config,
  );
  return events;
}

/**
 * Best-effort read of the per-Story phase-timings JSON written by
 * `post-merge-close.js`. Returns `null` when the file is missing or
 * malformed — phaseTimingsMs in the StoryPerfSummary degrades to `{}`
 * rather than throwing.
 */
async function readPhaseTimings(epicId, storyId, config, overridePath) {
  const target =
    overridePath ??
    storyArtifactPath(epicId, storyId, 'phase-timings.json', config);
  try {
    const buf = await fs.readFile(target, 'utf8');
    const parsed = JSON.parse(buf);
    if (parsed && typeof parsed === 'object') return parsed;
    return null;
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    Logger.warn(
      `[analyze-execution] could not parse phase-timings at ${target}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * Render a small operator-facing summary block that doubles as the
 * comment body. The fenced JSON payload is the canonical machine-
 * readable surface; the prose lines above it give a human a reason to
 * skim. The retro composer reads the fenced JSON, not the prose.
 */
function renderStoryBody(payload) {
  const friction = Object.entries(payload.frictionByCategory ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  const phaseRows = Object.entries(payload.phaseTimingsMs ?? {})
    .map(([k, v]) => `- \`${k}\`: ${v}ms`)
    .join('\n');
  const lines = [
    `### Story Perf Summary — Story #${payload.storyId} (Epic #${payload.epicId})`,
    '',
    `Closed at: \`${payload.closedAt}\``,
    '',
    friction.length > 0
      ? `**Friction:** ${friction}`
      : '**Friction:** none recorded',
    '',
    phaseRows.length > 0
      ? `**Phase timings:**\n${phaseRows}`
      : '**Phase timings:** none recorded',
    '',
    `**Rework:** ${payload.reworkScore.filesEditedBeyondThreshold} files beyond threshold`,
    `**Retries:** ${payload.retryDensity.retries} across ${payload.retryDensity.uniqueCommands} unique command(s)`,
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ];
  return lines.join('\n');
}

/**
 * Render the per-Epic baseline-refresh-rate row (Story #1400 / Task #1427).
 * Returns an empty string when `refresh` is null so the caller can
 * concatenate unconditionally.
 */
function renderBaselineRefreshRateRow(refresh) {
  if (!refresh) return '';
  const row = (refresh.perEpic ?? [])[0];
  if (!row) {
    return [
      '',
      `**Baseline refresh discipline (trailing ${refresh.windowDays}d):** no Story merges in window`,
      '',
    ].join('\n');
  }
  const pct = (row.cleanMergeRate * 100).toFixed(1);
  const target = row.cleanMergeRate >= 0.9 ? '✅' : '⚠️';
  return [
    '',
    `**Baseline refresh discipline (trailing ${refresh.windowDays}d):** ${target} ${pct}% clean-merge rate (${row.storyMerges - row.baselineRefreshes}/${row.storyMerges} Stories landed without follow-up refresh; ${row.baselineRefreshes} \`baseline-refresh:\` commit(s))`,
    '',
  ].join('\n');
}

function renderEpicBody(payload, extras = {}) {
  const counts = payload.signalCounts ?? {};
  const countLine = Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  const hotspots = (payload.topHotspots ?? [])
    .map(
      (h) =>
        `- \`${h.phase}\` — ${h.occurrences} occurrence(s), avg ratio ${h.avgRatio.toFixed(2)}`,
    )
    .join('\n');
  const friction = (payload.mostFrictionStories ?? [])
    .map((s) => `- Story #${s.storyId}: ${s.frictionCount} friction signal(s)`)
    .join('\n');
  const lines = [
    `### Epic Perf Report — Epic #${payload.epicId}`,
    '',
    `Generated at: \`${payload.generatedAt}\``,
    '',
    `**Signal counts:** ${countLine.length > 0 ? countLine : 'none'}`,
    '',
    hotspots.length > 0
      ? `**Top hotspots:**\n${hotspots}`
      : '**Top hotspots:** none recorded',
    '',
    friction.length > 0
      ? `**Most-friction Stories:**\n${friction}`
      : '**Most-friction Stories:** none recorded',
    renderBaselineRefreshRateRow(extras.baselineRefreshRate),
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ];
  return lines.join('\n');
}

/**
 * Extract a story-perf-summary payload from a comment body. The body
 * begins with the structured marker line, followed by markdown prose,
 * followed by a fenced ```json``` block carrying the canonical payload.
 * We pull the first ```json fence between the marker and end-of-body.
 *
 * Returns `null` when the marker is missing, no fence is found, or the
 * fence does not parse — the caller treats absence as "no signal" and
 * keeps walking.
 */
export function extractStoryPerfSummaryFromComment(body) {
  if (typeof body !== 'string' || !body.includes(STORY_PERF_MARKER)) {
    return null;
  }
  const fenceMatch = body.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!fenceMatch) return null;
  try {
    const parsed = JSON.parse(fenceMatch[1]);
    if (parsed && parsed.kind === 'story-perf-summary') return parsed;
    return null;
  } catch {
    return null;
  }
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

  const payload = computeStoryPerfSummary(events, {
    storyId,
    epicId,
    closedAt: now().toISOString(),
    phaseTiming,
  });

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
 * Fetch every `story-perf-summary` structured comment from the Stories
 * under an Epic. We rely on `provider.getSubTickets(epicId)` for child
 * enumeration (Stories carry `parent: #<epicId>` either via the native
 * sub-issue link or the body marker — `getSubTickets` reconciles both).
 * Missing comments are skipped (the Story may have been recut and not
 * closed yet).
 */
async function collectStorySummaries(provider, epicId, logger) {
  let stories;
  try {
    const children = await provider.getSubTickets(epicId);
    stories = Array.isArray(children) ? children : [];
  } catch (err) {
    logger.warn?.(
      `[analyze-execution] getSubTickets(${epicId}) failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
  // Filter to Story tickets — descendants include Tasks too. We only
  // want the per-Story summaries, so guard on `type::story`.
  const storyTickets = stories.filter(
    (t) =>
      Array.isArray(t?.labels) &&
      t.labels.some(
        (l) => (typeof l === 'string' ? l : l?.name) === 'type::story',
      ),
  );

  const summaries = [];
  for (const ticket of storyTickets) {
    const id = Number(ticket.id ?? ticket.number);
    if (!Number.isInteger(id) || id < 1) continue;
    let comments;
    try {
      comments = (await provider.getTicketComments(id)) ?? [];
    } catch (err) {
      logger.warn?.(
        `[analyze-execution] getTicketComments(${id}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    for (const c of comments) {
      const parsed = extractStoryPerfSummaryFromComment(c?.body);
      if (parsed) {
        summaries.push(parsed);
        break;
      }
    }
  }
  return summaries;
}

/**
 * Default git-log gatherer for the baseline-refresh-rate reporter
 * (Story #1400 / Task #1427). Reads commits on `epic/<id>` over the
 * trailing window and shapes them into the record format the pure
 * reporter expects. Returns `[]` on any spawn failure so the retro
 * comment keeps composing — the reporter then prints "no Story merges
 * in window" and the operator can investigate offline.
 *
 * Injectable via `runEpicMode({ gatherEpicCommitsFn })` so the unit test
 * can pin behavior without a temp git repo.
 */
function gatherEpicCommitsFromGit({ epicId, windowDays, cwd, logger }) {
  const ref = `epic/${epicId}`;
  const since = `${windowDays} days ago`;
  // Subject (%s) carries the Story-merge `(resolves #N)` and the
  // `baseline-refresh:` prefix; ISO commit date (%cI) drives the window
  // filter inside the reporter. Tab separator avoids subjects that
  // contain pipes.
  const res = gitSpawn(
    cwd,
    'log',
    ref,
    `--since=${since}`,
    '--pretty=format:%H%x09%cI%x09%s',
  );
  if (res.status !== 0) {
    logger.warn?.(
      `[analyze-execution] git log ${ref} failed (non-fatal): ${res.stderr || res.stdout}`,
    );
    return [];
  }
  const lines = (res.stdout || '').split('\n').filter(Boolean);
  return lines.map((line) => {
    const [sha, isoDate, ...rest] = line.split('\t');
    return {
      sha,
      isoDate,
      subject: rest.join('\t'),
      epicId,
    };
  });
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
 * }} ctx
 * @returns {Promise<{ commentId: number, payload: object, baselineRefreshRate: object | null }>}
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

  logger.info?.(`[analyze-execution] epic-mode epic=#${epicId}`);

  const summaries = await collectFn(provider, epicId, logger);
  const payload = computeEpicPerfReport(summaries, {
    epicId,
    generatedAt: now().toISOString(),
  });

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

  const body = renderEpicBody(payload, {
    baselineRefreshRate,
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
    Logger.fatal(
      'Usage: analyze-execution.js --epic <eid> [--story <sid>] [--phase-timings <path>]',
    );
  }

  const cwd = path.resolve(args.cwd ?? PROJECT_ROOT);
  const config = resolveConfig({ cwd });
  const provider = createProvider(config.orchestration);

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
