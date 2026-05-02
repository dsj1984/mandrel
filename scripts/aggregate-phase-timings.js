#!/usr/bin/env node

/**
 * aggregate-phase-timings.js — phase-timings aggregator CLI.
 *
 * Reads the `phase-timings` structured comments that `story-close`
 * posts on every closed Story, across a caller-supplied list of Epic IDs,
 * and prints p50/p95 per phase plus recommended concurrency caps for the
 * three v5.21.0 `concurrentMap` adoption sites (wave-gate, commit-assertion,
 * progress-reporter).
 *
 * The recommendations are advisory: the output is meant to feed the defaults
 * chosen for `orchestration.runners.concurrency.{waveGate,
 * commitAssertion, progressReporter}` in `default-agentrc.json`.
 *
 * Usage:
 *   node .agents/scripts/aggregate-phase-timings.js --epic 553 --epic 600 [--epic N ...]
 *   node .agents/scripts/aggregate-phase-timings.js --from-file epics.txt
 *   node .agents/scripts/aggregate-phase-timings.js --epic 553 --out temp/timings.md
 *
 * --from-file accepts one Epic ID per line (blank lines and `#` comments
 * are ignored).
 *
 * Exit codes:
 *   0 — summary printed (even if some Epics had zero phase-timings, that
 *       case is reported as a warning).
 *   1 — no Epics supplied, or every supplied Epic failed to produce any
 *       parseable samples.
 *   2 — configuration / provider error.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { createProvider } from './lib/provider-factory.js';

const PHASE_TIMINGS_MARKER = 'phase-timings';

/** Canonical phase order (matches lib/util/phase-timer.js). */
export const PHASE_ORDER = Object.freeze([
  'worktree-create',
  'bootstrap',
  'install',
  'implement',
  'lint',
  'test',
  'close',
  'api-sync',
]);

/**
 * Parse a single `phase-timings` comment body. Returns null for any parse
 * failure so the caller can warn-and-continue.
 *
 * @param {string} body
 * @returns {{ storyId: number, totalMs: number, phases: Array<{name: string, elapsedMs: number}> } | null}
 */
export function parsePhaseTimingsBody(body) {
  if (typeof body !== 'string') return null;
  const match = body.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match) return null;
  let payload;
  try {
    payload = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!payload || !Array.isArray(payload.phases)) return null;
  const phases = payload.phases
    .filter(
      (p) =>
        p && typeof p.name === 'string' && Number.isFinite(Number(p.elapsedMs)),
    )
    .map((p) => ({ name: p.name, elapsedMs: Number(p.elapsedMs) }));
  return {
    storyId: Number(payload.storyId) || 0,
    totalMs: Number(payload.totalMs) || 0,
    phases,
  };
}

/**
 * Locate a `phase-timings` structured comment in a comment list. The
 * marker pattern matches `upsertStructuredComment` — an HTML comment of
 * the form `<!-- structured:phase-timings -->` or a fenced JSON block
 * whose payload carries `kind: 'phase-timings'`.
 */
export function findPhaseTimingsInComments(comments) {
  if (!Array.isArray(comments)) return null;
  for (const c of comments) {
    if (!c || typeof c.body !== 'string') continue;
    if (
      c.body.includes(`<!-- structured:${PHASE_TIMINGS_MARKER} -->`) ||
      c.body.includes(`"kind": "${PHASE_TIMINGS_MARKER}"`) ||
      c.body.includes(`"kind":"${PHASE_TIMINGS_MARKER}"`)
    ) {
      return c;
    }
  }
  return null;
}

/**
 * Compute the nearest-rank percentile of a numeric sample array. Matches
 * the method used in progress-reporter's phase-timings aggregation so
 * the two paths never disagree on a shared dataset.
 */
export function percentile(samples, q) {
  if (!Array.isArray(samples) || samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(q * sorted.length) - 1),
  );
  return sorted[idx];
}

/**
 * Aggregate per-phase p50/p95 across a flat list of summaries.
 *
 * @param {Array<ReturnType<typeof parsePhaseTimingsBody>>} summaries
 */
