// tests/lib/orchestration/epic-runner/phases/build-wave-dag.test.js
//
// Unit coverage for `discoverOpenStories` — the shared Story-enumeration
// contract behind the wave DAG, the snapshot payload, and the preflight
// Story count. Story #4246 adds the context-ticket exclusion so a context
// spec ticket can never be enumerated as a deliverable Story.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { discoverOpenStories } from '../../../../../.agents/scripts/lib/orchestration/epic-runner/phases/build-wave-dag.js';

function makeProvider(children) {
  return {
    async getSubTickets(_epicId) {
      return children;
    },
  };
}

describe('build-wave-dag — discoverOpenStories', () => {
  it('returns the open type::story children', async () => {
    const provider = makeProvider([
      { id: 11, labels: ['type::story'], state: 'open' },
      { id: 12, labels: ['type::story'], state: 'open' },
    ]);
    const stories = await discoverOpenStories({ epicId: 9, provider });
    assert.deepEqual(
      stories.map((s) => s.id),
      [11, 12],
    );
  });

  it('skips closed Stories', async () => {
    const provider = makeProvider([
      { id: 11, labels: ['type::story'], state: 'open' },
      { id: 12, labels: ['type::story'], state: 'closed' },
    ]);
    const stories = await discoverOpenStories({ epicId: 9, provider });
    assert.deepEqual(
      stories.map((s) => s.id),
      [11],
    );
  });

  it('excludes context spec tickets even when they carry type::story (Story #4246)', async () => {
    // A context ticket mislabelled with type::story must never reach a
    // delivery wave — it has no story branch or acceptance contract.
    const provider = makeProvider([
      {
        id: 14,
        labels: ['type::story', 'context::tech-spec'],
        state: 'open',
      },
      {
        id: 15,
        labels: ['type::story', 'context::acceptance-spec'],
        state: 'open',
      },
      { id: 16, labels: ['type::story'], state: 'open' },
    ]);
    const stories = await discoverOpenStories({ epicId: 9, provider });
    assert.deepEqual(
      stories.map((s) => s.id),
      [16],
    );
  });
});
