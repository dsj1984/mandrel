/**
 * emit-story-heartbeat.js — Story #3057.
 *
 * Programmatic helper that appends a single `story.heartbeat` NDJSON
 * record to `temp/epic-<id>/lifecycle.ndjson` during a Story's
 * implementation loop. Story-implementation phases can run for many
 * minutes between dispatch and merge; `story.heartbeat` is the
 * inspectable in-progress signal the host-loop reconciler reads to
 * confirm forward progress.
 *
 * Distinct from:
 *   - `story.dispatch.start` — one per Story per dispatch attempt
 *     (lifecycle-emit-story-dispatch.js).
 *   - `story.merged` — one per Story per close, post-merge.
 *
 * The emit is best-effort: a failure to append (missing schema,
 * unreachable ledger path, validation error) MUST NOT block the phase
 * transition itself. Callers should catch and log via the script's
 * Logger; the heartbeat is observability, not state.
 *
 * Schema contract (story.heartbeat.schema.json):
 *   { event, storyId, epicId, phase, timestamp, operator? }
 *
 * The schema declares `additionalProperties: false`, so this emitter's
 * signature is deliberately narrow: only the schema-allowed fields are
 * accepted. The earlier per-child Task id and progress counters
 * were dropped under Epic #3078's
 * 2-tier hard cutover — they would fail strict validation and have no
 * meaning now that the Story is the leaf execution unit with no child
 * tickets. The optional `operator` field (Story #3480) records the handle
 * holding the assignee-as-lease claim; it is included only when supplied so
 * pre-lease callers continue to emit the unchanged shape.
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
  'story.heartbeat.schema.json',
);

const VALID_PHASES = new Set([
  'init',
  'implementing',
  'closing',
  'blocked',
  'done',
]);

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
 * Append exactly one `story.heartbeat` NDJSON record to the Epic ledger.
 *
 * @param {object} opts
 * @param {number} opts.storyId   Story whose implementation loop is firing.
 * @param {number} opts.epicId    Parent Epic — required for the ledger path.
 * @param {string} [opts.phase='implementing']
 *                                One of init|implementing|closing|blocked|done.
 * @param {string} [opts.timestamp]   ISO-8601 wall clock. Defaults to now().
 * @param {string} [opts.operator]    Optional lease-owner handle (Story #3480).
 *                                    When a non-empty string is supplied it is
 *                                    recorded on the payload so the
 *                                    assignee-as-lease primitive can decide a
 *                                    claim's liveness from the latest heartbeat
 *                                    for a given owner. Omitted when absent so
 *                                    pre-lease callers emit the unchanged shape.
 * @param {object} [opts.config]      Optional resolved config for tempRoot.
 * @param {string} [opts.ledgerPath]  Override for tests.
 * @returns {{ ledgerPath: string, record: object }}
 */
export function emitStoryHeartbeat(opts) {
  const {
    storyId,
    epicId,
    phase = 'implementing',
    timestamp = new Date().toISOString(),
    operator,
    config,
    ledgerPath: ledgerPathOverride,
  } = opts ?? {};

  if (!Number.isInteger(storyId) || storyId < 1) {
    throw new Error('emitStoryHeartbeat: storyId must be a positive integer');
  }
  if (!Number.isInteger(epicId) || epicId < 1) {
    throw new Error('emitStoryHeartbeat: epicId must be a positive integer');
  }
  if (!VALID_PHASES.has(phase)) {
    throw new Error(
      `emitStoryHeartbeat: phase "${phase}" must be one of: ${[...VALID_PHASES].join(', ')}`,
    );
  }
  if (
    operator !== undefined &&
    (typeof operator !== 'string' || operator.length === 0)
  ) {
    throw new Error(
      'emitStoryHeartbeat: operator, when supplied, must be a non-empty string',
    );
  }

  const payload = {
    event: 'story.heartbeat',
    storyId,
    epicId,
    phase,
    timestamp,
    ...(operator !== undefined ? { operator } : {}),
  };

  const validator = getValidator();
  if (!validator(payload)) {
    const detail = (validator.errors ?? [])
      .map((e) => `${e.instancePath || '/'} ${e.message}`)
      .join('; ');
    throw new Error(
      `emitStoryHeartbeat: payload failed schema validation: ${detail}`,
    );
  }

  const ledgerPath = ledgerPathOverride ?? epicLedgerPath(epicId, config);
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const record = {
    kind: 'emitted',
    ts: timestamp,
    event: 'story.heartbeat',
    payload,
  };
  appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`, 'utf8');
  return { ledgerPath, record };
}
