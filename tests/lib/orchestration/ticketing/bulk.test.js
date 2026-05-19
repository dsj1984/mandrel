/**
 * Story #1848 — Sibling test for the extracted `ticketing/bulk`
 * sub-module. Exercises the cascade surface directly so the
 * verb-family split is contractually pinned independent of the
 * facade re-export.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { ITicketingProvider } from '../../../../.agents/scripts/lib/ITicketingProvider.js';
import {
  __resetParentCascadeLocks,
  __setCascadeRetryDelays,
  cascadeCompletion,
  cascadeParentState,
  deriveParentState,
  logCascadePartialFailures,
} from '../../../../.agents/scripts/lib/orchestration/ticketing/bulk.js';
import { STATE_LABELS } from '../../../../.agents/scripts/lib/orchestration/ticketing/reads.js';

class MockProvider extends ITicketingProvider {
  constructor() {
    super();
    this.updates = [];
    this.comments = [];
    this.tickets = {
      1: {
        id: 1,
        labels: ['agent::ready', 'type::story'],
        body: 'Story body\n- [ ] #2',
        state: 'open',
      },
      2: {
        id: 2,
        labels: ['agent::done', 'type::task'],
        body: 'Task body\nparent: #1',
        state: 'closed',
      },
    };
    this.deps = {
      1: { blocks: [], blockedBy: [2] },
      2: { blocks: [1], blockedBy: [] },
    };
    this.subTickets = {
      1: [this.tickets[2]],
      2: [],
    };
  }

  async getTicket(id) {
    return this.tickets[id];
  }

  async updateTicket(id, mutations) {
    this.updates.push({ id, mutations });
    if (mutations.labels) {
      const rm = mutations.labels.remove || [];
      const add = mutations.labels.add || [];
      let current = this.tickets[id].labels.filter((l) => !rm.includes(l));
      current = [...new Set([...current, ...add])];
      this.tickets[id].labels = current;
    }
    if (mutations.body !== undefined) {
      this.tickets[id].body = mutations.body;
    }
    if (mutations.state !== undefined) {
      this.tickets[id].state = mutations.state;
    }
  }

  async postComment(id, payload) {
    this.comments.push({ id, payload });
  }

  async getTicketDependencies(id) {
    return this.deps[id];
  }

  async getSubTickets(id) {
    return this.subTickets[id].map((t) => this.tickets[t.id]);
  }
}

describe('ticketing/bulk — cascadeCompletion happy path', () => {
  let mock;

  beforeEach(() => {
    mock = new MockProvider();
    __resetParentCascadeLocks();
    __setCascadeRetryDelays({ delays: [] });
  });

  it('returns empty cascade when the ticket is not agent::done', async () => {
    mock.tickets[2].labels = ['agent::executing'];
    const result = await cascadeCompletion(mock, 2);
    assert.deepEqual(result.cascadedTo, []);
    assert.deepEqual(result.failed, []);
  });

  it('cascades the parent to agent::done when its only child closes', async () => {
    const result = await cascadeCompletion(mock, 2);
    assert.deepEqual(result.cascadedTo, [1]);
    assert.deepEqual(result.failed, []);
    // Parent label flipped.
    assert.equal(
      mock.tickets[1].labels.includes(STATE_LABELS.DONE),
      true,
      'parent should be agent::done',
    );
    // A progress comment was posted on the parent.
    const progress = mock.comments.find(
      (c) => c.id === 1 && c.payload.type === 'progress',
    );
    assert.ok(progress, 'progress comment should be posted on parent');
  });

  it('leaves the parent untouched when siblings are still open', async () => {
    mock.tickets[3] = {
      id: 3,
      labels: ['agent::executing'],
      body: 'Sibling open',
      state: 'open',
    };
    mock.subTickets[1] = [mock.tickets[2], mock.tickets[3]];
    const result = await cascadeCompletion(mock, 2);
    assert.deepEqual(result.cascadedTo, []);
    assert.equal(mock.tickets[1].labels.includes(STATE_LABELS.DONE), false);
  });
});

describe('ticketing/bulk — logCascadePartialFailures', () => {
  it('is a no-op when the cascade envelope has no failures', () => {
    assert.doesNotThrow(() => logCascadePartialFailures(42, null));
    assert.doesNotThrow(() => logCascadePartialFailures(42, { failed: [] }));
    assert.doesNotThrow(() => logCascadePartialFailures(42, {}));
  });
});

describe('ticketing/bulk — deriveParentState (Story #2676)', () => {
  it('returns null for an empty child set', () => {
    assert.equal(deriveParentState([]), null);
    assert.equal(deriveParentState(undefined), null);
  });

  it('returns blocked when any child is blocked, regardless of siblings', () => {
    const siblings = [
      { labels: ['agent::executing'], state: 'open' },
      { labels: ['agent::blocked'], state: 'open' },
      { labels: ['agent::done'], state: 'closed' },
    ];
    assert.equal(deriveParentState(siblings), STATE_LABELS.BLOCKED);
  });

  it('returns done when every child is done or closed', () => {
    const siblings = [
      { labels: ['agent::done'], state: 'closed' },
      { labels: [], state: 'closed' },
      { labels: ['agent::done'], state: 'closed' },
    ];
    assert.equal(deriveParentState(siblings), STATE_LABELS.DONE);
  });

  it('returns executing when any child is executing and none is blocked', () => {
    const siblings = [
      { labels: ['agent::executing'], state: 'open' },
      { labels: ['agent::ready'], state: 'open' },
    ];
    assert.equal(deriveParentState(siblings), STATE_LABELS.EXECUTING);
  });

  it('treats closing as executing-equivalent for derivation', () => {
    const siblings = [
      { labels: ['agent::closing'], state: 'open' },
      { labels: ['agent::ready'], state: 'open' },
    ];
    assert.equal(deriveParentState(siblings), STATE_LABELS.EXECUTING);
  });

  it('returns null when no child is blocked/executing/closing and not all are done', () => {
    const siblings = [
      { labels: ['agent::ready'], state: 'open' },
      { labels: ['agent::done'], state: 'closed' },
    ];
    assert.equal(deriveParentState(siblings), null);
  });
});

class ThreeLevelMock extends ITicketingProvider {
  constructor() {
    super();
    this.updates = [];
    this.comments = [];
    // Hierarchy: Epic 100 ← Story 10 ← Tasks 1, 2
    this.tickets = {
      1: {
        id: 1,
        labels: ['agent::ready', 'type::task'],
        body: 'Task 1\nparent: #10',
        state: 'open',
      },
      2: {
        id: 2,
        labels: ['agent::ready', 'type::task'],
        body: 'Task 2\nparent: #10',
        state: 'open',
      },
      10: {
        id: 10,
        labels: ['agent::ready', 'type::story'],
        body: 'Story\n- [ ] #1\n- [ ] #2\nparent: #100',
        state: 'open',
      },
      100: {
        id: 100,
        labels: ['agent::ready', 'type::epic'],
        body: 'Epic\n- [ ] #10',
        state: 'open',
      },
    };
    this.deps = {
      1: { blocks: [10], blockedBy: [] },
      2: { blocks: [10], blockedBy: [] },
      10: { blocks: [100], blockedBy: [1, 2] },
      100: { blocks: [], blockedBy: [10] },
    };
    this.subTickets = {
      1: [],
      2: [],
      10: [this.tickets[1], this.tickets[2]],
      100: [this.tickets[10]],
    };
  }
  async getTicket(id) {
    return this.tickets[id];
  }
  async updateTicket(id, mutations) {
    this.updates.push({ id, mutations });
    if (mutations.labels) {
      const rm = mutations.labels.remove || [];
      const add = mutations.labels.add || [];
      let current = this.tickets[id].labels.filter((l) => !rm.includes(l));
      current = [...new Set([...current, ...add])];
      this.tickets[id].labels = current;
    }
    if (mutations.body !== undefined) this.tickets[id].body = mutations.body;
    if (mutations.state !== undefined) this.tickets[id].state = mutations.state;
  }
  async postComment(id, payload) {
    this.comments.push({ id, payload });
  }
  async getTicketDependencies(id) {
    return this.deps[id];
  }
  async getSubTickets(id) {
    return this.subTickets[id].map((t) => this.tickets[t.id]);
  }
}

describe('ticketing/bulk — cascadeParentState (Story #2676)', () => {
  let mock;
  beforeEach(() => {
    mock = new ThreeLevelMock();
    __resetParentCascadeLocks();
    __setCascadeRetryDelays({ delays: [] });
  });

  it('bubbles executing up through Story and Epic when a Task starts work', async () => {
    mock.tickets[1].labels = ['agent::executing', 'type::task'];
    const result = await cascadeParentState(mock, 1);
    assert.equal(
      mock.tickets[10].labels.includes(STATE_LABELS.EXECUTING),
      true,
      'Story should flip to agent::executing',
    );
    assert.equal(
      mock.tickets[100].labels.includes(STATE_LABELS.EXECUTING),
      true,
      'Epic should flip to agent::executing',
    );
    assert.ok(result.cascadedTo.includes(10));
    assert.ok(result.cascadedTo.includes(100));
    assert.deepEqual(result.failed, []);
  });

  it('lets blocked sibling override an executing sibling', async () => {
    mock.tickets[1].labels = ['agent::executing', 'type::task'];
    mock.tickets[2].labels = ['agent::blocked', 'type::task'];
    const result = await cascadeParentState(mock, 2);
    assert.equal(
      mock.tickets[10].labels.includes(STATE_LABELS.BLOCKED),
      true,
      'Story should flip to agent::blocked even though a sibling is executing',
    );
    assert.equal(
      mock.tickets[10].labels.includes(STATE_LABELS.EXECUTING),
      false,
      'Story should not also carry agent::executing',
    );
    assert.ok(result.cascadedTo.includes(10));
  });

  it('does not regress the parent when only some children are done', async () => {
    mock.tickets[10].labels = ['agent::executing', 'type::story'];
    mock.tickets[1].labels = ['agent::done', 'type::task'];
    mock.tickets[1].state = 'closed';
    // Task #2 is still agent::ready/open.
    const result = await cascadeParentState(mock, 1);
    assert.equal(
      mock.tickets[10].labels.includes(STATE_LABELS.EXECUTING),
      true,
      'Story should remain agent::executing while Task #2 is still open',
    );
    assert.equal(mock.tickets[10].labels.includes(STATE_LABELS.DONE), false);
    assert.deepEqual(result.cascadedTo, []);
  });

  it('is a no-op when the parent is already in the derived state', async () => {
    mock.tickets[10].labels = ['agent::executing', 'type::story'];
    mock.tickets[100].labels = ['agent::executing', 'type::epic'];
    mock.tickets[1].labels = ['agent::executing', 'type::task'];
    const prevUpdates = mock.updates.length;
    const result = await cascadeParentState(mock, 1);
    // No label mutations on either parent — the idempotency guard skipped
    // both transitions.
    const labelUpdates = mock.updates
      .slice(prevUpdates)
      .filter(
        (u) =>
          (u.id === 10 || u.id === 100) && u.mutations.labels !== undefined,
      );
    assert.deepEqual(
      labelUpdates,
      [],
      'no label writes when derived state already matches current',
    );
    assert.deepEqual(result.cascadedTo, []);
  });

  it('returns empty cascade when the child has no recognised agent::* state', async () => {
    mock.tickets[1].labels = ['type::task'];
    const result = await cascadeParentState(mock, 1);
    assert.deepEqual(result.cascadedTo, []);
    assert.deepEqual(result.failed, []);
  });
});