export function aggregate(summaries) {
  const buckets = new Map();
  let sampleCount = 0;
  for (const s of summaries) {
    if (!s || !Array.isArray(s.phases)) continue;
    sampleCount++;
    for (const p of s.phases) {
      if (!buckets.has(p.name)) buckets.set(p.name, []);
      buckets.get(p.name).push(p.elapsedMs);
    }
  }
  const rows = [];
  for (const name of PHASE_ORDER) {
    const samples = buckets.get(name);
    if (!samples || samples.length === 0) continue;
    rows.push({
      name,
      p50: percentile(samples, 0.5),
      p95: percentile(samples, 0.95),
      n: samples.length,
    });
  }
  for (const [name, samples] of buckets.entries()) {
    if (PHASE_ORDER.includes(name)) continue;
    rows.push({
      name,
      p50: percentile(samples, 0.5),
      p95: percentile(samples, 0.95),
      n: samples.length,
    });
  }
  return { rows, sampleCount };
}

/**
 * Recommend caps for each concurrentMap adoption site from observed
 * workload. The mapping is advisory — the aggregator never mutates
 * config. Callers thread the returned values into
 * `default-agentrc.json` manually after reviewing the summary.
 *
 * Heuristic (documented so operators can sanity-check):
 *   - waveGate: 0 (uncapped) when sample count < 50, else cap at 16.
 *     The wave-gate reads Story tickets during /epic-close; a single
 *     Epic's fanout is bounded by its story count, so uncapped suits
 *     typical Epics (< 20 stories). A cap kicks in only for very
 *     large Epics where provider rate-limit headroom is a concern.
 *   - commitAssertion: matches the v5.21.0 constant (4). Observed
 *     `close` p95 has been the determining factor; a higher cap adds
 *     no throughput because git rev-list is fast per call.
 *   - progressReporter: matches the v5.21.0 constant (8). The poll
 *     cadence (intervalSec) dominates latency; a higher cap makes no
 *     measurable difference at current Epic sizes.
 */
export function recommendCaps({ sampleCount }) {
  return {
    waveGate: sampleCount >= 50 ? 16 : 0,
    commitAssertion: 4,
    progressReporter: 8,
  };
}

