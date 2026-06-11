/**
 * emit-story-dispatch-end.js — Story #3900.
 *
 * Programmatic helper that appends a single `story.dispatch.end` NDJSON
 * record to `temp/epic-<id>/lifecycle.ndjson` for one recorded Story.
 *
 * Why this exists:
 *   The `wave-tick.js` in-flight reconciler (and the `--check-idle`
 *   watchdog) compute "in-flight" Stories as those carrying a
 *   `story.dispatch.start` record WITHOUT a matching `story.dispatch.end`.
 *   Before this Story the only producer of `story.dispatch.end` was
 *   `lib/orchestration/wave-session.js`, which nothing imports outside
 *   tests — so every dispatched Story stayed "in-flight" forever and the
 *   idle watchdog flagged completed Stories as stalled. The host-LLM driven
 *   `/deliver` path closes a wave through `epic-execute-record-wave.js`,
 *   so that CLI is the correct place to emit the matching dispatch-end per
 *   recorded Story.
 *
 * The emit mirrors the thin direct-append shape of
 * `lifecycle-emit-story-dispatch.js` (start) and `emit-story-heartbeat.js`:
 * one schema-validated `emitted`-kind record, no full listener chain. It is
 * best-effort at the call site — a failed append must not block the wave
 * loop, so callers wrap it and log.
 *
 * Schema contract (story.dispatch.end.schema.json):
 *   { storyId, outcome: done|blocked|failed|skipped, durationMs }
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { epicLedgerPath } from '../../config/temp-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'schemas',
  'lifecycle',
  'story.dispatch.end.schema.json',
);

const VALID_OUTCOMES = new Set(['done', 'blocked', 'failed', 'skipped']);

let _validator;

function getValidator() {
  if (_validator) return _validator;
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  _validator = ajv.compile(schema);
  return _validator;
}

/**
 * Append exactly one `story.dispatch.end` NDJSON record to the Epic ledger.
 *
 * @param {object} opts
 * @param {number} opts.epicId       Parent Epic — required for the ledger path.
 * @param {number} opts.storyId      Story whose dispatch settled.
 * @param {string} opts.outcome      One of done|blocked|failed|skipped.
 * @param {number} [opts.durationMs=0]  Wall-clock dispatch duration in ms.
 *                                       Defaults to 0 when the host loop does
 *                                       not track per-Story timing.
 * @param {string} [opts.timestamp]  ISO-8601 wall clock. Defaults to now().
 * @param {object} [opts.config]     Optional resolved config for tempRoot.
 * @param {string} [opts.ledgerPath] Override for tests.
 * @returns {{ ledgerPath: string, record: object }}
 */
export function emitStoryDispatchEnd(opts) {
  const {
    epicId,
    storyId,
    outcome,
    durationMs = 0,
    timestamp = new Date().toISOString(),
    config,
    ledgerPath: ledgerPathOverride,
  } = opts ?? {};

  if (!Number.isInteger(epicId) || epicId < 1) {
    throw new Error('emitStoryDispatchEnd: epicId must be a positive integer');
  }
  if (!Number.isInteger(storyId) || storyId < 1) {
    throw new Error('emitStoryDispatchEnd: storyId must be a positive integer');
  }
  if (!VALID_OUTCOMES.has(outcome)) {
    throw new Error(
      `emitStoryDispatchEnd: outcome "${outcome}" must be one of: ${[...VALID_OUTCOMES].join(', ')}`,
    );
  }
  if (!Number.isInteger(durationMs) || durationMs < 0) {
    throw new Error(
      'emitStoryDispatchEnd: durationMs must be a non-negative integer',
    );
  }

  const payload = { storyId, outcome, durationMs };

  const validator = getValidator();
  if (!validator(payload)) {
    const detail = (validator.errors ?? [])
      .map((e) => `${e.instancePath || '/'} ${e.message}`)
      .join('; ');
    throw new Error(
      `emitStoryDispatchEnd: payload failed schema validation: ${detail}`,
    );
  }

  const ledgerPath = ledgerPathOverride ?? epicLedgerPath(epicId, config);
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const record = {
    kind: 'emitted',
    ts: timestamp,
    event: 'story.dispatch.end',
    payload,
  };
  appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`, 'utf8');
  return { ledgerPath, record };
}

/**
 * Map a recorded Story status (`done`/`blocked`/`failed`) to the
 * `story.dispatch.end` outcome enum. The status taxonomy is a strict subset
 * of the outcome enum, so the mapping is identity for the three values the
 * record-wave projection produces. Unknown values throw rather than emit a
 * schema-invalid record.
 *
 * @param {string} status
 * @returns {string}
 */
export function storyStatusToDispatchOutcome(status) {
  if (!VALID_OUTCOMES.has(status)) {
    throw new Error(
      `storyStatusToDispatchOutcome: unknown story status "${status}"`,
    );
  }
  return status;
}
