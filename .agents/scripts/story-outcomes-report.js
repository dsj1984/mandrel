#!/usr/bin/env node

/**
 * story-outcomes-report.js — roll up the `story-outcome` records close writes
 * when `delivery.feedbackLoop.outcomeRecord` is on: per-Story rows, first-pass
 * rate, mean attempts to land, failed gates by count, and the same rates split
 * by the mandrel version of each landing. Read-only; one paginated read.
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import {
  OUTCOME_COMMENT_TYPE,
  parseOutcomeBody,
} from './lib/observability/story-outcome.js';
import { structuredCommentMarker } from './lib/orchestration/ticketing/reads.js';
import { createProvider } from './lib/provider-factory.js';

const USAGE = {
  invocation:
    'node .agents/scripts/story-outcomes-report.js [--since <YYYY-MM-DD>] [--json]',
  summary:
    'Summarize the per-Story close outcome records (story-outcome comments) updated in the window: per-Story rows, first-pass rate, mean attempts to land, blocked/failed share of attempts, failed gates ranked by count, and the same rates by landing mandrel version.',
  flags: [
    ['--since <YYYY-MM-DD>', 'Window start (default: 7 days ago).'],
    ['--json', 'Emit the report as JSON instead of a table.'],
  ],
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;

/** @param {number|null} r */
const pct = (r) => (r === null ? '-' : `${(r * 100).toFixed(1)}%`);
const ratio = (num, den) => (den > 0 ? num / den : null);
const mean = (values) =>
  values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;

function storyIdOf(comment) {
  const match = /\/issues\/(\d+)$/.exec(String(comment?.issue_url ?? ''));
  return match ? Number(match[1]) : null;
}

/** Latest outcome comment per Story, by `updated_at`. */
function latestPerStory(comments) {
  const marker = structuredCommentMarker(OUTCOME_COMMENT_TYPE);
  const byStory = new Map();
  for (const comment of comments ?? []) {
    if (!String(comment?.body ?? '').includes(marker)) continue;
    const storyId = storyIdOf(comment);
    const prior = byStory.get(storyId);
    if (!prior || String(comment.updated_at) > String(prior.updated_at)) {
      byStory.set(storyId, comment);
    }
  }
  return byStory;
}

function landingVersion(record) {
  const landing = record.attempts.findLast((a) => a?.status === 'landed');
  return landing?.mandrelVersion ?? 'unknown';
}

function storyRow(storyId, record) {
  const s = record.summary;
  return {
    storyId: record.storyId ?? storyId,
    attempts: s.attempts ?? 0,
    byStatus: s.byStatus ?? {},
    landed: Boolean(s.landedAt),
    firstPass: s.firstPass === true,
    landedOnAttempt: s.landedOnAttempt ?? null,
    failedGates: s.failedGates ?? {},
    mandrelVersion: s.landedAt ? landingVersion(record) : null,
  };
}

function landingRates(rows) {
  const landed = rows.filter((r) => r.landed);
  return {
    landed: landed.length,
    firstPassRate: ratio(
      landed.filter((r) => r.firstPass).length,
      landed.length,
    ),
    meanAttemptsToLand: mean(
      landed.map((r) => r.landedOnAttempt).filter(Number.isInteger),
    ),
  };
}

/**
 * @param {Array<object>} comments  raw repo issue comments.
 * @returns {object} the report.
 */
export function summarizeOutcomes(comments) {
  const rows = [];
  const unreadable = [];
  for (const [storyId, comment] of latestPerStory(comments)) {
    const record = parseOutcomeBody(comment.body);
    if (record) rows.push(storyRow(storyId, record));
    else unreadable.push({ storyId, commentId: comment.id ?? null });
  }
  rows.sort((a, b) => a.storyId - b.storyId);
  const totalAttempts = rows.reduce((n, r) => n + r.attempts, 0);
  const sumStatus = (status) =>
    rows.reduce((n, r) => n + (r.byStatus[status] ?? 0), 0);
  const gateCounts = {};
  for (const row of rows) {
    for (const [gate, count] of Object.entries(row.failedGates)) {
      gateCounts[gate] = (gateCounts[gate] ?? 0) + count;
    }
  }
  const versions = [
    ...new Set(rows.filter((r) => r.landed).map((r) => r.mandrelVersion)),
  ];
  return {
    stories: rows.length,
    ...landingRates(rows),
    blockedShare: ratio(sumStatus('blocked'), totalAttempts),
    failedShare: ratio(sumStatus('failed'), totalAttempts),
    failedGates: Object.entries(gateCounts)
      .map(([gate, count]) => ({ gate, count }))
      .sort((a, b) => b.count - a.count || a.gate.localeCompare(b.gate)),
    byMandrelVersion: Object.fromEntries(
      versions
        .sort()
        .map((v) => [
          v,
          landingRates(rows.filter((r) => r.mandrelVersion === v)),
        ]),
    ),
    unreadable,
    rows,
  };
}

