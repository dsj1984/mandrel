/**
 * Unit tests for the container-Epic rollup (Story #5205).
 *
 * The rollup is the only writer to a container Epic, so these tests police
 * both what it writes and — just as load-bearing — what it must never write:
 * an `agent::*` label on the container, or an issue-state write reopening one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rollUpEpicForStory } from '../../../.agents/scripts/lib/orchestration/epic-rollup.js';

/** A column sync that records every push instead of touching a board. */
function fakeColumnSync(status = 'synced') {
  const calls = [];
  return {
    calls,
    setColumn: async (issueId, column) => {
      calls.push({ issueId, column });
      return status === 'synced'
        ? { status: 'synced', column }
        : { status: 'skipped', reason: status };
    },
  };
}

/**
 * A container Epic whose children live in the body checklist.
 *
 * The node id is **snake_case on purpose**: the rollup reaches these objects
 * through `listIssuesByLabel`, which returns the REST payload verbatim, so
 * `node_id` — not the mapped `nodeId` — is the shape production actually
 * hands the native reader (Story #5251). Pass `{ node_id: null }` for an Epic
 * with no resolvable id.
 *
 * @param {number} number
 * @param {number[]} childIds
 * @param {{ state?: string, assignees?: unknown[], node_id?: string|null }} [extra]
 */
