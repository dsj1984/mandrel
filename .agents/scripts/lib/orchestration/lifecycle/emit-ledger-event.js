/**
 * Shared schema-validate-and-append core for the merge-terminal lifecycle
 * emitters (outcomes that end short of `agent::done`).
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
 * Writable scopes. The schemas still accept `'epic'` so archived records
 * keep validating on read; only the writer path is gone.
 */
const VALID_SCOPES = new Set(['story']);

/** @type {Map<string, Function>} */
const _validators = new Map();

/**
 * @param {string} schemaFile
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
 * @param {object} args
 * @param {string} args.emitter
 * @param {string} args.schemaFile
 * @param {object} args.payload
 * @param {number} args.ticketId
 * @param {string} args.timestamp
 * @param {object} [args.config]
 * @param {string} [args.ledgerPath]
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
