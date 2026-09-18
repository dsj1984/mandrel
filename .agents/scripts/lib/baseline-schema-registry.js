// Baseline schema registry: one AJV instance, so per-kind schemas' `allOf`
// envelope references resolve. `BASELINE_SCHEMA_FILES` must match the
// on-disk listing (a mirror-drift test enforces it).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to `.agents/schemas/baselines/` resolved from this module. */
export const BASELINE_SCHEMAS_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  'schemas',
  'baselines',
);

/** Envelope schema filename. */
export const BASELINE_ENVELOPE_FILE = 'baseline-envelope.schema.json';

/** Per-kind baseline schema filenames in stable registration order. */
export const BASELINE_KIND_SCHEMA_FILES = Object.freeze([
  'coverage.schema.json',
  'crap.schema.json',
  'maintainability.schema.json',
  'mutation.schema.json',
  'bundle-size.schema.json',
  'duplication.schema.json',
]);

/**
 * Schemas for engine reports about baselines, not baselines themselves;
 * registered because every file in the directory must be.
 */
const BASELINE_REPORT_SCHEMA_FILES = ['audit-baselines-envelope.schema.json'];

/** Every baseline schema filename (envelope + per-kind + report) in registration order. */
export const BASELINE_SCHEMA_FILES = Object.freeze([
  BASELINE_ENVELOPE_FILE,
  ...BASELINE_KIND_SCHEMA_FILES,
  ...BASELINE_REPORT_SCHEMA_FILES,
]);

/**
 * Build an AJV instance with the envelope and every per-kind baseline schema
 * pre-registered. Throws if any schema file is unreadable or fails to compile.
 *
 * @returns {Ajv} configured AJV with all baseline schemas registered.
 */
export function buildBaselineSchemaAjv() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  for (const filename of BASELINE_SCHEMA_FILES) {
    const filePath = path.join(BASELINE_SCHEMAS_DIR, filename);
    const schema = JSON.parse(readFileSync(filePath, 'utf8'));
    ajv.addSchema(schema, filename);
  }
  return ajv;
}
