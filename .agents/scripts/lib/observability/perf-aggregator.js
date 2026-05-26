/**
 * Performance signal aggregator (Epic #1030 / Story #1123; rewrite under
 * Epic #1181 / Story #1438 / Task #1460).
 *
 * Pure functions that turn the per-Story `signals.ndjson` stream into the
 * structured payloads posted by `analyze-execution.js`:
 *
 *   - `computeStoryPerfSummary(events, opts)` → `<!-- structured:story-perf-summary -->`
 *   - `computeEpicPerfReport(perStorySummaries, opts)` → `<!-- structured:epic-perf-report -->`
 *
 * Plus streaming counterparts that consume the canonical
 * `lib/signals/read` iterator directly, so the aggregator owns its own
 * NDJSON ingestion through the shared reader (Task #1460 AC):
 *
 *   - `computeStoryPerfSummaryFromStore({ storyId, epicId, config? })`
 *   - `computeEpicPerfReportFromStore({ epicId, perStorySummaries, config? })`
 *
 * Schemas:
 *   - `.agents/schemas/story-perf-summary.schema.json`
 *   - `.agents/schemas/epic-perf-report.schema.json`
 *
 * Robustness contract:
 *   - Both helpers tolerate empty / partial input. Empty streams produce a
 *     well-formed payload with zeroed counters and empty arrays so the
 *     analyzer can still upsert a comment without throwing.
 *   - Malformed events (missing `kind`, non-object payload) are silently
 *     skipped; the caller is responsible for reading them off the wire and
 *     deciding whether to log. The aggregator never throws on bad data.
 *   - Numeric fields are floored to non-negative integers so the schemas
 *     (`integer`, `minimum: 0`) hold by construction.
 *
 * NDJSON ingestion discipline (Epic #1181):
 *   - Field-name literals for event `kind` come from
 *     `lib/signals/schema.js` so writer ↔ reader names stay in lockstep.
 *   - All file I/O for `signals.ndjson` goes through `lib/signals/read.js`
 *     (no direct `readFileSync` / `createReadStream` on signals.ndjson in
 *     this module). A grep gate in `tests/lib/checks/` enforces this on
 *     CI.
 */

import { isObject } from '../json-utils.js';
import { read as readSignals } from '../signals/read.js';
import { EVENT_KINDS } from '../signals/schema.js';

const FRICTION_KIND = EVENT_KINDS.FRICTION;
const HOTSPOT_KIND = EVENT_KINDS.HOTSPOT;
const REWORK_KIND = EVENT_KINDS.REWORK;
const RETRY_KIND = EVENT_KINDS.RETRY;
const SIGNAL_COUNT_KINDS = Object.freeze([
  EVENT_KINDS.FRICTION,
  EVENT_KINDS.HOTSPOT,
  EVENT_KINDS.REWORK,
  EVENT_KINDS.CHURN,
  EVENT_KINDS.IDLE,
  EVENT_KINDS.RETRY,
]);

function nonNegativeInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function nonNegativeNumber(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/**
 * Pull friction-by-category counts off a list of NDJSON events. Keys are
 * the `details.category` strings; values ≥ 0 integers.
 *
 * @param {Iterable<object>} events
 * @returns {Object<string, number>}
 */
function frictionByCategory(events) {
  const out = {};
  for (const evt of events) {
    if (!isObject(evt) || evt.kind !== FRICTION_KIND) continue;
    const category =
      isObject(evt.details) && typeof evt.details.category === 'string'
        ? evt.details.category
        : 'Unknown';
    out[category] = (out[category] ?? 0) + 1;
  }
  return out;
}

/**
 * Build the `topSlowPhasesVsBaseline` array. We accept hotspot signals
 * carrying `{ phase, elapsedMs, baselineP95Ms, ratio }` in `details` and
 * surface them sorted by ratio descending. The hotspot detector is a
 * future Epic-#1030 Story; until it lands the input list is empty and
 * this returns `[]`.
 *
 * @param {Iterable<object>} events
 * @param {{ limit?: number }} [opts]
 * @returns {Array<{phase: string, elapsedMs: number, baselineP95Ms: number, ratio: number}>}
 */
function topSlowPhasesVsBaseline(events, opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 5;
  const rows = [];
  for (const evt of events) {
    if (!isObject(evt) || evt.kind !== HOTSPOT_KIND) continue;
    const d = isObject(evt.details) ? evt.details : {};
    const phase =
      typeof evt.phase === 'string' && evt.phase.length > 0
        ? evt.phase
        : typeof d.phase === 'string' && d.phase.length > 0
          ? d.phase
          : null;
    if (!phase) continue;
    rows.push({
      phase,
      elapsedMs: nonNegativeInt(d.elapsedMs),
      baselineP95Ms: nonNegativeInt(d.baselineP95Ms),
      ratio: nonNegativeNumber(d.ratio),
    });
  }
  rows.sort((a, b) => b.ratio - a.ratio);
  return rows.slice(0, limit);
}

/**
 * Build the `reworkScore` object: `{ filesEditedBeyondThreshold, topPath?,
 * topPathEdits? }`. We aggregate `kind: 'rework'` signals whose details
 * carry a `path` and an `edits` count. When the input has no rework
 * signals we return the zero-shape: `{ filesEditedBeyondThreshold: 0 }`.
 *
 * @param {Iterable<object>} events
 * @returns {{ filesEditedBeyondThreshold: number, topPath?: string|null, topPathEdits?: number|null }}
 */
function reworkScore(events) {
  const editsByPath = new Map();
  for (const evt of events) {
    if (!isObject(evt) || evt.kind !== REWORK_KIND) continue;
    const d = isObject(evt.details) ? evt.details : {};
    const p = typeof d.path === 'string' && d.path.length > 0 ? d.path : null;
    if (!p) continue;
    const edits = nonNegativeInt(d.edits);
    editsByPath.set(p, Math.max(editsByPath.get(p) ?? 0, edits));
  }
  if (editsByPath.size === 0) {
    return { filesEditedBeyondThreshold: 0 };
  }
  let topPath = null;
  let topPathEdits = 0;
  for (const [p, n] of editsByPath) {
    if (n > topPathEdits) {
      topPath = p;
      topPathEdits = n;
    }
  }
  return {
    filesEditedBeyondThreshold: editsByPath.size,
    topPath,
    topPathEdits,
  };
}

/**
 * Build the `retryDensity` object: `{ retries, uniqueCommands }`. Sums
 * `kind: 'retry'` signals; `uniqueCommands` is the number of distinct
 * `details.command` strings observed. Zero-shape on empty input.
 *
 * @param {Iterable<object>} events
 * @returns {{ retries: number, uniqueCommands: number }}
 */
function retryDensity(events) {
  let retries = 0;
  const commands = new Set();
  for (const evt of events) {
    if (!isObject(evt) || evt.kind !== RETRY_KIND) continue;
    const d = isObject(evt.details) ? evt.details : {};
    retries += 1;
    if (typeof d.command === 'string' && d.command.length > 0) {
      commands.add(d.command);
    }
  }
  return { retries, uniqueCommands: commands.size };
}

/**
 * Convert a phase-timer summary `{ phases: [{ name, elapsedMs }, ...] }`
 * into the flat `{ <name>: <ms> }` map the schema wants. Last entry wins
 * if a phase appears twice (mark/finish boundaries).
 *
 * @param {{ phases?: Array<{ name: string, elapsedMs: number }> } | null | undefined} timing
 * @returns {Object<string, number>}
 */
function phaseTimingsMs(timing) {
  if (!isObject(timing) || !Array.isArray(timing.phases)) return {};
  const out = {};
  for (const p of timing.phases) {
    if (!isObject(p)) continue;
    if (typeof p.name !== 'string' || p.name.length === 0) continue;
    out[p.name] = nonNegativeInt(p.elapsedMs);
  }
  return out;
}

/**
 * Compute the StoryPerfSummary payload from a list of NDJSON events
 * sampled out of `temp/epic-<eid>/stories/story-<sid>/signals.ndjson` plus an
 * optional phase-timer summary.
 *
 * @param {Iterable<object>} events
 * @param {{ storyId: number, epicId: number, closedAt?: string, phaseTiming?: object|null }} opts
 * @returns {object} StoryPerfSummary payload (schema: story-perf-summary)
 */
export function computeStoryPerfSummary(events, opts) {
  if (!isObject(opts)) {
    throw new TypeError('computeStoryPerfSummary: opts is required');
  }
  const storyId = Number(opts.storyId);
  const epicId = Number(opts.epicId);
  if (!Number.isInteger(storyId) || storyId < 1) {
    throw new RangeError(
      `computeStoryPerfSummary: storyId must be a positive integer (got ${opts.storyId})`,
    );
  }
  if (!Number.isInteger(epicId) || epicId < 1) {
    throw new RangeError(
      `computeStoryPerfSummary: epicId must be a positive integer (got ${opts.epicId})`,
    );
  }
  const closedAt =
    typeof opts.closedAt === 'string' && opts.closedAt.length > 0
      ? opts.closedAt
      : new Date().toISOString();

  // Materialise the iterable so each helper can scan independently.
  const evtArr = [];
  for (const e of events ?? []) {
    if (isObject(e) && typeof e.kind === 'string') evtArr.push(e);
  }

  return {
    kind: 'story-perf-summary',
    storyId,
    epicId,
    closedAt,
    frictionByCategory: frictionByCategory(evtArr),
    phaseTimingsMs: phaseTimingsMs(opts.phaseTiming),
    topSlowPhasesVsBaseline: topSlowPhasesVsBaseline(evtArr),
    reworkScore: reworkScore(evtArr),
    retryDensity: retryDensity(evtArr),
  };
}

/**
 * Compute the EpicPerfReport payload from a list of per-Story summaries
 * (each shaped like `computeStoryPerfSummary`'s return value) plus an
 * optional list of raw events for signal-count rollup.
 *
 * `signalCounts` rolls up across **events**, not summaries — a Story's
 * `frictionByCategory` only carries friction (the named slice the schema
 * surfaces), but the Epic-level rollup wants every kind. When `opts.events`
 * is absent we fall back to summing each summary's friction count and
 * leave the other kinds at 0.
 *
 * @param {Iterable<object>} perStorySummaries
 * @param {{ epicId: number, generatedAt?: string, events?: Iterable<object>, waveParallelism?: Array<object>, topHotspots?: Array<object> }} opts
 * @returns {object} EpicPerfReport payload (schema: epic-perf-report)
 */
/**
 * Predicate / collector: walk a `perStorySummaries` iterable and emit
 * only the entries whose `kind === 'story-perf-summary'`. Extracted from
 * `computeEpicPerfReport` so the input-validation cascade is independently
 * testable and the parent stays straight-line. Returns `[]` for nullish
 * inputs, which matches the parent's prior behaviour.
 *
 * @param {Iterable<object>|null|undefined} perStorySummaries
 * @returns {object[]}
 */
export function collectValidStorySamples(perStorySummaries) {
  const out = [];
  if (!perStorySummaries) return out;
  for (const s of perStorySummaries) {
    if (isObject(s) && s.kind === 'story-perf-summary') out.push(s);
  }
  return out;
}

/**
 * Build the `signalCounts` block. When `events` is supplied we roll up
 * across every kind in `SIGNAL_COUNT_KINDS`; otherwise we sum the
 * per-Story friction counts so the legacy summary-only path keeps the
 * same friction total.
 *
 * @param {Iterable<object>|null|undefined} events
 * @param {object[]} summaries
 * @returns {{friction: number, hotspot: number, rework: number, churn: number, idle: number, retry: number}}
 */
function buildSignalCounts(events, summaries) {
  const counts = {
    friction: 0,
    hotspot: 0,
    rework: 0,
    churn: 0,
    idle: 0,
    retry: 0,
  };
  if (events) {
    for (const evt of events) {
      if (!isObject(evt) || typeof evt.kind !== 'string') continue;
      if (SIGNAL_COUNT_KINDS.includes(evt.kind)) {
        counts[evt.kind] += 1;
      }
    }
    return counts;
  }
  for (const s of summaries) {
    if (!isObject(s.frictionByCategory)) continue;
    for (const v of Object.values(s.frictionByCategory)) {
      counts.friction += nonNegativeInt(v);
    }
  }
  return counts;
}

/**
 * Aggregate the `topHotspots` block from per-Story samples: group each
 * story's `topSlowPhasesVsBaseline` rows by phase, count occurrences,
 * average the ratio, then sort by `occurrences desc, avgRatio desc` and
 * cap at 5. Extracted from `computeEpicPerfReport` so the parent stays
 * straight-line; callers that pass `opts.topHotspots` skip this helper
 * entirely.
 *
 * @param {object[]} summaries
 * @returns {Array<{phase: string, occurrences: number, avgRatio: number}>}
 */
function aggregateTopHotspots(summaries) {
  const acc = new Map();
  for (const s of summaries) {
    const arr = Array.isArray(s.topSlowPhasesVsBaseline)
      ? s.topSlowPhasesVsBaseline
      : [];
    for (const row of arr) {
      if (!isObject(row) || typeof row.phase !== 'string') continue;
      const rec = acc.get(row.phase) ?? {
        phase: row.phase,
        occurrences: 0,
        ratioSum: 0,
      };
      rec.occurrences += 1;
      rec.ratioSum += nonNegativeNumber(row.ratio);
      acc.set(row.phase, rec);
    }
  }
  return [...acc.values()]
    .map((r) => ({
      phase: r.phase,
      occurrences: r.occurrences,
      avgRatio: r.occurrences > 0 ? r.ratioSum / r.occurrences : 0,
    }))
    .sort((a, b) => b.occurrences - a.occurrences || b.avgRatio - a.avgRatio)
    .slice(0, 5);
}

/**
 * Default verify-concurrency cap when the caller does not override it.
 * Mirrors the default for `delivery.deliverRunner.verifyConcurrencyCap`
 * in `.agentrc.json` (Epic #3019 Tech Spec §1.4).
 */
const DEFAULT_VERIFY_CONCURRENCY_CAP = 4;

/**
 * Clamp `n` to the inclusive range [lo, hi]. Returns `lo` for NaN /
 * non-finite inputs so the coercer stays well-behaved on garbage.
 *
 * @param {number} n
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

/**
 * Coerce a single waveParallelism input row into the schema-canonical
 * shape `{ waveIndex, wallClockMs, summedStoryMs, utilisation,
 * capBinding, verifyConcurrencyCap }` (Story #3025).
 *
 * - Numeric fields are floored to non-negative integers (or clamped
 *   numbers for utilisation) so the JSON-schema `integer` / `minimum: 0`
 *   constraints hold by construction.
 * - `utilisation` is clamped to `[0, 1]` per the Tech Spec
 *   contract (§1.1).
 * - `capBinding` is coerced to boolean.
 * - `verifyConcurrencyCap` falls back to the project default (4) when the
 *   caller omits it or supplies a non-positive integer; the schema
 *   requires `minimum: 1` so 0 is not a valid carrier value.
 *
 * Exported for unit-testing the coercer in isolation.
 *
 * @param {object | null | undefined} row
 * @returns {{ waveIndex: number, wallClockMs: number, summedStoryMs: number, utilisation: number, capBinding: boolean, verifyConcurrencyCap: number }}
 */
export function coerceWaveParallelismRow(row) {
  const src = isObject(row) ? row : {};
  const cap = Number(src.verifyConcurrencyCap);
  const verifyConcurrencyCap =
    Number.isInteger(cap) && cap >= 1 ? cap : DEFAULT_VERIFY_CONCURRENCY_CAP;
  return {
    waveIndex: nonNegativeInt(src.waveIndex),
    wallClockMs: nonNegativeInt(src.wallClockMs),
    summedStoryMs: nonNegativeInt(src.summedStoryMs),
    utilisation: clamp(nonNegativeNumber(src.utilisation), 0, 1),
    capBinding: Boolean(src.capBinding),
    verifyConcurrencyCap,
  };
}

export function computeEpicPerfReport(perStorySummaries, opts) {
  if (!isObject(opts)) {
    throw new TypeError('computeEpicPerfReport: opts is required');
  }
  const epicId = Number(opts.epicId);
  if (!Number.isInteger(epicId) || epicId < 1) {
    throw new RangeError(
      `computeEpicPerfReport: epicId must be a positive integer (got ${opts.epicId})`,
    );
  }
  const generatedAt =
    typeof opts.generatedAt === 'string' && opts.generatedAt.length > 0
      ? opts.generatedAt
      : new Date().toISOString();

  const summaries = collectValidStorySamples(perStorySummaries);

  // signalCounts: prefer the raw-event roll-up; fall back to friction-only
  // when the caller did not pass events.
  const signalCounts = buildSignalCounts(opts.events, summaries);

  const topHotspots = Array.isArray(opts.topHotspots)
    ? opts.topHotspots
    : aggregateTopHotspots(summaries);

  // mostFrictionStories: per-Story friction count, sorted desc, capped.
  const mostFrictionStories = summaries
    .map((s) => {
      const counts = isObject(s.frictionByCategory)
        ? Object.values(s.frictionByCategory).reduce(
            (acc, v) => acc + nonNegativeInt(v),
            0,
          )
        : 0;
      return {
        storyId: nonNegativeInt(s.storyId),
        frictionCount: counts,
      };
    })
    .filter((row) => row.storyId > 0)
    .sort((a, b) => b.frictionCount - a.frictionCount)
    .slice(0, 5);

  const waveParallelism = Array.isArray(opts.waveParallelism)
    ? opts.waveParallelism.map((row) => coerceWaveParallelismRow(row))
    : [];

  return {
    kind: 'epic-perf-report',
    epicId,
    generatedAt,
    signalCounts,
    waveParallelism,
    topHotspots,
    mostFrictionStories,
  };
}

// ---------------------------------------------------------------------------
// Streaming entry-points (Epic #1181 / Story #1438 / Task #1460)
// ---------------------------------------------------------------------------

/**
 * Streaming variant of `computeStoryPerfSummary` that ingests events
 * directly from `lib/signals/read.js` rather than expecting the caller
 * to materialise the iterable upstream. The aggregation logic is
 * identical — we collect the events through the shared reader and then
 * delegate to `computeStoryPerfSummary`.
 *
 * Use this when the caller is the analyzer and already has the
 * `{ epicId, storyId, config }` triple; use the pure
 * `computeStoryPerfSummary(events, opts)` when the caller already
 * holds an in-memory event array (tests, mock injections).
 *
 * @param {{
 *   storyId: number,
 *   epicId: number,
 *   closedAt?: string,
 *   phaseTiming?: object|null,
 *   config?: object,
 * }} opts
 * @returns {Promise<object>} StoryPerfSummary payload.
 */
export async function computeStoryPerfSummaryFromStore(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('computeStoryPerfSummaryFromStore: opts is required');
  }
  const { storyId, epicId, config } = opts;
  const events = [];
  for await (const evt of readSignals({
    epic: Number(epicId),
    story: Number(storyId),
    config,
  })) {
    events.push(evt);
  }
  return computeStoryPerfSummary(events, {
    storyId,
    epicId,
    closedAt: opts.closedAt,
    phaseTiming: opts.phaseTiming,
  });
}

/**
 * Streaming variant of `computeEpicPerfReport` that ingests the
 * raw-event roll-up directly from `lib/signals/read.js` (across every
 * Story under the Epic). Per-Story summaries are still passed in by
 * the caller — those are the canonical per-Story payloads upserted
 * onto each Story ticket and not derivable from the raw stream alone
 * (they fold in phase-timer data).
 *
 * @param {{
 *   epicId: number,
 *   perStorySummaries?: Iterable<object>,
 *   generatedAt?: string,
 *   waveParallelism?: Array<object>,
 *   topHotspots?: Array<object>,
 *   config?: object,
 * }} opts
 * @returns {Promise<object>} EpicPerfReport payload.
 */
export async function computeEpicPerfReportFromStore(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('computeEpicPerfReportFromStore: opts is required');
  }
  const { epicId, perStorySummaries, config } = opts;
  const events = [];
  for await (const evt of readSignals({ epic: Number(epicId), config })) {
    events.push(evt);
  }
  return computeEpicPerfReport(perStorySummaries ?? [], {
    epicId,
    generatedAt: opts.generatedAt,
    events,
    waveParallelism: opts.waveParallelism,
    topHotspots: opts.topHotspots,
  });
}
