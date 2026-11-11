/**
 * coverage-deferral.js — the vocabulary of a coverage capture deferred to CI:
 * its reasons, the PR-body marker CI workflows and confirm-merge route on,
 * and the handoff envelope's `coverage` field.
 */

import { replaceBeneathCloses } from './pr-body-lines.js';

/** The PR-body key line's key — a stable contract. */
const COVERAGE_DEFERRED_KEY = 'Coverage-deferred';

/** The deferral reasons the key line carries — a stable contract. */
export const COVERAGE_DEFERRED_REASONS = Object.freeze({
  overBudget: 'over-budget',
  suiteOfRecordCi: 'suite-of-record-ci',
  baseSyncCi: 'base-sync-ci',
});

/** The gates that run the suite: only their deferral is a coverage deferral. */
export const SUITE_GATE_NAMES = new Set(['test', 'coverage-capture']);

/**
 * The suite gate's entry among a close's `deferred[]`, else `undefined`; a
 * typecheck or lint deferral never stands for the suite.
 *
 * @param {Array<{ gate: { name: string }, reason: string }>|undefined} deferred
 */
export function suiteGateDeferral(deferred) {
  return (deferred ?? []).find((d) => SUITE_GATE_NAMES.has(d.gate.name));
}

/** The prose line each reason adds beneath `Closes #<id>`. */
const PROSE = Object.freeze({
  [COVERAGE_DEFERRED_REASONS.overBudget]:
    "Coverage deferred to CI: the capture slice was over this host's budget (exit 76, onOverBudget: defer-to-ci).",
  [COVERAGE_DEFERRED_REASONS.suiteOfRecordCi]:
    'Coverage deferred to CI: CI is the coverage and CRAP ratchet of record (suiteOfRecord: ci).',
  [COVERAGE_DEFERRED_REASONS.baseSyncCi]:
    'Coverage deferred to CI: close merged the base conflict-free and CI revalidates the merged tree (revalidateAfterBaseSync: ci).',
});

const PROSE_LINES = new Set(Object.values(PROSE));

/** The handoff envelope's `policy` for each reason. */
const POLICY = Object.freeze({
  [COVERAGE_DEFERRED_REASONS.overBudget]: 'defer-to-ci',
  [COVERAGE_DEFERRED_REASONS.suiteOfRecordCi]: 'suite-of-record',
  [COVERAGE_DEFERRED_REASONS.baseSyncCi]: 'base-sync',
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
 * `body` with its deferral lines replaced by `reason`'s, placed beneath
 * `Closes #<id>` (appended when that line is missing).
 *
 * @param {string|null|undefined} body @param {string} reason
 * @returns {string}
 */
export function rewriteDeferralLines(body, reason) {
  return replaceBeneathCloses(body, isDeferralLine, deferralLines(reason));
}

/** A prose or key line of any deferral reason. */
function isDeferralLine(line) {
  return PROSE_LINES.has(line) || line.startsWith(`${COVERAGE_DEFERRED_KEY}:`);
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
