/**
 * lib/spec/loader.js — spec + state file I/O for the epic-spec reconciler.
 *
 * Owns the two files that bracket the structural SSOT migration (Epic
 * #1182 / Tech Spec #1483):
 *
 *   - `temp/epic-<epic-id>/<epic-id>.yaml`        — declarative spec (regenerated)
 *   - `temp/epic-<epic-id>/<epic-id>.state.json`  — slug→issue mapping (observed)
 *
 * Both files live under the per-Epic ephemeral tree `temp/epic-<id>/`
 * (already gitignored) so /plan reruns don't churn a tracked path
 * and so concurrent Epics never collide on a single shared directory.
 * Tests inject `opts.epicsDir` to point at a sandbox; the default for
 * production callers is derived from `lib/config/temp-paths.js#epicTempDir`.
 *
 * The module is intentionally a thin, dependency-light I/O layer:
 *
 *   • `loadSpec(epicId)`  → parses YAML, validates against
 *     `.agents/schemas/epic-spec.schema.json` (Ajv2020). Throws a
 *     `SpecValidationError` carrying the offending JSON Pointer paths
 *     when the spec is structurally invalid. Missing file throws
 *     `SpecNotFoundError`.
 *   • `loadState(epicId)` → returns `{ epicId, mapping: {} }` (with
 *     `lastReconciledAt` omitted) when the state file is missing, so
 *     callers can start reconciling against a fresh Epic without a
 *     pre-existing state file.
 *   • `writeState(epicId, state)` → writes pretty-printed JSON with
 *     deterministically sorted keys (recursive). Repeated writes of an
 *     equivalent state produce a byte-identical file. Trailing newline
 *     included so the file behaves well under git + POSIX `cat`.
 *
 * The loader does **not** make any GitHub calls; it is pure file I/O
 * over the two on-disk artefacts. The reconciler (Wave 1) layers diff
 * + apply on top of this surface.
 *
 * All public functions accept an optional `{ epicsDir, schemaPath, fs }`
 * options bag so tests can point the loader at a sandbox directory
 * without monkey-patching `process.cwd()` or the project schema path.
 *
 * Cross-references:
 *   - Schema:  `.agents/schemas/epic-spec.schema.json` (Story #1490)
 *   - Fixtures: `tests/fixtures/epic-specs/*.json` (Story #1490)
 *   - Tech Spec §"`.agents/epics/<epic-id>.yaml` (spec)" + §"state.json"
 */

