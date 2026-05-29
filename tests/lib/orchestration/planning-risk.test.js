import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyPlanningRisk } from '../../../.agents/scripts/lib/orchestration/planning-risk.js';

const HIGH_RISK_CRITICAL_WORKFLOW = {
  title: 'Adaptive Planning Gate Routing',
  body: `## Scope

Changes /epic-plan gate behavior and acceptance-spec creation for critical workflow orchestration.`,
  labels: ['type::epic'],
};

const LOW_RISK_DOCS_ONLY = {
  title: 'Documentation cleanup',
  body: `## Scope

Docs-only updates to README and SDLC prose. Internal documentation cleanup only.`,
  labels: ['type::epic'],
};

const MIXED_SIGNAL_EPIC = {
  title: 'Harden auth endpoints and update docs',
  body: `## Scope

- Add security hardening for authentication flows
- Docs-only changelog entry for operators`,
  labels: ['type::epic'],
};

const CLI_SECURITY_EPIC = {
  title: 'Env-tooling CLI: doctor, fix, lint commands',
  body: `## Scope

A command-line tooling epic. Includes security hardening of the secret-loading
path. No browser surface — headless CLI scripts only.`,
  labels: ['type::epic'],
};

const UI_SECURITY_EPIC = {
  title: 'Secure the account settings page',
  body: `## Scope

User-facing security hardening for the authentication UI change on the settings
screen.`,
  labels: ['type::epic'],
};

describe('classifyPlanningRisk', () => {
  it('classifies a critical-workflow Epic as high risk requiring review', () => {
    const result = classifyPlanningRisk(HIGH_RISK_CRITICAL_WORKFLOW);

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

  it('classifies a docs-only Epic as low risk with waived acceptance', () => {
    const result = classifyPlanningRisk(LOW_RISK_DOCS_ONLY);

    assert.strictEqual(result.overallLevel, 'low');
    assert.strictEqual(result.requiresReview, false);
    assert.strictEqual(result.acceptanceDisposition, 'not-applicable');
    assert.strictEqual(result.gateDecision, 'auto-proceed');
    assert.ok(
      result.axes.some(
        (entry) => entry.axis === 'docs-only' && entry.level === 'low',
      ),
    );
  });

  it('records each contributing axis with reviewer-readable evidence for mixed Epics', () => {
    const result = classifyPlanningRisk(MIXED_SIGNAL_EPIC);

    assert.ok(result.axes.length >= 2);

    const security = result.axes.find((entry) => entry.axis === 'security');
    const docsOnly = result.axes.find((entry) => entry.axis === 'docs-only');

    assert.ok(security, 'expected security axis');
    assert.ok(docsOnly, 'expected docs-only axis');
    assert.match(String(security.evidence), /security|auth/i);
    assert.match(String(docsOnly.evidence), /docs/i);
    assert.ok(security.evidence.length <= 120);
    assert.ok(docsOnly.evidence.length <= 120);
  });

  it('weights a CLI/tooling security Epic with no UI surface away from required acceptance (Story #3362)', () => {
    const result = classifyPlanningRisk(CLI_SECURITY_EPIC);

    // The security keyword still raises the axis...
    assert.ok(
      result.axes.some((entry) => entry.axis === 'security'),
      'expected security axis',
    );
    // ...but a headless CLI epic cannot satisfy a BDD `.feature` Acceptance
    // Spec, so the disposition must not be forced to `required`.
    assert.strictEqual(result.acceptanceDisposition, 'recommended');
  });

  it('keeps required acceptance when a security Epic IS user-facing (Story #3362)', () => {
    const result = classifyPlanningRisk(UI_SECURITY_EPIC);

    assert.ok(
      result.axes.some((entry) => entry.axis === 'visible-behavior'),
      'expected visible-behavior axis',
    );
    // A user-facing surface overrides the CLI weighting — acceptance stays
    // required.
    assert.strictEqual(result.acceptanceDisposition, 'required');
  });

  it('returns the stable planning risk envelope shape', () => {
    const result = classifyPlanningRisk(HIGH_RISK_CRITICAL_WORKFLOW);

    assert.ok(Array.isArray(result.axes));
    for (const entry of result.axes) {
      assert.ok(typeof entry.axis === 'string');
      assert.ok(['low', 'medium', 'high'].includes(entry.level));
      assert.ok(
        typeof entry.evidence === 'string' && entry.evidence.length > 0,
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
});
