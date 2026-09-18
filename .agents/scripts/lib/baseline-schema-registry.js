// ---------------------------------------------------------------------------
// Canonical baseline schema registry (Story #1888).
//
// The shared envelope schema and the six per-kind row/rollup schemas live
// under .agents/schemas/baselines/. Consumers compile them through a single
// AJV instance so cross-references (per-kind schemas `allOf` the envelope)
// resolve without each callsite re-registering the envelope.
//
// `BASELINE_SCHEMA_FILES` is the source of truth for the registered set —
// the mirror-drift test reads it back and compares against the on-disk
// directory listing to catch a new schema landing under baselines/ without
// being registered here.
// ---------------------------------------------------------------------------

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
 * Report schemas that live under `.agents/schemas/baselines/` but describe
 * an *engine's output about* the baselines rather than a committed baseline
 * (Story #4902). They are registered here for two reasons: the AJV instance
 * below is the one place a caller can compile a baselines-directory schema
 * without re-registering the envelope, and the mirror-drift test compares
 * this registry against the on-disk listing — an unregistered file there is
 * drift regardless of which category it belongs to.
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
