/**
 * standard-args.js — shared CLI flag parser for the dispatcher's
 * top-level scripts (Story #2460, Epic #2453 — CLI thinning pilot).
 *
 * Replaces the per-CLI hand-rolled flag dispatch with a single
 * declarative entrypoint that the refactored scripts (story-close,
 * epic-deliver, check-baselines, audit-suite/cli) all call. The helper
 * is **intentionally minimal**: it only covers the flags every dispatcher
 * CLI shares (`--epic`, `--story`, `--task`, `--changed-since`, `--json`,
 * `--full-scope`, `--dry-run`). CLI-specific flags (e.g. `--skip-dashboard`
 * on story-close, `--gate` on check-baselines) stay in the calling
 * script's local `defineFlags` schema.
 *
 * Contract
 * --------
 *   parseStandardCliArgs(argv, schema?) → { values, positionals }
 *
 *   - `argv`   — `process.argv.slice(2)` shape; the helper does NOT strip
 *     the leading `node` + script-path entries on the caller's behalf.
 *   - `schema` — optional, declarative override of which flags are
 *     required. Shape: `{ [flagName]: { required?: boolean } }`. Unknown
 *     keys in `schema` are rejected so a typo in the caller's schema does
 *     not silently disable the required-field check.
 *
 *   `values` is always returned with every known flag present:
 *
 *     { epicId, storyId, taskId, changedSince, json, fullScope, dryRun }
 *
 *   Ticket-shaped flags (`--epic`, `--story`, `--task`) parse via
 *   `parseTicketId` (positive integer; leading `#` stripped; `null` on
 *   anything invalid). The string-shaped `--changed-since` keeps the raw
 *   string (or `null` when absent). Boolean flags coerce to `false` when
 *   absent and `true` when present (with or without a value).
 *
 * Failure modes
 * -------------
 *   - **Unknown flag**: an argv token shaped like `--foo` whose name is
 *     not in the supported set throws an `Error` with a stable
 *     `code: 'UNKNOWN_FLAG'` plus the offending flag name. Callers
 *     wrapping the parse in `runAsCli` get a clean exit-1 with the
 *     message printed to stderr.
 *   - **Missing required flag**: when `schema[flag].required === true`
 *     and the resolved value is absent (ticket flags → `null`; string
 *     flags → `null`/empty; boolean flags → `false`), the parser throws
 *     with `code: 'MISSING_REQUIRED_FLAG'` and the flag name.
 *
 * Why a thin shim and not a re-export of `defineFlags`
 * ----------------------------------------------------
 *   `defineFlags` is a powerful declarative parser, but every dispatcher
 *   CLI hand-rolls its own option spec — duplicated `--epic` / `--story`
 *   blocks across four scripts, each subtly different (some accept
 *   short `-e`, some don't). `parseStandardCliArgs` collapses that
 *   duplication into one canonical spec; callers compose their
 *   CLI-specific flags via a separate `defineFlags` call against their
 *   own argv slice.
 *
 * @module lib/cli/standard-args
 */

import { defineFlags, parseTicketId } from '../cli-args.js';

/**
 * Canonical spec passed to `defineFlags`. Every key in `SUPPORTED_FLAGS`
 * is what the parser will accept; anything else triggers `UNKNOWN_FLAG`.
 *
 * Each entry below maps the kebab-cased CLI flag to:
 *   - `key`:  the camelCased output key on `values`
 *   - `type`: 'ticket' | 'string' | 'boolean'
 *
 * The values in `defineFlags`'s `spec` argument are the declarative
 * shape `defineFlags` understands; the `key` is duplicated here so the
 * required-field check (which works against `values`) can locate each
 * flag's resolved slot without re-parsing the alias rules.
 */
const SUPPORTED_FLAGS = Object.freeze({
  epic: { key: 'epicId', type: 'ticket' },
  story: { key: 'storyId', type: 'ticket' },
  task: { key: 'taskId', type: 'ticket' },
  'changed-since': { key: 'changedSince', type: 'string' },
  json: { key: 'json', type: 'boolean' },
  'full-scope': { key: 'fullScope', type: 'boolean' },
  'dry-run': { key: 'dryRun', type: 'boolean' },
});

const FLAG_NAMES = Object.keys(SUPPORTED_FLAGS);

/**
 * Build the `defineFlags` spec from the canonical flag table. Kept as a
 * function so we can reshape it cheaply if `defineFlags` ever grows new
 * declarative knobs.
 */
function buildDefineFlagsSpec() {
  const spec = {};
  for (const [flag, { key, type }] of Object.entries(SUPPORTED_FLAGS)) {
    spec[flag] = { type, alias: key };
  }
  return spec;
}

/**
 * Scan the raw argv for `--foo` tokens whose name is not in the
 * supported set. `defineFlags` silently drops unknown flags (its
 * `parseTokens` walker treats them as a no-op), which is the wrong
 * default for a strict shared parser — a typo in `--changed-sinec` would
 * silently produce `changedSince: null`. We pre-walk the argv with the
 * supported-name allowlist instead.
 *
 * Returns the offending flag name on the first hit, or `null` when
 * every flag-shaped token is known. The supported-name match is exact
 * (no `--` prefix, no `=value` suffix).
 */
