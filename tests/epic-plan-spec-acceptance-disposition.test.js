/**
 * tests/epic-plan-spec-acceptance-disposition.test.js — Story #4145.
 *
 * Unit contract for the no-BDD-runner acceptance waiver in
 * `deriveRiskEnvelope`. When the project ships no supported BDD runner
 * (`bddRunner.fallback === true`, e.g. a node:test repo with no
 * `tests/features/**`), an authored acceptance-spec AC table can never be
 * reconciled by `@epic-<id>-ac-*` feature tags, so `/deliver` finalize would
 * abort and force a manual `acceptance::n-a`. The waiver forces the
 * acceptance disposition to `not-applicable` for those repos so finalize
 * succeeds without manual label surgery — while leaving repos WITH a runner
 * (and the review gate) untouched, and keeping the override operator-visible
 * via `acceptanceWaivedReason`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deriveRiskEnvelope } from '../.agents/scripts/lib/orchestration/planning-risk.js';

const REQUIRED_AXIS_VERDICT = {
  axes: [
    {
      axis: 'visible-behavior',
      level: 'high',
      rationale: 'Changes a user-visible delivery flow.',
    },
  ],
  summary: 'Required-axis change that would normally author an AC table.',
};

const RECOMMENDED_AXIS_VERDICT = {
  axes: [
    {
      axis: 'internal-refactor',
      level: 'medium',
      rationale: 'Medium-blast-radius internal refactor.',
    },
  ],
  summary: 'Recommended disposition under risk axes alone.',
};

const DOCS_ONLY_VERDICT = {
  axes: [
    {
      axis: 'docs-only',
      level: 'low',
      rationale: 'Prose-only updates; no executable surface.',
    },
  ],
  summary: 'Documentation cleanup; already not-applicable.',
};

const NO_RUNNER = Object.freeze({
  runner: null,
  pendingTag: null,
  supported: false,
  fallback: true,
  reason: 'no-bdd-runner-detected',
});

const BDD_RUNNER_PRESENT = Object.freeze({
  runner: 'playwright-bdd',
  pendingTag: '@skip',
  supported: true,
  fallback: false,
});

describe('deriveRiskEnvelope — no-BDD-runner acceptance waiver (Story #4145)', () => {
  it('forces not-applicable when a required-axis verdict meets no BDD runner', () => {
    const result = deriveRiskEnvelope(REQUIRED_AXIS_VERDICT, {
      bddRunner: NO_RUNNER,
    });

    // Without the waiver this verdict would derive `required`.
    assert.strictEqual(result.acceptanceDisposition, 'not-applicable');
  });

  it('records an operator-visible waiver rationale (not silent)', () => {
    const result = deriveRiskEnvelope(REQUIRED_AXIS_VERDICT, {
      bddRunner: NO_RUNNER,
    });

    assert.ok(
      typeof result.acceptanceWaivedReason === 'string' &&
        result.acceptanceWaivedReason.length > 0,
      'expected a non-empty acceptanceWaivedReason',
    );
    assert.match(result.acceptanceWaivedReason, /no BDD runner/i);
    // Surfaces the original axis-derived disposition for the audit trail.
    assert.match(result.acceptanceWaivedReason, /required/);
    assert.match(result.acceptanceWaivedReason, /no-bdd-runner-detected/);
  });

  it('also waives a recommended disposition when no BDD runner exists', () => {
    const result = deriveRiskEnvelope(RECOMMENDED_AXIS_VERDICT, {
      bddRunner: NO_RUNNER,
    });

    assert.strictEqual(result.acceptanceDisposition, 'not-applicable');
    assert.ok(result.acceptanceWaivedReason);
    assert.match(result.acceptanceWaivedReason, /recommended/);
  });

  it('does not stamp a waiver reason when the disposition was already not-applicable', () => {
    const result = deriveRiskEnvelope(DOCS_ONLY_VERDICT, {
      bddRunner: NO_RUNNER,
    });

    assert.strictEqual(result.acceptanceDisposition, 'not-applicable');
    assert.strictEqual(result.acceptanceWaivedReason, undefined);
  });

  it('leaves a required disposition intact when a BDD runner is present', () => {
    const result = deriveRiskEnvelope(REQUIRED_AXIS_VERDICT, {
      bddRunner: BDD_RUNNER_PRESENT,
    });

    assert.strictEqual(result.acceptanceDisposition, 'required');
    assert.strictEqual(result.acceptanceWaivedReason, undefined);
  });

  it('leaves the disposition intact when no bddRunner probe is supplied (back-compat)', () => {
    const noOpts = deriveRiskEnvelope(REQUIRED_AXIS_VERDICT);
    const nullRunner = deriveRiskEnvelope(REQUIRED_AXIS_VERDICT, {
      bddRunner: null,
    });

    assert.strictEqual(noOpts.acceptanceDisposition, 'required');
    assert.strictEqual(noOpts.acceptanceWaivedReason, undefined);
    assert.strictEqual(nullRunner.acceptanceDisposition, 'required');
  });

  it('waives acceptance but does NOT relax the review gate for a high-risk Epic', () => {
    const result = deriveRiskEnvelope(REQUIRED_AXIS_VERDICT, {
      bddRunner: NO_RUNNER,
    });

    // The acceptance-spec requirement is waived, but a high-risk Epic still
    // routes to review — the override touches only the AC disposition.
    assert.strictEqual(result.acceptanceDisposition, 'not-applicable');
    assert.strictEqual(result.overallLevel, 'high');
    assert.strictEqual(result.requiresReview, true);
    assert.strictEqual(result.gateDecision, 'review-required');
  });
});
