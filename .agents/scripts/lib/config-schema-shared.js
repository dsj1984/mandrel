/**
 * Shell-injection pattern source (string form) used inside JSON Schema
 * `not.pattern` clauses. Kept as a string so the schema literal and the
 * regex form share one definition.
 *
 * Matches `;`, `&`, `|`, backtick, or `$(`.
 */
export const SHELL_INJECTION_PATTERN_STRING = '([;&|`]|\\$\\()';

/**
 * Regex form of the lenient shell-injection pattern for runtime string checks.
 */
export const SHELL_INJECTION_RE = new RegExp(SHELL_INJECTION_PATTERN_STRING);

/**
 * Stricter shell metacharacter pattern for orchestration runtime values
 * (owner, repo, operator handle, webhook URL) where no shell metacharacters
 * are ever legitimate.
 */
export const SHELL_INJECTION_RE_STRICT = /[&|;`<>()$]/;

// ---------------------------------------------------------------------------
// Canonical baseline schema registration (Story #1888).
//
// The shared envelope schema and the seven per-kind row/rollup schemas live
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

/**
 * Absolute path to `.agents/schemas/baselines/` resolved from this module.
 */
export const BASELINE_SCHEMAS_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  'schemas',
  'baselines',
);

/**
 * Envelope schema filename. Registered separately so per-kind schemas can
 * resolve `{ "$ref": "baseline-envelope.schema.json" }`.
 */
export const BASELINE_ENVELOPE_FILE = 'baseline-envelope.schema.json';

/**
 * Per-kind baseline schema filenames in stable registration order.
 *
 * When a new per-kind schema is added under `.agents/schemas/baselines/`,
 * append its filename here. The mirror-drift test asserts that this list
 * matches the on-disk directory contents (modulo the envelope) and fails
 * loudly when the two diverge.
 */
export const BASELINE_KIND_SCHEMA_FILES = Object.freeze([
  'lint.schema.json',
  'coverage.schema.json',
  'crap.schema.json',
  'maintainability.schema.json',
  'mutation.schema.json',
  'lighthouse.schema.json',
  'bundle-size.schema.json',
]);

/**
 * Every baseline schema filename (envelope + per-kind) in registration
 * order. Convenience export — `BASELINE_KIND_SCHEMA_FILES` is the editable
 * source of truth.
 */
export const BASELINE_SCHEMA_FILES = Object.freeze([
  BASELINE_ENVELOPE_FILE,
  ...BASELINE_KIND_SCHEMA_FILES,
]);

/**
 * Build an AJV instance with the envelope and all per-kind baseline schemas
 * pre-registered. Per-kind schemas resolve their `allOf` reference to the
 * envelope through the shared instance.
 *
 * Throws if any schema file is unreadable or fails to compile — callers
 * that want a non-throwing check can wrap in try/catch and inspect the
 * thrown error.
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
