/**
 * standard-args.js — shared CLI flag parser for the dispatcher's
 * top-level scripts (Story #2460, Epic #2453 — CLI thinning pilot).
 *
 * Replaces the per-CLI hand-rolled flag dispatch with a single
 * declarative entrypoint that the refactored scripts (story-close,
 * epic-deliver, check-baselines, audit-suite/cli) all call. The helper
 * covers the flags every dispatcher CLI shares (`--epic`, `--story`,
 * `--changed-since`, `--json`, `--full-scope`, `--dry-run`)
 * and — via the `extras` schema entry — caller-defined extras (e.g.
 * `--root`, `--scope`, `--check`) so a script can replace its local
 * argv walker with a single declarative call.
 *
 * Contract
 * --------
 *   parseStandardCliArgs(argv, schema?) → { values, positionals }
 *   parseStandardCliArgs({ argv, schema?, extras? }) → { values, positionals }
 *
 *   - `argv`    — `process.argv.slice(2)` shape; the helper does NOT strip
 *     the leading `node` + script-path entries on the caller's behalf.
 *   - `schema`  — optional, declarative override of which standard flags
 *     are required. Shape: `{ [flagName]: { required?: boolean } }`.
 *     Unknown keys are rejected so a typo doesn't silently disable the
 *     required-field check.
 *   - `extras`  — optional, declarative map of caller-defined flags.
 *     Shape: `{ [flagName]: { type, alias?, default?, required? } }`.
 *     `type` is one of `'string' | 'boolean' | 'ticket' | 'integer' |
 *     'string-multi'`. `alias` defaults to the camelCased flag name.
 *     Extras flow through the same `defineFlags` machinery as the
 *     standard set and are emitted on `values` under their `alias`.
 *
 *   `values` is always returned with every known flag present:
 *
 *     { epicId, storyId, changedSince, json, fullScope, dryRun,
 *       ...extras }
 *
 *   Ticket-shaped flags (`--epic`, `--story`) parse via
 *   `parseTicketId` (positive integer; leading `#` stripped; `null` on
 *   anything invalid). The string-shaped `--changed-since` keeps the raw
 *   string (or `null` when absent). Boolean flags coerce to `false` when
 *   absent and `true` when present (with or without a value).
 *
 * Failure modes
 * -------------
 *   - **Unknown flag**: an argv token shaped like `--foo` whose name is
 *     not in the supported set (standard + extras) throws an `Error`
 *     with a stable `code: 'UNKNOWN_FLAG'` plus the offending flag name.
 *   - **Missing required flag**: when `schema[flag].required === true`
 *     (or `extras[flag].required === true`) and the resolved value is
 *     absent (ticket flags → `null`; string flags → `null`/empty;
 *     boolean flags → `false`), the parser throws with
 *     `code: 'MISSING_REQUIRED_FLAG'` and the flag name.
 *   - **Unsupported extras type**: a typo in `extras[flag].type` throws
 *     with `code: 'UNKNOWN_EXTRAS_TYPE'`.
 *
 * Why a thin shim and not a re-export of `defineFlags`
 * ----------------------------------------------------
 *   `defineFlags` is a powerful declarative parser, but every dispatcher
 *   CLI hand-rolls its own option spec — duplicated `--epic` / `--story`
 *   blocks across four scripts, each subtly different. `parseStandardCliArgs`
 *   collapses that duplication into one canonical spec with a small
 *   `extras` surface for the per-script flags.
 *
 * @module lib/cli/standard-args
 */

import { defineFlags, parseTicketId } from '../cli-args.js';

/**
 * Canonical spec passed to `defineFlags`. Every key in `SUPPORTED_FLAGS`
 * is what the parser will accept; anything else triggers `UNKNOWN_FLAG`
 * unless it is declared via `extras`.
 *
 * Each entry below maps the kebab-cased CLI flag to:
 *   - `key`:  the camelCased output key on `values`
 *   - `type`: 'ticket' | 'string' | 'boolean'
 */
const SUPPORTED_FLAGS = Object.freeze({
  epic: { key: 'epicId', type: 'ticket' },
  story: { key: 'storyId', type: 'ticket' },
  'changed-since': { key: 'changedSince', type: 'string' },
  json: { key: 'json', type: 'boolean' },
  'full-scope': { key: 'fullScope', type: 'boolean' },
  'dry-run': { key: 'dryRun', type: 'boolean' },
});

