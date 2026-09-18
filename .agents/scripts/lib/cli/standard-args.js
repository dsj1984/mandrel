/**
 * Shared CLI flag parser: one canonical spec for the standard dispatcher
 * flags plus declarative per-script `extras`
 * (`{ type, alias?, default?, required? }`, alias defaults to camelCase).
 *
 * `argv` is `process.argv.slice(2)`. `values` always carries every known
 * flag. Throws with a stable `code`: `UNKNOWN_FLAG`, `MISSING_REQUIRED_FLAG`,
 * `UNKNOWN_FLAG_IN_SCHEMA`, `UNKNOWN_EXTRAS_TYPE`, `EXTRAS_FLAG_COLLISION`.
 *
 * @module lib/cli/standard-args
 */

import { defineFlags, parseTicketId } from '../cli-args.js';

/** Kebab-case flag → `{ key` on `values`, `type }`. */
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
 * @param {unknown} opts
 * @returns {{ argv: string[], schema: object | undefined, extras: object | undefined }}
 */
function normaliseCallSignature(opts) {
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
    throw new Error(
      'parseStandardCliArgs: options must be a plain object ({ argv, schema?, extras? })',
    );
  }
  const { argv, schema, extras } = opts;
  return { argv: argv ?? [], schema, extras };
}

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

function knownFlagNames(extras) {
  if (!extras) return FLAG_NAMES;
  return FLAG_NAMES.concat(Object.keys(extras));
}

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

/** Reject unknown keys so a typo cannot silently disable a required check. */
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

function enforceRequired(values, schema) {
  if (!schema) return;
  for (const [flag, rule] of Object.entries(schema)) {
    if (!rule || rule.required !== true) continue;
    const meta = SUPPORTED_FLAGS[flag];
    if (isAbsent(meta.type, values[meta.key])) throwMissing(flag);
  }
}

function enforceExtrasRequired(values, extras) {
  if (!extras) return;
  for (const [flag, def] of Object.entries(extras)) {
    if (!def || def.required !== true) continue;
    const key = def.alias ?? camelCase(flag);
    if (isAbsent(def.type, values[key])) throwMissing(flag);
  }
}

/** Absent strings become `null` and booleans strict `false`. */
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
 * @param {{ argv?: string[], schema?: object, extras?: object }} [opts]
 * @returns {{ values: Record<string, unknown>, positionals: string[] }}
 */
export function parseStandardCliArgs(opts = {}) {
  const { argv, schema, extras } = normaliseCallSignature(opts);
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
