/**
 * resolve-stories-epic.test.js — Epic expansion at the delivery seam
 * (Story #5139).
 *
 * The most important test in this file is the last one: the `Epic: #N` footer
 * refusal must still fire. Container Epics were added *without* reviving that
 * footer, and the whole Story-only delivery invariant rests on it staying
 * refused — so a regression there is the failure mode this suite exists for.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { nativeChildReader } from '../../../resolve-stories.js';
import { expandEpicIds } from '../epic-expansion.js';
import { toStoryRecord } from '../resolve-stories.js';

/** Build a fake ticket. */
const story = (number, extra = {}) => ({
  number,
  labels: ['type::story'],
  state: 'open',
  body: '',
  ...extra,
});
const epic = (number, childIds, extra = {}) => ({
  number,
  labels: ['type::epic'],
  state: 'open',
  body: `## Goal\n\ng\n\n## Stories\n\n${childIds.map((c) => `- [ ] #${c}`).join('\n')}\n`,
  ...extra,
});

/** A `getTicket` over a fixed issue table. */
const tableGet = (issues) => async (id) => issues.get(id) ?? null;

describe('expandEpicIds', () => {
  it('leaves a plain Story id untouched', async () => {
    const issues = new Map([[10, story(10)]]);
    const out = await expandEpicIds({ ids: [10], getTicket: tableGet(issues) });
    assert.deepEqual(out.ids, [10]);
    assert.deepEqual(out.expansions, []);
  });

  it('expands an Epic to its open child Stories', async () => {
    const issues = new Map([
      [1, epic(1, [10, 11])],
      [10, story(10)],
      [11, story(11)],
    ]);
    const out = await expandEpicIds({ ids: [1], getTicket: tableGet(issues) });
    assert.deepEqual(out.ids, [10, 11]);
    assert.deepEqual(out.expansions, [{ epicId: 1, childIds: [10, 11] }]);
  });

  it('excludes a closed child and an agent::done child', async () => {
    const issues = new Map([
      [1, epic(1, [10, 11, 12])],
      [10, story(10)],
      [11, story(11, { state: 'closed' })],
      [12, story(12, { labels: ['type::story', 'agent::done'] })],
    ]);
    const out = await expandEpicIds({ ids: [1], getTicket: tableGet(issues) });
    assert.deepEqual(out.ids, [10], 'only the still-open child survives');
  });

  it('mixes Epic and Story ids into a deduped union in first-seen order', async () => {
    const issues = new Map([
      [1, epic(1, [10, 11])],
      [10, story(10)],
      [11, story(11)],
      [20, story(20)],
    ]);
    const out = await expandEpicIds({
      ids: [20, 1, 10],
      getTicket: tableGet(issues),
    });
    assert.deepEqual(out.ids, [20, 10, 11], '#10 must not appear twice');
  });

  it('unions native sub-issue edges with the body checklist', async () => {
    const issues = new Map([
      [1, epic(1, [10])],
      [10, story(10)],
      [11, story(11)],
    ]);
    const out = await expandEpicIds({
      ids: [1],
      getTicket: tableGet(issues),
      readNativeChildIds: async () => [11],
    });
    assert.deepEqual(out.ids.sort(), [10, 11]);
  });

  it('skips a non-Story child with a warning instead of wedging the run', async () => {
    const warnings = [];
    const issues = new Map([
      [1, epic(1, [10, 99])],
      [10, story(10)],
      [99, { number: 99, labels: ['type::chore'], state: 'open' }],
    ]);
    const out = await expandEpicIds({
      ids: [1],
      getTicket: tableGet(issues),
      warn: (m) => warnings.push(m),
    });
    assert.deepEqual(out.ids, [10]);
    assert.match(warnings.join('\n'), /child #99 is not a type::story/);
  });

  it('skips an unreadable child rather than failing the whole expansion', async () => {
    const warnings = [];
    const issues = new Map([
      [1, epic(1, [10, 66])],
      [10, story(10)],
    ]);
    const getTicket = async (id) => {
      if (id === 66) throw new Error('403 forbidden');
      return issues.get(id) ?? null;
    };
    const out = await expandEpicIds({
      ids: [1],
      getTicket,
      warn: (m) => warnings.push(m),
    });
    assert.deepEqual(out.ids, [10]);
    assert.match(warnings.join('\n'), /could not read child #66/);
  });

  it('errors — never returns empty — for an Epic that lists no children', async () => {
    const issues = new Map([[1, epic(1, [])]]);
    await assert.rejects(
      () => expandEpicIds({ ids: [1], getTicket: tableGet(issues) }),
      /Epic #1 lists no child Stories/,
    );
  });

  it('distinguishes a degraded read from a genuinely empty container (Story #5210)', async () => {
    const issues = new Map([[1, epic(1, [])]]);

    await assert.rejects(
      () =>
        expandEpicIds({
          ids: [1],
          getTicket: tableGet(issues),
          readNativeChildIds: async () => {
            throw new Error('gh-exec: gh exited with code 1');
          },
        }),
      /incomplete, not empty/,
      'telling an operator to link Stories that ARE linked sends them the wrong way',
    );
  });

  it('errors when every child has already landed', async () => {
    const issues = new Map([
      [1, epic(1, [10])],
      [10, story(10, { state: 'closed' })],
    ]);
    await assert.rejects(
      () => expandEpicIds({ ids: [1], getTicket: tableGet(issues) }),
      /none are still open/,
    );
  });

  it('errors on an id that does not resolve to an issue', async () => {
    await assert.rejects(
      () => expandEpicIds({ ids: [404], getTicket: async () => null }),
      /Issue #404 was not found/,
    );
  });
});

describe('the Epic: #N refusal survives container Epics', () => {
  it('still hard-errors on a Story body carrying the v1 footer', () => {
    assert.throws(
      () =>
        toStoryRecord(
          { number: 10, labels: ['type::story'], body: 'Epic: #4001\n' },
          10,
        ),
      /still carries an "Epic: #4001" footer/,
      'container Epics must NOT revive the child→parent footer',
    );
  });

  it('still hard-errors on a named non-Story id', () => {
    assert.throws(
      () => toStoryRecord({ number: 1, labels: ['type::epic'] }, 1),
      /is not a Story/,
      'a named Epic reaching toStoryRecord is a bug — expansion runs first',
    );
  });
});

describe("nativeChildReader — the expansion path's native reader", () => {
  /** A provider double that records the node id it was called with. */
  const recordingProvider = (childIds = [11, 12]) => {
    const calls = [];
    return {
      calls,
      _getNativeSubIssues: async (parentNodeId, parentId) => {
        calls.push({ parentNodeId, parentId });
        if (typeof parentNodeId !== 'string' || parentNodeId === '') {
          throw new Error(
            'gh: Variable $id of type ID! was provided invalid value',
          );
        }
        return childIds;
      },
    };
  };

  it('resolves the node id under either casing', async () => {
    for (const source of [{ nodeId: 'I_x' }, { node_id: 'I_x' }]) {
      const provider = recordingProvider();
      const ids = await nativeChildReader(provider)({ ...source, number: 90 });
      assert.deepEqual(ids, [11, 12]);
      assert.deepEqual(provider.calls, [{ parentNodeId: 'I_x', parentId: 90 }]);
    }
  });

  it('no-ops without calling the API when no node id resolves', async () => {
    const provider = recordingProvider();
    assert.deepEqual(await nativeChildReader(provider)({ number: 90 }), []);
    assert.deepEqual(provider.calls, []);
  });

  it('yields [] for a provider without the GraphQL surface', async () => {
    assert.deepEqual(await nativeChildReader({})({ node_id: 'I_x' }), []);
  });
});
