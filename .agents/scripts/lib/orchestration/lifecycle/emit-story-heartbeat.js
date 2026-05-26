/**
 * emit-story-heartbeat.js — Story #3057.
 *
 * Programmatic helper that appends a single `story.heartbeat` NDJSON
 * record to `temp/epic-<id>/lifecycle.ndjson` after a Task close inside
 * a Story's implementation loop. Story-implementation phases can run
 * for many minutes between dispatch and merge; `story.heartbeat` is
 * the inspectable in-progress signal the host-loop reconciler reads
 * to confirm forward progress.
 *
 * Distinct from:
 *   - `story.dispatch.start` — one per Story per dispatch attempt
 *     (lifecycle-emit-story-dispatch.js).
 *   - `story.merged` — one per Story per close, post-merge.
 *
 * The emit is best-effort: a failure to append (missing schema,
 * unreachable ledger path, validation error) MUST NOT block the Task
 * transition itself. Callers should catch and log via the script's
 * Logger; the heartbeat is observability, not state.
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
 * @param {number} opts.taskId    Closed Task id whose commit triggered the heartbeat.
 * @param {string} [opts.timestamp]  ISO-8601 wall clock. Defaults to now().
 * @param {object} [opts.config]  Optional resolved config for tempRoot lookup.
 * @param {string} [opts.ledgerPath]  Override for tests.
 * @returns {{ ledgerPath: string, record: object }}
 */
export function emitStoryHeartbeat(opts) {
  const {
    storyId,
    epicId,
    taskId,
    timestamp = new Date().toISOString(),
    config,
    ledgerPath: ledgerPathOverride,
  } = opts ?? {};

  if (!Number.isInteger(storyId) || storyId < 1) {
    throw new Error('emitStoryHeartbeat: storyId must be a positive integer');
  }
  if (!Number.isInteger(epicId) || epicId < 1) {
    throw new Error('emitStoryHeartbeat: epicId must be a positive integer');
  }
  if (!Number.isInteger(taskId) || taskId < 1) {
    throw new Error('emitStoryHeartbeat: taskId must be a positive integer');
  }

  const payload = {
    event: 'story.heartbeat',
    storyId,
    epicId,
    phase: 'implementing',
    taskId,
    timestamp,
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
