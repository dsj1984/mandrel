import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runWaveGate } from '../.agents/scripts/wave-gate.js';

function manifestComment(stories) {
  const body = [
    '<!-- ap:structured-comment type="dispatch-manifest" -->',
    '```json',
    JSON.stringify({ stories }),
    '```',
  ].join('\n');
  return { id: 1, body };
}

function parkedComment(recuts = [], parked = []) {
  const body = [
    '<!-- ap:structured-comment type="parked-follow-ons" -->',
    '```json',
    JSON.stringify({ recuts, parked }),
    '```',
  ].join('\n');
  return { id: 2, body };
}

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
 * Test provider that records every getTicket invocation timing and
 * exposes a gated `getTicket` — callers await `startBarrier` before
 * resolving, so a serial fanout will deadlock and a parallel fanout
 * will release all at once.
 */
class TimingProvider {
  constructor({ tickets, throwFor = new Set(), comments = [] }) {
    this.tickets = tickets;
    this.throwFor = throwFor;
    this.comments = comments;
    this.calls = [];
    this.startedCount = 0;
    this._barrier = null;
  }

  setBarrier(expected) {
    let resolve;
    const p = new Promise((r) => {
      resolve = r;
    });
    this._barrier = { promise: p, resolve, expected };
  }

  async getTicketComments(_epicId) {
    return this.comments;
  }

  async getTicket(id) {
    const call = { id, startAt: performance.now(), endAt: null };
    this.calls.push(call);
    this.startedCount += 1;
    if (this._barrier) {
      if (this.startedCount >= this._barrier.expected) {
        this._barrier.resolve();
      }
      await this._barrier.promise;
    }
    if (this.throwFor.has(id)) {
      call.endAt = performance.now();
      throw new Error(`fetch failed #${id}`);
    }
    const t = this.tickets[id];
    call.endAt = performance.now();
    if (!t) throw new Error(`Ticket ${id} missing`);
    return { ...t };
  }
}

describe('sprint-wave-gate — parallel getTicket fanout', () => {
  it('starts all manifest getTicket calls before any resolves', async () => {
    const storyIds = [101, 102, 103, 104, 105];
    const tickets = Object.fromEntries(
      storyIds.map((id) => [id, { id, state: 'closed' }]),
    );
    const provider = new TimingProvider({
      tickets,
      comments: [
        manifestComment(
          storyIds.map((id) => ({ storyId: id, title: `S${id}`, wave: 1 })),
        ),
      ],
    });
    provider.setBarrier(storyIds.length);

    const result = await runWaveGate({
      epicId: 999,
      injectedProvider: provider,
    });

    assert.equal(result.success, true);
    assert.equal(result.total, storyIds.length);
    assert.equal(provider.calls.length, storyIds.length);
    // Concurrent-start witness: the barrier only releases once all N
    // calls have started, so a reached-the-barrier success is proof.
    const maxStart = Math.max(...provider.calls.map((c) => c.startAt));
    const minEnd = Math.min(...provider.calls.map((c) => c.endAt));
    assert.ok(
      maxStart <= minEnd,
      `expected all starts (max=${maxStart}) before any end (min=${minEnd})`,
    );
  });

  it('fans out manifest + recuts + parked concurrently across all three batches', async () => {
    const manifestIds = [201, 202, 203];
    const recutIds = [301, 302];
    const parkedIds = [401, 402];
    const allIds = [...manifestIds, ...recutIds, ...parkedIds];
    const tickets = Object.fromEntries(
      allIds.map((id) => [id, { id, state: 'closed' }]),
    );
    const provider = new TimingProvider({
      tickets,
      comments: [
        manifestComment(
          manifestIds.map((id) => ({ storyId: id, title: `S${id}`, wave: 1 })),
        ),
        parkedComment(
          recutIds.map((id) => ({ storyId: id, parentId: id - 100 })),
          parkedIds.map((id) => ({ storyId: id })),
        ),
      ],
    });
    provider.setBarrier(allIds.length);

    const result = await runWaveGate({
      epicId: 999,
      injectedProvider: provider,
    });

    assert.equal(result.success, true);
    assert.equal(result.total, manifestIds.length);
    assert.equal(result.recuts, recutIds.length);
    assert.equal(result.parked, parkedIds.length);
    assert.equal(provider.calls.length, allIds.length);
  });
});

