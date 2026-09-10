/**
 * Unit tests for the container-Epic rollup (Story #5205).
 *
 * The rollup is the only writer to a container Epic, so these tests police
 * both what it writes and — just as load-bearing — what it must never write:
 * an `agent::*` label on the container, or an issue-state write reopening one.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { rollUpEpicForStory } from '../../../.agents/scripts/lib/orchestration/epic-rollup.js';

const SCRIPTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../.agents/scripts',
);
const readScript = (rel) => readFileSync(path.join(SCRIPTS, rel), 'utf8');

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
 * The **mapped** ticket shape (Story #5280): the rollup now reaches every Epic
 * through `listTicketsByLabel` or `getParentIssue`, both of which map their
 * payload, so `id` is the issue number and the node id is `nodeId`. The raw
 * REST shape this fixture used to mimic — `number` plus `node_id` — is exactly
 * what the declared read exists to keep out of consumer modules; a fixture
 * still producing it would be testing a shape production can no longer hand
 * them (Story #5251 arrived at from the other side).
 *
 * Pass `{ nodeId: null }` for an Epic with no resolvable id.
 *
 * @param {number} id
 * @param {number[]} childIds
 * @param {{ state?: string, assignees?: unknown[], nodeId?: string|null }} [extra]
 */
function container(id, childIds, extra = {}) {
  return {
    id,
    nodeId: `I_epic_${id}`,
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
 * @param {string[]} [extraLabels]
 */
function child(id, agentLabel, state = 'open', extraLabels = []) {
  return {
    id,
    title: `Story ${id}`,
    body: '',
    labels: [
      'type::story',
      ...(agentLabel ? [agentLabel] : []),
      ...extraLabels,
    ],
    state,
  };
}

/**
 * Provider double.
 *
 * `epics` is what the `type::epic` listing returns; `parent` (when given) is
 * what the one-call parent lookup answers, and its presence is what selects
 * the native path over the scan. `children` is the child lookup; every write
 * lands in `updates`; every read is counted in `calls` so a test can assert
 * how many round-trips a rollup actually spends.
 */
function fakeProvider({
  epics = [],
  children = [],
  parent = null,
  parentError,
  nativeChildren,
  nativeChildrenError,
  missingChildIds = [],
} = {}) {
  const byId = new Map(children.map((c) => [Number(c.id), c]));
  const missing = new Set(missingChildIds.map(Number));
  const updates = [];
  const nativeCalls = [];
  const calls = { listTicketsByLabel: 0, getParentIssue: 0, getTicket: 0 };
  let inFlight = 0;
  let maxInFlight = 0;
  const provider = {
    updates,
    nativeCalls,
    calls,
    get maxInFlight() {
      return maxInFlight;
    },
    listTicketsByLabel: async ({ state, labels }) => {
      calls.listTicketsByLabel++;
      // The double refuses a listing whose `state` it was not told to honour.
      // A rollup asking "did a child reopen under a container I closed?" gets
      // a wrong answer, not a partial one, from an open-only listing — so a
      // caller that forgets the filter must fail here rather than silently
      // pass every test that happens to use only open Epics.
      if (state !== 'open' && state !== 'closed' && state !== 'all') {
        throw new Error(
          `listTicketsByLabel: unhonoured state filter ${String(state)}`,
        );
      }
      if (labels !== 'type::epic') return [];
      return state === 'all'
        ? epics
        : epics.filter((e) => (e.state ?? 'open') === state);
    },
    getTicket: async (id) => {
      calls.getTicket++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        // Yield twice so overlapping reads are actually observable — a mapper
        // that never awaits would report a max of 1 whatever the cap is.
        await Promise.resolve();
        await Promise.resolve();
        if (missing.has(Number(id))) return null;
        return byId.get(Number(id)) ?? null;
      } finally {
        inFlight--;
      }
    },
    updateTicket: async (id, mutations) => {
      updates.push({ id, mutations });
    },
  };
  if (parentError) {
    provider.getParentIssue = async () => {
      calls.getParentIssue++;
      throw parentError;
    };
  } else if (parent !== null) {
    provider.getParentIssue = async (storyId) => {
      calls.getParentIssue++;
      return typeof parent === 'function' ? parent(storyId) : parent;
    };
  }
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
    provider.getNativeSubIssues = async (parentNodeId, parentId) => {
      recordCall(parentNodeId, parentId);
      throw nativeChildrenError;
    };
  } else if (nativeChildren) {
    provider.getNativeSubIssues = async (parentNodeId, parentId) => {
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

describe('rollUpEpicForStory — a closed child carries no agent state (Story #5255)', () => {
  it('closes a container whose only blocked child was closed as superseded', async () => {
    // The reported shape: a Story hit `agent::blocked`, was re-planned, and
    // `plan-persist` closed it as superseded with the label still attached.
    // Every child then landed, the body checklist ticked through — and the
    // epilogue reported `{ closed: [], pending: [epicId] }` on every run,
    // indistinguishable from a child still in flight.
    const provider = fakeProvider({
      epics: [container(90, [1, 2, 3])],
      children: [
        child(1, 'agent::done'),
        child(2, 'agent::blocked', 'closed'),
        child(3, 'agent::done'),
      ],
    });
    const columnSync = fakeColumnSync();

    const result = await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: {},
      columnSync,
    });

    assert.deepEqual(result.closed, [90]);
    assert.deepEqual(result.pending, []);
    assert.deepEqual(columnSync.calls, [{ issueId: 90, column: 'Done' }]);
    assert.deepEqual(provider.updates, [
      { id: 90, mutations: { state: 'closed', state_reason: 'completed' } },
    ]);
  });

  it('still holds the container open — and owned — for an OPEN blocked child', async () => {
    const provider = fakeProvider({
      epics: [container(90, [1, 2])],
      children: [child(1, 'agent::done'), child(2, 'agent::blocked')],
    });
    const columnSync = fakeColumnSync();

    const result = await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: { github: { operatorHandle: '@dsj1984' } },
      columnSync,
    });

    assert.deepEqual(result.closed, []);
    assert.deepEqual(result.pending, [90]);
    // The HITL signal is intact: an open blocked child keeps the Epic in
    // `IN_FLIGHT_STATES`, so someone stays named on it.
    assert.deepEqual(provider.updates, [
      { id: 90, mutations: { addAssignees: ['dsj1984'] } },
    ]);
    assert.deepEqual(columnSync.calls, [
      { issueId: 90, column: 'In Progress' },
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

  it('reaches the native read with a raw REST `node_id`, whatever produced it', async () => {
    // The regression this file exists to pin (Story #5251): the rollup's
    // Epics used to come straight from `listIssuesByLabel`, which does NOT run
    // through `issueToTicket`, so they carried `node_id` and never `nodeId`.
    // Reading the camelCase name alone sent `undefined` to `$id: ID!`, which
    // GitHub rejects as a `permanent` error — so every Epic silently fell
    // back to its body checklist while reporting an API failure.
    //
    // The declared read has since removed the *source* of that divergence, but
    // the shared reader still accepts both casings for the expansion path, and
    // this pins that it does: fixing one caller must not break the other.
    const epic = container(90, []);
    epic.node_id = epic.nodeId;
    delete epic.nodeId;
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
      { parentNodeId: 'I_epic_90', parentId: 90 },
    ]);
    assert.deepEqual(result.closed, [90], 'the native children were read');
    assert.equal(result.epics[0].detail, null, 'the read did not degrade');
  });

  it("reaches the native read with a mapped ticket's camelCase `nodeId`", async () => {
    // The other half of the contract, and now the shape every rollup read
    // produces: both `listTicketsByLabel` and `getParentIssue` map their
    // payload, and `resolve-stories.js` feeds the same reader `getTicket`
    // output. Both casings must resolve, or fixing one path breaks the other.
    const epic = container(90, [], { nodeId: 'I_epic_mapped_90' });
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
      epics: [container(90, [1, 2], { nodeId: null })],
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
        listTicketsByLabel: boom,
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

describe('rollUpEpicForStory — the parent resolves in one call (Story #5280)', () => {
  it('spends one getParentIssue and never lists Epics at all', async () => {
    // The lookup used to be a search: list every open `type::epic`, read each
    // one's children, keep the one that mentions this Story. That is
    // O(containers) round-trips to answer a question the sub-issue edge
    // answers directly, and all but one of the reads was discarded.
    const provider = fakeProvider({
      parent: container(90, [1, 2]),
      children: [child(1, 'agent::executing'), child(2, 'agent::ready')],
      nativeChildren: [1, 2],
    });

    const result = await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: {},
      columnSync: fakeColumnSync(),
    });

    assert.equal(result.epics[0].epicId, 90);
    assert.equal(provider.calls.getParentIssue, 1, 'exactly one parent read');
    assert.equal(
      provider.calls.listTicketsByLabel,
      0,
      'the native edge answered, so nothing is scanned',
    );
    assert.deepEqual(
      provider.nativeCalls,
      [{ parentNodeId: 'I_epic_90', parentId: 90 }],
      "only the resolved Epic's own sub-issue tree is walked",
    );
  });

  it('rolls up a parent the scan would never have found, because it is closed', async () => {
    // The native edge outlives the container's state, so a reopened child of a
    // closed Epic is reachable in one call.
    const provider = fakeProvider({
      parent: container(90, [1], { state: 'closed' }),
      children: [child(1, 'agent::executing')],
    });
    const columnSync = fakeColumnSync();

    await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: {},
      columnSync,
    });

    assert.deepEqual(columnSync.calls, [
      { issueId: 90, column: 'In Progress' },
    ]);
  });

  it('falls back to the scan when the Story has no native parent edge', async () => {
    // Linkage can legitimately be a checklist row with no sub-issue edge
    // behind it — an operator typing `- [ ] #123` into the body by hand.
    const provider = fakeProvider({
      parent: async () => null,
      epics: [container(90, [1])],
      children: [child(1, 'agent::executing')],
    });

    const result = await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: {},
      columnSync: fakeColumnSync(),
    });

    assert.equal(result.epics[0].epicId, 90);
    assert.equal(provider.calls.listTicketsByLabel, 1);
  });

  it('falls back to the scan when the parent lookup itself fails', async () => {
    const provider = fakeProvider({
      parentError: new Error('HTTP 502'),
      epics: [container(90, [1])],
      children: [child(1, 'agent::executing')],
    });

    const result = await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: {},
      columnSync: fakeColumnSync(),
    });

    assert.equal(result.epics[0].epicId, 90, 'the scan covered the degrade');
  });

  it('ignores a native parent that is not a container Epic', async () => {
    const provider = fakeProvider({
      parent: { id: 77, labels: ['type::story'], state: 'open', body: '' },
      epics: [],
      children: [child(1, 'agent::executing')],
    });

    const result = await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: {},
      columnSync: fakeColumnSync(),
    });

    assert.equal(result.reason, 'no-container-epic');
  });
});

