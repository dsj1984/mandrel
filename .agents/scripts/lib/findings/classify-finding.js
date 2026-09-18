/**
 * lib/findings/classify-finding.js — resolve a QA ledger item's `class` and
 * route it to the labels Triage applies on promotion. An absent or unknown
 * class throws rather than defaulting: a mis-routed finding is worse than a
 * loud failure.
 */

import { META_LABELS } from '../label-constants.js';
import { normalizeSeverity, SEVERITIES } from './severity.js';

/** Not in `label-constants.js`: the focus axis is consumer-extensible. */
export const FOCUS_LABELS = {
  PRODUCT: 'focus::product',
  ENVIRONMENT: 'focus::environment',
  SCRIPTS: 'focus::scripts',
  TESTS: 'focus::tests',
  ENHANCEMENT: 'focus::enhancement',
};

/** Mirrors the `class` enum in `.agents/schemas/qa-ledger.schema.json`. */
export const FINDING_CLASSES = Object.freeze([
  'product-bug',
  'environment-setup',
  'tooling-dx',
  'test-gap',
  'enhancement',
]);

/**
 * `tooling-dx` carries `meta::framework-gap` so `/mandrel-plan` Phase 0
 * surfaces it.
 */
const CLASS_TO_LABELS = Object.freeze({
  'product-bug': [FOCUS_LABELS.PRODUCT],
  'environment-setup': [FOCUS_LABELS.ENVIRONMENT],
  'tooling-dx': [FOCUS_LABELS.SCRIPTS, META_LABELS.FRAMEWORK_GAP],
  'test-gap': [FOCUS_LABELS.TESTS],
  enhancement: [FOCUS_LABELS.ENHANCEMENT, META_LABELS.CONSUMER_IMPROVEMENT],
});

export { SEVERITIES };

/**
 * Tokens in `area`/`labels` marking a finding security-relevant. Orthogonal
 * to the class route.
 */
const SECURITY_TOKENS = Object.freeze([
  'security',
  'injection',
  'xss',
  'csrf',
  'auth',
  'authz',
  'authentication',
  'authorization',
  'secret',
  'secrets',
  'vulnerability',
  'vuln',
  'cve',
]);

/**
 * @param {object} finding
 * @returns {string} one of {@link SEVERITIES}
 */
function resolveSeverity(finding) {
  return normalizeSeverity(finding?.severity);
}

/**
 * @param {object} finding
 * @returns {boolean}
 */
function resolveSecuritySignal(finding) {
  if (finding?.security === true) return true;

  const haystack = [];
  if (typeof finding?.area === 'string') haystack.push(finding.area);
  if (Array.isArray(finding?.labels)) {
    for (const label of finding.labels) {
      if (typeof label === 'string') haystack.push(label);
    }
  }

  const normalized = haystack.map((s) => s.toLowerCase());
  return normalized.some((value) =>
    SECURITY_TOKENS.some((token) => value.includes(token)),
  );
}

/**
 * @param {object} finding
 * @returns {string} one of {@link FINDING_CLASSES}
 * @throws {TypeError} when `finding` is not an object
 * @throws {RangeError} when the class is absent, empty, or unknown
 */
function resolveClass(finding) {
  if (finding === null || typeof finding !== 'object') {
    throw new TypeError('classifyFinding: finding must be an object');
  }
  const raw = finding.class;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new RangeError(
      'classifyFinding: finding.class is required and must be a non-empty string',
    );
  }
  const normalized = raw.trim();
  if (!FINDING_CLASSES.includes(normalized)) {
    throw new RangeError(
      `classifyFinding: unknown finding class "${normalized}"; expected one of ${FINDING_CLASSES.join(', ')}`,
    );
  }
  return normalized;
}

/**
 * Classify a finding and route it to its label set. `severity` and `security`
 * are additive signals; they never alter the labels.
 *
 * @param {object} finding — a ledger item carrying a `class` field.
 * @returns {{ class: string, labels: string[], severity: string, security: boolean }}
 * @throws {TypeError|RangeError} on a non-object finding or an
 *   unknown/empty class.
 */
export function classifyFinding(finding) {
  const findingClass = resolveClass(finding);
  return {
    class: findingClass,
    labels: [...CLASS_TO_LABELS[findingClass]],
    severity: resolveSeverity(finding),
    security: resolveSecuritySignal(finding),
  };
}

export const __testing = {
  CLASS_TO_LABELS,
  resolveSeverity,
  resolveSecuritySignal,
};
