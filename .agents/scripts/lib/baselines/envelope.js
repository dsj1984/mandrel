/**
 * envelope.js — assemble and validate baseline envelopes (Story #1891,
 * Epic #1786).
 *
 * Every committed Mandrel baseline ships an envelope-shaped JSON with five
 * top-level keys:
 *
 *   {
 *     "$schema": ".agents/schemas/baselines/<kind>.schema.json",
 *     "kernelVersion": "<semver>",
 *     "generatedAt": "<ISO-8601>",
 *     "rollup":  { "*": { ... }, [component]: { ... } },
 *     "rows":    [ ... ]
 *   }
 *
 * The envelope contract is declared in
 * `.agents/schemas/baselines/baseline-envelope.schema.json` and the
 * per-kind schemas extend it via `allOf` (Story #1888).
 *
 * This module exposes:
 *
 *   buildEnvelope({ kind, rollup, rows, kernelVersion, generatedAt? })
 *     Stamps `$schema`, `kernelVersion`, and `generatedAt` onto a freshly
 *     constructed envelope. When `generatedAt` is omitted, the
 *     `MANDREL_BASELINE_GENERATED_AT` env var overrides any other clock
 *     reading — this lets reproducible-build tests pin the timestamp
 *     without monkey-patching `Date`. When neither is provided, the
 *     envelope stamps `new Date().toISOString()`.
 *
 *   assertEnvelope(envelope)
 *     Compiles every per-kind schema once (AJV) and validates the envelope
 *     against the schema named in its `$schema`. Throws on schema
 *     mismatch, missing top-level keys, or a `$schema` that doesn't
 *     correspond to one of the seven known per-kind schemas.
 *
 * The writer (`writer.js`) calls `buildEnvelope` then `assertEnvelope`
 * before serialising — so every baseline written through the shared
 * pipeline is schema-valid by construction.
 *
 * @module lib/baselines/envelope
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Repo-relative `.agents/schemas/baselines/` directory. Resolved off the
 * module URL so the envelope works the same in the main checkout, in a
 * worktree, and inside CI's bare clone — none of those have a stable
 * `process.cwd()` relative to the schemas.
 */
const SCHEMAS_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'schemas',
  'baselines',
);

/**
 * Canonical list of kinds the shared envelope supports. The writer's
 * per-kind module list lives in `kinds/index.js`; this constant is the
 * envelope's view of the same set, kept here to break the import cycle
 * (`kinds/<kind>` imports envelope; envelope only needs the names).
 */
export const KNOWN_KINDS = Object.freeze([
  'lint',
  'coverage',
  'crap',
  'maintainability',
  'mutation',
  'lighthouse',
  'bundle-size',
  'duplication',
]);

function schemaRefFor(kind) {
  return `.agents/schemas/baselines/${kind}.schema.json`;
}

function kernelVersionPattern() {
  return /^[0-9]+\.[0-9]+\.[0-9]+$/;
}

function isoTimestampPattern() {
  // RFC 3339 / ISO 8601 with optional fractional seconds and a `Z` or
  // `±HH:MM` offset. AJV's `date-time` format does the heavy validation;
  // this is a cheap pre-check so we can throw a friendlier error before
  // AJV ever runs.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
}

/**
 * Resolve the effective `generatedAt` for an envelope. Priority:
 *
 *   1. Caller-supplied `generatedAt`.
 *   2. `MANDREL_BASELINE_GENERATED_AT` env var (reproducible-build hook).
 *   3. `new Date().toISOString()`.
 *
 * Validates the resulting string against an ISO-8601 shape and throws a
 * clear error if it doesn't match — operators get the failure at write
 * time, not when AJV runs.
 *
 * @param {string|undefined} explicit
 * @returns {string}
 */
function resolveGeneratedAt(explicit) {
  const candidate =
    typeof explicit === 'string' && explicit.length > 0
      ? explicit
      : (process.env.MANDREL_BASELINE_GENERATED_AT ?? new Date().toISOString());
  if (typeof candidate !== 'string' || !isoTimestampPattern().test(candidate)) {
    throw new Error(
      `envelope.buildEnvelope: generatedAt must be an ISO-8601 timestamp (got ${JSON.stringify(candidate)})`,
    );
  }
  return candidate;
}