describe('rollUpEpicForStory — a reopened child pulls a closed Epic back', () => {
  it('moves the closed container to In Progress without reopening the issue', async () => {
    // The scan path, because the double exposes no `getParentIssue` — which is
    // what puts the `state` filter under test. With `state: 'open'` the closed
    // container is not in the listing at all, so the Status correction this
    // module has always promised was unreachable and the `isClosed(epic)`
    // branches downstream were dead code.
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
      provider.updates.some((u) => u.mutations.state !== undefined),
      false,
      'closure is one-way — an operator who closed a container is not overruled',
    );
    assert.deepEqual(
      result.pending,
      [],
      'a closed container with live work is corrected, not reported pending',
    );
  });

  it('refuses a listing whose state filter the provider did not honour', async () => {
    // Guards the guard: the double throws on an unrecognised `state`, so this
    // asserts the double is actually policing the filter rather than ignoring
    // it — otherwise the test above would pass on a caller that sent none.
    const provider = fakeProvider({ epics: [container(90, [1])] });
    await assert.rejects(
      () => provider.listTicketsByLabel({ labels: 'type::epic' }),
      /unhonoured state filter/,
    );
  });
});

describe('rollUpEpicForStory — bounded child reads', () => {
  it('keeps at most FETCH_CONCURRENCY reads in flight', async () => {
    const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const provider = fakeProvider({
      parent: container(90, ids),
      children: ids.map((id) => child(id, 'agent::done')),
    });

    await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: {},
      columnSync: fakeColumnSync(),
    });

    assert.equal(provider.calls.getTicket, ids.length, 'every child was read');
    assert.equal(
      provider.maxInFlight,
      5,
      'the fan-out saturates the cap and never exceeds it',
    );
  });

  it('rejects the whole batch on the first child read that throws', async () => {
    const ids = [1, 2, 3, 4, 5, 6, 7, 8];
    const provider = fakeProvider({
      parent: container(90, ids),
      children: ids.map((id) => child(id, 'agent::done')),
    });
    const inner = provider.getTicket;
    provider.getTicket = async (id) => {
      if (Number(id) === 3) throw new Error('HTTP 500');
      return inner(id);
    };

    const result = await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: {},
      columnSync: fakeColumnSync(),
    });

    assert.equal(result.epics[0].detail, 'child-read-failed');
    assert.deepEqual(result.pending, [90]);
    assert.equal(
      provider.updates.length,
      0,
      'nothing is written on a failed read',
    );
  });
});

