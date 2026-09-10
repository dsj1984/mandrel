/**
 * dependency-candidates.test.js — cross-plan footprint overlap (Story #5155).
 *
 * The load-bearing behaviours: overlap is computed on **declared footprints**
 * (so the planner sees the collision the wave runner would later enforce), and
 * a seed naming no paths costs **no provider round-trip** at all — the common
 * one-line seed must not pay for a backlog listing that could only return
 * nothing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findDependencyCandidates } from '../dependency-candidates.js';

/** A Story issue whose body declares a `## Changes` footprint. */
function storyIssue({ number, title = 'A Story', paths = [], state = 'open' }) {
  const changes = paths
    .map((p) => `- \`${p}\` — refactors-existing`)
    .join('\n');
  return {
    // The mapped ticket shape `listTicketsByLabel` returns: `id` is the issue
    // number. A raw REST payload would name the database id `id`, which is
    // exactly the confusion the declared read exists to remove.
    id: number,
    title,
    state,
    labels: ['type::story'],
    body: [
      '## Goal',
      '',
      'Do the thing.',
      '',
      '## Changes',
      '',
      changes,
      '',
      '## Acceptance',
      '',
      '- [ ] AC-1: it works',
      '',
      '## Verify',
      '',
      '- npm test (unit)',
      '',
    ].join('\n'),
  };
}

function providerDouble({ stories = [], listThrows = false } = {}) {
  const calls = { list: 0 };
  return {
    calls,
    listTicketsByLabel: async (args) => {
      calls.list++;
      if (listThrows) throw new Error('listing down');
      assert.equal(args.labels, 'type::story');
      return stories;
    },
  };
}

describe('findDependencyCandidates — overlap detection', () => {
  it('surfaces only Stories whose declared paths actually intersect', async () => {
    const provider = providerDouble({
      stories: [
        storyIssue({ number: 11, paths: ['src/a.js', 'src/b.js'] }),
        storyIssue({ number: 12, paths: ['docs/unrelated.md'] }),
      ],
    });

    const out = await findDependencyCandidates({
      predictedPaths: ['src/b.js'],
      provider,
    });

    assert.equal(out.length, 1);
    assert.equal(out[0].id, 11);
    assert.deepEqual(out[0].overlappingPaths, ['src/b.js']);
  });

  it('ranks the most entangled Story first, tie-breaking on id', async () => {
    const provider = providerDouble({
      stories: [
        storyIssue({ number: 30, paths: ['a.js'] }),
        storyIssue({ number: 20, paths: ['a.js', 'b.js'] }),
        storyIssue({ number: 10, paths: ['b.js'] }),
      ],
    });

    const out = await findDependencyCandidates({
      predictedPaths: ['a.js', 'b.js'],
      provider,
    });

    assert.deepEqual(
      out.map((c) => c.id),
      [20, 10, 30],
    );
  });

  it('excludes ids the caller already knows about', async () => {
    const provider = providerDouble({
      stories: [storyIssue({ number: 40, paths: ['a.js'] })],
    });

    const out = await findDependencyCandidates({
      predictedPaths: ['a.js'],
      provider,
      excludeIds: [40],
    });

    assert.deepEqual(out, []);
  });

  it('skips a Story with no declared footprint rather than guessing from prose', async () => {
    const provider = providerDouble({
      stories: [
        {
          number: 50,
          title: 'Prose only',
          state: 'open',
          body: 'Touches a.js somewhere.',
        },
      ],
    });

    assert.deepEqual(
      await findDependencyCandidates({ predictedPaths: ['a.js'], provider }),
      [],
    );
  });
});

describe('findDependencyCandidates — the no-op path', () => {
  it('returns [] WITHOUT a provider call when the seed named no paths', async () => {
    const provider = providerDouble({
      stories: [storyIssue({ number: 60, paths: ['a.js'] })],
    });

    assert.deepEqual(
      await findDependencyCandidates({ predictedPaths: [], provider }),
      [],
    );
    assert.equal(provider.calls.list, 0, 'no round-trip to buy nothing');

    assert.deepEqual(
      await findDependencyCandidates({ predictedPaths: ['  '], provider }),
      [],
    );
    assert.equal(provider.calls.list, 0);
  });

  it('degrades to [] when the listing fails', async () => {
    const provider = providerDouble({ listThrows: true });
    assert.deepEqual(
      await findDependencyCandidates({ predictedPaths: ['a.js'], provider }),
      [],
    );
  });

  it('degrades to [] with no listing surface at all', async () => {
    assert.deepEqual(
      await findDependencyCandidates({
        predictedPaths: ['a.js'],
        provider: {},
      }),
      [],
    );
  });
});
