/**
 * planning-risk.js — deterministic Epic planning risk classifier.
 *
 * Pure ESM, no I/O. Reads Epic title/body/labels and returns a stable
 * planningRisk envelope for gate routing and acceptance disposition.
 */

/** @typedef {'low' | 'medium' | 'high'} RiskLevel */
/** @typedef {'required' | 'recommended' | 'not-applicable'} AcceptanceDisposition */
/** @typedef {'review-required' | 'auto-proceed'} GateDecision */

/**
 * @typedef {Object} PlanningRiskAxis
 * @property {string} axis
 * @property {RiskLevel} level
 * @property {string} evidence
 */

/**
 * @typedef {Object} PlanningRiskEnvelope
 * @property {PlanningRiskAxis[]} axes
 * @property {RiskLevel} overallLevel
 * @property {boolean} requiresReview
 * @property {AcceptanceDisposition} acceptanceDisposition
 * @property {GateDecision} gateDecision
 */

/** Closed axis vocabulary for planning risk classification. */
export const PLANNING_RISK_AXES = Object.freeze([
  'visible-behavior',
  'public-api',
  'security',
  'data-migration',
  'billing',
  'destructive-mutation',
  'critical-workflow',
  'internal-refactor',
  'docs-only',
  'test-harness',
]);

const LEVEL_RANK = Object.freeze({ low: 0, medium: 1, high: 2 });

const REQUIRED_AXES = new Set([
  'visible-behavior',
  'public-api',
  'security',
  'data-migration',
  'billing',
  'destructive-mutation',
  'critical-workflow',
]);

const NOT_APPLICABLE_AXES = new Set([
  'docs-only',
  'test-harness',
  'internal-refactor',
]);

/**
 * @typedef {Object} AxisRule
 * @property {string} axis
 * @property {RiskLevel} level
 * @property {RegExp} pattern
 * @property {(snippet: string) => string} evidenceFor
 */

/** @type {AxisRule[]} */
const AXIS_RULES = [
  {
    axis: 'critical-workflow',
    level: 'high',
    pattern:
      /\b(?:\/epic-plan|epic-plan|orchestrat(?:ion|e)|critical\s+workflow|gate\s+(?:behavior|routing)|acceptance-spec\s+creation)\b/i,
    evidenceFor: (snippet) =>
      `Critical workflow signal: ${trimSnippet(snippet)}`,
  },
  {
    axis: 'security',
    level: 'high',
    pattern: /\b(?:security|authentication|auth(?:entication)?|authorization)\b/i,
    evidenceFor: (snippet) => `Security signal: ${trimSnippet(snippet)}`,
  },
  {
    axis: 'public-api',
    level: 'high',
    pattern: /\b(?:public\s+api|api\s+contract|breaking\s+api)\b/i,
    evidenceFor: (snippet) => `Public API signal: ${trimSnippet(snippet)}`,
  },
  {
    axis: 'visible-behavior',
    level: 'high',
    pattern:
      /\b(?:user-facing|operator-visible|visible\s+behavior|ui\s+change)\b/i,
    evidenceFor: (snippet) =>
      `Visible behavior signal: ${trimSnippet(snippet)}`,
  },
  {
    axis: 'data-migration',
    level: 'high',
    pattern: /\b(?:data\s+migration|schema\s+migration|migrate\s+data)\b/i,
    evidenceFor: (snippet) => `Data migration signal: ${trimSnippet(snippet)}`,
  },
  {
    axis: 'billing',
    level: 'high',
    pattern: /\b(?:billing|payment|stripe|subscription)\b/i,
    evidenceFor: (snippet) => `Billing signal: ${trimSnippet(snippet)}`,
  },
  {
    axis: 'destructive-mutation',
    level: 'high',
    pattern:
      /\b(?:destructive|drop\s+table|delete\s+user\s+data|irreversible)\b/i,
    evidenceFor: (snippet) =>
      `Destructive mutation signal: ${trimSnippet(snippet)}`,
  },
  {
    axis: 'internal-refactor',
    level: 'low',
    pattern: /\b(?:internal\s+refactor|refactor(?:ing)?(?:\s+only)?)\b/i,
    evidenceFor: (snippet) =>
      `Internal refactor signal: ${trimSnippet(snippet)}`,
  },
  {
    axis: 'test-harness',
    level: 'low',
    pattern: /\b(?:test\s+harness|test\s+infrastructure)\b/i,
    evidenceFor: (snippet) => `Test harness signal: ${trimSnippet(snippet)}`,
  },
  {
    axis: 'docs-only',
    level: 'low',
    pattern: /\b(?:docs-only|documentation\s+only|readme|prose\s+cleanup)\b/i,
    evidenceFor: (snippet) => `Docs-only signal: ${trimSnippet(snippet)}`,
  },
];