/**
 * Construct an envelope. The caller supplies the per-kind row + rollup
 * shape; this module stamps the envelope-level keys.
 *
 * @param {{
 *   kind: string,
 *   rollup: Record<string, object>,
 *   rows: Array<object>,
 *   kernelVersion: string,
 *   generatedAt?: string,
 * }} params
 * @returns {{
 *   $schema: string,
 *   kernelVersion: string,
 *   generatedAt: string,
 *   rollup: Record<string, object>,
 *   rows: Array<object>,
 * }}
 */
export function buildEnvelope({
  kind,
  rollup,
  rows,
  kernelVersion,
  generatedAt,
} = {}) {
  if (typeof kind !== 'string' || !KNOWN_KINDS.includes(kind)) {
    throw new TypeError(
      `envelope.buildEnvelope: kind must be one of ${KNOWN_KINDS.join(', ')} (got ${JSON.stringify(kind)})`,
    );
  }
  if (
    typeof kernelVersion !== 'string' ||
    !kernelVersionPattern().test(kernelVersion)
  ) {
    throw new TypeError(
      `envelope.buildEnvelope: kernelVersion must be semver-shaped (got ${JSON.stringify(kernelVersion)})`,
    );
  }
  if (!rollup || typeof rollup !== 'object' || Array.isArray(rollup)) {
    throw new TypeError(
      'envelope.buildEnvelope: rollup must be an object keyed by component',
    );
  }
  if (!Object.hasOwn(rollup, '*')) {
    throw new Error(
      'envelope.buildEnvelope: rollup["*"] (whole-repo rollup) is required',
    );
  }
  if (!Array.isArray(rows)) {
    throw new TypeError('envelope.buildEnvelope: rows must be an array');
  }

  return {
    $schema: schemaRefFor(kind),
    kernelVersion,
    generatedAt: resolveGeneratedAt(generatedAt),
    rollup,
    rows,
  };
}

/**
 * Lazy AJV instance — compiled schemas are memoised so successive writes
 * during a single Node process don't re-compile the seven schemas.
 */
let _ajv = null;
const _validators = new Map();

function getAjv() {
  if (_ajv) return _ajv;
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const envelopeSchema = JSON.parse(
    fs.readFileSync(
      path.join(SCHEMAS_DIR, 'baseline-envelope.schema.json'),
      'utf8',
    ),
  );
  ajv.addSchema(envelopeSchema, 'baseline-envelope.schema.json');
  _ajv = ajv;
  return ajv;
}

function getValidator(kind) {
  if (_validators.has(kind)) return _validators.get(kind);
  const ajv = getAjv();
  const schema = JSON.parse(
    fs.readFileSync(path.join(SCHEMAS_DIR, `${kind}.schema.json`), 'utf8'),
  );
  const validate = ajv.compile(schema);
  _validators.set(kind, validate);
  return validate;
}

/**
 * The five top-level keys every envelope MUST carry. Pre-checked before
 * AJV runs so the error names the missing key directly instead of
 * surfacing as an AJV "required" violation.
 */
const REQUIRED_TOP_LEVEL_KEYS = Object.freeze([
  '$schema',
  'kernelVersion',
  'generatedAt',
  'rollup',
  'rows',
]);

// ---------------------------------------------------------------------------
// Shared baseline compatibility axes (Story #2467, Task #2492).
//
// Every baseline-kind compatibility check shares the same universal
// invariants: the envelope must exist, its kernelVersion must match the
// running scorer, and (when published) its `generatedAt` must be monotonic
// vs the running clock. Per-kind axis tables (e.g. `CRAP_COMPAT_AXES`)
// compose these into their kind-specific axis list so the hoisted axes
// live in exactly one place.
//
// Each axis exposes `{ name, severity, check }`:
//   - `name`     — stable label used as `kind` in the failure envelope.
//   - `severity` — `'fatal'` (short-circuit, exitCode 1) or `'warn'`
//                  (accumulate into `warnings`).
//   - `check`    — pure function over the compat context. Returns `null`
//                  when the axis passes, or a string message describing
//                  the failure.
// ---------------------------------------------------------------------------

/**
 * Universal "missing baseline" axis. Fires when the loader returned `null`
 * / `undefined`. The operator message is parametrised by the kind label
 * supplied at composition time so each kind keeps its own bootstrap hint.
 *
 * @param {string} kindLabel — operator-facing label (e.g. `CRAP`, `MI`).
 * @returns {{name: string, severity: 'fatal', check: (ctx: {baseline: unknown}) => string|null}}
 */
