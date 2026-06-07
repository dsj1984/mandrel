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
 * the `/epic-plan` Phase 0 feedback fetcher surfaces it to the planner.
 */
const CLASS_TO_LABELS = Object.freeze({
  'product-bug': [FOCUS_LABELS.PRODUCT],
  'environment-setup': [FOCUS_LABELS.ENVIRONMENT],
  'tooling-dx': [FOCUS_LABELS.SCRIPTS, META_LABELS.FRAMEWORK_GAP],
  'test-gap': [FOCUS_LABELS.TESTS],
  enhancement: [FOCUS_LABELS.ENHANCEMENT, META_LABELS.CONSUMER_IMPROVEMENT],
});

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
 * Classify a finding into exactly one class and route it to its label set.
 *
 * @param {object} finding — a ledger item carrying a `class` field.
 * @returns {{ class: string, labels: string[] }} the resolved class and the
 *   ordered, deduplicated GitHub labels Triage should apply.
 * @throws {TypeError|RangeError} on a non-object finding or an
 *   unknown/empty class (never silently defaults).
 */
export function classifyFinding(finding) {
  const findingClass = resolveClass(finding);
  return {
    class: findingClass,
    labels: [...CLASS_TO_LABELS[findingClass]],
  };
}

export const __testing = { CLASS_TO_LABELS };
