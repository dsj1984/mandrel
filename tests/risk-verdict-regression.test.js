/**
 * risk-verdict-regression.test.js — risk-verdict control-case regression
 * (Story #3877, Epic #3865).
 *
 * Contract tier. Locks in the two probe control cases the model-evolution
 * recalibration must keep getting right after the hard cutover from the
 * retired keyword-regex classifier to the planner-supplied,
 * schema-validated risk verdict (`deriveRiskEnvelope`):
 *
 *   1. FALSE-POSITIVE GUARD — a verdict that merely *names* billing and
 *      security in an Out-of-Scope sense (the PRD says "out of scope:
 *      billing", "no auth changes") must NOT be rated high-risk. The old
 *      regex classifier tripped `security` / `billing` on keyword presence
 *      alone; the judged path lets the planner record those axes as the
 *      low-severity, non-applicable signals they actually are (or omit them
 *      entirely), so the envelope is not high-risk and not review-required.
 *
 *   2. TRUE-POSITIVE — a verdict for a credential-vault rotation that
 *      re-issues every active session is a genuine `security` change at
 *      `high` level. The envelope must be high-risk, review-required, and
 *      carry a `required` acceptance disposition.
 *
 * Both control verdicts are first validated against
 * `risk-verdict.schema.json` (via `validateRiskVerdict`, the same read
 * boundary `epic-plan-spec.js` uses) and only then derived — so the
 * regression exercises the model-judged path end to end, not the deleted
 * regex. A schema-invalid verdict would fail closed before derivation.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateRiskVerdict } from '../.agents/scripts/epic-plan-spec.js';
import { deriveRiskEnvelope } from '../.agents/scripts/lib/orchestration/planning-risk.js';

/**
 * Control case 1 — the false-positive guard. A delivery whose PRD/Tech Spec
 * mention billing and security only to scope them OUT. The planner judges
 * that no required axis genuinely applies: the actual change is an internal
 * refactor. (The retired regex would have keyword-matched "billing" and
 * "security" and forced high-risk.)
 */
const OUT_OF_SCOPE_VERDICT = {
  axes: [
    {
      axis: 'internal-refactor',
      level: 'low',
      rationale:
        'Extracts a shared pagination helper. The PRD explicitly scopes billing and authentication OUT — no payment path or auth boundary is touched.',
    },
  ],
  summary:
    'Internal refactor only. Billing and security are named in the PRD solely as out-of-scope boundaries, not as changes; no required risk axis genuinely applies.',
};

/**
 * Control case 2 — the true positive. Rotating the credential vault and
 * re-issuing every active session is a real, high-severity security change.
 * The planner records a `security` axis at `high`.
 */
const CREDENTIAL_VAULT_VERDICT = {
  axes: [
    {
      axis: 'security',
      level: 'high',
      rationale:
        'Rotates the credential vault encryption keys and force-reissues every active session token, invalidating all live sessions. A regression here locks out every user or leaks credentials.',
    },
  ],
  summary:
    'High-risk security change: credential-vault key rotation with full session re-issue. Requires human review before delivery.',
};

describe('risk-verdict control-case regression (Story #3877)', () => {
  describe('false-positive guard — Out-of-Scope billing/security is NOT high-risk', () => {
    it('passes schema validation (a well-formed judged verdict)', () => {
      assert.doesNotThrow(() => validateRiskVerdict(OUT_OF_SCOPE_VERDICT));
    });

    it('derives a non-high overall level', () => {
      const envelope = deriveRiskEnvelope(OUT_OF_SCOPE_VERDICT);
      assert.notEqual(
        envelope.overallLevel,
        'high',
        'naming billing/security as out-of-scope must not force high risk',
      );
    });

    it('does not require review and auto-proceeds', () => {
      const envelope = deriveRiskEnvelope(OUT_OF_SCOPE_VERDICT);
      assert.equal(envelope.requiresReview, false);
      assert.equal(envelope.gateDecision, 'auto-proceed');
    });

    it('does not force a required acceptance disposition', () => {
      const envelope = deriveRiskEnvelope(OUT_OF_SCOPE_VERDICT);
      assert.notEqual(
        envelope.acceptanceDisposition,
        'required',
        'an internal-refactor-only verdict must not force a required Acceptance Spec',
      );
    });
  });

  describe('true positive — credential-vault / session-reissue IS high-risk and review-required', () => {
    it('passes schema validation (a well-formed judged verdict)', () => {
      assert.doesNotThrow(() => validateRiskVerdict(CREDENTIAL_VAULT_VERDICT));
    });

    it('derives a high overall level', () => {
      const envelope = deriveRiskEnvelope(CREDENTIAL_VAULT_VERDICT);
      assert.equal(envelope.overallLevel, 'high');
    });

    it('requires review and routes to the review gate', () => {
      const envelope = deriveRiskEnvelope(CREDENTIAL_VAULT_VERDICT);
      assert.equal(envelope.requiresReview, true);
      assert.equal(envelope.gateDecision, 'review-required');
    });

    it('forces a required acceptance disposition', () => {
      const envelope = deriveRiskEnvelope(CREDENTIAL_VAULT_VERDICT);
      assert.equal(envelope.acceptanceDisposition, 'required');
    });

    it('preserves the security axis the planner judged', () => {
      const envelope = deriveRiskEnvelope(CREDENTIAL_VAULT_VERDICT);
      const securityAxis = envelope.axes.find(
        (axis) => axis.axis === 'security',
      );
      assert.ok(securityAxis, 'the security axis must survive derivation');
      assert.equal(securityAxis.level, 'high');
    });
  });
});