function formatMs(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

/**
 * Render the markdown summary. Signature matches the shape callers pass
 * around (the aggregated rows plus metadata about the run) so this stays
 * a pure renderer.
 */
export function renderSummary({
  rows,
  sampleCount,
  epicIds,
  epicSampleCounts,
  caps,
  synthetic = false,
  generatedAt,
}) {
  const header = synthetic
    ? '# Phase-timings aggregate (SYNTHETIC — no post-#553 Epics available)'
    : '# Phase-timings aggregate';
  const epicLine = epicIds.length
    ? epicIds
        .map((id) => {
          const n = epicSampleCounts?.get(id) ?? 0;
          return `#${id} (${n})`;
        })
        .join(', ')
    : '(none)';
  const lines = [
    header,
    '',
    `- Generated: ${generatedAt}`,
    `- Epics sampled: ${epicLine}`,
    `- Stories aggregated: ${sampleCount}`,
    '',
    '## Per-phase timings (p50 / p95)',
    '',
  ];
  if (rows.length === 0) {
    lines.push('_No phase-timings samples found._');
  } else {
    lines.push(
      '| Phase | p50 | p95 | n |',
      '| --- | --- | --- | --- |',
      ...rows.map(
        (r) =>
          `| ${r.name} | ${formatMs(r.p50)} | ${formatMs(r.p95)} | ${r.n} |`,
      ),
    );
  }
  lines.push(
    '',
    '## Recommended `orchestration.runners.concurrency` defaults',
    '',
    '| Site | Cap | Rationale |',
    '| --- | --- | --- |',
    `| waveGate | ${caps.waveGate} | ${
      caps.waveGate === 0
        ? 'Uncapped — fanout bounded by Story count per Epic.'
        : 'Capped to bound provider read pressure on large Epics.'
    } |`,
    `| commitAssertion | ${caps.commitAssertion} | Matches v5.21.0 constant; git rev-list is fast per call. |`,
    `| progressReporter | ${caps.progressReporter} | Matches v5.21.0 constant; interval dominates latency. |`,
    '',
  );
  return lines.join('\n');
}

async function loadEpicsFromFile(path, { readFileImpl = readFile } = {}) {
  const buf = await readFileImpl(path, 'utf8');
  return String(buf)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => Number.parseInt(line, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * Fetch and aggregate phase-timings for the given Epic IDs.
 *
 * Strategy:
 *   - For each Epic, read its child tickets via `provider.getSubTickets`.
 *     `story-close` posts `phase-timings` on the Story itself
 *     (not on the Epic), so we need to enumerate children and inspect
 *     their comments.
 *   - For each child, call `provider.getTicketComments`. Children that
 *     never posted a phase-timings comment (older Stories, Stories that
 *     failed before close) are silently skipped.
 *   - An Epic that yields zero phase-timings is logged as a warning and
 *     counted toward "Epics with no samples". It does not halt the run.
 *
 * @param {number[]} epicIds
 * @param {{ provider: import('./lib/ITicketingProvider.js').ITicketingProvider, logger?: object }} opts
 */
export async function collectSummaries(
  epicIds,
  { provider, logger = console },
) {
  const summaries = [];
  const epicSampleCounts = new Map();
  const errors = [];

  for (const epicId of epicIds) {
    let children;
    try {
      children = (await provider.getSubTickets(epicId)) ?? [];
    } catch (err) {
      errors.push({ epicId, error: err.message });
      logger.warn?.(
        `[aggregate-phase-timings] Epic #${epicId}: getSubTickets failed — ${err.message}`,
      );
      epicSampleCounts.set(epicId, 0);
      continue;
    }
    let count = 0;
    for (const child of children) {
      const childId = Number(child?.id);
      if (!Number.isFinite(childId)) continue;
      let comments;
      try {
        comments = (await provider.getTicketComments(childId)) ?? [];
      } catch (err) {
        logger.warn?.(
          `[aggregate-phase-timings] Story #${childId}: getTicketComments failed — ${err.message}`,
        );
        continue;
      }
      const comment = findPhaseTimingsInComments(comments);
      if (!comment) continue;
      const parsed = parsePhaseTimingsBody(comment.body);
      if (!parsed) continue;
      summaries.push(parsed);
      count++;
    }
    epicSampleCounts.set(epicId, count);
    if (count === 0) {
      logger.warn?.(
        `[aggregate-phase-timings] Epic #${epicId}: no phase-timings found across ${children.length} child ticket(s).`,
      );
    }
  }

  return { summaries, epicSampleCounts, errors };
}

/**
 * Full end-to-end run: collect + aggregate + render. Exposed as a module
 * function so the tests can drive it with a mocked provider.
 */
export async function runAggregator({
  epicIds,
  provider,
  logger = console,
  synthetic = false,
  now = () => new Date(),
} = {}) {
  if (!Array.isArray(epicIds) || epicIds.length === 0) {
    throw new Error('runAggregator requires a non-empty epicIds array');
  }
  if (!provider) {
    throw new Error('runAggregator requires a provider');
  }
  const { summaries, epicSampleCounts, errors } = await collectSummaries(
    epicIds,
    { provider, logger },
  );
  const { rows, sampleCount } = aggregate(summaries);
  const caps = recommendCaps({ sampleCount });
  const markdown = renderSummary({
    rows,
    sampleCount,
    epicIds,
    epicSampleCounts,
    caps,
    synthetic,
    generatedAt: now().toISOString(),
  });
  return { markdown, rows, sampleCount, epicSampleCounts, caps, errors };
}

async function main() {
  const { values } = parseArgs({
    options: {
      epic: { type: 'string', multiple: true },
      'from-file': { type: 'string' },
      out: { type: 'string' },
      synthetic: { type: 'boolean', default: false },
    },
    strict: false,
  });

  let epicIds = Array.isArray(values.epic)
    ? values.epic.map((v) => Number.parseInt(v, 10)).filter((n) => n > 0)
    : [];
  if (values['from-file']) {
    const fromFile = await loadEpicsFromFile(values['from-file']);
    epicIds = [...new Set([...epicIds, ...fromFile])];
  }

  if (epicIds.length === 0) {
    console.error(
      '[aggregate-phase-timings] No Epics supplied. Pass --epic <id> (repeatable) or --from-file <path>.',
    );
    process.exit(1);
  }

  const { orchestration } = resolveConfig();
  let provider;
  try {
    provider = createProvider(orchestration);
  } catch (err) {
    console.error(
      `[aggregate-phase-timings] Provider init failed: ${err.message}`,
    );
    process.exit(2);
  }

  const result = await runAggregator({
    epicIds,
    provider,
    synthetic: values.synthetic === true,
  });

  if (values.out) {
    await writeFile(values.out, result.markdown, 'utf8');
    console.error(`[aggregate-phase-timings] Wrote ${values.out}`);
  }
  process.stdout.write(`${result.markdown}\n`);

  if (result.sampleCount === 0) {
    console.error(
      '[aggregate-phase-timings] ⚠ Zero phase-timings samples — recommended caps default to v5.21.0 constants.',
    );
    process.exit(1);
  }
}

runAsCli(import.meta.url, main, { source: 'aggregate-phase-timings' });
