// The single read entry point for every baseline: resolve path, parse,
// schema-validate, canonicalise row paths, and return a narrow envelope.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  BASELINE_KIND_SCHEMA_FILES,
  buildBaselineSchemaAjv,
} from '../baseline-schema-registry.js';
import { getBaselines } from '../config/baselines.js';
import { resolveConfig } from '../config-resolver.js';

// Overridden by `delivery.quality.gates.<kind>.baselinePath`.
const DEFAULT_PATHS = Object.freeze({
  coverage: 'baselines/coverage.json',
  crap: 'baselines/crap.json',
  maintainability: 'baselines/maintainability.json',
  mutation: 'baselines/mutation.json',
  'bundle-size': 'baselines/bundle-size.json',
  duplication: 'baselines/duplication.json',
});

const KIND_TO_SCHEMA_FILE = Object.freeze({
  coverage: 'coverage.schema.json',
  crap: 'crap.schema.json',
  maintainability: 'maintainability.schema.json',
  mutation: 'mutation.schema.json',
  'bundle-size': 'bundle-size.schema.json',
  duplication: 'duplication.schema.json',
});

// Lazy: building AJV reads schema files off disk.
let _ajv = null;
function ajv() {
  if (_ajv === null) {
    _ajv = buildBaselineSchemaAjv();
  }
  return _ajv;
}

/**
 * @param {string} kind
 * @param {{ configPath?: string, cwd?: string }} [opts]
 * @returns {string} absolute path
 */
function resolveBaselinePath(kind, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  let configured = null;
  try {
    const resolved = resolveConfig({
      cwd,
      configPath: opts.configPath,
    });
    const gateBlock = resolved?.delivery?.quality?.gates?.[kind] ?? null;
    if (gateBlock?.baselinePath) {
      configured = gateBlock.baselinePath;
    } else {
      const flat = getBaselines(resolved ?? {});
      if (kind === 'crap' || kind === 'maintainability') {
        configured = flat[kind]?.path ?? null;
      }
    }
  } catch {
    configured = null;
  }
  const rel = configured ?? DEFAULT_PATHS[kind];
  return path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);
}

/**
 * Strip a `.worktrees/<name>/` prefix that hand-edits inside a worktree can
 * smuggle into a committed baseline.
 *
 * @param {string} value
 * @returns {string}
 */
