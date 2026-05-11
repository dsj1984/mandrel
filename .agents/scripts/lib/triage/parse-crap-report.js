/**
 * Pure parser for `crap-report.json` artifacts uploaded by ci.yml.
 *
 * The CRAP gate (`.agents/scripts/check-crap.js`) emits a structured
 * envelope conforming to `.agents/schemas/crap-report.schema.json`. The
 * triage workflow surfaces only the top regressions on the PR comment —
 * the full envelope is already attached to the failing CI run as a
 * downloadable artifact.
 *
 * "Top" means: sort by CRAP score descending (highest = worst), break ties
 * by `(file, method, startLine)` ascending so reruns produce byte-identical
 * comment bodies. The `top` parameter defaults to 5; callers pass `top: 0`
 * to skip the section entirely (useful when the CRAP gate did not run).
 */

/**
 * @typedef {object} CrapViolation
 * @property {string} file
 * @property {string} method
 * @property {number} startLine
 * @property {number} cyclomatic
 * @property {number} coverage
 * @property {number} crap
 * @property {number|null} baseline
 * @property {number} ceiling
 * @property {'regression'|'drifted-regression'|'new'} kind
 */

/**
 * @typedef {object} CrapEnvelope
 * @property {string} kernelVersion
 * @property {string} escomplexVersion
 * @property {{ total:number, regressions:number, newViolations:number,
 *              drifted:number, removed:number, skippedNoCoverage:number }} summary
 * @property {CrapViolation[]} violations
 */

const VALID_KINDS = new Set(['regression', 'drifted-regression', 'new']);

/**
 * Validate envelope shape *just enough* to render a comment safely. Full
 * schema-conformance is enforced by the producer's Ajv check at write
 * time; the triage parser is defensive only against truncated artifacts
 * and the artifact-corrupted-on-upload class of failure.
 *
 * @param {unknown} raw
 * @returns {raw is CrapEnvelope}
 */
export function isCrapEnvelope(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const e = /** @type {Record<string, unknown>} */ (raw);
  if (typeof e.kernelVersion !== 'string') return false;
  if (!e.summary || typeof e.summary !== 'object') return false;
  if (!Array.isArray(e.violations)) return false;
  for (const v of e.violations) {
    if (!v || typeof v !== 'object') return false;
    const vo = /** @type {Record<string, unknown>} */ (v);
    if (typeof vo.file !== 'string') return false;
    if (typeof vo.method !== 'string') return false;
    if (typeof vo.startLine !== 'number') return false;
    if (typeof vo.crap !== 'number') return false;
    if (typeof vo.kind !== 'string' || !VALID_KINDS.has(vo.kind)) return false;
  }
  return true;
}

/**
 * Parse a raw artifact buffer into a validated envelope. Throws on
 * structural failure with a message that names the artifact path so the
 * workflow log carries enough context to diagnose without re-downloading.
 *
 * @param {string} raw JSON text.
 * @param {{ source?: string }} [opts] Optional source label used in errors.
 * @returns {CrapEnvelope}
 */
export function parseCrapEnvelope(raw, opts = {}) {
  if (typeof raw !== 'string') {
    throw new TypeError('parseCrapEnvelope: raw must be a string');
  }
  const source = opts.source ?? 'crap-report.json';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `parseCrapEnvelope: ${source} is not valid JSON: ${err.message}`,
    );
  }
  if (!isCrapEnvelope(parsed)) {
    throw new Error(
      `parseCrapEnvelope: ${source} does not match the CrapReport envelope shape`,
    );
  }
  return parsed;
}

/**
 * Compare two violations for deterministic ordering. Higher CRAP score is
 * "worse" so it sorts to the top; ties are broken by (file, method,
 * startLine) ascending so re-runs against the same envelope produce the
 * same top-N selection byte-for-byte.
 *
 * Exported for testing — the tie-break determinism is part of the
 * idempotency contract enforced by t2-tests.
 *
 * @param {CrapViolation} a
 * @param {CrapViolation} b
 */
export function compareViolationsDesc(a, b) {
  if (b.crap !== a.crap) return b.crap - a.crap;
  const fileCmp = a.file.localeCompare(b.file);
  if (fileCmp !== 0) return fileCmp;
  const methodCmp = a.method.localeCompare(b.method);
  if (methodCmp !== 0) return methodCmp;
  return a.startLine - b.startLine;
}

/**
 * Select the top-N worst regressions from a CRAP envelope.
 *
 * `top` defaults to 5. Returns an empty array when `top <= 0` or the
 * envelope has no violations.
 *
 * @param {CrapEnvelope} envelope
 * @param {{ top?: number }} [opts]
 * @returns {CrapViolation[]}
 */
export function topRegressions(envelope, opts = {}) {
  if (!isCrapEnvelope(envelope)) {
    throw new TypeError('topRegressions: envelope must be a CrapEnvelope');
  }
  const top = Number.isInteger(opts.top) ? opts.top : 5;
  if (top <= 0) return [];
  return [...envelope.violations].sort(compareViolationsDesc).slice(0, top);
}

/**
 * Convenience: parse + select in one call. Matches the shape consumed by
 * the comment renderer in `triage-ci-failure.js`.
 *
 * @param {string} raw
 * @param {{ source?: string, top?: number }} [opts]
 * @returns {{ envelope: CrapEnvelope, top: CrapViolation[] }}
 */
export function parseCrapReport(raw, opts = {}) {
  const envelope = parseCrapEnvelope(raw, opts);
  return { envelope, top: topRegressions(envelope, opts) };
}
