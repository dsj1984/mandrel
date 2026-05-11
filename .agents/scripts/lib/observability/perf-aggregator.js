/**
 * Performance signal aggregator (Epic #1030 / Story #1123).
 *
 * Pure functions that turn the per-Story `signals.ndjson` stream into the
 * structured payloads posted by `analyze-execution.js`:
 *
 *   - `computeStoryPerfSummary(events, opts)` → `<!-- structured:story-perf-summary -->`
 *   - `computeEpicPerfReport(perStorySummaries, opts)` → `<!-- structured:epic-perf-report -->`
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
 */

const FRICTION_KIND = 'friction';
const HOTSPOT_KIND = 'hotspot';
const REWORK_KIND = 'rework';
const RETRY_KIND = 'retry';
const SIGNAL_COUNT_KINDS = Object.freeze([
  'friction',
  'hotspot',
  'rework',
  'churn',
  'idle',
  'retry',
]);

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

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
 * sampled out of `temp/epic-<eid>/story-<sid>/signals.ndjson` plus an
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

  const summaries = [];
  for (const s of perStorySummaries ?? []) {
    if (isObject(s) && s.kind === 'story-perf-summary') summaries.push(s);
  }

  // signalCounts: prefer the raw-event roll-up; fall back to friction-only
  // when the caller did not pass events.
  const signalCounts = {
    friction: 0,
    hotspot: 0,
    rework: 0,
    churn: 0,
    idle: 0,
    retry: 0,
  };
  if (opts.events) {
    for (const evt of opts.events) {
      if (!isObject(evt) || typeof evt.kind !== 'string') continue;
      if (SIGNAL_COUNT_KINDS.includes(evt.kind)) {
        signalCounts[evt.kind] += 1;
      }
    }
  } else {
    for (const s of summaries) {
      if (!isObject(s.frictionByCategory)) continue;
      for (const v of Object.values(s.frictionByCategory)) {
        signalCounts.friction += nonNegativeInt(v);
      }
    }
  }

  // topHotspots: aggregate across summaries' `topSlowPhasesVsBaseline`.
  // Group by phase, count occurrences, average ratio, sort by occurrences
  // desc then avgRatio desc, cap at 5.
  const hotspotAcc = new Map();
  for (const s of summaries) {
    const arr = Array.isArray(s.topSlowPhasesVsBaseline)
      ? s.topSlowPhasesVsBaseline
      : [];
    for (const row of arr) {
      if (!isObject(row) || typeof row.phase !== 'string') continue;
      const rec = hotspotAcc.get(row.phase) ?? {
        phase: row.phase,
        occurrences: 0,
        ratioSum: 0,
      };
      rec.occurrences += 1;
      rec.ratioSum += nonNegativeNumber(row.ratio);
      hotspotAcc.set(row.phase, rec);
    }
  }
  const topHotspots = Array.isArray(opts.topHotspots)
    ? opts.topHotspots
    : [...hotspotAcc.values()]
        .map((r) => ({
          phase: r.phase,
          occurrences: r.occurrences,
          avgRatio: r.occurrences > 0 ? r.ratioSum / r.occurrences : 0,
        }))
        .sort(
          (a, b) => b.occurrences - a.occurrences || b.avgRatio - a.avgRatio,
        )
        .slice(0, 5);

  // mostFrictionStories: per-Story friction count, sorted desc, capped.
  // When the upstream signal carries an optional `dispatchModel` hint
  // (Epic #1185), propagate it onto the record. The field is omitted
  // entirely (never null) when absent so the pre-Epic shape is byte-
  // identical for the unset path.
  const mostFrictionStories = summaries
    .map((s) => {
      const counts = isObject(s.frictionByCategory)
        ? Object.values(s.frictionByCategory).reduce(
            (acc, v) => acc + nonNegativeInt(v),
            0,
          )
        : 0;
      const row = {
        storyId: nonNegativeInt(s.storyId),
        frictionCount: counts,
      };
      if (
        typeof s.dispatchModel === 'string' &&
        (s.dispatchModel === 'haiku' ||
          s.dispatchModel === 'sonnet' ||
          s.dispatchModel === 'opus')
      ) {
        row.dispatchModel = s.dispatchModel;
      }
      return row;
    })
    .filter((row) => row.storyId > 0)
    .sort((a, b) => b.frictionCount - a.frictionCount)
    .slice(0, 5);

  const waveParallelism = Array.isArray(opts.waveParallelism)
    ? opts.waveParallelism.map((row) => ({
        wave: nonNegativeInt(row?.wave),
        wallClockMs: nonNegativeInt(row?.wallClockMs),
        sumStoryMs: nonNegativeInt(row?.sumStoryMs),
        utilization: nonNegativeNumber(row?.utilization),
        stories: nonNegativeInt(row?.stories),
      }))
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
