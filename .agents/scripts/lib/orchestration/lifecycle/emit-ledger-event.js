/**
 * emit-ledger-event.js — shared validate-and-append core for the
 * merge-terminal lifecycle emitters (Story #4539).
 *
 * `emit-merge-unlanded.js` and `emit-merge-flip-failed.js` report the two
 * terminal outcomes a landing attempt can reach without ending at
 * `agent::done`. They share everything except their schema and their
 * payload's meaning, so the Ajv compile/cache, the scope→ledger routing,
 * and the NDJSON append live here once rather than being copy-pasted.
 *
 * Like its callers, this is a bare `appendFileSync` rather than a bus
 * publish: these events fire from the `single-story-close` flow, which has
 * no bus at all, so a direct append keeps the call site dependency-free.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { storyLedgerPath } from '../../config/temp-paths.js';

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

/**
 * The scopes a merge-terminal event may be WRITTEN with. v2.0.0 removed the
 * Epic tier, so `'story'` is the only emittable scope.
 *
 * Note the deliberate asymmetry with the `merge.unlanded` /
 * `merge.flip-failed` schema enums, which still accept `'epic'`: archived
 * ledger records carry `scope: 'epic'` and the schemas must keep validating
 * them on read. The value stays READABLE; only the writer path is gone —
 * the same split `merge-block-class.js` keeps for `predicate-refused`.
 */
const VALID_SCOPES = new Set(['story']);

/** @type {Map<string, Function>} */
const _validators = new Map();

/**
 * Compile (once) and return the validator for a lifecycle schema file.
 *
 * @param {string} schemaFile Basename under `.agents/schemas/lifecycle/`.
 * @returns {Function}
 */
function getValidator(schemaFile) {
  const cached = _validators.get(schemaFile);
  if (cached) return cached;
  const schema = JSON.parse(
    readFileSync(path.resolve(SCHEMA_DIR, schemaFile), 'utf8'),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validator = ajv.compile(schema);
  _validators.set(schemaFile, validator);
  return validator;
}

/**
 * Assert the fields every merge-terminal event shares. Throws with the
 * caller's own emitter name so the message stays attributable.
 *
 * @param {string} emitter
 * @param {{ scope: string, ticketId: number, prNumber: number, reason: string, elapsedSeconds: number }} fields
 */
export function assertMergeTerminalFields(
  emitter,
  { scope, ticketId, prNumber, reason, elapsedSeconds },
) {
  if (!VALID_SCOPES.has(scope)) {
    throw new Error(
      `${emitter}: scope "${scope}" must be one of: ${[...VALID_SCOPES].join(', ')}`,
    );
  }
  if (!Number.isInteger(ticketId) || ticketId < 1) {
    throw new Error(`${emitter}: ticketId must be a positive integer`);
  }
  if (!Number.isInteger(prNumber) || prNumber < 1) {
    throw new Error(`${emitter}: prNumber must be a positive integer`);
  }
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new Error(`${emitter}: reason must be a non-empty string`);
  }
  if (typeof elapsedSeconds !== 'number' || elapsedSeconds < 0) {
    throw new Error(`${emitter}: elapsedSeconds must be a non-negative number`);
  }
}

/**
 * Validate a payload against its lifecycle schema and append exactly one
 * NDJSON record to the scope-resolved ledger.
 *
 * @param {object} args
 * @param {string} args.emitter       Caller name, for error attribution.
 * @param {string} args.schemaFile    Basename under `schemas/lifecycle/`.
 * @param {object} args.payload       The event payload (already assembled).
 * @param {number} args.ticketId
 * @param {string} args.timestamp
 * @param {object} [args.config]
 * @param {string} [args.ledgerPath]  Override for tests / non-default layouts.
 * @returns {{ ledgerPath: string, record: object }}
 */
export function appendLedgerEvent({
  emitter,
  schemaFile,
  payload,
  ticketId,
  timestamp,
  config,
  ledgerPath: ledgerPathOverride,
}) {
  const validator = getValidator(schemaFile);
  if (!validator(payload)) {
    const detail = (validator.errors ?? [])
      .map((e) => `${e.instancePath || '/'} ${e.message}`)
      .join('; ');
    throw new Error(`${emitter}: payload failed schema validation: ${detail}`);
  }

  const ledgerPath =
    ledgerPathOverride ?? storyLedgerPath(null, ticketId, config);
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const record = {
    kind: 'emitted',
    ts: timestamp,
    event: payload.event,
    payload,
  };
  appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`, 'utf8');
  return { ledgerPath, record };
}
