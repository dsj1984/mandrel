/**
 * Story #1795 — `opts.ticketSnapshot` seam contract tests.
 *
 * `transitionTicketState` historically issued two `getTicket` calls per
 * invocation when `opts.notify` was set: once for the notify
 * `fromState` snapshot, once inside the provider's label-merge path.
 * Threading `opts.ticketSnapshot` from a caller that already holds the
 * ticket eliminates both reads.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { transitionTicketState } from '../../../.agents/scripts/lib/orchestration/ticketing.js';

function makeRecordingProvider({ ticket }) {
  const getTicketCalls = [];
  const updateCalls = [];
  return {
    async getTicket(id) {
      getTicketCalls.push(id);
      return ticket;
    },
    async updateTicket(id, mutations) {
      updateCalls.push({ id, mutations });
    },
    async postComment() {},
    async getSubTickets() {
      return [];
    },
    getTicketCalls,
    updateCalls,
  };
}

describe('transitionTicketState — opts.ticketSnapshot seam', () => {
  it('makes zero getTicket calls when opts.ticketSnapshot is supplied (with notify)', async () => {
    const ticket = {
      id: 42,
      labels: ['type::task', 'agent::executing'],
      body: 'Epic: #1788',
    };
    const provider = makeRecordingProvider({ ticket });
    const notifyCalls = [];
    const notify = (...args) => {
      notifyCalls.push(args);
    };
    await transitionTicketState(provider, 42, 'agent::done', {
      notify,
      cascade: false,
      ticketSnapshot: ticket,
    });
    assert.equal(
      provider.getTicketCalls.length,
      0,
      `expected zero getTicket calls, got ${provider.getTicketCalls.length}`,
    );
    assert.equal(provider.updateCalls.length, 1);
    assert.equal(provider.updateCalls[0].mutations.state, 'closed');
    // The snapshot must be threaded down so the provider's label-merge
    // path skips its own getTicket too.
    assert.equal(
      provider.updateCalls[0].mutations._ticketSnapshot,
      ticket,
      'snapshot must be threaded into updateTicket mutations as _ticketSnapshot',
    );
  });

  it('preserves the legacy single getTicket call when opts.ticketSnapshot is omitted (with notify)', async () => {
    const ticket = {
      id: 42,
      labels: ['type::task', 'agent::executing'],
      body: 'Epic: #1788',
    };
    const provider = makeRecordingProvider({ ticket });
    await transitionTicketState(provider, 42, 'agent::done', {
      notify: () => {},
      cascade: false,
    });
    assert.equal(provider.getTicketCalls.length, 1);
    assert.deepEqual(provider.getTicketCalls, [42]);
  });

  it('loads the snapshot once for a non-recovery target with neither notify nor ticketSnapshot set', async () => {
    // The invalid-transition observer needs the prior state on every flip
    // (Story #5805). The provider's label merge would otherwise issue its
    // own read, so threading the snapshot keeps production at one read.
    for (const target of ['agent::closing', 'agent::done']) {
      const ticket = { id: 5, labels: ['agent::executing'], body: '' };
      const provider = makeRecordingProvider({ ticket });
      await transitionTicketState(provider, 5, target, { cascade: false });
      assert.deepEqual(
        provider.getTicketCalls,
        [5],
        `expected exactly one snapshot read for ${target}`,
      );
      assert.equal(
        provider.updateCalls[0].mutations._ticketSnapshot,
        ticket,
        'the snapshot must be threaded into updateTicket for reuse',
      );
    }
  });

  it('loads the snapshot once for a block-recovery target and threads it into updateTicket (Story #4622)', async () => {
    // A `→ agent::executing|ready` transition needs the *prior* state to
    // detect a block→active recovery. The snapshot is loaded once and
    // forwarded as `_ticketSnapshot`, so the provider's label-merge path
    // reuses it rather than issuing its own read — net-neutral in production.
    for (const target of ['agent::executing', 'agent::ready']) {
      const ticket = { id: 5, labels: ['agent::blocked'], body: '' };
      const provider = makeRecordingProvider({ ticket });
      await transitionTicketState(provider, 5, target, { cascade: false });
      assert.equal(
        provider.getTicketCalls.length,
        1,
        `expected exactly one snapshot read for ${target}`,
      );
      assert.equal(
        provider.updateCalls[0].mutations._ticketSnapshot,
        ticket,
        'the snapshot must be threaded into updateTicket for reuse',
      );
    }
  });

  it('derives fromState from the supplied ticketSnapshot for the notify payload', async () => {
    const ticket = {
      id: 9,
      title: 'Sample',
      labels: ['type::story', 'agent::executing'],
      body: '',
    };
    const provider = makeRecordingProvider({ ticket });
    const notifyArgs = [];
    await transitionTicketState(provider, 9, 'agent::done', {
      notify: (targetId, payload) => {
        notifyArgs.push({ targetId, payload });
      },
      cascade: false,
      ticketSnapshot: ticket,
    });
    // notify is dispatched at medium severity for Story → done
    assert.ok(
      notifyArgs.length === 1,
      'notify should fire once for story-done',
    );
    assert.equal(notifyArgs[0].payload.event, 'state-transition');
    assert.equal(notifyArgs[0].payload.level, 'story');
  });
});