const CLEANUP_PATTERN = /\b(?:cleanup|chore-only|housekeeping)\b/i;

/**
 * @param {string} text
 * @returns {string}
 */
function trimSnippet(text) {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= 80) return collapsed;
  return `${collapsed.slice(0, 77)}...`;
}

/**
 * @param {string} haystack
 * @param {RegExp} pattern
 * @returns {string|null}
 */
function firstMatchSnippet(haystack, pattern) {
  const match = haystack.match(pattern);
  if (!match || typeof match.index !== 'number') return null;
  const start = Math.max(0, match.index - 20);
  const end = Math.min(haystack.length, match.index + match[0].length + 40);
  return haystack.slice(start, end);
}

/**
 * @param {PlanningRiskAxis[]} axes
 * @returns {RiskLevel}
 */
function resolveOverallLevel(axes) {
  if (axes.length === 0) return 'low';
  return axes.reduce(
    (highest, entry) =>
      LEVEL_RANK[entry.level] > LEVEL_RANK[highest] ? entry.level : highest,
    'low',
  );
}

/**
 * @param {PlanningRiskAxis[]} axes
 * @param {RiskLevel} overallLevel
 * @returns {AcceptanceDisposition}
 */
function resolveAcceptanceDisposition(axes, overallLevel) {
  if (axes.some((entry) => REQUIRED_AXES.has(entry.axis))) {
    return 'required';
  }
  if (
    overallLevel === 'medium' ||
    axes.some((entry) => entry.level === 'medium')
  ) {
    return 'recommended';
  }
  if (
    axes.length > 0 &&
    axes.every((entry) => NOT_APPLICABLE_AXES.has(entry.axis))
  ) {
    return 'not-applicable';
  }
  if (overallLevel === 'low') return 'not-applicable';
  return 'recommended';
}

/**
 * @param {RiskLevel} overallLevel
 * @param {PlanningRiskAxis[]} axes
 * @returns {boolean}
 */
function resolveRequiresReview(overallLevel, axes) {
  if (overallLevel === 'high') return true;
  if (overallLevel === 'medium') {
    return axes.some(
      (entry) =>
        entry.level === 'medium' &&
        (REQUIRED_AXES.has(entry.axis) || entry.axis === 'visible-behavior'),
    );
  }
  return false;
}

/**
 * Classify planning risk for an Epic without mutating GitHub state.
 *
 * @param {{ title?: string, body?: string, labels?: string[] }} [input]
 * @returns {PlanningRiskEnvelope}
 */
export function classifyPlanningRisk(input = {}) {
  const title = typeof input.title === 'string' ? input.title : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const labels = Array.isArray(input.labels) ? input.labels : [];
  const haystack = `${title}\n${body}\n${labels.join('\n')}`;

  /** @type {PlanningRiskAxis[]} */
  const axes = [];

  for (const rule of AXIS_RULES) {
    const snippet = firstMatchSnippet(haystack, rule.pattern);
    if (!snippet) continue;
    axes.push({
      axis: rule.axis,
      level: rule.level,
      evidence: rule.evidenceFor(snippet),
    });
  }

  if (
    axes.length === 0 &&
    CLEANUP_PATTERN.test(haystack) &&
    !/\b(?:security|auth|api|billing|migration)\b/i.test(haystack)
  ) {
    axes.push({
      axis: 'docs-only',
      level: 'low',
      evidence: 'Cleanup-only scope with no high-risk axis signals.',
    });
  }

  const overallLevel = resolveOverallLevel(axes);
  const acceptanceDisposition = resolveAcceptanceDisposition(axes, overallLevel);
  const requiresReview = resolveRequiresReview(overallLevel, axes);
  const gateDecision = requiresReview ? 'review-required' : 'auto-proceed';

  return {
    axes,
    overallLevel,
    requiresReview,
    acceptanceDisposition,
    gateDecision,
  };
}