export function canonicaliseRowPath(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  const forward = value.replace(/\\/g, '/');
  return forward.replace(/^\.worktrees\/[^/]+\//, '');
}

/**
 * @param {string} kind
 * @param {Record<string, unknown>} row
 * @returns {Record<string, unknown>}
 */
function canonicaliseRow(kind, row) {
  if (!row || typeof row !== 'object') return row;
  const field = kind === 'bundle-size' ? 'bundle' : 'path';
  const value = row[field];
  if (typeof value !== 'string') return row;
  const canonical = canonicaliseRowPath(value);
  if (canonical === value) return row;
  return { ...row, [field]: canonical };
}

/**
 * @param {string} kind
 * @param {unknown} parsed
 * @param {string} sourceHint  Path or descriptor included in error text.
 */
function validate(kind, parsed, sourceHint) {
  const schemaFile = KIND_TO_SCHEMA_FILE[kind];
  if (!schemaFile) {
    throw new Error(
      `[baselines/reader] unknown kind "${kind}"; expected one of ${Object.keys(
        KIND_TO_SCHEMA_FILE,
      ).join(', ')}`,
    );
  }
  const validator = ajv().getSchema(schemaFile);
  if (!validator) {
    throw new Error(
      `[baselines/reader] schema "${schemaFile}" not registered with the shared AJV instance`,
    );
  }
  const ok = validator(parsed);
  if (!ok) {
    const detail = (validator.errors ?? [])
      .map((e) => `${e.instancePath || '/'} ${e.message}`)
      .join('; ');
    throw new Error(
      `[baselines/reader] schema validation failed for "${sourceHint}" (kind=${kind}): ${detail}`,
    );
  }
}

/**
 * The one narrowing projection for every loaded envelope. It is an
 * allow-list: compat axes read stamps off the loaded object and fail closed
 * on `undefined`, so every envelope stamp must be carried through here. The
 * committed file carries no rollup; a consumer that needs one derives it from
 * `rows` through the kind module.
 *
 * @param {string} kind
 * @param {object} parsed A validated baseline envelope.
 * @returns {{ rows: Array<object>, kernelVersion: string }}
 */
function shapeEnvelope(kind, parsed) {
  const rows = Array.isArray(parsed.rows)
    ? parsed.rows.map((row) => canonicaliseRow(kind, row))
    : [];
  return {
    rows,
    kernelVersion: parsed.kernelVersion,
    scoringSemantics: parsed.scoringSemantics,
    tsTranspilerVersion: parsed.tsTranspilerVersion,
    provenanceStamped: parsed.provenanceStamped,
  };
}

/**
 * @param {string} kind
 * @param {string} absolutePath
 * @returns {{ rows: Array<object>, kernelVersion: string }}
 */
function readAndShape(kind, absolutePath) {
  let raw;
  try {
    raw = readFileSync(absolutePath, 'utf8');
  } catch (err) {
    throw new Error(
      `[baselines/reader] failed to read baseline at ${absolutePath}: ${err?.message ?? err}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[baselines/reader] failed to parse JSON at ${absolutePath}: ${err?.message ?? err}`,
    );
  }
  validate(kind, parsed, absolutePath);
  return shapeEnvelope(kind, parsed);
}

/**
 * Kind from a `$schema` ending in `<kind>.schema.json`, or null.
 *
 * @param {unknown} schemaValue
 * @returns {string | null}
 */
function inferKindFromSchema(schemaValue) {
  if (typeof schemaValue !== 'string') return null;
  const tail = schemaValue.split('/').pop() ?? '';
  for (const [kind, file] of Object.entries(KIND_TO_SCHEMA_FILE)) {
    if (file === tail) return kind;
  }
  return null;
}

/**
 * @param {string} kind
 * @param {{ configPath?: string, cwd?: string }} [opts]
 * @returns {{ rows: Array<object>, kernelVersion: string }}
 */
export function load(kind, opts = {}) {
  if (!Object.hasOwn(KIND_TO_SCHEMA_FILE, kind)) {
    throw new Error(
      `[baselines/reader] unknown kind "${kind}"; expected one of ${Object.keys(
        KIND_TO_SCHEMA_FILE,
      ).join(', ')}`,
    );
  }
  const abs = resolveBaselinePath(kind, opts);
  return readAndShape(kind, abs);
}

/**
 * Kind is inferred from `$schema` unless `opts.kind` is given.
 *
 * @param {string} absolutePath
 * @param {{ kind?: string }} [opts]
 * @returns {{ rows: Array<object>, kernelVersion: string }}
 */
export function loadFile(absolutePath, opts = {}) {
  if (typeof absolutePath !== 'string' || absolutePath.length === 0) {
    throw new Error(
      '[baselines/reader] loadFile: absolutePath must be a non-empty string',
    );
  }
  let raw;
  try {
    raw = readFileSync(absolutePath, 'utf8');
  } catch (err) {
    throw new Error(
      `[baselines/reader] failed to read baseline at ${absolutePath}: ${err?.message ?? err}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[baselines/reader] failed to parse JSON at ${absolutePath}: ${err?.message ?? err}`,
    );
  }
  const kind = opts.kind ?? inferKindFromSchema(parsed?.$schema);
  if (!kind || !Object.hasOwn(KIND_TO_SCHEMA_FILE, kind)) {
    throw new Error(
      `[baselines/reader] loadFile: cannot infer kind for ${absolutePath}; pass opts.kind`,
    );
  }
  validate(kind, parsed, absolutePath);
  return shapeEnvelope(kind, parsed);
}

export const _internals = Object.freeze({
  DEFAULT_PATHS,
  KIND_TO_SCHEMA_FILE,
  resolveBaselinePath,
  inferKindFromSchema,
});

export { BASELINE_KIND_SCHEMA_FILES };
