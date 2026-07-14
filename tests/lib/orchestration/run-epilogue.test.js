/**
 * Unit tests for the v2 run-epilogue scaffold (inert per-run ceremony planner).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  planRunEpilogue,
  RUN_EPILOGUE_STEP_KINDS,
} from '../../../.agents/scripts/lib/orchestration/run-epilogue.js';

describe('planRunEpilogue — not applicable', () => {
  it('is inapplicable for a single-Story run (common case)', () => {
    const plan = planRunEpilogue({ planRunId: 'run-1', stories: ['s1'] });
    assert.equal(plan.applicable, false);
    assert.deepEqual(plan.steps, []);
    assert.match(plan.reason, /single-Story/);
  });

  it('is inapplicable for an empty run', () => {
    const plan = planRunEpilogue({ planRunId: 'run-1', stories: [] });
    assert.equal(plan.applicable, false);
    assert.match(plan.reason, /no Stories/);
  });

  it('is inapplicable for a multi-Story run with no planRunId', () => {
    const plan = planRunEpilogue({ stories: ['s1', 's2'] });
    assert.equal(plan.applicable, false);
    assert.match(plan.reason, /requires a planRunId/);
  });
});

describe('planRunEpilogue — applicable (N>1)', () => {
  it('emits the three ordered epilogue steps over the run Stories', () => {
    const plan = planRunEpilogue({
      planRunId: 'run-42',
      stories: ['s1', 's2', 's3'],
    });
    assert.equal(plan.applicable, true);
    assert.equal(plan.planRunId, 'run-42');
    assert.deepEqual(
      plan.steps.map((s) => s.kind),
      [...RUN_EPILOGUE_STEP_KINDS],
    );
    for (const step of plan.steps) {
      assert.deepEqual(step.stories, ['s1', 's2', 's3']);
    }
  });

  it('normalizes story ids from objects, dedupes, and preserves order', () => {
    const plan = planRunEpilogue({
      planRunId: '  run-7  ',
      stories: [{ id: 's1' }, { slug: 's2' }, 's1', '  s3  '],
    });
    assert.equal(plan.planRunId, 'run-7');
    assert.deepEqual(plan.stories, ['s1', 's2', 's3']);
  });

  it('accepts numeric Story ids from resolve-plan-run envelopes', () => {
    const plan = planRunEpilogue({
      planRunId: 'run-8',
      stories: [{ id: 101 }, { id: 102 }, 103],
    });
    assert.equal(plan.applicable, true);
    assert.deepEqual(plan.stories, ['101', '102', '103']);
  });

  it('is pure — no side effects, deterministic output', () => {
    const args = { planRunId: 'run-9', stories: ['a', 'b'] };
    assert.deepEqual(planRunEpilogue(args), planRunEpilogue(args));
  });
});
