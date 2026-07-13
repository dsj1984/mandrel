/**
 * emit-slice-lifecycle.js — Epic #4475 (M4-A).
 *
 * Programmatic emitters for the three single-delivery slice lifecycle events
 * (`slice.start`, `slice.end`, `slice.heartbeat`) — the single-delivery
 * analogues of the per-Story `story.dispatch.start` / `story.dispatch.end` /
 * `story.heartbeat` events. They append one schema-validated NDJSON record to
 * `temp/epic-<id>/lifecycle.ndjson`, mirroring `emit-story-heartbeat.js`.
 *
 * A single-delivery run collapses the whole Epic into one long guarded
 * session walking the `## Delivery Slicing` table on `epic/<id>`. Without a
 * per-Story heartbeat the `/deliver` idle watchdog cannot tell a live session
 * from a dead one, so these events give the long session an inspectable
 * forward-progress signal (`slice.heartbeat`) plus per-slice boundaries
 * (`slice.start` / `slice.end`) the resume path reads back.
 *
 * Introduced INERT in M4-A: the executor that emits these lands in M4-B
 * (`deliver-epic-single.md`). Shipping the emitters + schemas now keeps that
 * PR the flip-only change.
 *
 * The emit is best-effort at the call site (a failure to append MUST NOT
 * block the slice transition itself); callers catch and log via the script's
 * Logger, exactly as the story-heartbeat callers do. These functions still
 * throw on a programming error (bad argument / schema mismatch) so the bug
 * surfaces in tests.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { epicLedgerPath } from '../../config/temp-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'schemas',
  'lifecycle',
);

const VALID_PHASES = new Set([
  'init',
  'implementing',
  'closing',
  'blocked',
  'done',
]);

const VALID_OUTCOMES = new Set(['done', 'blocked', 'failed', 'skipped']);

/** Lazily-compiled AJV validators, one per event schema. */
const _validators = new Map();

function getValidator(event) {
  let validator = _validators.get(event);
  if (!validator) {
    const schema = JSON.parse(
      readFileSync(path.join(SCHEMA_DIR, `${event}.schema.json`), 'utf8'),
    );
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    validator = ajv.compile(schema);
    _validators.set(event, validator);
  }
  return validator;
}

function assertEpicId(epicId) {
  if (!Number.isInteger(epicId) || epicId < 1) {
    throw new Error('emit-slice-lifecycle: epicId must be a positive integer');
  }
}

function assertSliceId(sliceId) {
  if (typeof sliceId !== 'string' || sliceId.length === 0) {
    throw new Error('emit-slice-lifecycle: sliceId must be a non-empty string');
  }
}

/**
 * Validate `payload` against `<event>.schema.json`, then append it as a single
 * NDJSON `emitted` record to the Epic ledger. Shared tail of all three
 * emitters.
 *
 * @param {string} event
 * @param {object} payload
 * @param {{ epicId: number, timestamp: string, config?: object, ledgerPath?: string }} ctx
 * @returns {{ ledgerPath: string, record: object }}
 */
