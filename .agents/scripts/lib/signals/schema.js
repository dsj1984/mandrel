/**
 * Signals schema — single source of truth for event-kind constants and
 * shape guards (Epic #1181 / Story #1438 / Task #1458).
 *
 * Both writers (`lib/observability/signals-writer.js` callers) and
 * readers (`lib/signals/read.js`, `lib/observability/perf-aggregator.js`)
 * import their field names from this module so the on-disk NDJSON shape
 * stays under one schema.
 *
 * Pure module: importing has **no I/O side effects**. The exported
 * `EVENT_KINDS` object is `Object.freeze`'d so consumers can use it as a
 * compile-time-ish constant without worrying about mutation.
 *
 * ## Event-kind enumeration
 *
 * The set below is the audited union of `kind:` literals emitted via
 * `signals-writer.appendSignal` and `signals-writer.appendTrace` across
 * the codebase as of Epic #1181 (audit-snapshot 2026-05-11):
 *
 * Signals-writer `appendSignal` call sites:
 *   - `friction`       — quality-gate / runtime friction (check-crap.js,
 *                        check-maintainability.js, diagnose-friction.js,
 *                        post-merge-pipeline.js, progress-reporter.js,
 *                        auto-refresh-runner.js)
 *   - `dispatched`     — (no live emitter; retained pending Story #3908 sweep)
 *   - `wave-start` / `wave-complete` — `lib/wave-runner/tick.js` (read by
 *                        perf-aggregator's `waveParallelism` report;
 *                        `wave-start` also anchors span-tree Story spans)
 *   - `wave-end`       — span-tree pairing anchor (no live emitter after the
 *                        Epic #2646 listener deletion; retained for span-tree)
 *   - `state-transition` — orchestration/ticketing.js
 *
 * Story #3909 retired the write-only wave kinds with no consumer (`wave-tick`,
 * `epic-complete`) — they duplicated the checkpoint + `epic-run-progress`
 * rollup and nothing read them back.
 *
 * Signals-writer `appendTrace` call sites (traces.ndjson sibling, but
 * sharing the same envelope shape — `tool-trace-hook.js`):
 *   - `trace`          — per-tool-call timing record
 *
 * Aggregator-consumed kinds (perf-aggregator.js scans these — emitters
 * for `hotspot`, `rework`, `churn`, `idle`, `retry` are future Epic #1030
 * detector Stories that the aggregator was built to receive; the schema
 * pins the names so emitters land on a known shape):
 *   - `hotspot`, `rework`, `churn`, `idle`, `retry`
 *
 * ## Common envelope
 *
 * Every signal MUST carry at minimum:
 *   - `ts`     — ISO-8601 timestamp string (writers historically used
 *                `timestamp:` instead; both keys are accepted by the
 *                guards below for backward-compat — the migration to
 *                `ts:` lands in a follow-on Story).
 *   - `epic`   — integer Epic ID (writers historically used `epicId:`;
 *                same backward-compat note).
 *   - `kind`   — one of `EVENT_KINDS`.
 *
 * Optional but commonly carried:
 *   - `story` / `storyId`  — integer Story ID
 *   - `task` / `taskId`    — integer Task ID (nullable)
 *   - `source`             — `{ tool: string }`
 *   - `details`            — kind-specific payload (object or string)
 *
 * @module lib/signals/schema
 */

import { isObject } from '../json-utils.js';
import { isPositiveInt } from './detectors/common.js';

/**
 * Frozen enumeration of every event kind currently emitted by
 * `signals-writer.appendSignal` / `appendTrace`, plus the
 * aggregator-consumed kinds whose detectors are future Stories.
 *
 * Field names are kebab-cased to match the on-disk literals.
 */
export const EVENT_KINDS = Object.freeze({
  FRICTION: 'friction',
  TRACE: 'trace',
  DISPATCHED: 'dispatched',
  // Wave-window forensics signals: `wave-start` / `wave-end` anchor the
  // span-tree's Story spans, and the perf-aggregator brackets each wave's
  // wall-clock from `wave-start` → `wave-complete` (the `waveParallelism`
  // report). These are READ — they survive.
  WAVE_START: 'wave-start',
  WAVE_END: 'wave-end',
  WAVE_COMPLETE: 'wave-complete',
  // Story #3909 — the write-only wave-lifecycle kinds with no consumer
  // (`wave-tick`, `epic-complete`) were retired. They duplicated the
  // `epic-run-state` checkpoint and the `epic-run-progress` rollup and nothing
  // read them back.
  STATE_TRANSITION: 'state-transition',
  HOTSPOT: 'hotspot',
  REWORK: 'rework',
  CHURN: 'churn',
  IDLE: 'idle',
  RETRY: 'retry',
  // Story #3819 — per-criterion acceptance self-eval signal emitted by
  // acceptance-eval.js. One record per Story per eval-loop terminus,
  // carrying which acceptance items needed rework and the round count, so
  // the retro and /plan Phase 0 feedback fetch can see acceptance
  // churn alongside friction/hotspot data.
  ACCEPTANCE_EVAL: 'acceptance-eval',
});

/**
 * The set of event-kind string values (for fast membership checks).
 *
 * @type {ReadonlySet<string>}
 */