import {
  existsSync as defaultExistsSync,
  mkdirSync as defaultMkdirSync,
  readFileSync as defaultReadFileSync,
  writeFileSync as defaultWriteFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import yaml from 'js-yaml';

import { epicTempDir } from '../config/temp-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// scripts/lib/spec/ → scripts/lib/ → scripts/ → .agents/
const PROJECT_AGENTS_DIR = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_SCHEMA_PATH = path.join(
  PROJECT_AGENTS_DIR,
  'schemas',
  'epic-spec.schema.json',
);

// Resolve the default per-Epic spec directory under `temp/epic-<id>/`.
// Caller-injected `opts.epicsDir` still wins for tests and any external
// tooling that wants to point at a sandbox. Production callers omit the
// option and route through this helper.
function defaultEpicsDir(epicId) {
  return epicTempDir(epicId);
}

const defaultFsAdapter = Object.freeze({
  existsSync: defaultExistsSync,
  mkdirSync: defaultMkdirSync,
  readFileSync: defaultReadFileSync,
  writeFileSync: defaultWriteFileSync,
});

let cachedValidator = null;
let cachedValidatorKey = null;

/**
 * Compile (and cache) the Ajv2020 validator for the epic-spec schema.
 * Cached by absolute schema path so tests can swap to a sandbox schema.
 *
 * @param {string} schemaPath
 * @param {{ readFileSync: typeof defaultReadFileSync }} fs
 * @returns {(data: unknown) => boolean}
 */
function getValidator(schemaPath, fs) {
  if (cachedValidator && cachedValidatorKey === schemaPath) {
    return cachedValidator;
  }
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  cachedValidator = ajv.compile(schema);
  cachedValidatorKey = schemaPath;
  return cachedValidator;
}

/**
 * Test-only hook: drop the cached validator so a subsequent call
 * recompiles. Safe to leave exported — production code never invokes it.
 */
export function _resetValidatorCacheForTests() {
  cachedValidator = null;
  cachedValidatorKey = null;
}

/**
 * Structured error raised by `loadSpec` when the YAML parses but fails
 * schema validation. The Ajv error list is normalised to an array of
 * `{ path, message }` so callers (reconciler CLI, tests) can render the
 * offending JSON Pointer without re-parsing the Ajv envelope.
 */
export class SpecValidationError extends Error {
  /**
   * @param {string} epicId
   * @param {Array<{path: string, message: string, params?: object}>} issues
   */
  constructor(epicId, issues) {
    const head = issues[0] ?? { path: '/', message: 'unknown' };
    super(
      `Spec for epic ${epicId} failed schema validation at ${head.path}: ${head.message}`,
    );
    this.name = 'SpecValidationError';
    this.epicId = epicId;
    this.issues = issues;
  }
}

/**
 * Raised by `loadSpec` when the on-disk YAML file does not exist.
 */
export class SpecNotFoundError extends Error {
  /**
   * @param {string} epicId
   * @param {string} filePath
   */
  constructor(epicId, filePath) {
    super(`Spec file missing for epic ${epicId}: ${filePath}`);
    this.name = 'SpecNotFoundError';
    this.epicId = epicId;
    this.filePath = filePath;
  }
}

/**
 * Raised by `loadSpec` when the file exists but is not parseable YAML.
 */
export class SpecParseError extends Error {
  /**
   * @param {string} epicId
   * @param {string} filePath
   * @param {Error} cause
   */
  constructor(epicId, filePath, cause) {
    super(
      `Spec file for epic ${epicId} is not valid YAML (${filePath}): ${cause.message}`,
    );
    this.name = 'SpecParseError';
    this.epicId = epicId;
    this.filePath = filePath;
    this.cause = cause;
  }
}

function resolveOpts(epicId, opts = {}) {
  return {
    epicsDir: opts.epicsDir ?? defaultEpicsDir(epicId),
    schemaPath: opts.schemaPath ?? DEFAULT_SCHEMA_PATH,
    fs: opts.fs ?? defaultFsAdapter,
  };
}

/**
 * Resolve the on-disk spec path for `epicId` under the configured
 * epics dir. Exported for tests and for the reconciler CLI's error
 * messages.
 *
 * @param {number|string} epicId
 * @param {{epicsDir?: string}} [opts]
 * @returns {string}
 */
export function specPath(epicId, opts = {}) {
  const { epicsDir } = resolveOpts(epicId, opts);
  return path.join(epicsDir, `${String(epicId)}.yaml`);
}

/**
 * Resolve the on-disk state path for `epicId` under the configured
 * epics dir.
 *
 * @param {number|string} epicId
 * @param {{epicsDir?: string}} [opts]
 * @returns {string}
 */
export function statePath(epicId, opts = {}) {
  const { epicsDir } = resolveOpts(epicId, opts);
  return path.join(epicsDir, `${String(epicId)}.state.json`);
}

/**
 * Convert Ajv's error array into the loader's `{ path, message }`
 * shape. Ajv2020 uses `instancePath` for the JSON Pointer into the
 * data; for `required` errors it leaves the missing property in
 * `params.missingProperty` rather than the path, so we append it so
 * the caller sees `/epic` instead of `` (root) for the canonical
 * `epic required` failure.
 *
 * @param {Array<{instancePath:string,message:string,keyword:string,params?:Record<string,unknown>}>} ajvErrors
 * @returns {Array<{path:string,message:string,params?:object}>}
 */
function normaliseAjvErrors(ajvErrors) {
  return ajvErrors.map((err) => {
    let p = err.instancePath || '/';
    if (
      err.keyword === 'required' &&
      typeof err.params?.missingProperty === 'string'
    ) {
      const sep = p === '/' ? '' : '/';
      p = `${p}${sep}${err.params.missingProperty}`;
    }
    return {
      path: p,
      message: err.message ?? 'validation failed',
      params: err.params,
    };
  });
}

/**
 * Load and validate the spec YAML for `epicId`. Returns the parsed
 * JavaScript object on success. Throws `SpecNotFoundError`,
 * `SpecParseError`, or `SpecValidationError` otherwise.
 *
 * @param {number|string} epicId
 * @param {{epicsDir?: string, schemaPath?: string, fs?: typeof defaultFsAdapter}} [opts]
 * @returns {object}
 */
export function loadSpec(epicId, opts = {}) {
  const { schemaPath, fs } = resolveOpts(epicId, opts);
  const filePath = specPath(epicId, opts);

  if (!fs.existsSync(filePath)) {
    throw new SpecNotFoundError(String(epicId), filePath);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  let parsed;
  try {
    parsed = yaml.load(raw, { filename: filePath });
  } catch (err) {
    throw new SpecParseError(String(epicId), filePath, err);
  }

  if (parsed == null || typeof parsed !== 'object') {
    throw new SpecValidationError(String(epicId), [
      {
        path: '/',
        message: 'spec root must be an object',
      },
    ]);
  }

  const validate = getValidator(schemaPath, fs);
  const ok = validate(parsed);
  if (!ok) {
    throw new SpecValidationError(
      String(epicId),
      normaliseAjvErrors(validate.errors ?? []),
    );
  }

  return parsed;
}

/**
 * Empty-state default. `loadState` returns this shape when the state
 * file does not exist; callers can rely on `mapping` being a plain
 * object (never undefined).
 *
 * @param {number|string} epicId
 * @returns {{epicId: number, mapping: Record<string, never>}}
 */
function emptyState(epicId) {
  return { epicId: Number(epicId), mapping: {} };
}

/**
 * Load the state file for `epicId`. Returns an empty mapping when the
 * file is missing (the canonical "fresh Epic" case the reconciler
 * faces on first apply). Throws if the file exists but is not valid
 * JSON.
 *
 * @param {number|string} epicId
 * @param {{epicsDir?: string, fs?: typeof defaultFsAdapter}} [opts]
 * @returns {{epicId: number, mapping: object, lastReconciledAt?: string}}
 */
export function loadState(epicId, opts = {}) {
  const { fs } = resolveOpts(epicId, opts);
  const filePath = statePath(epicId, opts);

  if (!fs.existsSync(filePath)) {
    return emptyState(epicId);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

/**
 * Recursively sort object keys (arrays preserve order). Returns a new
 * value with the same shape — leaves are returned unchanged.
 *
 * Exported for `state-writer.js` so the hashing path can share the
 * exact same canonicalisation as the file writer.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Render `state` to deterministic JSON. Public so the test suite can
 * assert the byte-identical-roundtrip property without re-implementing
 * the formatter.
 *
 * @param {object} state
 * @returns {string} pretty-printed JSON, terminated by a single newline.
 */
export function renderStateJson(state) {
  return `${JSON.stringify(sortKeysDeep(state), null, 2)}\n`;
}

/**
 * Write the state file for `epicId`. Creates the parent directory
 * lazily. Object keys are recursively sorted so re-writing the same
 * logical state produces a byte-identical file (AC: "diffs stay
 * stable", "byte-identical when written twice").
 *
 * Returns the absolute path written so callers can log it.
 *
 * @param {number|string} epicId
 * @param {object} state
 * @param {{epicsDir?: string, fs?: typeof defaultFsAdapter}} [opts]
 * @returns {string}
 */
export function writeState(epicId, state, opts = {}) {
  const { epicsDir, fs } = resolveOpts(epicId, opts);
  if (!fs.existsSync(epicsDir)) {
    fs.mkdirSync(epicsDir, { recursive: true });
  }
  const filePath = statePath(epicId, opts);
  fs.writeFileSync(filePath, renderStateJson(state), 'utf8');
  return filePath;
}

/**
 * Write the spec YAML file for `epicId`. Creates the parent directory
 * lazily and emits a top-level `$schema` reference so editors with
 * YAML-schema autocomplete (e.g. the Red Hat YAML extension) resolve
 * the schema from the file itself.
 *
 * Story #1498 / Task #1525 introduced this writer so the rewritten
 * `/plan` halves can persist the spec from the decomposer's
 * ticket-array projection (`renderSpec`) without reaching into raw
 * `js-yaml` calls scattered across the planning scripts.
 *
 * The function validates the spec via the same Ajv2020 compiler the
 * loader caches — a malformed spec is rejected synchronously instead of
 * being persisted and tripping `loadSpec` on the next reconciler run.
 *
 * @param {number|string} epicId
 * @param {object} spec       spec object matching `epic-spec.schema.json`.
 * @param {{epicsDir?: string, schemaPath?: string, fs?: typeof defaultFsAdapter}} [opts]
 * @returns {string}          the absolute path written.
 */
export function writeSpec(epicId, spec, opts = {}) {
  const { epicsDir, schemaPath, fs } = resolveOpts(epicId, opts);
  if (!spec || typeof spec !== 'object') {
    throw new TypeError('[writeSpec] spec must be an object');
  }
  const validate = getValidator(schemaPath, fs);
  const ok = validate(spec);
  if (!ok) {
    throw new SpecValidationError(
      String(epicId),
      normaliseAjvErrors(validate.errors ?? []),
    );
  }
  if (!fs.existsSync(epicsDir)) {
    fs.mkdirSync(epicsDir, { recursive: true });
  }
  const filePath = specPath(epicId, opts);
  // Lazy require: `js-yaml` is already a runtime dep of the loader, but
  // keeping the import top-level would force every consumer of `loader.js`
  // to pay the parse cost even when they only need state helpers.
  const yamlDump = yaml.dump(spec, {
    noRefs: true,
    sortKeys: false,
    lineWidth: 120,
  });
  fs.writeFileSync(filePath, yamlDump, 'utf8');
  return filePath;
}