function appendSliceEvent(
  event,
  payload,
  { epicId, timestamp, config, ledgerPath: ledgerPathOverride },
) {
  const validator = getValidator(event);
  if (!validator(payload)) {
    const detail = (validator.errors ?? [])
      .map((e) => `${e.instancePath || '/'} ${e.message}`)
      .join('; ');
    throw new Error(
      `emit-slice-lifecycle: ${event} payload failed schema validation: ${detail}`,
    );
  }

  const ledgerPath = ledgerPathOverride ?? epicLedgerPath(epicId, config);
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const record = { kind: 'emitted', ts: timestamp, event, payload };
  appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`, 'utf8');
  return { ledgerPath, record };
}

/**
 * Append one `slice.start` record as the executor begins implementing a slice.
 *
 * @param {object} opts
 * @param {number} opts.epicId
 * @param {string} opts.sliceId       Stable slice-map key (e.g. `slice-1`).
 * @param {number} [opts.sliceIndex]  Zero-based position in the Delivery
 *                                    Slicing table.
 * @param {string} [opts.title]       Human-readable slice label.
 * @param {string} [opts.timestamp]   ISO-8601 wall clock. Defaults to now().
 * @param {object} [opts.config]
 * @param {string} [opts.ledgerPath]  Override for tests.
 * @returns {{ ledgerPath: string, record: object }}
 */
export function emitSliceStart(opts) {
  const {
    epicId,
    sliceId,
    sliceIndex,
    title,
    timestamp = new Date().toISOString(),
    config,
    ledgerPath,
  } = opts ?? {};
  assertEpicId(epicId);
  assertSliceId(sliceId);

  const payload = {
    event: 'slice.start',
    epicId,
    sliceId,
    ...(Number.isInteger(sliceIndex) ? { sliceIndex } : {}),
    ...(typeof title === 'string' ? { title } : {}),
    timestamp,
  };
  return appendSliceEvent('slice.start', payload, {
    epicId,
    timestamp,
    config,
    ledgerPath,
  });
}

/**
 * Append one `slice.end` record when a slice finishes. A `done` outcome is
 * what the slice-map checkpoint flips `slices[id].status` to before the walk
 * advances.
 *
 * @param {object} opts
 * @param {number} opts.epicId
 * @param {string} opts.sliceId
 * @param {'done'|'blocked'|'failed'|'skipped'} opts.outcome
 * @param {number} [opts.sliceIndex]
 * @param {number} [opts.durationMs]
 * @param {string} [opts.timestamp]
 * @param {object} [opts.config]
 * @param {string} [opts.ledgerPath]
 * @returns {{ ledgerPath: string, record: object }}
 */
export function emitSliceEnd(opts) {
  const {
    epicId,
    sliceId,
    outcome,
    sliceIndex,
    durationMs,
    timestamp = new Date().toISOString(),
    config,
    ledgerPath,
  } = opts ?? {};
  assertEpicId(epicId);
  assertSliceId(sliceId);
  if (!VALID_OUTCOMES.has(outcome)) {
    throw new Error(
      `emit-slice-lifecycle: slice.end outcome "${outcome}" must be one of: ${[...VALID_OUTCOMES].join(', ')}`,
    );
  }

  const payload = {
    event: 'slice.end',
    epicId,
    sliceId,
    ...(Number.isInteger(sliceIndex) ? { sliceIndex } : {}),
    outcome,
    ...(Number.isInteger(durationMs) ? { durationMs } : {}),
    timestamp,
  };
  return appendSliceEvent('slice.end', payload, {
    epicId,
    timestamp,
    config,
    ledgerPath,
  });
}

/**
 * Append one `slice.heartbeat` record from inside a slice's implementation
 * loop — the forward-progress signal the idle watchdog reads for the single
 * long session.
 *
 * @param {object} opts
 * @param {number} opts.epicId
 * @param {string} opts.sliceId
 * @param {string} [opts.phase='implementing']  init|implementing|closing|blocked|done.
 * @param {string} [opts.timestamp]
 * @param {string} [opts.operator]  Optional lease-owner handle; included only
 *                                  when a non-empty string is supplied.
 * @param {object} [opts.config]
 * @param {string} [opts.ledgerPath]
 * @returns {{ ledgerPath: string, record: object }}
 */
export function emitSliceHeartbeat(opts) {
  const {
    epicId,
    sliceId,
    phase = 'implementing',
    timestamp = new Date().toISOString(),
    operator,
    config,
    ledgerPath,
  } = opts ?? {};
  assertEpicId(epicId);
  assertSliceId(sliceId);
  if (!VALID_PHASES.has(phase)) {
    throw new Error(
      `emit-slice-lifecycle: slice.heartbeat phase "${phase}" must be one of: ${[...VALID_PHASES].join(', ')}`,
    );
  }
  if (
    operator !== undefined &&
    (typeof operator !== 'string' || operator.length === 0)
  ) {
    throw new Error(
      'emit-slice-lifecycle: operator, when supplied, must be a non-empty string',
    );
  }

  const payload = {
    event: 'slice.heartbeat',
    epicId,
    sliceId,
    phase,
    timestamp,
    ...(operator !== undefined ? { operator } : {}),
  };
  return appendSliceEvent('slice.heartbeat', payload, {
    epicId,
    timestamp,
    config,
    ledgerPath,
  });
}