export const EVENT_KIND_VALUES = Object.freeze(
  new Set(Object.values(EVENT_KINDS)),
);

/**
 * Field-name constants exported so reader/aggregator code does not
 * spread string literals across the module graph.
 */
export const FIELDS = Object.freeze({
  // Envelope (canonical names — migration to these is in flight)
  TS: 'ts',
  EPIC: 'epic',
  STORY: 'story',
  TASK: 'task',
  KIND: 'kind',

  // Legacy envelope aliases still emitted by some writers
  TIMESTAMP: 'timestamp',
  EPIC_ID: 'epicId',
  STORY_ID: 'storyId',
  TASK_ID: 'taskId',

  // Common payload fields
  SOURCE: 'source',
  DETAILS: 'details',
  CATEGORY: 'category',
  PHASE: 'phase',
});

/**
 * Return true when `v` is a non-empty ISO-8601-ish timestamp string.
 * We don't fully validate format here — the schema's contract is "looks
 * like a timestamp string", not "round-trips through Date.parse exactly".
 *
 * @param {unknown} v
 * @returns {boolean}
 */
function isTimestamp(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Common envelope guard: every signal MUST carry `ts` (or legacy
 * `timestamp`), `epic` (or legacy `epicId`), and a recognised `kind`.
 *
 * Returns true when the envelope is well-formed. Used by `lib/signals/read`
 * to discard malformed lines before yielding them to the consumer.
 *
 * @param {unknown} evt
 * @returns {boolean}
 */
export function hasCommonEnvelope(evt) {
  if (!isObject(evt)) return false;
  if (typeof evt.kind !== 'string' || !EVENT_KIND_VALUES.has(evt.kind)) {
    return false;
  }
  const ts = evt.ts ?? evt.timestamp;
  if (!isTimestamp(ts)) return false;
  const epic = evt.epic ?? evt.epicId;
  if (!isPositiveInt(epic)) return false;
  return true;
}

/**
 * Generic per-kind guard. Returns true when the envelope is well-formed
 * AND (when `kind` is supplied) the event's `kind` matches.
 *
 * @param {unknown} evt
 * @param {string} [kind] — optional kind to match (one of `EVENT_KINDS`).
 * @returns {boolean}
 */
export function isValidSignal(evt, kind) {
  if (!hasCommonEnvelope(evt)) return false;
  if (kind != null && evt.kind !== kind) return false;
  return true;
}

/**
 * Per-kind shape guards. Each entry asserts the envelope plus any
 * required per-kind fields. Unknown kinds fall back to the envelope
 * check.
 *
 * The guards are intentionally lax — they reject records that are
 * obviously malformed (missing `kind`, missing `ts`, missing `epic`),
 * not records with extra fields or future schema extensions. The
 * aggregator (perf-aggregator.js) carries its own per-kind narrowing.
 *
 * @type {Readonly<Record<string, (evt: unknown) => boolean>>}
 */
export const GUARDS = Object.freeze({
  [EVENT_KINDS.FRICTION]: (evt) => {
    if (!isValidSignal(evt, EVENT_KINDS.FRICTION)) return false;
    // friction signals commonly carry a `category` field, but some
    // writers (early in the migration) omit it. We accept both.
    return true;
  },
  [EVENT_KINDS.TRACE]: (evt) => isValidSignal(evt, EVENT_KINDS.TRACE),
  [EVENT_KINDS.DISPATCHED]: (evt) => isValidSignal(evt, EVENT_KINDS.DISPATCHED),
  [EVENT_KINDS.WAVE_START]: (evt) => isValidSignal(evt, EVENT_KINDS.WAVE_START),
  [EVENT_KINDS.WAVE_END]: (evt) => isValidSignal(evt, EVENT_KINDS.WAVE_END),
  [EVENT_KINDS.WAVE_TICK]: (evt) => isValidSignal(evt, EVENT_KINDS.WAVE_TICK),
  [EVENT_KINDS.WAVE_COMPLETE]: (evt) =>
    isValidSignal(evt, EVENT_KINDS.WAVE_COMPLETE),
  [EVENT_KINDS.EPIC_COMPLETE]: (evt) =>
    isValidSignal(evt, EVENT_KINDS.EPIC_COMPLETE),
  [EVENT_KINDS.STATE_TRANSITION]: (evt) =>
    isValidSignal(evt, EVENT_KINDS.STATE_TRANSITION),
  [EVENT_KINDS.HOTSPOT]: (evt) => isValidSignal(evt, EVENT_KINDS.HOTSPOT),
  [EVENT_KINDS.REWORK]: (evt) => isValidSignal(evt, EVENT_KINDS.REWORK),
  [EVENT_KINDS.CHURN]: (evt) => isValidSignal(evt, EVENT_KINDS.CHURN),
  [EVENT_KINDS.IDLE]: (evt) => isValidSignal(evt, EVENT_KINDS.IDLE),
  [EVENT_KINDS.RETRY]: (evt) => isValidSignal(evt, EVENT_KINDS.RETRY),
  [EVENT_KINDS.ACCEPTANCE_EVAL]: (evt) =>
    isValidSignal(evt, EVENT_KINDS.ACCEPTANCE_EVAL),
});