function findUnknownFlag(argv) {
  for (const tok of argv) {
    if (typeof tok !== 'string') continue;
    if (tok === '--') break;
    if (!tok.startsWith('--')) continue;
    const eq = tok.indexOf('=');
    const name = eq >= 0 ? tok.slice(2, eq) : tok.slice(2);
    if (name.length === 0) continue;
    if (!FLAG_NAMES.includes(name)) return name;
  }
  return null;
}

/**
 * Validate the caller-supplied `schema`. Reject any key that is not a
 * supported flag — silently dropping a typo would let a "required" flag
 * never actually be enforced.
 */
function validateSchema(schema) {
  if (schema === undefined || schema === null) return;
  if (typeof schema !== 'object') {
    throw new Error('parseStandardCliArgs: schema must be an object');
  }
  for (const flag of Object.keys(schema)) {
    if (!Object.hasOwn(SUPPORTED_FLAGS, flag)) {
      const err = new Error(
        `parseStandardCliArgs: schema references unsupported flag "${flag}". ` +
          `Supported: ${FLAG_NAMES.join(', ')}.`,
      );
      err.code = 'UNKNOWN_FLAG_IN_SCHEMA';
      throw err;
    }
  }
}

/**
 * Apply the per-flag `required` constraints from `schema` against the
 * resolved `values`. "Absent" depends on type:
 *   - `ticket` → `null` (the canonical "not parsable" sentinel)
 *   - `string` → `null` or `''`
 *   - `boolean` → `false` (absent or explicitly `--flag=false`)
 *
 * Throws on the first missing required flag with a stable error code.
 */
function enforceRequired(values, schema) {
  if (!schema) return;
  for (const [flag, rule] of Object.entries(schema)) {
    if (!rule || rule.required !== true) continue;
    const meta = SUPPORTED_FLAGS[flag];
    const cur = values[meta.key];
    let absent = false;
    if (meta.type === 'ticket') absent = cur === null || cur === undefined;
    else if (meta.type === 'string')
      absent = cur === null || cur === undefined || cur === '';
    else if (meta.type === 'boolean') absent = !cur;
    if (absent) {
      const err = new Error(
        `parseStandardCliArgs: missing required flag --${flag}`,
      );
      err.code = 'MISSING_REQUIRED_FLAG';
      err.flag = flag;
      throw err;
    }
  }
}

/**
 * Coerce the raw `defineFlags` output into the canonical shape the
 * dispatcher CLIs consume. `defineFlags` already applies the alias
 * (`epic` → `epicId`, …) and runs `parseTicketId` for the ticket-typed
 * entries, so this step mostly normalises absent strings / booleans into
 * a stable JSON-friendly shape.
 *
 * The `parseTicketId` import is retained as a safety net: callers that
 * pre-process argv into `--epic=#123` (with a literal `#`) get the
 * same coercion the rest of the codebase uses.
 */
function normaliseValues(raw) {
  const out = {};
  for (const [flag, { key, type }] of Object.entries(SUPPORTED_FLAGS)) {
    let v = raw[key];
    if (type === 'ticket') {
      // `defineFlags` already ran parseTicketId, but keep this idempotent
      // in case a future call path bypasses defineFlags (e.g. tests
      // injecting pre-built `values`).
      v = parseTicketId(v);
    } else if (type === 'string') {
      v = typeof v === 'string' && v.length > 0 ? v : null;
    } else if (type === 'boolean') {
      v = v === true;
    }
    out[key] = v;
    // Touch `flag` lint-side; the destructure is the load-bearing read.
    void flag;
  }
  return out;
}

/**
 * Parse the dispatcher's shared CLI flag surface. See module docstring
 * for the full contract.
 *
 * @param {string[]} argv - argv slice (no `node` / script path).
 * @param {Record<string, { required?: boolean }>} [schema]
 * @returns {{ values: Record<string, unknown>, positionals: string[] }}
 */
export function parseStandardCliArgs(argv = [], schema) {
  if (!Array.isArray(argv)) {
    throw new Error('parseStandardCliArgs: argv must be an array');
  }
  const unknown = findUnknownFlag(argv);
  if (unknown !== null) {
    const err = new Error(
      `parseStandardCliArgs: unknown flag --${unknown}. ` +
        `Supported: ${FLAG_NAMES.map((n) => `--${n}`).join(', ')}.`,
    );
    err.code = 'UNKNOWN_FLAG';
    err.flag = unknown;
    throw err;
  }
  validateSchema(schema);
  const { values: raw, positionals } = defineFlags(
    buildDefineFlagsSpec(),
    argv,
  );
  const values = normaliseValues(raw);
  enforceRequired(values, schema);
  return { values, positionals };
}

export { FLAG_NAMES, SUPPORTED_FLAGS };
