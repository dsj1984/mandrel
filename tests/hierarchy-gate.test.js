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
  }
  async getSubTickets(parentId) {
    return this.graph[parentId] ?? [];
  }
}

describe('runHierarchyGate', () => {
  it('passes when every descendant is closed and tasks carry agent::done', async () => {
    const provider = new GraphProvider({
      100: [
        {
          id: 200,
          title: 'Feature A',
          state: 'closed',
          labels: ['type::feature'],
        },
      ],
      200: [
        {
          id: 300,
          title: 'Story A1',
          state: 'closed',
          labels: ['type::story'],
        },
      ],
      300: [
        {
          id: 400,
          title: 'Task A1.1',
          state: 'closed',
          labels: ['type::task', 'agent::done'],
        },
      ],
    });
    const result = await runHierarchyGate({
      epicId: 100,
      injectedProvider: provider,
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.total, 3);
    assert.strictEqual(result.checked, 3);
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

  it('fails when a Task is closed without agent::done', async () => {
    const provider = new GraphProvider({
      100: [
        {
          id: 401,
          title: 'Task missing agent::done',
          state: 'closed',
          labels: ['type::task'],
        },
      ],
      401: [],
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

  it('defers auxiliary tickets (context::prd / type::health) — they close in Phase 7', async () => {
    const provider = new GraphProvider({
      100: [
        { id: 250, title: 'PRD', state: 'open', labels: ['context::prd'] },
        {
          id: 251,
          title: 'Sprint Health',
          state: 'open',
          labels: ['type::health'],
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

  it('does not loop on shared-ancestor cycles', async () => {
    // Story 300 shows up under both Feature 200 and Feature 201.
    const provider = new GraphProvider({
      100: [
        {
          id: 200,
          title: 'Feature A',
          state: 'closed',
          labels: ['type::feature'],
        },
        {
          id: 201,
          title: 'Feature B',
          state: 'closed',
          labels: ['type::feature'],
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
      201: [
        {
          id: 300,
          title: 'Story shared',
          state: 'closed',
          labels: ['type::story'],
        },
      ],
      300: [],
    });
    const result = await runHierarchyGate({
      epicId: 100,
      injectedProvider: provider,
    });
    assert.strictEqual(result.success, true);
    // Story 300 only counted once despite appearing under two parents.
    assert.strictEqual(result.total, 3);
  });
});
