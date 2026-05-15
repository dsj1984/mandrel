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