function container(number, childIds, extra = {}) {
  return {
    number,
    node_id: `I_epic_${number}`,
    labels: ['type::epic'],
    state: 'open',
    body: `## Goal\n\nGroup them.\n\n## Stories\n\n${childIds
      .map((c) => `- [ ] #${c}`)
      .join('\n')}\n`,
    ...extra,
  };
}

/**
 * A child Story at a given lifecycle label.
 *
 * @param {number} id
 * @param {string|null} agentLabel
 * @param {string} [state]
 */
function child(id, agentLabel, state = 'open') {
  return {
    id,
    number: id,
    title: `Story ${id}`,
    body: '',
    labels: agentLabel ? ['type::story', agentLabel] : ['type::story'],
    state,
  };
}

/**
 * Provider double. `epics` is what the open-`type::epic` listing returns;
 * `tickets` is the child lookup; every write lands in `updates`.
 */
function fakeProvider({
  epics = [],
  children = [],
  nativeChildren,
  nativeChildrenError,
} = {}) {
  const byId = new Map(children.map((c) => [Number(c.number), c]));
  const updates = [];
  const nativeCalls = [];
  const provider = {
    updates,
    nativeCalls,
    listIssuesByLabel: async ({ labels }) =>
      labels === 'type::epic' ? epics : [],
    getTicket: async (id) => byId.get(Number(id)) ?? null,
    updateTicket: async (id, mutations) => {
      updates.push({ id, mutations });
    },
  };
  // The double reads its arguments. An earlier version answered
  // `async () => nativeChildren`, which is precisely why a reader passing
  // `undefined` as the node id for every Epic went unnoticed until a consumer
  // hit it in production (Story #5251). Reject a missing id the way the live
  // GraphQL surface does — `$id: ID!` will not take one.
  const recordCall = (parentNodeId, parentId) => {
    nativeCalls.push({ parentNodeId, parentId });
    if (typeof parentNodeId !== 'string' || parentNodeId === '') {
      throw new Error(
        `gh: Variable $id of type ID! was provided invalid value ${String(parentNodeId)}`,
      );
    }
  };
  if (nativeChildrenError) {
    provider._getNativeSubIssues = async (parentNodeId, parentId) => {
      recordCall(parentNodeId, parentId);
      throw nativeChildrenError;
    };
  } else if (nativeChildren) {
    provider._getNativeSubIssues = async (parentNodeId, parentId) => {
      recordCall(parentNodeId, parentId);
      return nativeChildren;
    };
  }
  return provider;
}

describe('rollUpEpicForStory — status derived from the children', () => {
  it('moves the Epic to In Progress and records the owner when a child starts', async () => {
    const provider = fakeProvider({
      epics: [container(90, [1, 2])],
      children: [child(1, 'agent::executing'), child(2, 'agent::ready')],
    });
    const columnSync = fakeColumnSync();

    const result = await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: { github: { operatorHandle: '@dsj1984' } },
      columnSync,
    });

    assert.deepEqual(columnSync.calls, [
      { issueId: 90, column: 'In Progress' },
    ]);
    assert.deepEqual(provider.updates, [
      { id: 90, mutations: { addAssignees: ['dsj1984'] } },
    ]);
    assert.equal(result.epics[0].assigned, true);
    assert.deepEqual(result.closed, []);
    assert.deepEqual(result.pending, [90]);
  });

  it('closes the Epic as completed and marks it Done once every child landed', async () => {
    const provider = fakeProvider({
      epics: [container(90, [1, 2])],
      children: [child(1, 'agent::done'), child(2, null, 'closed')],
    });
    const columnSync = fakeColumnSync();

    const result = await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: {},
      columnSync,
    });

    assert.deepEqual(columnSync.calls, [{ issueId: 90, column: 'Done' }]);
    assert.deepEqual(provider.updates, [
      { id: 90, mutations: { state: 'closed', state_reason: 'completed' } },
    ]);
    assert.deepEqual(result.closed, [90]);
    assert.deepEqual(result.pending, []);
  });

  it('leaves an Epic with an outstanding child open and reports it pending', async () => {
    const provider = fakeProvider({
      epics: [container(90, [1, 2, 3])],
      children: [
        child(1, 'agent::done'),
        child(2, 'agent::done'),
        child(3, 'agent::ready'),
      ],
    });

    const result = await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: {},
      columnSync: fakeColumnSync(),
    });

    assert.deepEqual(result.closed, []);
    assert.deepEqual(result.pending, [90]);
    assert.equal(provider.updates.length, 0, 'a pending Epic takes no write');
  });

  it('surfaces a blocked child as In Progress and keeps the owner on the Epic', async () => {
    const provider = fakeProvider({
      epics: [container(90, [1])],
      children: [child(1, 'agent::blocked')],
    });
    const columnSync = fakeColumnSync();

    await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: { github: { operatorHandle: 'dsj1984' } },
      columnSync,
    });

    assert.deepEqual(columnSync.calls, [
      { issueId: 90, column: 'In Progress' },
    ]);
    assert.deepEqual(provider.updates, [
      { id: 90, mutations: { addAssignees: ['dsj1984'] } },
    ]);
  });
});

describe('rollUpEpicForStory — the container invariants', () => {
  it('never writes an agent:: label on the Epic across a full child lifecycle', async () => {
    for (const label of [
      'agent::ready',
      'agent::executing',
      'agent::closing',
      'agent::blocked',
      'agent::done',
    ]) {
      const provider = fakeProvider({
        epics: [container(90, [1])],
        children: [child(1, label)],
      });
      await rollUpEpicForStory({
        storyId: 1,
        provider,
        config: { github: { operatorHandle: 'dsj1984' } },
        columnSync: fakeColumnSync(),
      });
      for (const { mutations } of provider.updates) {
        assert.equal(
          JSON.stringify(mutations).includes('agent::'),
          false,
          `a container must never be labelled (child at ${label})`,
        );
      }
    }
  });

  it('recomputes a closed Epic back to In Progress without reopening it', async () => {
    const provider = fakeProvider({
      epics: [container(90, [1, 2], { state: 'closed' })],
      children: [child(1, 'agent::executing'), child(2, 'agent::done')],
    });
    const columnSync = fakeColumnSync();

    const result = await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: {},
      columnSync,
    });

    assert.deepEqual(columnSync.calls, [
      { issueId: 90, column: 'In Progress' },
    ]);
    assert.equal(
      provider.updates.some((u) => 'state' in u.mutations),
      false,
      'closure is one-way — a reopened child never reopens the container',
    );
    assert.deepEqual(result.pending, [], 'a closed Epic is not pending');
  });

  it('does not re-close an already-closed Epic whose children all landed', async () => {
    const provider = fakeProvider({
      epics: [container(90, [1], { state: 'closed' })],
      children: [child(1, 'agent::done')],
    });

    const result = await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: {},
      columnSync: fakeColumnSync(),
    });

    assert.deepEqual(result.closed, []);
    assert.equal(provider.updates.length, 0);
  });

  it('does not re-add an owner the Epic already carries', async () => {
    const provider = fakeProvider({
      epics: [container(90, [1], { assignees: [{ login: 'dsj1984' }] })],
      children: [child(1, 'agent::executing')],
    });

    await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: { github: { operatorHandle: '@dsj1984' } },
      columnSync: fakeColumnSync(),
    });

    assert.equal(provider.updates.length, 0, 'the assign is idempotent');
  });
});

describe('rollUpEpicForStory — child discovery', () => {
  it('rolls up an Epic whose children are only native sub-issues', async () => {
    // The body checklist is empty — the children exist solely as GitHub
    // sub-issue edges, the shape that used to be expandable but unclosable.
    const provider = fakeProvider({
      epics: [container(90, [])],
      children: [child(1, 'agent::done'), child(2, 'agent::done')],
      nativeChildren: [1, 2],
    });

    const result = await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: {},
      columnSync: fakeColumnSync(),
    });

    assert.deepEqual(result.closed, [90]);
    assert.deepEqual(provider.updates, [
      { id: 90, mutations: { state: 'closed', state_reason: 'completed' } },
    ]);
  });

  it('reaches the native read with the raw REST `node_id` listIssuesByLabel returns', async () => {
    // The regression this file exists to pin (Story #5251): the rollup's
    // Epics come straight from `listIssuesByLabel`, which does NOT run
    // through `issueToTicket`, so they carry `node_id` and never `nodeId`.
    // Reading the camelCase name alone sent `undefined` to `$id: ID!`, which
    // GitHub rejects as a `permanent` error — so every Epic silently fell
    // back to its body checklist while reporting an API failure.
    const provider = fakeProvider({
      epics: [container(90, [])],
      children: [child(1, 'agent::done'), child(2, 'agent::done')],
      nativeChildren: [1, 2],
    });

    const result = await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: {},
      columnSync: fakeColumnSync(),
    });

    assert.deepEqual(provider.nativeCalls, [
      { parentNodeId: 'I_epic_90', parentId: 90 },
    ]);
    assert.deepEqual(result.closed, [90], 'the native children were read');
    assert.equal(result.epics[0].detail, null, 'the read did not degrade');
  });

  it("reaches the native read with a mapped ticket's camelCase `nodeId`", async () => {
    // The other half of the contract: `resolve-stories.js` feeds its reader
    // `getTicket` output, which IS mapped. Both casings must resolve, or
    // fixing one path breaks the other.
    const epic = container(90, [], { node_id: undefined });
    epic.nodeId = 'I_epic_mapped_90';
    const provider = fakeProvider({
      epics: [epic],
      children: [child(1, 'agent::done'), child(2, 'agent::done')],
      nativeChildren: [1, 2],
    });

    const result = await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: {},
      columnSync: fakeColumnSync(),
    });

    assert.deepEqual(provider.nativeCalls, [
      { parentNodeId: 'I_epic_mapped_90', parentId: 90 },
    ]);
    assert.deepEqual(result.closed, [90]);
  });

  it('skips the native read entirely when no node id resolves', async () => {
    // A missing id is a clean no-op, not a manufactured API error: the
    // checklist still carries the children, and nothing is reported as
    // degraded because no read was attempted.
    const provider = fakeProvider({
      epics: [container(90, [1, 2], { node_id: null })],
      children: [child(1, 'agent::done'), child(2, 'agent::done')],
      nativeChildren: [1, 2],
    });

    const result = await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: {},
      columnSync: fakeColumnSync(),
    });

    assert.deepEqual(provider.nativeCalls, [], 'the API was never called');
    assert.deepEqual(result.closed, [90], 'the checklist carried the children');
    assert.equal(
      result.epics[0].detail,
      null,
      'a skipped read is not a degraded read',
    );
  });

  it('ignores an Epic that does not list this Story', async () => {
    const provider = fakeProvider({
      epics: [container(91, [7, 8])],
      children: [child(7, 'agent::done'), child(8, 'agent::done')],
    });

    const result = await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: {},
      columnSync: fakeColumnSync(),
    });

    assert.equal(result.reason, 'no-container-epic');
    assert.equal(provider.updates.length, 0);
  });

  it('leaves the Epic untouched when a child cannot be read', async () => {
    const provider = fakeProvider({
      epics: [container(90, [1, 2])],
      children: [child(1, 'agent::done')],
    });
    provider.getTicket = async (id) => {
      if (Number(id) === 2) throw new Error('403 forbidden');
      return child(1, 'agent::done');
    };

    const result = await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: {},
      columnSync: fakeColumnSync(),
    });

    assert.deepEqual(result.pending, [90], 'unknown never means "landed"');
    assert.equal(result.epics[0].detail, 'child-read-failed');
    assert.equal(provider.updates.length, 0);
  });
});

describe('rollUpEpicForStory — a degraded child read never closes (Story #5210)', () => {
  /**
   * The incident shape, reduced. Container #1891 had 58 native sub-issues, 23
   * of them open. The GraphQL read threw a status-less `gh exited with code 1`,
   * the reader degraded to the body checklist, and the checklist's only rows in
   * the then-supported bare form were the three Stories that had just landed —
   * so "every child Story landed" was true of the list and false of the Epic.
   */
  function incident() {
    return fakeProvider({
      // The body names only the landed Story; the 23 open siblings exist
      // solely as native sub-issue edges the failing read would have returned.
      epics: [container(1891, [2350])],
      children: [child(2350, 'agent::done')],
      nativeChildrenError: Object.assign(
        new Error('gh-exec: gh exited with code 1'),
        { stderr: 'HTTP 403: You have exceeded a secondary rate limit' },
      ),
    });
  }

  it('leaves the Epic OPEN when the authoritative read failed', async () => {
    const provider = incident();

    const result = await rollUpEpicForStory({
      storyId: 2350,
      provider,
      config: {},
      columnSync: fakeColumnSync(),
    });

    assert.equal(
      provider.updates.some((u) => u.mutations?.state === 'closed'),
      false,
      'closure is the one write that cannot be undone next tick',
    );
    assert.deepEqual(result.closed, []);
    assert.deepEqual(result.pending, [1891]);
    assert.equal(result.epics[0].closed, false);
    assert.equal(result.epics[0].detail, 'child-read-degraded');
  });

  it('still applies the recoverable writes — a blip costs no board accuracy', async () => {
    const provider = fakeProvider({
      epics: [container(1891, [2350])],
      children: [child(2350, 'agent::executing')],
      nativeChildrenError: new Error('gh-exec: gh exited with code 1'),
    });
    const columnSync = fakeColumnSync();

    const result = await rollUpEpicForStory({
      storyId: 2350,
      provider,
      config: { github: { operatorHandle: '@dsj1984' } },
      columnSync,
    });

    assert.deepEqual(columnSync.calls, [
      { issueId: 1891, column: 'In Progress' },
    ]);
    assert.deepEqual(provider.updates, [
      { id: 1891, mutations: { addAssignees: ['dsj1984'] } },
    ]);
    assert.equal(result.epics[0].assigned, true);
  });

  it('applies the Done column but withholds only the close', async () => {
    const provider = incident();
    const columnSync = fakeColumnSync();

    const result = await rollUpEpicForStory({
      storyId: 2350,
      provider,
      config: {},
      columnSync,
    });

    assert.deepEqual(
      columnSync.calls,
      [{ issueId: 1891, column: 'Done' }],
      'Status recomputes next tick, so a possibly-stale column is acceptable',
    );
    assert.equal(result.epics[0].column, 'Done');
  });

  it('reports the degrade even when a board write also failed', async () => {
    const provider = incident();

    const result = await rollUpEpicForStory({
      storyId: 2350,
      provider,
      config: {},
      columnSync: fakeColumnSync('no-board-item'),
    });

    assert.equal(
      result.epics[0].detail,
      'child-read-degraded',
      'the reason the Epic is still open must not be masked by a column detail',
    );
  });

  it('closes exactly as before when the authoritative read SUCCEEDS', async () => {
    const provider = fakeProvider({
      epics: [container(1891, [2350])],
      children: [child(2350, 'agent::done')],
      nativeChildren: [2350],
    });

    const result = await rollUpEpicForStory({
      storyId: 2350,
      provider,
      config: {},
      columnSync: fakeColumnSync(),
    });

    assert.deepEqual(result.closed, [1891], 'the guard must not be a blanket');
    assert.equal(result.epics[0].detail, null);
  });

  it('does not re-close an already-closed Epic on a degraded read', async () => {
    const provider = fakeProvider({
      epics: [container(1891, [2350], { state: 'closed' })],
      children: [child(2350, 'agent::done')],
      nativeChildrenError: new Error('gh-exec: gh exited with code 1'),
    });

    const result = await rollUpEpicForStory({
      storyId: 2350,
      provider,
      config: {},
      columnSync: fakeColumnSync(),
    });

    assert.deepEqual(result.pending, [], 'a closed container is not pending');
    assert.equal(provider.updates.length, 0);
  });
});

describe('rollUpEpicForStory — degradation', () => {
  it('never throws when every provider call rejects', async () => {
    const boom = async () => {
      throw new Error('network down');
    };
    const result = await rollUpEpicForStory({
      storyId: 1,
      provider: {
        listIssuesByLabel: boom,
        getTicket: boom,
        updateTicket: boom,
      },
      config: {},
    });
    assert.deepEqual(result.epics, []);
    assert.equal(result.reason, 'no-container-epic');
  });

  it('reports the Epic pending when the close write is refused', async () => {
    const provider = fakeProvider({
      epics: [container(90, [1])],
      children: [child(1, 'agent::done')],
    });
    provider.updateTicket = async () => {
      throw new Error('422 unprocessable');
    };

    const result = await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: {},
      columnSync: fakeColumnSync(),
    });

    assert.deepEqual(result.closed, []);
    assert.deepEqual(result.pending, [90]);
    assert.match(result.epics[0].detail, /422/);
  });

  it('records a refused board mutation without failing the rollup', async () => {
    const provider = fakeProvider({
      epics: [container(90, [1])],
      children: [child(1, 'agent::done')],
    });

    const result = await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: {},
      columnSync: fakeColumnSync('not-on-project'),
    });

    assert.deepEqual(result.closed, [90], 'the close still happens');
    assert.equal(result.epics[0].column, null);
  });

  it('refuses a provider missing the surface it needs', async () => {
    const result = await rollUpEpicForStory({
      storyId: 1,
      provider: { getTicket: async () => null },
      config: {},
    });
    assert.equal(result.reason, 'provider-unsupported');
  });

  it('refuses a non-positive Story id', async () => {
    const result = await rollUpEpicForStory({
      storyId: 0,
      provider: fakeProvider(),
      config: {},
    });
    assert.equal(result.reason, 'invalid-story-id');
  });
});

describe('rollUpEpicForStory — owner resolution', () => {
  it('strips a leading @ so the assignees API gets a bare login', async () => {
    const provider = fakeProvider({
      epics: [container(90, [1])],
      children: [child(1, 'agent::executing')],
    });

    await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: { github: { operatorHandle: '@dsj1984' } },
      columnSync: fakeColumnSync(),
    });

    assert.deepEqual(provider.updates, [
      { id: 90, mutations: { addAssignees: ['dsj1984'] } },
    ]);
  });

  it('records no owner rather than throwing when none is configured', async () => {
    for (const config of [{}, { github: { operatorHandle: '@[USERNAME]' } }]) {
      const provider = fakeProvider({
        epics: [container(90, [1])],
        children: [child(1, 'agent::executing')],
      });

      const result = await rollUpEpicForStory({
        storyId: 1,
        provider,
        config,
        columnSync: fakeColumnSync(),
      });

      assert.equal(
        provider.updates.length,
        0,
        'the shipped placeholder is not an owner',
      );
      assert.equal(result.epics[0].detail, 'no-operator-handle');
    }
  });
});
