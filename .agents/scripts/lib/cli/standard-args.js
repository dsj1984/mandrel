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

const isNullish = (v) => v === null || v === undefined;

/** Per-type rules shared by built-in and extra flags. */
const FLAG_TYPES = Object.freeze({
  string: {
    normalise: (v, orDefault) =>
      typeof v === 'string' && v.length > 0 ? v : orDefault(null),
    isAbsent: (v) => isNullish(v) || v === '',
  },
  boolean: { normalise: (v) => v === true, isAbsent: (v) => !v },
  ticket: { normalise: (v) => parseTicketId(v), isAbsent: isNullish },
  integer: {
    normalise: (v, orDefault) => (v === undefined ? orDefault(undefined) : v),
    isAbsent: (v) => v === undefined || Number.isNaN(v),
  },
  'string-multi': {
    normalise: (v, orDefault) => (Array.isArray(v) ? v : orDefault([])),
    isAbsent: (v) => !Array.isArray(v) || v.length === 0,
  },
});

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

function flagEntries(schema, extras) {
  const entries = Object.entries(SUPPORTED_FLAGS).map(
    ([flag, { key, type }]) => ({
      flag,
      key,
      type,
      def: {},
      required: schema?.[flag]?.required === true,
    }),
  );
  for (const [flag, def] of Object.entries(extras ?? {})) {
    entries.push({
      flag,
      key: def.alias ?? camelCase(flag),
      type: def.type,
      def,
      required: def.required === true,
    });
  }
  return entries;
}

function buildDefineFlagsSpec(entries) {
  const spec = {};
  for (const { flag, key, type, def } of entries) {
    spec[flag] = { type, alias: key };
    if ('default' in def) spec[flag].default = def.default;
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
    if (!Object.hasOwn(FLAG_TYPES, def.type)) {
      const err = new Error(
        `parseStandardCliArgs: extras["${flag}"].type "${def.type}" is unsupported. ` +
          `Supported: ${Object.keys(FLAG_TYPES).join(', ')}.`,
      );
      err.code = 'UNKNOWN_EXTRAS_TYPE';
      throw err;
    }
  }
}

function throwMissing(flag) {
  const err = new Error(
    `parseStandardCliArgs: missing required flag --${flag}`,
  );
  err.code = 'MISSING_REQUIRED_FLAG';
  err.flag = flag;
  throw err;
}

function normaliseValues(raw, entries) {
  const out = {};
  for (const { key, type, def } of entries) {
    const orDefault = (empty) => ('default' in def ? def.default : empty);
    out[key] = FLAG_TYPES[type].normalise(raw[key], orDefault);
  }
  return out;
}

function enforceRequired(values, entries) {
  for (const { flag, key, type, required } of entries) {
    if (required && FLAG_TYPES[type].isAbsent(values[key])) throwMissing(flag);
  }
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
  const entries = flagEntries(schema, extras);
  const { values: raw, positionals } = defineFlags(
    buildDefineFlagsSpec(entries),
    argv,
  );
  const values = normaliseValues(raw, entries);
  enforceRequired(values, entries);
  return { values, positionals };
}

export { FLAG_NAMES, SUPPORTED_FLAGS };