export function missingBaselineAxis(kindLabel) {
  return {
    name: 'missing-baseline',
    severity: 'fatal',
    check: ({ baseline }) =>
      baseline === null || baseline === undefined
        ? `[${kindLabel}] ❌ no baseline found — run the matching baseline-update command and commit with a 'baseline-refresh:' subject to bootstrap`
        : null,
  };
}

/**
 * Universal "kernel-version drift" axis. Fires when the baseline's
 * recorded `kernelVersion` differs from the running scorer's
 * `kernelVersion`. Warn-only by default — kernel drift surfaces as a
 * baseline-refresh nudge, not a close-validation failure.
 *
 * @param {string} kindLabel
 * @returns {{name: string, severity: 'warn', check: (ctx: {baseline: {kernelVersion?: string}|null|undefined, runningKernelVersion: string}) => string|null}}
 */
export function kernelDriftAxis(kindLabel) {
  return {
    name: 'kernel-drift',
    severity: 'warn',
    check: ({ baseline, runningKernelVersion }) =>
      baseline && baseline.kernelVersion !== runningKernelVersion
        ? `[${kindLabel}] ⚠ kernelVersion drift: baseline=${baseline.kernelVersion} running=${runningKernelVersion}. ` +
          "Run the matching baseline-update command and commit with a 'baseline-refresh:' subject to refresh."
        : null,
  };
}

/**
 * Reduce an axis list against a compat context, emitting either a fatal
 * envelope `{ ok: false, exitCode: 1, kind, message }` (on the first
 * 'fatal' match) or an accumulating `{ ok: true, warnings }` envelope.
 *
 * Shared by every per-kind `evaluateBaselineCompatibility` caller so the
 * reduce body lives in one place and stays well below the project's
 * cyclomatic-complexity ceiling.
 *
 * @template {object} Ctx
 * @param {Array<{name: string, severity: 'fatal'|'warn', check: (ctx: Ctx) => string|null}>} axes
 * @param {Ctx} ctx
 * @returns {{ok: true, warnings: string[]} | {ok: false, exitCode: 1, kind: string, message: string}}
 */
export function reduceCompatAxes(axes, ctx) {
  return axes.reduce(
    (acc, axis) => {
      if (!acc.ok) return acc;
      const message = axis.check(ctx);
      if (!message) return acc;
      if (axis.severity === 'fatal') {
        return { ok: false, exitCode: 1, kind: axis.name, message };
      }
      acc.warnings.push(message);
      return acc;
    },
    { ok: true, warnings: [] },
  );
}

/**
 * Validate an envelope against its per-kind schema.
 *
 * Two-phase check:
 *   1. Cheap structural pre-check — every top-level key present, `$schema`
 *      points at one of the seven known kinds. Throws with a clear
 *      message when violated.
 *   2. AJV schema validation against the per-kind schema named in `$schema`.
 *      Throws with the AJV error list serialised as JSON.
 *
 * @param {object} envelope
 * @returns {void}
 * @throws {Error}
 */
export function assertEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new TypeError('envelope.assertEnvelope: expected an object envelope');
  }
  for (const key of REQUIRED_TOP_LEVEL_KEYS) {
    if (!Object.hasOwn(envelope, key)) {
      throw new Error(
        `envelope.assertEnvelope: missing required top-level key "${key}"`,
      );
    }
  }
  const schemaRef = envelope.$schema;
  if (typeof schemaRef !== 'string') {
    throw new Error(
      'envelope.assertEnvelope: $schema must be a string pointing at a per-kind schema',
    );
  }
  const match = schemaRef.match(/baselines\/([^/]+)\.schema\.json$/);
  if (!match || !KNOWN_KINDS.includes(match[1])) {
    throw new Error(
      `envelope.assertEnvelope: $schema "${schemaRef}" does not point at one of the known kinds (${KNOWN_KINDS.join(', ')})`,
    );
  }
  const kind = match[1];
  const validate = getValidator(kind);
  const ok = validate(envelope);
  if (!ok) {
    throw new Error(
      `envelope.assertEnvelope: ${kind} envelope failed schema validation: ${JSON.stringify(validate.errors)}`,
    );
  }
}