describe('rollUpEpicForStory — what does and does not count as a child', () => {
  it('drops a body-only id that resolves to nothing, rather than stalling', async () => {
    // A checklist row is hand-editable prose and can cite a deleted,
    // transferred or mistyped issue. No re-run will ever make it resolve, so
    // reading it as a failed read pinned the container `pending` forever.
    const epic = container(90, [1, 2, 999]);
    const provider = fakeProvider({
      parent: epic,
      children: [child(1, 'agent::done'), child(2, 'agent::done')],
      nativeChildren: [1, 2],
      missingChildIds: [999],
    });

    const result = await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: {},
      columnSync: fakeColumnSync(),
    });

    assert.notEqual(result.epics[0].detail, 'child-read-failed');
    assert.deepEqual(result.closed, [90], 'the real children all landed');
  });

  it('still fails the read when a NATIVE edge resolves to nothing', async () => {
    // The backend vouched for that edge, so its absence is a real read
    // problem and the next tick may well answer differently.
    const provider = fakeProvider({
      parent: container(90, []),
      children: [child(1, 'agent::done')],
      nativeChildren: [1, 999],
      missingChildIds: [999],
    });

    const result = await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: {},
      columnSync: fakeColumnSync(),
    });

    assert.equal(result.epics[0].detail, 'child-read-failed');
    assert.deepEqual(result.closed, []);
  });

  it('refuses an Epic-typed child by name and derives without it', async () => {
    const nested = container(91, []);
    const provider = fakeProvider({
      parent: container(90, [1, 91]),
      children: [child(1, 'agent::done'), nested],
      nativeChildren: [1, 91],
    });

    const result = await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: {},
      columnSync: fakeColumnSync(),
    });

    assert.deepEqual(result.epics[0].refused, [
      { childId: 91, reason: 'epic-typed-child' },
    ]);
    assert.deepEqual(
      result.closed,
      [90],
      'the nested container neither blocked nor advanced the parent',
    );
  });
});

