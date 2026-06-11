/**
 * lib/findings/classify-finding.js — Finding classification + label routing.
 *
 * A "finding" here is an exploratory-QA ledger item (see
 * `.agents/schemas/qa-ledger.schema.json`, Epic #3686). Each item carries a
 * `class` drawn from a closed enum. `classifyFinding(finding)` resolves that
 * class and routes it to the GitHub label set Triage applies when promoting
 * the item to a follow-up ticket.
 *
 * Pure function: no network I/O. The class → label routing table is the
 * single source of truth for which labels a given finding class maps to;
 * label *names* are pulled from `lib/label-constants.js` so renames land in
 * one place rather than as string literals here.
 *
 * Rejection (not silent defaulting) is the contract: a finding whose class is
 * absent, empty, or outside the enum throws rather than falling back to a
 * default class. A misclassified finding routed to the wrong labels is worse
 * than a loud failure the operator can fix.
 */

import { META_LABELS } from '../label-constants.js';
import { normalizeSeverity, SEVERITIES } from './severity.js';

/**
 * Focus-axis labels (Story #3721). These scope a finding to the area of the
 * framework it concerns. They are not in `label-constants.js` because the
 * focus axis is consumer-extensible; the routing table below is the only
 * in-tree consumer, so the literals are defined here and referenced by symbol.
 */
export const FOCUS_LABELS = {
  PRODUCT: 'focus::product',
  ENVIRONMENT: 'focus::environment',
  SCRIPTS: 'focus::scripts',
  TESTS: 'focus::tests',
  ENHANCEMENT: 'focus::enhancement',
};

/**
 * The closed set of finding classes, mirroring the `class` enum in
 * `.agents/schemas/qa-ledger.schema.json`. Exported so callers can validate
 * against the same source of truth.
 */
export const FINDING_CLASSES = Object.freeze([
  'product-bug',
  'environment-setup',
  'tooling-dx',
  'test-gap',
  'enhancement',
]);

/**
 * Class → label-set routing table. Each class maps to exactly one label set.
 * `tooling-dx` is the framework-gap path: it carries `meta::framework-gap` so
 * the `/plan` Phase 0 feedback fetcher surfaces it to the planner.
 */
const CLASS_TO_LABELS = Object.freeze({
  'product-bug': [FOCUS_LABELS.PRODUCT],
  'environment-setup': [FOCUS_LABELS.ENVIRONMENT],
  'tooling-dx': [FOCUS_LABELS.SCRIPTS, META_LABELS.FRAMEWORK_GAP],
  'test-gap': [FOCUS_LABELS.TESTS],
  enhancement: [FOCUS_LABELS.ENHANCEMENT, META_LABELS.CONSUMER_IMPROVEMENT],
});

/**
 * The closed set of severity values a finding can carry, re-exported from the
 * canonical {@link ./severity.js} source of truth (Story #3816) so this module
 * does not re-declare its own list. Ordered highest → lowest:
 * `critical | high | medium | low | info`.
 */
export { SEVERITIES };

/**
 * Tokens that, when present in a finding's `area`, `labels`, or explicit
 * `security` flag, mark it as security-relevant. The security signal is
 * orthogonal to the class → label mapping: a `product-bug` and a `tooling-dx`
 * finding can both be security-relevant, so this never alters the class route.
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
 * Resolve a finding's severity to one of {@link SEVERITIES} via the shared
 * canonical normaliser. An absent, empty, or unrecognised severity resolves to
 * the canonical floor (`info`). Case- and whitespace-insensitive. Delegating to
 * {@link normalizeSeverity} keeps this path bit-for-bit identical to the
 * `promote-finding` path, so the same finding fingerprints the same regardless
 * of which path produced its severity (Story #3816).
 *
 * @param {object} finding
 * @returns {string} one of {@link SEVERITIES}
 */
function resolveSeverity(finding) {
  return normalizeSeverity(finding?.severity);
}

/**
 * Detect whether a finding is security-relevant. True when the finding sets an
 * explicit truthy `security` flag, OR when any of its `area` / `labels`
 * carries a known security token. Pure string inspection — no network I/O.
 *
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
 * Resolve the raw `class` field of a finding to a known, non-empty class.
 *
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
 * Classify a finding into exactly one class, route it to its label set, and
 * carry a severity value plus a security signal alongside.
 *
 * The class → label routing is unchanged: every class still maps to exactly
 * the same label set it always did. `severity` and `security` are additive
 * signal fields the caller can act on (e.g. escalate a high-severity security
 * finding) — they never alter the label set, so no existing class-to-label
 * mapping is dropped.
 *
 * @param {object} finding — a ledger item carrying a `class` field, and
 *   optionally `severity` and a `security` flag / security-relevant `area` /
 *   `labels`.
 * @returns {{ class: string, labels: string[], severity: string, security: boolean }}
 *   the resolved class, the ordered GitHub labels Triage should apply, the
 *   resolved severity (one of {@link SEVERITIES}; `info` when absent), and
 *   whether the finding is security-relevant.
 * @throws {TypeError|RangeError} on a non-object finding or an
 *   unknown/empty class (never silently defaults).
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
