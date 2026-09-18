/**
 * signal-validator.js — write-time validation of signal records against the
 * on-disk `signal-event.schema.json`, compiled once so the writer and the
 * contract test validate against the same document. Never throws.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import { Logger } from '../Logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'schemas',
  'signal-event.schema.json',
);

/**
 * `null` when the schema cannot be compiled: validation then fails open so a
 * packaging error never drops every signal.
 *
 * @returns {import('ajv').ValidateFunction | null}
 */
function buildValidator() {
  try {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    return ajv.compile(schema);
  } catch (err) {
    Logger.warn(
      `signal-validator: failed to compile signal-event schema (${
        err instanceof Error ? err.message : String(err)
      }); write-time validation disabled for this process.`,
    );
    return null;
  }
}

const _validate = buildValidator();

/**
 * @param {import('ajv').ErrorObject[] | null | undefined} errors
 * @returns {string}
 */
function violatingFieldOf(errors) {
  const first = Array.isArray(errors) && errors.length > 0 ? errors[0] : null;
  if (!first) return 'unknown';
  if (first.keyword === 'required' && first.params?.missingProperty) {
    return String(first.params.missingProperty);
  }
  if (typeof first.instancePath === 'string' && first.instancePath.length > 0) {
    return first.instancePath.replace(/^\//, '').replace(/\//g, '.');
  }
  if (
    first.keyword === 'additionalProperties' &&
    first.params?.additionalProperty
  ) {
    return String(first.params.additionalProperty);
  }
  return first.message ?? 'unknown';
}

/**
 * @param {unknown} record
 * @returns {{ valid: boolean, violatingField: string|null, message: string|null }}
 */
export function validateSignal(record) {
  if (_validate === null) {
    return { valid: true, violatingField: null, message: null };
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return {
      valid: false,
      violatingField: 'record',
      message: 'signal record must be a plain object',
    };
  }
  const valid = _validate(record);
  if (valid) return { valid: true, violatingField: null, message: null };
  const field = violatingFieldOf(_validate.errors);
  const message = _validate.errors?.[0]?.message ?? 'schema validation failed';
  return { valid: false, violatingField: field, message };
}
