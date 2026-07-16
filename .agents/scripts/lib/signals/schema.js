/**
 * Signals schema — single source of truth for event-kind constants and
 * shape guards (Epic #1181 / Story #1438 / Task #1458).
 *
 * Both writers (`lib/observability/signals-writer.js` callers) and
 * readers (`lib/signals/read.js`, the retro's gather-signals phase)
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
 *   - `friction`       — quality-gate / runtime friction (diagnose-friction.js,
 *                        lib/gates/friction.js)
 *   - `acceptance-eval` — acceptance-eval.js per-criterion terminus signal.
 *   - `wave-start` / `wave-complete` — wave-window anchors; `wave-start` also
 *                        anchors span-tree Story spans
 *   - `wave-end`       — span-tree pairing anchor (retained for span-tree)
 *   - `state-transition` — notification-derived window anchor.
 *
 * The `dispatched` kind was deleted in the Epic #4406 signal-contract
 * cutover — it had no live emitter and no consumer.
 *
 * Signals-writer `appendTrace` call sites (traces.ndjson sibling, but
 * sharing the same envelope shape — `tool-trace-hook.js`):
 *   - `trace`          — per-tool-call timing record
 *
 * Detector-emitted / aggregator-consumed kinds (`rework`, `retry` are
 * emitted by `lib/signals/detectors/*`; `hotspot`, `churn`, `idle` remain
 * pinned in the enum for the aggregator's kind-count rollup even though no
 * live detector emits them):
 *   - `hotspot`, `rework`, `churn`, `idle`, `retry`
 *
 * ## Common envelope (canonical — Epic #4406 / Story #4413)
 *
 * Every signal MUST carry at minimum:
 *   - `ts`     — ISO-8601 timestamp string. The single canonical
 *                timestamp key; the legacy `timestamp:` alias was deleted
 *                from every writer and this guard in the same PR.
 *   - `kind`   — one of `EVENT_KINDS`.
 *
 * Scoped signals additionally carry:
 *   - `epicId` — integer Epic ID (or `null` for standalone-Story
 *                friction). The single canonical epic-id key; the legacy
 *                `epic:` alias was deleted.
 *
 * Optional but commonly carried:
 *   - `storyId`  — integer Story ID
 *   - `taskId`   — integer Task ID (nullable)
 *   - `emitter`  — `{ tool: string, command?: string }` provenance
 *   - `source`   — `"framework" | "consumer"` classifier tag
 *   - `category` — top-level friction category string
 *   - `details`  — kind-specific payload (always an object)
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
  // Wave-window forensics signals: `wave-start` / `wave-end` anchor the
  // span-tree's Story spans. Story #4545 deleted the `waveParallelism`
  // consumer (perf-aggregator) with the execution-analysis surface; these
  // kinds stay as the span-tree's anchors.
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
  // Forensic breadcrumb appended to the per-Epic stream by the notify
  // dispatcher (lib/orchestration/lifecycle/listeners/notify-dispatcher.js)
  // when a lifecycle event maps to a webhook notification — the resume
  // suite reads it back to prove a dispatch survived a crash window without
  // duplicating. Enumerated so the write-time validator (Story #4413) does
  // not drop it; it is a deliberate write, not malformed data.
  NOTIFICATION_EMITTED: 'notification.emitted',
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
  // Canonical envelope keys — there is exactly one key per concept. The
  // legacy `timestamp` / `epic` / `story` / `task` aliases were deleted in
  // the Epic #4406 signal-contract cutover; no reader tolerates them.
  TS: 'ts',
  EPIC_ID: 'epicId',
  STORY_ID: 'storyId',
  TASK_ID: 'taskId',
  KIND: 'kind',

  // Common payload fields
  EMITTER: 'emitter',
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
 * Common envelope guard: every signal MUST carry `ts`, `epicId`, and a
 * recognised `kind`. Canonical keys only — the legacy `timestamp` / `epic`
 * aliases were deleted in the Epic #4406 cutover.
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
  if (!isTimestamp(evt.ts)) return false;
  // The canonical `epicId` key MUST be present — a record carrying only the
  // legacy `epic` alias is rejected (the cutover deleted that alias). Its
  // value is nullable by contract: standalone-Story friction carries
  // `epicId: null` (see signal-event.schema.json, where epicId is
  // `["integer","null"]`). So accept an explicit null, reject a missing key
  // or a present-but-non-positive-int value.
  if (!Object.hasOwn(evt, 'epicId')) return false;
  if (evt.epicId !== null && !isPositiveInt(evt.epicId)) return false;
  return true;
}

/**
 * Generic per-kind guard. Returns true when the envelope is well-formed
 * AND (when `kind` is supplied) the event's `kind` matches. The full
 * canonical-shape check lives in the AJV validator compiled from
 * `signal-event.schema.json` (see `lib/observability/signal-validator.js`);
 * this predicate is the cheap envelope gate the streaming reader uses.
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
