/**
 * Signals schema — the single source of event-kind constants, field names
 * and the envelope guard for the NDJSON signal streams. Pure, no I/O.
 *
 * Envelope: `ts` (ISO string), `kind` (an `EVENT_KINDS` value) and `epicId`
 * (integer, or `null` for standalone-Story friction). No legacy aliases
 * (`timestamp`, `epic`, …) are tolerated.
 *
 * @module lib/signals/schema
 */

import { isObject } from '../json-utils.js';
import { isPositiveInt } from './detectors/common.js';

/**
 * Every emitted kind, plus producerless kinds (`trace`, wave-*, `hotspot`,
 * `rework`, `churn`, `idle`, `retry`) pinned so a re-introduced emitter or
 * reader needs no schema bump.
 */
export const EVENT_KINDS = Object.freeze({
  FRICTION: 'friction',
  TRACE: 'trace',
  WAVE_START: 'wave-start',
  WAVE_END: 'wave-end',
  WAVE_COMPLETE: 'wave-complete',
  STATE_TRANSITION: 'state-transition',
  HOTSPOT: 'hotspot',
  REWORK: 'rework',
  CHURN: 'churn',
  IDLE: 'idle',
  RETRY: 'retry',
  ACCEPTANCE_EVAL: 'acceptance-eval',
  // Written by the notify dispatcher so resume can prove a dispatch survived a
  // crash window; enumerated so the write-time validator does not drop it.
  NOTIFICATION_EMITTED: 'notification.emitted',
});

/**
 * @type {ReadonlySet<string>}
 */
export const EVENT_KIND_VALUES = Object.freeze(
  new Set(Object.values(EVENT_KINDS)),
);

export const FIELDS = Object.freeze({
  TS: 'ts',
  EPIC_ID: 'epicId',
  STORY_ID: 'storyId',
  TASK_ID: 'taskId',
  KIND: 'kind',

  EMITTER: 'emitter',
  SOURCE: 'source',
  DETAILS: 'details',
  CATEGORY: 'category',
  PHASE: 'phase',
});

/**
 * "Looks like a timestamp string" — the format is not validated.
 *
 * @param {unknown} v
 * @returns {boolean}
 */
function isTimestamp(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * @param {unknown} evt
 * @returns {boolean}
 */
export function hasCommonEnvelope(evt) {
  if (!isObject(evt)) return false;
  if (typeof evt.kind !== 'string' || !EVENT_KIND_VALUES.has(evt.kind)) {
    return false;
  }
  if (!isTimestamp(evt.ts)) return false;
  // The key must be present; its value may be null but never a non-positive int.
  if (!Object.hasOwn(evt, 'epicId')) return false;
  if (evt.epicId !== null && !isPositiveInt(evt.epicId)) return false;
  return true;
}

/**
 * Cheap envelope gate for the streaming reader; the full shape check is the
 * AJV validator in `lib/observability/signal-validator.js`.
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
