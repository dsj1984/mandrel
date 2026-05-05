import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StoryLauncher } from '../../.agents/scripts/lib/orchestration/epic-runner/story-launcher.js';

describe('StoryLauncher', () => {
  it('planWave returns one entry per story with stable shape', () => {
    const launcher = new StoryLauncher({ concurrencyCap: 2 });
    const plan = launcher.planWave([{ id: 1 }, { id: 2 }, 3]);
    assert.deepEqual(plan, [
      { storyId: 1, worktree: undefined },
      { storyId: 2, worktree: undefined },
      { storyId: 3, worktree: undefined },
    ]);
  });

  it('planWave threads worktreeResolver into the plan', () => {
    const launcher = new StoryLauncher({
      concurrencyCap: 1,
      worktreeResolver: (id) => `/tmp/story-${id}`,
    });
    const plan = launcher.planWave([{ id: 7 }]);
    assert.equal(plan[0].worktree, '/tmp/story-7');
  });

  it('launchWave passes plan + concurrencyCap to dispatch and preserves order', async () => {
    const seen = [];
    const launcher = new StoryLauncher({
      concurrencyCap: 3,
      dispatch: async ({ plan, concurrencyCap }) => {
        seen.push({ plan, concurrencyCap });
        return plan.map((p) => ({
          storyId: p.storyId,
          status: 'done',
          detail: `did-${p.storyId}`,
        }));
      },
    });
    const stories = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const results = await launcher.launchWave(stories);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].concurrencyCap, 3);
    assert.deepEqual(
      results.map((r) => r.storyId),
      [1, 2, 3],
    );
    assert.equal(results[0].status, 'done');
    assert.equal(results[2].detail, 'did-3');
  });

  it('launchWave fills missing dispatch results with a failed entry', async () => {
    const launcher = new StoryLauncher({
      concurrencyCap: 2,
      dispatch: async ({ plan }) =>
        plan
          .filter((p) => p.storyId !== 2)
          .map((p) => ({ storyId: p.storyId, status: 'done' })),
    });
    const results = await launcher.launchWave([
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);
    assert.equal(results[0].status, 'done');
    assert.equal(results[1].status, 'failed');
    assert.match(results[1].detail, /no result/);
    assert.equal(results[2].status, 'done');
  });

  it('launchWave reports failure for every plan entry when dispatch throws', async () => {
    const launcher = new StoryLauncher({
      concurrencyCap: 2,
      dispatch: async () => {
        throw new Error('boom');
      },
    });
    const results = await launcher.launchWave([{ id: 1 }, { id: 2 }]);
    assert.equal(results.length, 2);
    for (const r of results) {
      assert.equal(r.status, 'failed');
      assert.match(r.detail, /boom/);
    }
  });

  it('launchWave throws when no dispatch adapter was injected', async () => {
    const launcher = new StoryLauncher({ concurrencyCap: 1 });
    await assert.rejects(
      () => launcher.launchWave([{ id: 1 }]),
      /requires a dispatch adapter/,
    );
  });

  it('launchWave returns empty array for an empty wave', async () => {
    const launcher = new StoryLauncher({
      concurrencyCap: 2,
      dispatch: async () => {
        throw new Error('should not be called for an empty wave');
      },
    });
    const results = await launcher.launchWave([]);
    assert.deepEqual(results, []);
  });

  it('rejects invalid concurrencyCap', () => {
    assert.throws(() => new StoryLauncher({ concurrencyCap: 0 }), RangeError);
    assert.throws(() => new StoryLauncher({}), RangeError);
  });
});
