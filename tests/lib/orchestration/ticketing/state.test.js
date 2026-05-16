/**
 * Story #1848 — Sibling test for the extracted `ticketing/state`
 * sub-module. Exercises the per-ticket mutation surface directly so
 * the verb-family split is contractually pinned independent of the
 * facade re-export. Includes branch coverage for the new
 * `validateTransitionInputs` predicate that pulled
 * `transitionTicketState` below CRAP 12.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { ITicketingProvider } from '../../../../.agents/scripts/lib/ITicketingProvider.js';
import {
  _resetStructuredCommentCache,
  STATE_LABELS,
  structuredCommentMarker,
} from '../../../../.agents/scripts/lib/orchestration/ticketing/reads.js';
import {
  postStructuredComment,
  toggleTasklistCheckbox,
  transitionTicketState,
  upsertStructuredComment,
} from '../../../../.agents/scripts/lib/orchestration/ticketing/state.js';

class MockProvider extends ITicketingProvider {
  constructor() {
    super();
    this.updates = [];
    this.comments = [];
    this.deleted = [];
    this.tickets = {
      10: {
        id: 10,
        labels: ['agent::executing', 'type::task'],
        body: 'Task body',
        state: 'open',
        title: 'Some task',
      },
      11: {
        id: 11,
        labels: ['agent::executing'],
        body: 'Parent body\n- [ ] #10',
        state: 'open',
      },
    };
    this.commentStore = [];
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
    const commentId = 1000 + this.commentStore.length;
    const entry = { id: commentId, ticketId: id, body: payload.body };
    this.commentStore.push(entry);
    this.comments.push({ id, payload });
    return { id: commentId, commentId };
  }

  async getTicketComments(id) {
    return this.commentStore.filter((c) => c.ticketId === id);
  }

  async deleteComment(commentId) {
    this.deleted.push(commentId);
    const idx = this.commentStore.findIndex((c) => c.id === commentId);
    if (idx >= 0) this.commentStore.splice(idx, 1);
  }

  async getTicketDependencies() {
    return { blocks: [], blockedBy: [] };
  }

  async getSubTickets() {
    return [];
  }
}

describe('ticketing/state — transitionTicketState', () => {
  let mock;

  beforeEach(() => {
    mock = new MockProvider();
    _resetStructuredCommentCache(mock);
  });

  it('validateTransitionInputs throws on unknown state labels', async () => {
    await assert.rejects(
      () => transitionTicketState(mock, 10, 'agent::not-a-state'),
      /Invalid state: agent::not-a-state/,
    );
    // Empty string is also invalid.
    await assert.rejects(
      () => transitionTicketState(mock, 10, ''),
      /Invalid state:/,
    );
  });

  it('validateTransitionInputs accepts every label in STATE_LABELS', async () => {
    for (const state of Object.values(STATE_LABELS)) {
      // Each call should succeed without throwing the validation error.
      await transitionTicketState(mock, 10, state);
    }
    // One update per state in the canonical enum (Story #2004 grew the
    // enum from 3 → 4 by adding BLOCKED; the assertion tracks the enum
    // size rather than a hard-coded literal so future additive growth
    // doesn't re-break this test).
    assert.equal(mock.updates.length, Object.values(STATE_LABELS).length);
  });

  it('flips ticket state to closed when transitioning to agent::done', async () => {
    await transitionTicketState(mock, 10, STATE_LABELS.DONE);
    const update = mock.updates[mock.updates.length - 1];
    assert.equal(update.mutations.state, 'closed');
    assert.equal(update.mutations.state_reason, 'completed');
  });

  it('reopens the ticket when transitioning away from agent::done', async () => {
    mock.tickets[10].labels = ['agent::done'];
    mock.tickets[10].state = 'closed';
    await transitionTicketState(mock, 10, STATE_LABELS.READY);
    const update = mock.updates[mock.updates.length - 1];
    assert.equal(update.mutations.state, 'open');
    assert.equal(update.mutations.state_reason, null);
  });

  it('skips upward cascade when cascade:false is supplied', async () => {
    // Make ticket appear closable
    mock.tickets[10].labels = ['agent::executing', 'type::task'];
    mock.tickets[10].body = 'Task body\nparent: #11';
    let cascadeFired = false;
    mock.getTicketDependencies = async () => {
      cascadeFired = true;
      return { blocks: [11], blockedBy: [] };
    };
    await transitionTicketState(mock, 10, STATE_LABELS.DONE, {
      cascade: false,
    });
    assert.equal(
      cascadeFired,
      false,
      'cascade:false should bypass the upward walk',
    );
  });

  it('suppresses notify dispatch for low-severity (task) transitions', async () => {
    const notifyCalls = [];
    const notify = async (...args) => {
      notifyCalls.push(args);
    };
    await transitionTicketState(mock, 10, STATE_LABELS.EXECUTING, { notify });
    // Task → executing is low-severity; notify must not fire.
    assert.equal(notifyCalls.length, 0);
  });

  // Story #2004 — `agent::blocked` is the framework's authoritative HITL
  // pause point. The transition must be reachable from every non-blocked
  // state, must end with exactly one `agent::*` label on the ticket, and
  // the resume path back to `agent::executing` must be symmetric.
  it('transitions to agent::blocked from every non-blocked state with exactly one agent::* label', async () => {
    const startStates = [
      STATE_LABELS.READY,
      STATE_LABELS.EXECUTING,
      STATE_LABELS.DONE,
    ];
    for (const fromState of startStates) {
      // Reset the ticket to the source state. For DONE we also flip the
      // GitHub state to `closed` so the reopen path is exercised.
      mock.tickets[10].labels = [fromState, 'type::task'];
      mock.tickets[10].state =
        fromState === STATE_LABELS.DONE ? 'closed' : 'open';

      await transitionTicketState(mock, 10, STATE_LABELS.BLOCKED);

      const agentLabels = mock.tickets[10].labels.filter((l) =>
        l.startsWith('agent::'),
      );
      assert.deepEqual(
        agentLabels,
        [STATE_LABELS.BLOCKED],
        `from ${fromState} → blocked: expected exactly one agent::* label (blocked), got ${JSON.stringify(agentLabels)}`,
      );
      // Blocked is not terminal; the GitHub issue must remain open even
      // when the source state was DONE (which had closed the issue).
      assert.equal(
        mock.tickets[10].state,
        'open',
        `from ${fromState} → blocked: ticket should be reopened/remain open`,
      );
    }
  });

  it('resumes from agent::blocked back to agent::executing', async () => {
    mock.tickets[10].labels = ['agent::blocked', 'type::task'];
    mock.tickets[10].state = 'open';

    await transitionTicketState(mock, 10, STATE_LABELS.EXECUTING);

    const agentLabels = mock.tickets[10].labels.filter((l) =>
      l.startsWith('agent::'),
    );
    assert.deepEqual(agentLabels, [STATE_LABELS.EXECUTING]);
    assert.equal(mock.tickets[10].state, 'open');
  });
});

describe('ticketing/state — toggleTasklistCheckbox', () => {
  let mock;

  beforeEach(() => {
    mock = new MockProvider();
  });

  it('toggles an unchecked box to checked', async () => {
    await toggleTasklistCheckbox(mock, 11, 10, true);
    assert.equal(mock.tickets[11].body.includes('- [x] #10'), true);
  });

  it('is a no-op when the sub-issue is not referenced', async () => {
    await toggleTasklistCheckbox(mock, 11, 999, true);
    assert.equal(mock.updates.length, 0);
  });
});

describe('ticketing/state — postStructuredComment', () => {
  let mock;

  beforeEach(() => {
    mock = new MockProvider();
  });

  it('posts a valid structured-comment type to the provider', async () => {
    await postStructuredComment(mock, 10, 'progress', 'hello world');
    assert.equal(mock.comments.length, 1);
    assert.equal(mock.comments[0].payload.type, 'progress');
    assert.equal(mock.comments[0].payload.body, 'hello world');
  });

  it('rejects unknown structured-comment types before touching provider', async () => {
    await assert.rejects(
      () => postStructuredComment(mock, 10, 'not-a-type', 'x'),
      /Invalid structured-comment type/,
    );
    assert.equal(mock.comments.length, 0);
  });
});

describe('ticketing/state — upsertStructuredComment', () => {
  let mock;

  beforeEach(() => {
    mock = new MockProvider();
    _resetStructuredCommentCache(mock);
  });

  it('inserts the comment with its HTML marker on a clean ticket', async () => {
    await upsertStructuredComment(mock, 10, 'friction', 'something went wrong');
    assert.equal(mock.comments.length, 1);
    const marker = structuredCommentMarker('friction');
    assert.ok(mock.comments[0].payload.body.startsWith(marker));
  });

  it('replaces an existing comment of the same type', async () => {
    await upsertStructuredComment(mock, 10, 'friction', 'first');
    await upsertStructuredComment(mock, 10, 'friction', 'second');
    assert.equal(mock.deleted.length, 1, 'old comment should be deleted');
    // Two posts, one delete; final body carries the second payload.
    assert.equal(mock.comments.length, 2);
    assert.ok(
      mock.commentStore.some((c) => c.body.includes('second')),
      'second body should survive',
    );
  });
});
