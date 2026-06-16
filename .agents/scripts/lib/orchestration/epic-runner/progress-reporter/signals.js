/**
 * progress-reporter/signals.js — parsing and aggregation helpers for the
 * `story-run-progress` and `phase-timings` structured comments.
 *
 * Extracted from the parent `progress-reporter.js` so the aggregator
 * surface (phase percentile rollups, story-run-progress parsing) is
 * testable independently of the comment composition (`composition.js`)
 * and webhook transport (`transport.js`). Pure functions only — no
 * provider calls, no I/O — which makes this the natural home for the
 * shared state lookup tables (`PHASE_TO_STATE`, `PHASE_ORDER`,
 * `STATE_EMOJI`) and the structured-comment kind constants.
 */

import { parseFencedJsonComment } from '../../structured-comment-parser.js';

/**
 * Structured-comment kind for the rolled-up Epic-level progress
 * comment. Persisted via `composition.upsertEpicRunProgress` and read
 * back by tests + reconcilers.
 */
export const EPIC_RUN_PROGRESS_TYPE = 'epic-run-progress';

/**
 * Structured-comment kind for the per-Story phase-timings summary
 * posted by `story-close.js`. Read back by the ProgressReporter so the
 * Epic-level snapshot can aggregate median/p95 across waves.
 */
export const PHASE_TIMINGS_TYPE = 'phase-timings';

/**
 * Structured-comment kind for the per-Story run-progress snapshot that
 * `/deliver` upserts on every Task transition. Read by
 * ProgressReporter so the Epic-level table reflects sub-agent state in
 * near-real time instead of label-derived classifications.
 */
export const STORY_RUN_PROGRESS_TYPE = 'story-run-progress';

/**
 * Phase → high-level state classification. Lookup table flattens the
 * previous switch so cyclomatic complexity stays at 1 (one branch in the
 * `??` fallback) rather than 6 — keeps the CRAP score floor-bound under
 * coverage variance.
 */
export const PHASE_TO_STATE = {
  done: 'done',
  blocked: 'blocked',
  implementing: 'in-flight',
  closing: 'in-flight',
  init: 'queued',
};

/**
 * Fixed ordering for the rendered phase-timings table. Matches the enum
 * in lib/util/phase-timer.js so rows line up with how operators think
 * about the story lifecycle rather than re-sorting by alphabet or
 * frequency.
 */
export const PHASE_ORDER = [
  'worktree-create',
  'bootstrap',
  'install',
  'implement',
  'lint',
  'test',
  'close',
  'api-sync',
];

/**
 * Emoji prefix per high-level state. Consumed by the rolled-up Epic table
 * (`composition.upsertEpicRunProgress`) so operators see a consistent icon
 * per state across the progress surface.
 */
export const STATE_EMOJI = {
  done: '✅',
  blocked: '🚧',
  'in-flight': '🔧',
  queued: '⏳',
  unknown: '❓',
};

/**
 * Map a `story-run-progress` phase to the high-level state label used
 * by the rendered tables. Returns `'unknown'` for any phase value that
 * isn't in the lookup table so an unexpected phase surfaces as an
 * unreadable row rather than a crash.
 */
export function phaseToState(phase) {
  return PHASE_TO_STATE[phase] ?? 'unknown';
}

/**
 * Parse a `story-run-progress` structured comment posted by `/deliver`.
 * Returns `null` for any malformed body — the caller falls back to the
 * ticket-label state derivation in that case.
 *
 * Expected payload shape (JSON inside a fenced json codeblock):
 *   {
 *     storyId: number,
 *     branch?: string,
 *     phase: 'init'|'implementing'|'closing'|'blocked'|'done',
 *     title?: string,
 *     updatedAt?: string,
 *   }
 */
export function parseStoryRunProgressComment(comment) {
  const payload = parseFencedJsonComment(comment);
  if (!payload || typeof payload !== 'object') return null;
  const phase = typeof payload.phase === 'string' ? payload.phase : undefined;
  return {
    storyId: Number(payload.storyId),
    title: typeof payload.title === 'string' ? payload.title : '',
    phase,
    state: phaseToState(phase),
  };
}

/**
 * Extract the `{ phases, ... }` payload from a `phase-timings` structured
 * comment. Comment body is the fenced-JSON format produced by
 * `renderPhaseTimingsCommentBody` in story-close. Returns `null`
 * for any parse failure — the caller treats that as "no summary
 * available" without erroring out progress rendering.
 */
export function parsePhaseTimingsComment(comment) {
  const payload = parseFencedJsonComment(comment);
  if (!payload || typeof payload !== 'object') return null;
  if (!Array.isArray(payload.phases)) return null;
  return {
    storyId: Number(payload.storyId),
    totalMs: Number(payload.totalMs) || 0,
    phases: payload.phases
      .filter(
        (p) =>
          p &&
          typeof p.name === 'string' &&
          Number.isFinite(Number(p.elapsedMs)),
      )
      .map((p) => ({ name: p.name, elapsedMs: Number(p.elapsedMs) })),
  };
}

/**
 * Aggregate a list of `phase-timings` summaries into per-phase median,
 * p95, and sample count. Returns phases ordered by the canonical
 * `PHASE_ORDER` so the rendered table always has the same row sequence —
 * operators should never have to hunt for the `install` row.
 */
export function aggregatePhaseTimings(summaries) {
  const buckets = new Map();
  for (const s of summaries) {
    if (!s || !Array.isArray(s.phases)) continue;
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
      median: percentile(samples, 0.5),
      p95: percentile(samples, 0.95),
      n: samples.length,
    });
  }
  // Include any unexpected phase names at the tail so a future enum
  // addition surfaces in the table instead of being silently dropped.
  for (const [name, samples] of buckets.entries()) {
    if (PHASE_ORDER.includes(name)) continue;
    rows.push({
      name,
      median: percentile(samples, 0.5),
      p95: percentile(samples, 0.95),
      n: samples.length,
    });
  }
  return rows;
}

function percentile(samples, q) {
  const sorted = [...samples].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  // Nearest-rank method — clamped so q=1 picks the last element.
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(q * sorted.length) - 1),
  );
  return sorted[idx];
}

/**
 * Render the aggregated phase-timings table. Returns `null` when there
 * are no summaries to render so the caller can elide the section
 * entirely rather than emitting an empty stub.
 */
export function renderPhaseTimingsSection(summaries) {
  if (!Array.isArray(summaries) || summaries.length === 0) return null;
  const rows = aggregatePhaseTimings(summaries);
  if (rows.length === 0) return null;
  const header = `### Phase timings (last ${summaries.length} completed stor${summaries.length === 1 ? 'y' : 'ies'})`;
  const table = [
    '| Phase | median ms | p95 ms | n |',
    '| --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.name} | ${r.median} | ${r.p95} | ${r.n} |`),
  ].join('\n');
  return `${header}\n\n${table}`;
}
