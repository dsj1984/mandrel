import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deriveRiskEnvelope,
  NOT_APPLICABLE_AXES,
  REQUIRED_AXES,
} from '../../../.agents/scripts/lib/orchestration/planning-risk.js';

const HIGH_RISK_CRITICAL_WORKFLOW_VERDICT = {
  axes: [
    {
      axis: 'critical-workflow',
      level: 'high',
      rationale:
        'Rewrites /plan gate routing — a failure mis-routes every plan.',
    },
  ],
  summary: 'High-risk orchestration change to the planning gate path.',
};

const DOCS_ONLY_VERDICT = {
  axes: [
    {
      axis: 'docs-only',
      level: 'low',
      rationale: 'Prose-only README and SDLC updates; no executable surface.',
    },
  ],
  summary: 'Documentation cleanup with no behavioral change.',
};

const MIXED_SIGNAL_VERDICT = {
  axes: [
    {
      axis: 'security',
      level: 'high',
      rationale: 'Hardens the authentication flow for operator endpoints.',
    },
    {
      axis: 'docs-only',
      level: 'low',
      rationale: 'Companion changelog entry for operators.',
    },
  ],
  summary: 'Auth hardening with a docs companion.',
};

const MEDIUM_INTERNAL_REFACTOR_VERDICT = {
  axes: [
    {
      axis: 'internal-refactor',
      level: 'medium',
      rationale: 'Restructures the resolver internals behind a stable API.',
    },
  ],
  summary: 'Medium-blast-radius internal refactor; public surface unchanged.',
};

describe('deriveRiskEnvelope', () => {
  it('derives a high-risk review-required envelope from a critical-workflow verdict', () => {
    const result = deriveRiskEnvelope(HIGH_RISK_CRITICAL_WORKFLOW_VERDICT);

    assert.strictEqual(result.overallLevel, 'high');
    assert.strictEqual(result.requiresReview, true);
    assert.strictEqual(result.acceptanceDisposition, 'required');
    assert.strictEqual(result.gateDecision, 'review-required');
    assert.ok(
      result.axes.some(
        (entry) => entry.axis === 'critical-workflow' && entry.level === 'high',
      ),
    );
  });

  it('derives a low-risk waived envelope from a docs-only verdict', () => {
    const result = deriveRiskEnvelope(DOCS_ONLY_VERDICT);

    assert.strictEqual(result.overallLevel, 'low');
    assert.strictEqual(result.requiresReview, false);
    assert.strictEqual(result.acceptanceDisposition, 'not-applicable');
    assert.strictEqual(result.gateDecision, 'auto-proceed');
  });

  it('carries every supplied axis with its planner rationale through to the envelope', () => {
    const result = deriveRiskEnvelope(MIXED_SIGNAL_VERDICT);

    assert.equal(result.axes.length, 2);
    const security = result.axes.find((entry) => entry.axis === 'security');
    const docsOnly = result.axes.find((entry) => entry.axis === 'docs-only');

    assert.ok(security, 'expected security axis');
    assert.ok(docsOnly, 'expected docs-only axis');
    assert.match(String(security.rationale), /auth/i);
    assert.match(String(docsOnly.rationale), /changelog/i);
    // A required axis forces the required disposition even alongside
    // not-applicable axes.
    assert.strictEqual(result.acceptanceDisposition, 'required');
  });

  it('routes a medium-level non-required axis to recommended without a review stop', () => {
    const result = deriveRiskEnvelope(MEDIUM_INTERNAL_REFACTOR_VERDICT);

    assert.strictEqual(result.overallLevel, 'medium');
    assert.strictEqual(result.requiresReview, false);
    assert.strictEqual(result.acceptanceDisposition, 'recommended');
    assert.strictEqual(result.gateDecision, 'auto-proceed');
  });

  it('requires review for a medium-level required axis', () => {
    const result = deriveRiskEnvelope({
      axes: [
        {
          axis: 'public-api',
          level: 'medium',
          rationale: 'Adds an optional field to a published response shape.',
        },
      ],
      summary: 'Additive API change.',
    });

    assert.strictEqual(result.overallLevel, 'medium');
    assert.strictEqual(result.requiresReview, true);
    assert.strictEqual(result.gateDecision, 'review-required');
  });

  it('derives an all-low auto-proceed envelope from an empty axes verdict', () => {
    const result = deriveRiskEnvelope({
      axes: [],
      summary: 'No recognized risk axis applies.',
    });

    assert.deepEqual(result.axes, []);
    assert.strictEqual(result.overallLevel, 'low');
    assert.strictEqual(result.requiresReview, false);
    assert.strictEqual(result.acceptanceDisposition, 'not-applicable');
    assert.strictEqual(result.gateDecision, 'auto-proceed');
  });

  it('returns the stable planning risk envelope shape', () => {
    const result = deriveRiskEnvelope(MIXED_SIGNAL_VERDICT);

    assert.ok(Array.isArray(result.axes));
    for (const entry of result.axes) {
      assert.ok(typeof entry.axis === 'string');
      assert.ok(['low', 'medium', 'high'].includes(entry.level));
      assert.ok(
        typeof entry.rationale === 'string' && entry.rationale.length > 0,
      );
    }
    assert.ok(['low', 'medium', 'high'].includes(result.overallLevel));
    assert.strictEqual(typeof result.requiresReview, 'boolean');
    assert.ok(
      ['required', 'recommended', 'not-applicable'].includes(
        result.acceptanceDisposition,
      ),
    );
    assert.ok(
      ['review-required', 'auto-proceed'].includes(result.gateDecision),
    );
  });

  it('exports the axis vocabulary the schema enum mirrors', () => {
    assert.deepEqual([...REQUIRED_AXES].sort(), [
      'billing',
      'critical-workflow',
      'data-migration',
      'destructive-mutation',
      'public-api',
      'security',
      'visible-behavior',
    ]);
    assert.deepEqual([...NOT_APPLICABLE_AXES].sort(), [
      'docs-only',
      'internal-refactor',
      'test-harness',
    ]);
  });
});
