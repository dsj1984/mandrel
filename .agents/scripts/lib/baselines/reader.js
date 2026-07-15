// .agents/scripts/lib/baselines/reader.js
//
// Story #1892 / Task #1903 — single read entry point for every baseline.
//
// Every gate that compares against a committed baseline file (`lint`,
// `coverage`, `crap`, `maintainability`, `mutation`, `lighthouse`,
// `bundle-size`) MUST go through this module rather than open-coding
// `JSON.parse(readFileSync(...))`. The reader:
//
//   1. Resolves the on-disk path for the given kind from the resolved
//      agentrc (or falls back to the canonical default under `baselines/`).
//   2. Parses the file as JSON.
//   3. Validates it against the per-kind baseline schema via the shared
//      AJV instance (built by `buildBaselineSchemaAjv` from the
//      `.agents/schemas/baselines/` registry).
//   4. Defensively canonicalises path-like row fields — strips
//      `.worktrees/<name>/` prefixes that creep in when a baseline is
//      hand-edited while inside a story worktree — so downstream
//      consumers see canonical repo-relative paths.
//   5. Returns the envelope's headline fields plus rows/rollup as a
//      narrow contract: `{ rollup, rows, kernelVersion, generatedAt }`.
//
// Reader-only: the writer side lives in a sibling module (Story #1891).
// No I/O happens here beyond reading the JSON file itself.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  BASELINE_KIND_SCHEMA_FILES,
  buildBaselineSchemaAjv,
} from '../baseline-schema-registry.js';
import { getBaselines } from '../config/baselines.js';
import { resolveConfig } from '../config-resolver.js';

// ---------------------------------------------------------------------------
// Kind → default path. The four kinds not surfaced by `getBaselines` (which
// only exposes lint/crap/maintainability for historical reasons) fall
// through this table. Repos that relocate a baseline should set
// `delivery.quality.gates.<kind>.baselinePath` in `.agentrc.json`.
// ---------------------------------------------------------------------------
const DEFAULT_PATHS = Object.freeze({
  lint: 'baselines/lint.json',
  coverage: 'baselines/coverage.json',
  crap: 'baselines/crap.json',
  maintainability: 'baselines/maintainability.json',
  mutation: 'baselines/mutation.json',
  lighthouse: 'baselines/lighthouse.json',
  'bundle-size': 'baselines/bundle-size.json',
  duplication: 'baselines/duplication.json',
});

const KIND_TO_SCHEMA_FILE = Object.freeze({
  lint: 'lint.schema.json',
  coverage: 'coverage.schema.json',
  crap: 'crap.schema.json',
  maintainability: 'maintainability.schema.json',
  mutation: 'mutation.schema.json',
  lighthouse: 'lighthouse.schema.json',
  'bundle-size': 'bundle-size.schema.json',
  duplication: 'duplication.schema.json',
});

// Lazy singleton — building the AJV instance reads eight schema files off
// disk; doing it once per process keeps `load()` cheap to call in a loop.
let _ajv = null;
function ajv() {
  if (_ajv === null) {
    _ajv = buildBaselineSchemaAjv();
  }
  return _ajv;
}

/**
 * Resolve the on-disk path for a baseline kind.
 *
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
      if (kind === 'lint' || kind === 'crap' || kind === 'maintainability') {
        configured = flat[kind]?.path ?? null;
      }
    }
  } catch {
    // Config resolution failures fall back to the canonical default.
    configured = null;
  }
  const rel = configured ?? DEFAULT_PATHS[kind];
  return path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);
}

/**
 * Defensively strip a `.worktrees/<name>/` prefix from a row's path-like
 * field. A baseline file committed on `main` should never carry such a
 * prefix, but hand-edits made from inside a story worktree occasionally
 * smuggle one in; the reader canonicalises so downstream consumers don't
 * have to special-case it.
 *
 * Pure; exported for tests.
 *
 * @param {string} value
 * @returns {string}
 */
export function canonicaliseRowPath(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  // Normalise Windows backslashes first so the regex matches both forms.
  const forward = value.replace(/\\/g, '/');
  return forward.replace(/^\.worktrees\/[^/]+\//, '');
}

/**
 * Apply `canonicaliseRowPath` to whichever field the kind keys on. Mutates
 * a shallow clone — the input row is never modified. Pure.
 *
 * @param {string} kind
 * @param {Record<string, unknown>} row
 * @returns {Record<string, unknown>}
 */
function canonicaliseRow(kind, row) {
  if (!row || typeof row !== 'object') return row;
  const field =
    kind === 'lighthouse'
      ? 'route'
      : kind === 'bundle-size'
        ? 'bundle'
        : 'path';
  const value = row[field];
  if (typeof value !== 'string') return row;
  const canonical = canonicaliseRowPath(value);
  if (canonical === value) return row;
  return { ...row, [field]: canonical };
}

/**
 * Validate a parsed baseline against its per-kind schema. Throws when
 * validation fails; the thrown Error carries the AJV error message in its
 * `.message` so callers can surface a meaningful diagnostic without
 * digging into AJV's `.errors` array.
 *
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
 * Internal: parse + validate + canonicalise. Used by both `load` and
 * `loadFile`.
 *
 * @param {string} kind
 * @param {string} absolutePath
 * @returns {{ rollup: object, rows: Array<object>, kernelVersion: string, generatedAt: string }}
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
  const rows = Array.isArray(parsed.rows)
    ? parsed.rows.map((row) => canonicaliseRow(kind, row))
    : [];
  return {
    rollup: parsed.rollup ?? { '*': {} },
    rows,
    kernelVersion: parsed.kernelVersion,
    generatedAt: parsed.generatedAt,
  };
}

/**
 * Inferred kind from the schema file name `<kind>.schema.json`. The
 * envelope's `$schema` field stores the per-kind file (per the writer
 * contract). Returns null when the value cannot be resolved to a known
 * kind; `loadFile` falls back to the caller-provided hint.
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
 * Load the canonical baseline for `kind` from its configured (or default)
 * on-disk path.
 *
 * @param {string} kind  One of lint | coverage | crap | maintainability |
 *   mutation | lighthouse | bundle-size.
 * @param {{ configPath?: string, cwd?: string }} [opts]
 * @returns {{ rollup: object, rows: Array<object>, kernelVersion: string, generatedAt: string }}
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
 * Load a baseline from an explicit absolute path. The kind is inferred
 * from the file's `$schema` field; an explicit `opts.kind` overrides the
 * inference (useful for fixtures that ship without a `$schema` pointer).
 *
 * @param {string} absolutePath
 * @param {{ kind?: string }} [opts]
 * @returns {{ rollup: object, rows: Array<object>, kernelVersion: string, generatedAt: string }}
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
  const rows = Array.isArray(parsed.rows)
    ? parsed.rows.map((row) => canonicaliseRow(kind, row))
    : [];
  return {
    rollup: parsed.rollup ?? { '*': {} },
    rows,
    kernelVersion: parsed.kernelVersion,
    generatedAt: parsed.generatedAt,
  };
}

export const _internals = Object.freeze({
  DEFAULT_PATHS,
  KIND_TO_SCHEMA_FILE,
  resolveBaselinePath,
  inferKindFromSchema,
});

export { BASELINE_KIND_SCHEMA_FILES };
