/**
 * handoff-suite-of-record.js — the credited-run step under
 * `coverage.suiteOfRecord: "ci"`, decided from config before any lock or spawn.
 */

import { suiteOfRecord } from '../close-validation/gates.js';
import {
  COVERAGE_DEFERRED_REASONS,
  deferCoverage,
} from '../coverage-deferral.js';

const UNDECLARED_DETAIL =
  'delivery.quality.gates.coverage.suiteOfRecord is "ci" but delivery.quality.gates.coverage.ciRatchetCheck is unset — name the CI check that runs coverage-ratchet.js, or set suiteOfRecord to "local"';

/**
 * The capture depositor's step under the `ci` posture: deferred to CI, or
 * `blocked` when no `ciRatchetCheck` would take the ratchet. `null` when the
 * posture is off or the depositor is `test`.
 *
 * @param {{ config: object, depositor: string, head: string, state: object }} ctx
 * @param {string} name
 * @returns {object|null}
 */
export function settleSuiteOfRecord(ctx, name) {
  const { ci, ciRatchetCheck } = suiteOfRecord(ctx.config);
  if (!ci || ctx.depositor !== 'coverage-capture') return null;
  const extra = { depositor: ctx.depositor };
  if (!ciRatchetCheck) {
    return {
      name,
      outcome: 'failed',
      detail: UNDECLARED_DETAIL,
      reason: 'ci-ratchet-undeclared',
      stop: 'blocked',
      ...extra,
    };
  }
  deferCoverage(ctx.state, ctx.head, COVERAGE_DEFERRED_REASONS.suiteOfRecordCi);
  return {
    name,
    outcome: 'deferred',
    detail: `coverage deferred to CI (suiteOfRecord: ci, ratchet check "${ciRatchetCheck}") — nothing spawned and no credit was deposited`,
    ...extra,
  };
}
