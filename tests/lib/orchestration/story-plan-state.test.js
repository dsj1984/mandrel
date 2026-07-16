// tests/lib/orchestration/story-plan-state.test.js
//
// Unit tier: the Story planning checkpoint reader. Story #4542 removed the
// three risk readers this file used to cover (`readStoryPlanningRisk`,
// `readStoryPlanningRiskSafe`, `resolveStoryPlanningRisk`) along with the
// checkpoint fields they read — review depth is derived from the diff at close
// time now, so no checkpoint read sits on the delivery path. What remains is
// the persist receipt and the reader that parses it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readStoryPlanState } from '../../../.agents/scripts/lib/orchestration/story-plan-state.js';

/** Wrap a checkpoint payload in the structured-comment envelope. */
function checkpointComment(payload) {
  return {
    body: [
      '<!-- ap:structured-comment type="story-plan-state" -->',
      '### story-plan-state',
      '',
      '```json',
      JSON.stringify(payload),
      '```',
    ].join('\n'),
  };
}

describe('Story planning state', () => {
  it('reads the persist receipt off the Story checkpoint', async () => {
    const persist = {
      completedAt: '2026-07-16T00:00:00.000Z',
      storyCount: 1,
      primaryStoryId: 17,
      stories: [{ slug: 'do-the-thing', id: 17 }],
    };
    const result = await readStoryPlanState({
      provider: {},
      storyId: 17,
      findCommentFn: async () =>
        checkpointComment({ version: 2, storyId: 17, persist }),
    });
    assert.deepEqual(result, { version: 2, storyId: 17, persist });
  });

  it('degrades a missing checkpoint to null', async () => {
    const result = await readStoryPlanState({
      provider: {},
      storyId: 17,
      findCommentFn: async () => null,
    });
    assert.equal(result, null);
  });

  it('degrades a malformed checkpoint body to null', async () => {
    const result = await readStoryPlanState({
      provider: {},
      storyId: 17,
      findCommentFn: async () => ({ body: 'not a fenced json checkpoint' }),
    });
    assert.equal(result, null);
  });
});
