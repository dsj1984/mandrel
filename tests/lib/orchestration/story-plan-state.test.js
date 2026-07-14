import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  readStoryPlanningRisk,
  readStoryPlanningRiskSafe,
  resolveStoryPlanningRisk,
} from '../../../.agents/scripts/lib/orchestration/story-plan-state.js';

describe('Story planning state', () => {
  it('reads planningRisk from the Story checkpoint', async () => {
    const planningRisk = { overallLevel: 'high', axes: [] };
    const result = await readStoryPlanningRisk({
      provider: {},
      storyId: 17,
      findCommentFn: async () => ({
        body: [
          '<!-- ap:structured-comment type="story-plan-state" -->',
          '### story-plan-state',
          '',
          '```json',
          JSON.stringify({ version: 2, storyId: 17, planningRisk }),
          '```',
        ].join('\n'),
      }),
    });
    assert.deepEqual(result, planningRisk);
  });

  it('degrades provider failures to neutral risk', async () => {
    const result = await readStoryPlanningRiskSafe({
      provider: {},
      storyId: 17,
      findCommentFn: async () => {
        throw new Error('network');
      },
    });
    assert.equal(result, null);
  });

  it('prefers an explicit planningRisk override', async () => {
    const override = { overallLevel: 'medium', axes: [] };
    const result = await resolveStoryPlanningRisk({
      provider: {},
      storyId: 17,
      planningRisk: override,
      findCommentFn: async () => {
        throw new Error('must not read when override is set');
      },
    });
    assert.deepEqual(result, override);
  });
});
