/**
 * Story #1795 — resume-check cache pre-warm contract tests.
 *
 * Historically `iterate-waves` issued `getTicket(id, { fresh: true })`
 * for every Story in every wave to detect `agent::done` on resume.
 * Story #1795 reads from the provider's in-process cache by default
 * and force-refreshes **only** Stories the prior checkpoint reports
 * as part of a halted wave (the operator-resume case where labels
 * may have been hand-edited).
 *
 * `collectHaltedStoryIds` is the pure helper that derives the
 * force-fresh set from the checkpoint payload. The wave-level call
 * path is covered indirectly by existing integration coverage; the
 * helper carries the new behavioural contract.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectHaltedStoryIds } from '../../../../.agents/scripts/lib/wave-runner/wave-checkpoint.js';

describe('collectHaltedStoryIds', () => {
  it('returns an empty set when no checkpoint is supplied', () => {
    assert.equal(collectHaltedStoryIds(null).size, 0);
    assert.equal(collectHaltedStoryIds(undefined).size, 0);
    assert.equal(collectHaltedStoryIds({}).size, 0);
    assert.equal(collectHaltedStoryIds({ waves: 'not-array' }).size, 0);
  });

  it('returns an empty set when every wave completed cleanly', () => {
    const cp = {
      waves: [
        {
          status: 'completed',
          stories: [{ storyId: 1, status: 'done' }],
        },
        {
          status: 'completed',
          stories: [{ storyId: 2, status: 'done' }],
        },
      ],
    };
    assert.equal(collectHaltedStoryIds(cp).size, 0);
  });

  it('collects story IDs from halted waves only', () => {
    const cp = {
      waves: [
        {
          status: 'completed',
          stories: [{ storyId: 1, status: 'done' }],
        },
        {
          status: 'halted',
          stories: [
            { storyId: 7, status: 'blocked' },
            { storyId: 8, status: 'done' },
          ],
        },
      ],
    };
    const halted = collectHaltedStoryIds(cp);
    assert.equal(halted.size, 2);
    assert.ok(halted.has(7));
    assert.ok(halted.has(8));
    assert.ok(!halted.has(1));
  });

  it('tolerates legacy/partial story shapes ({ id }, raw number)', () => {
    const cp = {
      waves: [
        {
          status: 'halted',
          stories: [{ id: 11 }, 12, { storyId: 0 }, { storyId: 'nope' }],
        },
      ],
    };
    const halted = collectHaltedStoryIds(cp);
    assert.ok(halted.has(11));
    assert.ok(halted.has(12));
    assert.ok(!halted.has(0));
    assert.equal(halted.size, 2);
  });
});
