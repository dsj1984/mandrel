import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyPlanningRisk } from '../../../.agents/scripts/lib/orchestration/planning-risk.js';
import { resolveReviewRouting } from '../../../.agents/scripts/lib/orchestration/plan-review-routing.js';

describe('resolveReviewRouting — Story #2795', () => {
  it('requires stop for high-risk planning', () => {
    const planningRisk = classifyPlanningRisk({
      title: 'Adaptive Planning Gate Routing',
      body: 'Changes /epic-plan gate behavior and acceptance-spec creation.',
      labels: ['type::epic'],
    });

    const routing = resolveReviewRouting({ planningRisk });

    assert.equal(planningRisk.requiresReview, true);
    assert.equal(routing.decision, 'review-required');
    assert.equal(routing.requiresStop, true);
    assert.equal(routing.forceReviewApplied, false);
    assert.match(routing.operatorMessage, /STOP before Phase 8/i);
  });

  it('auto-proceeds for low-risk planning', () => {
    const planningRisk = classifyPlanningRisk({
      title: 'Docs-only readme cleanup',
      body: 'Documentation-only prose cleanup.',
      labels: ['type::epic'],
    });

    const routing = resolveReviewRouting({ planningRisk });

    assert.equal(planningRisk.requiresReview, false);
    assert.equal(routing.decision, 'auto-proceed');
    assert.equal(routing.requiresStop, false);
    assert.match(routing.operatorMessage, /auto-proceed/i);
  });

  it('forces review stop on low-risk Epics when operator override is set', () => {
    const planningRisk = classifyPlanningRisk({
      title: 'Docs-only readme cleanup',
      body: 'Documentation-only prose cleanup.',
      labels: ['type::epic'],
    });

    const routing = resolveReviewRouting({ planningRisk, forceReview: true });

    assert.equal(routing.decision, 'operator-override-review');
    assert.equal(routing.requiresStop, true);
    assert.equal(routing.forceReviewApplied, true);
    assert.match(routing.operatorMessage, /override/i);
  });
});
