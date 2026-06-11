import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runHierarchyGate } from '../.agents/scripts/hierarchy-gate.js';

function trapExit() {
  let exitCode = null;
  const origExit = process.exit;
  process.exit = (code) => {
    exitCode = code;
    throw new Error(`__exit:${code}`);
  };
  return {
    restore() {
      process.exit = origExit;
    },
    code() {
      return exitCode;
    },
  };
}

/**
 * In-memory provider implementing the slice of ITicketingProvider the
 * hierarchy gate uses. `graph` maps parent IDs to child ticket records.
 */
class GraphProvider {
  constructor(graph) {
    this.graph = graph;
    this.calls = [];
  }
  async getSubTickets(parentId) {
    this.calls.push(parentId);
    return this.graph[parentId] ?? [];
  }
}

describe('runHierarchyGate', () => {
  it('passes when every descendant Story is closed', async () => {
    const provider = new GraphProvider({
      100: [
        {
          id: 200,
          title: 'Story A',
          state: 'closed',
          labels: ['type::story'],
        },
        {
          id: 300,
          title: 'Story A1',
          state: 'closed',
          labels: ['type::story'],
        },
      ],
    });
    const result = await runHierarchyGate({
      epicId: 100,
      injectedProvider: provider,
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.total, 2);
    assert.strictEqual(result.checked, 2);
    assert.strictEqual(result.auxiliaryDeferred, 0);
  });

  it('fails when a Story is still open', async () => {
    const provider = new GraphProvider({
      100: [
        {
          id: 201,
          title: 'Story open',
          state: 'open',
          labels: ['type::story'],
        },
      ],
      201: [],
    });
    const trap = trapExit();
    try {
      await assert.rejects(
        runHierarchyGate({ epicId: 100, injectedProvider: provider }),
        /__exit:1/,
      );
      assert.strictEqual(trap.code(), 1);
    } finally {
      trap.restore();
    }
  });

  it('defers auxiliary tickets (context::prd / context::tech-spec) — they close in Phase 7', async () => {
    const provider = new GraphProvider({
      100: [
        { id: 250, title: 'PRD', state: 'open', labels: ['context::prd'] },
        {
          id: 251,
          title: 'Tech Spec',
          state: 'open',
          labels: ['context::tech-spec'],
        },
        {
          id: 252,
          title: 'Story A',
          state: 'closed',
          labels: ['type::story'],
        },
      ],
      250: [],
      251: [],
      252: [],
    });
    const result = await runHierarchyGate({
      epicId: 100,
      injectedProvider: provider,
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.auxiliaryDeferred, 2);
    assert.strictEqual(result.checked, 1);
  });

  it('exits 2 when getSubTickets throws', async () => {
    const provider = {
      getSubTickets: async () => {
        throw new Error('transport exploded');
      },
    };
    const trap = trapExit();
    try {
      await assert.rejects(
        runHierarchyGate({ epicId: 100, injectedProvider: provider }),
        /__exit:2/,
      );
      assert.strictEqual(trap.code(), 2);
    } finally {
      trap.restore();
    }
  });

  it('does not loop when a descendant appears under two parents', async () => {
    // Untyped grouping ticket 200 and the Epic both reference Story 300.
    const provider = new GraphProvider({
      100: [
        {
          id: 200,
          title: 'Untyped grouping',
          state: 'closed',
          labels: [],
        },
        {
          id: 300,
          title: 'Story shared',
          state: 'closed',
          labels: ['type::story'],
        },
      ],
      200: [
        {
          id: 300,
          title: 'Story shared',
          state: 'closed',
          labels: ['type::story'],
        },
      ],
    });
    const result = await runHierarchyGate({
      epicId: 100,
      injectedProvider: provider,
    });
    assert.strictEqual(result.success, true);
    // Story 300 only counted once despite appearing under two parents.
    assert.strictEqual(result.total, 2);
  });

  it('never expands type::story leaves — no getSubTickets call per Story (Story #3989)', async () => {
    const provider = new GraphProvider({
      100: [
        { id: 300, title: 'Story 1', state: 'closed', labels: ['type::story'] },
        { id: 301, title: 'Story 2', state: 'closed', labels: ['type::story'] },
      ],
    });
    const result = await runHierarchyGate({
      epicId: 100,
      injectedProvider: provider,
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.total, 2);
    // Only the Epic is expanded — never the leaf Stories.
    assert.deepStrictEqual(provider.calls.sort(), [100]);
  });

  it('passes for a 2-tier tree (Stories with no child tickets) (Story #3127)', async () => {
    // Under the 2-tier hierarchy a Story has zero child tickets —
    // acceptance criteria live inline on the Story body. The gate must
    // accept this shape as well-formed when every Story is closed.
    const provider = new GraphProvider({
      100: [
        {
          id: 300,
          title: 'Story inline-acceptance',
          state: 'closed',
          labels: ['type::story'],
        },
      ],
    });
    const result = await runHierarchyGate({
      epicId: 100,
      injectedProvider: provider,
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.checked, 1);
    assert.strictEqual(result.auxiliaryDeferred, 0);
  });
});