const FLAG_NAMES = Object.keys(SUPPORTED_FLAGS);

const SUPPORTED_EXTRAS_TYPES = new Set([
  'string',
  'boolean',
  'ticket',
  'integer',
  'string-multi',
]);

function camelCase(name) {
  return name.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
}

/**
 * Normalize the call signature. Accepts either positional
 * `(argv, schema)` (backward compat) or the object form
 * `({ argv, schema, extras })`.
 *
 * @param {unknown} argvOrOpts
 * @param {unknown} maybeSchema
 * @returns {{ argv: string[], schema: object | undefined, extras: object | undefined }}
 */
function normaliseCallSignature(argvOrOpts, maybeSchema) {
  if (
    argvOrOpts !== null &&
    typeof argvOrOpts === 'object' &&
    !Array.isArray(argvOrOpts)
  ) {
    const { argv, schema, extras } = argvOrOpts;
    return { argv: argv ?? [], schema, extras };
  }
  return { argv: argvOrOpts ?? [], schema: maybeSchema, extras: undefined };
}

/**
 * Build the `defineFlags` spec from the canonical flag table plus any
 * caller-supplied extras. Extras are merged after the standard set; a
 * collision (e.g. extras declaring `--story`) is rejected up-front in
 * `validateExtras`.
 */
function buildDefineFlagsSpec(extras) {
  const spec = {};
  for (const [flag, { key, type }] of Object.entries(SUPPORTED_FLAGS)) {
    spec[flag] = { type, alias: key };
  }
  if (!extras) return spec;
  for (const [flag, def] of Object.entries(extras)) {
    const entry = { type: def.type, alias: def.alias ?? camelCase(flag) };
    if ('default' in def) entry.default = def.default;
    spec[flag] = entry;
  }
  return spec;
}

/**
 * Collect every flag name the parser recognises (standard + extras).
 * Used by the unknown-flag walker.
 */
function knownFlagNames(extras) {
  if (!extras) return FLAG_NAMES;
  return FLAG_NAMES.concat(Object.keys(extras));
}

/**
 * Scan the raw argv for `--foo` tokens whose name is not in the known
 * set. Returns the first offender or `null`.
 */
function findUnknownFlag(argv, known) {
  for (const tok of argv) {
    if (typeof tok !== 'string') continue;
    if (tok === '--') break;
    if (!tok.startsWith('--')) continue;
    const eq = tok.indexOf('=');
    const name = eq >= 0 ? tok.slice(2, eq) : tok.slice(2);
    if (name.length === 0) continue;
    if (!known.includes(name)) return name;
  }
  return null;
}

/**
 * Validate the caller-supplied `schema`. Reject any key that is not a
 * supported standard flag.
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
 * Validate the caller-supplied `extras`. Each entry must declare a
 * supported type; declaring a flag name that collides with a standard
 * flag is rejected (use the `schema` for required-marking instead).
 */
function validateExtras(extras) {
  if (extras === undefined || extras === null) return;
  if (typeof extras !== 'object') {
    throw new Error('parseStandardCliArgs: extras must be an object');
  }
  for (const [flag, def] of Object.entries(extras)) {
    if (Object.hasOwn(SUPPORTED_FLAGS, flag)) {
      const err = new Error(
        `parseStandardCliArgs: extras "${flag}" collides with a standard flag; ` +
          `use the schema entry to mark it required instead.`,
      );
      err.code = 'EXTRAS_FLAG_COLLISION';
      throw err;
    }
    if (!def || typeof def !== 'object') {
      throw new Error(
        `parseStandardCliArgs: extras["${flag}"] must be an object`,
      );
    }
    if (!SUPPORTED_EXTRAS_TYPES.has(def.type)) {
      const err = new Error(
        `parseStandardCliArgs: extras["${flag}"].type "${def.type}" is unsupported. ` +
          `Supported: ${[...SUPPORTED_EXTRAS_TYPES].join(', ')}.`,
      );
      err.code = 'UNKNOWN_EXTRAS_TYPE';
      throw err;
    }
  }
}

/**
 * "Absent" test parameterised by flag type. Mirrored across the
 * standard and extras enforcement passes.
 */