describe('rollUpEpicForStory — how a container closed', () => {
  it('closes as not_planned when every child is closed and none landed', async () => {
    // The supersede shape: a cohort re-planned out of existence closes every
    // child, carrying no `agent::done` and having merged nothing. Reporting
    // that as `completed` over "every child Story landed" was false twice.
    const provider = fakeProvider({
      parent: container(90, [1, 2]),
      children: [child(1, null, 'closed'), child(2, null, 'closed')],
    });

    const result = await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: {},
      columnSync: fakeColumnSync(),
    });

    assert.deepEqual(result.closed, [90]);
    assert.deepEqual(provider.updates, [
      { id: 90, mutations: { state: 'closed', state_reason: 'not_planned' } },
    ]);
  });

  it('still closes as completed when a single child actually landed', async () => {
    const provider = fakeProvider({
      parent: container(90, [1, 2]),
      children: [child(1, 'agent::done'), child(2, null, 'closed')],
    });

    await rollUpEpicForStory({
      storyId: 1,
      provider,
      config: {},
      columnSync: fakeColumnSync(),
    });

    assert.deepEqual(provider.updates, [
      { id: 90, mutations: { state: 'closed', state_reason: 'completed' } },
    ]);
  });
});

describe('nativeChildReader has exactly one definition (Story #5280)', () => {
  // The expansion path and the rollup path must read an Epic's children the
  // same way. Two private copies is the shape that lets them drift, and the
  // drift is not cosmetic: an Epic the expansion can see children under but
  // the rollup cannot is expandable and permanently unclosable. A structural
  // assertion rather than a behavioural one, because the property being
  // protected is "there is only one of these" — which no amount of passing
  // behaviour can demonstrate.
  const OWNER = 'lib/orchestration/epic-container.js';
  const CONSUMERS = ['resolve-stories.js', 'lib/orchestration/epic-rollup.js'];
  const DEFINITION = /function nativeChildReader\s*\(/;

  it('defines it in epic-container.js and nowhere else', () => {
    assert.match(readScript(OWNER), DEFINITION);
    for (const consumer of CONSUMERS) {
      assert.doesNotMatch(
        readScript(consumer),
        DEFINITION,
        `${consumer} must import the reader, not define its own`,
      );
    }
  });

  it('is imported from that module by both consumers', () => {
    for (const consumer of CONSUMERS) {
      const source = readScript(consumer);
      assert.match(
        source,
        /import\s*\{[^}]*\bnativeChildReader\b[^}]*\}\s*from\s*'[^']*epic-container\.js'/s,
        `${consumer} must import nativeChildReader from epic-container.js`,
      );
    }
  });

  it('hands both consumers the same function object', async () => {
    const [
      { nativeChildReader: fromOwner },
      { nativeChildReader: reExported },
    ] = await Promise.all([
      import('../../../.agents/scripts/lib/orchestration/epic-container.js'),
      import('../../../.agents/scripts/resolve-stories.js'),
    ]);
    assert.equal(
      reExported,
      fromOwner,
      "resolve-stories re-exports the shared reader, it doesn't wrap one",
    );
  });
});
