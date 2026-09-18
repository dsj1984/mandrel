/**
 * Build and validate baseline envelopes.
 *
 * @module lib/baselines/envelope
 */

import {
  BASELINE_KIND_SCHEMA_FILES,
  buildBaselineSchemaAjv,
} from '../baseline-schema-registry.js';

/**
 * Derived from the schema registry, so every known kind has a compiled schema.
 */
export const KNOWN_KINDS = Object.freeze(
  BASELINE_KIND_SCHEMA_FILES.map((file) => file.replace(/\.schema\.json$/, '')),
);

function schemaRefFor(kind) {
  return `.agents/schemas/baselines/${kind}.schema.json`;
}

function kernelVersionPattern() {
  return /^[0-9]+\.[0-9]+\.[0-9]+$/;
}

function isoTimestampPattern() {
  // Cheap pre-check for a friendlier error; AJV's `date-time` is authoritative.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
}

/**
 * Explicit value, else `MANDREL_BASELINE_GENERATED_AT` (reproducible builds),
 * else now.
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
 * @param {{
 *   kind: string,
 *   rollup: Record<string, object>,
 *   rows: Array<object>,
 *   kernelVersion: string,
 *   generatedAt?: string,
 *   extras?: Record<string, unknown>,
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
  extras,
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

  // `extras` carries per-kind stamps (scoring semantics that change
  // independently of the kernel); unknown extras fail `assertEnvelope`.
  return {
    $schema: schemaRefFor(kind),
    kernelVersion,
    generatedAt: resolveGeneratedAt(generatedAt),
    ...(extras && typeof extras === 'object' ? extras : {}),
    rollup,
    rows,
  };
}

/**
 * Memoised registry-built AJV — one builder, so writer and reader cannot
 * disagree about what a valid envelope is.
 */
let _ajv = null;
function ajv() {
  if (_ajv === null) {
    _ajv = buildBaselineSchemaAjv();
  }
  return _ajv;
}

/**
 * @param {string} kind
 * @returns {import('ajv').ValidateFunction}
 */
function getValidator(kind) {
  return ajv().getSchema(`${kind}.schema.json`);
}

/** Pre-checked so the error names the missing key directly. */
const REQUIRED_TOP_LEVEL_KEYS = Object.freeze([
  '$schema',
  'kernelVersion',
  'generatedAt',
  'rollup',
  'rows',
]);

/**
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
 * Warn-only: kernel drift is a refresh nudge, not a validation failure.
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
 * First fatal axis short-circuits; warn axes accumulate.
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
 * Structural pre-check, then AJV against the schema named in `$schema`.
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