function isAbsent(type, cur) {
  if (type === 'ticket') return cur === null || cur === undefined;
  if (type === 'string') return cur === null || cur === undefined || cur === '';
  if (type === 'boolean') return !cur;
  if (type === 'integer') return cur === undefined || Number.isNaN(cur);
  if (type === 'string-multi') return !Array.isArray(cur) || cur.length === 0;
  return cur === undefined || cur === null;
}

function throwMissing(flag) {
  const err = new Error(
    `parseStandardCliArgs: missing required flag --${flag}`,
  );
  err.code = 'MISSING_REQUIRED_FLAG';
  err.flag = flag;
  throw err;
}

/**
 * Apply the per-flag `required` constraints from `schema` against the
 * resolved `values`.
 */
function enforceRequired(values, schema) {
  if (!schema) return;
  for (const [flag, rule] of Object.entries(schema)) {
    if (!rule || rule.required !== true) continue;
    const meta = SUPPORTED_FLAGS[flag];
    if (isAbsent(meta.type, values[meta.key])) throwMissing(flag);
  }
}

/**
 * Apply the per-flag `required` constraints declared on `extras`.
 */
function enforceExtrasRequired(values, extras) {
  if (!extras) return;
  for (const [flag, def] of Object.entries(extras)) {
    if (!def || def.required !== true) continue;
    const key = def.alias ?? camelCase(flag);
    if (isAbsent(def.type, values[key])) throwMissing(flag);
  }
}

/**
 * Coerce the raw `defineFlags` output into the canonical shape the
 * dispatcher CLIs consume. `defineFlags` already applies the alias
 * (`epic` → `epicId`, …) and runs `parseTicketId` for the ticket-typed
 * entries; we normalise absent strings / booleans into a stable
 * JSON-friendly shape for the standard set and pass extras through
 * with light coercion (string → null on empty, boolean → strict false).
 */
function normaliseValues(raw, extras) {
  const out = {};
  for (const [, { key, type }] of Object.entries(SUPPORTED_FLAGS)) {
    let v = raw[key];
    if (type === 'ticket') {
      v = parseTicketId(v);
    } else if (type === 'string') {
      v = typeof v === 'string' && v.length > 0 ? v : null;
    } else if (type === 'boolean') {
      v = v === true;
    }
    out[key] = v;
  }
  if (!extras) return out;
  for (const [flag, def] of Object.entries(extras)) {
    const key = def.alias ?? camelCase(flag);
    let v = raw[key];
    if (def.type === 'boolean') {
      v = v === true;
    } else if (def.type === 'string') {
      if (v === undefined) v = 'default' in def ? def.default : null;
    } else if (def.type === 'ticket') {
      v = parseTicketId(v);
    } else if (def.type === 'string-multi') {
      if (!Array.isArray(v)) v = 'default' in def ? def.default : [];
    } else if (def.type === 'integer') {
      if (v === undefined && 'default' in def) v = def.default;
    }
    out[key] = v;
  }
  return out;
}

/**
 * Parse the dispatcher's shared CLI flag surface. See module docstring
 * for the full contract.
 *
 * @param {string[]|{argv?: string[], schema?: object, extras?: object}} argvOrOpts
 * @param {Record<string, { required?: boolean }>} [maybeSchema]
 * @returns {{ values: Record<string, unknown>, positionals: string[] }}
 */
export function parseStandardCliArgs(argvOrOpts = [], maybeSchema) {
  const { argv, schema, extras } = normaliseCallSignature(
    argvOrOpts,
    maybeSchema,
  );
  if (!Array.isArray(argv)) {
    throw new Error('parseStandardCliArgs: argv must be an array');
  }
  validateExtras(extras);
  validateSchema(schema);
  const known = knownFlagNames(extras);
  const unknown = findUnknownFlag(argv, known);
  if (unknown !== null) {
    const err = new Error(
      `parseStandardCliArgs: unknown flag --${unknown}. ` +
        `Supported: ${known.map((n) => `--${n}`).join(', ')}.`,
    );
    err.code = 'UNKNOWN_FLAG';
    err.flag = unknown;
    throw err;
  }
  const { values: raw, positionals } = defineFlags(
    buildDefineFlagsSpec(extras),
    argv,
  );
  const values = normaliseValues(raw, extras);
  enforceRequired(values, schema);
  enforceExtrasRequired(values, extras);
  return { values, positionals };
}

export { FLAG_NAMES, SUPPORTED_FLAGS };
