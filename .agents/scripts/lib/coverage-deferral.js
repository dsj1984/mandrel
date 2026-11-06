/**
 * coverage-deferral.js — the vocabulary of a coverage capture deferred to CI:
 * its reasons, the PR-body marker CI workflows and confirm-merge route on,
 * and the handoff envelope's `coverage` field.
 */

/** The PR-body key line's key — a stable contract. */
export const COVERAGE_DEFERRED_KEY = 'Coverage-deferred';

/** The deferral reasons the key line carries — a stable contract. */
export const COVERAGE_DEFERRED_REASONS = Object.freeze({
  overBudget: 'over-budget',
  suiteOfRecordCi: 'suite-of-record-ci',
});

/** The prose line each reason adds beneath `Closes #<id>`. */
const PROSE = Object.freeze({
  [COVERAGE_DEFERRED_REASONS.overBudget]:
    "Coverage deferred to CI: the capture slice was over this host's budget (exit 76, onOverBudget: defer-to-ci).",
  [COVERAGE_DEFERRED_REASONS.suiteOfRecordCi]:
    'Coverage deferred to CI: CI is the coverage and CRAP ratchet of record (suiteOfRecord: ci).',
});

/** The handoff envelope's `policy` for each reason. */
const POLICY = Object.freeze({
  [COVERAGE_DEFERRED_REASONS.overBudget]: 'defer-to-ci',
  [COVERAGE_DEFERRED_REASONS.suiteOfRecordCi]: 'suite-of-record',
});

/**
 * The prose line, then the key line directly beneath it; none without a reason.
 *
 * @param {string|null|undefined} reason
 * @returns {string[]}
 */
export function deferralLines(reason) {
  if (!reason) return [];
  return ['', PROSE[reason], `${COVERAGE_DEFERRED_KEY}: ${reason}`];
}

/**
 * The reason a PR body's key line carries, else `null`.
 *
 * @param {string|null|undefined} body
 * @returns {string|null}
 */
export function readDeferralMarker(body) {
  const match = new RegExp(
    `^${COVERAGE_DEFERRED_KEY}:[ \\t]*(\\S+)[ \\t]*$`,
    'm',
  ).exec(String(body ?? ''));
  return match ? match[1] : null;
}

/**
 * Record a deferral and its reason at `head`.
 *
 * @param {{ coverageDeferredHead?: string, coverageDeferredReason?: string }} state
 * @param {string} head @param {string} reason
 */
export function deferCoverage(state, head, reason) {
  state.coverageDeferredHead = head;
  state.coverageDeferredReason = reason;
}

/**
 * The envelope's `coverage` field for a recorded deferral.
 *
 * @param {string|undefined} reason
 * @returns {{ status: 'deferred', reason: string, policy: string }}
 */
export function deferralEnvelope(
  reason = COVERAGE_DEFERRED_REASONS.overBudget,
) {
  return { status: 'deferred', reason, policy: POLICY[reason] };
}
