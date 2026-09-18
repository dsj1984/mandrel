// .agents/scripts/lib/baselines/reader.js
//
// Story #1892 / Task #1903 — single read entry point for every baseline.
//
// Every gate that compares against a committed baseline file (`coverage`,
// `crap`, `maintainability`, `mutation`, `bundle-size`, `duplication`) MUST go through this module rather than open-coding
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
//      narrow contract: `{ rollup, rows, kernelVersion, generatedAt,
//      scoringSemantics }`.
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
// Kind → default path. The kinds not surfaced by `getBaselines` (which
// only exposes crap/maintainability for historical reasons) fall
// through this table. Repos that relocate a baseline should set
// `delivery.quality.gates.<kind>.baselinePath` in `.agentrc.json`.
// ---------------------------------------------------------------------------
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

// Lazy singleton — building the AJV instance reads the schema files off
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
      if (kind === 'crap' || kind === 'maintainability') {
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
  const field = kind === 'bundle-size' ? 'bundle' : 'path';
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
 * Internal: the ONE narrowing projection every loaded envelope passes through.
 *
 * `load` and `loadFile` reach a validated `parsed` envelope by different routes
 * — one resolves the path from config, the other infers the kind from
 * `$schema` — but the shape they hand back is the same narrow contract, so it
 * is built here rather than written out at each exit.
 *
 * **That single-sourcing is the point, not tidiness.** The projection is an
 * ALLOW-LIST: a field absent from it is silently dropped, and the envelope
 * stamps below are read off the LOADED object by compat axes that fail closed
 * when a stamp reads `undefined`. While the list was duplicated at the two
 * exits, adding a stamp to one and not the other produced a gate that rejected
 * every baseline in the repo for a stamp that was present on disk — which is
 * exactly what happened to `provenanceStamped` between Story #4901 and this
 * fix. One list means a new stamp cannot be half-added.
 *
 * @param {string} kind
 * @param {object} parsed A validated baseline envelope.
 * @returns {{ rollup: object, rows: Array<object>, kernelVersion: string, generatedAt: string }}
 */
function shapeEnvelope(kind, parsed) {
  const rows = Array.isArray(parsed.rows)
    ? parsed.rows.map((row) => canonicaliseRow(kind, row))
    : [];
  return {
    rollup: parsed.rollup ?? { '*': {} },
    rows,
    kernelVersion: parsed.kernelVersion,
    generatedAt: parsed.generatedAt,
    // Story #4775 — carry the per-kind scoring-semantics stamp through the
    // narrowing. The gate's compat check reads it off the LOADED envelope, so
    // dropping it here would make every baseline look unstamped and fail the
    // whole repo closed on a stamp that is actually present on disk.
    scoringSemantics: parsed.scoringSemantics,
    // Story #4866 — same contract for the transpiler stamp. Dropping it here
    // would leave the ts-transpiler compat axis reachable but blind: it would
    // read `undefined` off every loaded envelope and pass vacuously, which is
    // the exact deadness this Story exists to end.
    tsTranspilerVersion: parsed.tsTranspilerVersion,
    // Story #4901 — the coordinate-provenance marker, and the stamp that proved
    // the warnings above were not hypothetical. Its `provenance-unstamped` axis
    // keys on `!== true`, so while this line was missing the axis read
    // `undefined` off every envelope and rejected each one with "baseline
    // predates coordinate-provenance stamping" — un-satisfiable, because
    // re-deriving the baseline writes the marker the reader then drops.
    provenanceStamped: parsed.provenanceStamped,
  };
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
  return shapeEnvelope(kind, parsed);
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
 * @param {string} kind  One of coverage | crap | maintainability |
 *   mutation | bundle-size | duplication.
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
  return shapeEnvelope(kind, parsed);
}

export const _internals = Object.freeze({
  DEFAULT_PATHS,
  KIND_TO_SCHEMA_FILE,
  resolveBaselinePath,
  inferKindFromSchema,
});

export { BASELINE_KIND_SCHEMA_FILES };