describe('sprint-wave-gate — pass/fail/fetch-error contract', () => {
  it('passes when every manifest story is closed', async () => {
    const provider = new TimingProvider({
      tickets: {
        10: { id: 10, state: 'closed' },
        11: { id: 11, state: 'closed' },
      },
      comments: [
        manifestComment([
          { storyId: 10, title: 'a', wave: 1 },
          { storyId: 11, title: 'b', wave: 1 },
        ]),
      ],
    });
    const result = await runWaveGate({ epicId: 1, injectedProvider: provider });
    assert.equal(result.success, true);
    assert.equal(result.total, 2);
  });

  it('fails (exit 1) when a manifest story is still open', async () => {
    const provider = new TimingProvider({
      tickets: {
        10: { id: 10, state: 'closed' },
        11: { id: 11, state: 'open' },
      },
      comments: [
        manifestComment([
          { storyId: 10, title: 'a', wave: 1 },
          { storyId: 11, title: 'b', wave: 1 },
        ]),
      ],
    });
    const trap = trapExit();
    try {
      await assert.rejects(
        runWaveGate({ epicId: 1, injectedProvider: provider }),
        /__exit:1/,
      );
      assert.equal(trap.code(), 1);
    } finally {
      trap.restore();
    }
  });

  it('treats fetch failures as still-open (exit 1)', async () => {
    const provider = new TimingProvider({
      tickets: {
        10: { id: 10, state: 'closed' },
      },
      throwFor: new Set([11]),
      comments: [
        manifestComment([
          { storyId: 10, title: 'a', wave: 1 },
          { storyId: 11, title: 'b', wave: 1 },
        ]),
      ],
    });
    const trap = trapExit();
    try {
      await assert.rejects(
        runWaveGate({ epicId: 1, injectedProvider: provider }),
        /__exit:1/,
      );
      assert.equal(trap.code(), 1);
    } finally {
      trap.restore();
    }
  });

  it('halts on open recuts unless --allow-open-recuts is set', async () => {
    const provider = new TimingProvider({
      tickets: {
        10: { id: 10, state: 'closed' },
        20: { id: 20, state: 'open' },
      },
      comments: [
        manifestComment([{ storyId: 10, title: 'a', wave: 1 }]),
        parkedComment([{ storyId: 20, parentId: 10 }], []),
      ],
    });
    const trap = trapExit();
    try {
      await assert.rejects(
        runWaveGate({ epicId: 1, injectedProvider: provider }),
        /__exit:1/,
      );
      assert.equal(trap.code(), 1);
    } finally {
      trap.restore();
    }
  });

  it('halts on open parked follow-ons unless --allow-parked is set', async () => {
    const provider = new TimingProvider({
      tickets: {
        10: { id: 10, state: 'closed' },
        30: { id: 30, state: 'open' },
      },
      comments: [
        manifestComment([{ storyId: 10, title: 'a', wave: 1 }]),
        parkedComment([], [{ storyId: 30 }]),
      ],
    });
    const trap = trapExit();
    try {
      await assert.rejects(
        runWaveGate({ epicId: 1, injectedProvider: provider }),
        /__exit:1/,
      );
      assert.equal(trap.code(), 1);
    } finally {
      trap.restore();
    }
  });

  it('passes when all manifest + follow-ons are closed', async () => {
    const provider = new TimingProvider({
      tickets: {
        10: { id: 10, state: 'closed' },
        20: { id: 20, state: 'closed' },
        30: { id: 30, state: 'closed' },
      },
      comments: [
        manifestComment([{ storyId: 10, title: 'a', wave: 1 }]),
        parkedComment([{ storyId: 20, parentId: 10 }], [{ storyId: 30 }]),
      ],
    });
    const result = await runWaveGate({ epicId: 1, injectedProvider: provider });
    assert.equal(result.success, true);
    assert.equal(result.total, 1);
    assert.equal(result.recuts, 1);
    assert.equal(result.parked, 1);
  });
});