/** @param {string[][]} rows @returns {string[]} space-padded columns. */
function alignRows(rows) {
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, i) => cell.padEnd(widths[i]))
      .join('  ')
      .trimEnd(),
  );
}

function renderReport(report) {
  const fmtMean = (m) => (m === null ? '-' : m.toFixed(2));
  const storyTable = alignRows([
    ['story', 'attempts', 'landed', 'first-pass', 'version', 'failed gates'],
    ...report.rows.map((r) => [
      `#${r.storyId}`,
      String(r.attempts),
      r.landed ? 'yes' : 'no',
      r.firstPass ? 'yes' : 'no',
      r.mandrelVersion ?? '-',
      Object.keys(r.failedGates).join(', ') || '-',
    ]),
  ]);
  const versionTable = alignRows([
    ['version', 'landed', 'first-pass', 'mean attempts'],
    ...Object.entries(report.byMandrelVersion).map(([v, r]) => [
      v,
      String(r.landed),
      pct(r.firstPassRate),
      fmtMean(r.meanAttemptsToLand),
    ]),
  ]);
  return [
    ...storyTable,
    '',
    `stories ${report.stories} · landed ${report.landed} · first-pass ${pct(report.firstPassRate)} · mean attempts to land ${fmtMean(report.meanAttemptsToLand)} · blocked ${pct(report.blockedShare)} · failed ${pct(report.failedShare)} of attempts`,
    `failed gates: ${report.failedGates.map((g) => `${g.gate} ${g.count}`).join(', ') || 'none'}`,
    '',
    ...versionTable,
    ...(report.unreadable.length > 0
      ? [
          '',
          `unreadable: ${report.unreadable.map((u) => `#${u.storyId}`).join(', ')}`,
        ]
      : []),
    '',
  ].join('\n');
}

/**
 * @param {string[]} [argv]
 * @param {{ resolveConfigImpl?: typeof resolveConfig,
 *   providerFactory?: typeof createProvider,
 *   stdout?: { write: (s: string) => void }, cwd?: string, nowMs?: number }} [deps]
 * @returns {Promise<object>} the report.
 */
export async function runStoryOutcomesReport(
  argv = process.argv.slice(2),
  deps = {},
) {
  const {
    resolveConfigImpl = resolveConfig,
    providerFactory = createProvider,
    stdout = process.stdout,
    cwd = process.cwd(),
    nowMs = Date.now(),
  } = deps;
  const { values } = parseArgs({
    args: argv,
    options: { since: { type: 'string' }, json: { type: 'boolean' } },
  });
  if (values.since !== undefined && !DATE.test(values.since)) {
    throw new Error(
      `story-outcomes-report: --since must be YYYY-MM-DD (got "${values.since}").`,
    );
  }
  const since = values.since
    ? `${values.since}T00:00:00Z`
    : new Date(nowMs - DEFAULT_WINDOW_DAYS * DAY_MS).toISOString();
  const provider = providerFactory(resolveConfigImpl({ cwd }));
  const report = summarizeOutcomes(await provider.getRepoCommentsSince(since));
  stdout.write(
    values.json
      ? `${JSON.stringify({ since, ...report }, null, 2)}\n`
      : renderReport(report),
  );
  return report;
}

async function main() {
  await runStoryOutcomesReport();
  return 0;
}

runAsCli(import.meta.url, main, {
  source: 'story-outcomes-report',
  propagateExitCode: true,
  errorPrefix: '[story-outcomes-report] ❌ Fatal error',
  usage: USAGE,
});
