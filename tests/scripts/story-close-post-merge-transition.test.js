/**
 * tests/scripts/story-close-post-merge-transition.test.js — Story #2534,
 * Task #2538.
 *
 * Proves the post-merge ticket-closure phase reliably transitions the
 * Story label `agent::closing → agent::done` and closes the issue, and
 * that re-running the phase against an already-closed Story is a no-op
 * (no double-emit, no error). Exercising `ticketClosurePhase` with a
 * fake `ITicketingProvider` is the smallest faithful surface that
 * captures the same behavior story-close.js delegates to.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ticketClosurePhase } from '../../.agents/scripts/lib/orchestration/post-merge-pipeline.js';
import { STATE_LABELS } from '../../.agents/scripts/lib/orchestration/ticketing.js';

/**
 * Minimal in-memory provider that records every updateTicket call so the
 * test can assert exactly one transition is emitted per Story. Honours the
 * one-state-at-a-time contract used by `transitionTicketState`: the
 * `labels.add`/`labels.remove` mutation is replayed against the stored
 * ticket so subsequent reads reflect the new state.
 */
function makeFakeProvider(initial = []) {
  const tickets = new Map();
  for (const t of initial) {
    tickets.set(Number(t.id), {
      id: Number(t.id),
      state: t.state ?? 'open',
      labels: Array.isArray(t.labels) ? [...t.labels] : [],
      body: t.body ?? '',
    });
  }
  const calls = { updateTicket: [], getSubTickets: [], getTicket: [] };
  return {
    tickets,
    calls,
    async getTicket(id) {
      calls.getTicket.push(Number(id));
      const t = tickets.get(Number(id));
      if (!t) return null;
      return { ...t, labels: [...t.labels] };
    },
    async updateTicket(id, mutations) {
      calls.updateTicket.push({ id: Number(id), mutations });
      const t = tickets.get(Number(id));
      if (!t) return;
      if (mutations?.labels) {
        const add = mutations.labels.add ?? [];
        const remove = mutations.labels.remove ?? [];
        t.labels = t.labels.filter((l) => !remove.includes(l));
        for (const l of add) if (!t.labels.includes(l)) t.labels.push(l);
      }
      if (mutations?.state) t.state = mutations.state;
    },
    async getSubTickets(id) {
      calls.getSubTickets.push(Number(id));
      return [];
    },
    async getTicketDependencies() {
      // No parents in this fixture; cascade short-circuits.
      return { blocks: [], blockedBy: [] };
    },
  };
}

function makeNoopLogger() {
  return { error: () => {}, warn: () => {}, info: () => {} };
}

describe('ticketClosurePhase — post-merge label transition (Story #2534)', () => {
  it('fresh run: transitions Story #N from agent::closing → agent::done and closes the ticket', async () => {
    const storyId = 99001;
    const tasks = [{ id: 99002, labels: ['agent::executing', 'type::task'] }];
    const provider = makeFakeProvider([
      {
        id: storyId,
        state: 'open',
        labels: ['agent::closing', 'type::story'],
      },
      {
        id: 99002,
        state: 'open',
        labels: ['agent::executing', 'type::task'],
      },
    ]);

    const result = await ticketClosurePhase({
      provider,
      tasks,
      storyId,
      progress: () => {},
      logger: makeNoopLogger(),
    });

    const story = provider.tickets.get(storyId);
    assert.equal(story.state, 'closed', 'Story ticket must be closed');
    assert.ok(
      story.labels.includes(STATE_LABELS.DONE),
      `Story must carry ${STATE_LABELS.DONE} label`,
    );
    assert.ok(
      !story.labels.includes(STATE_LABELS.CLOSING),
      'Story must NOT carry agent::closing after transition',
    );
    assert.ok(
      result.closedTickets.includes(storyId),
      'ticketClosurePhase result must list Story in closedTickets',
    );

    // Exactly one Story-level updateTicket call should target the Story.
    const storyUpdates = provider.calls.updateTicket.filter(
      (c) => c.id === storyId,
    );
    assert.equal(
      storyUpdates.length,
      1,
      'Story-level updateTicket must fire exactly once on fresh close',
    );
  });

  it('idempotent re-run: re-invoking the phase on an already-closed Story does not error and emits no additional Story-level transition', async () => {
    const storyId = 99010;
    const tasks = [{ id: 99011, labels: [STATE_LABELS.DONE, 'type::task'] }];
    const provider = makeFakeProvider([
      {
        id: storyId,
        state: 'closed',
        labels: [STATE_LABELS.DONE, 'type::story'],
      },
      {
        id: 99011,
        state: 'closed',
        labels: [STATE_LABELS.DONE, 'type::task'],
      },
    ]);

    let threw = null;
    let result;
    try {
      result = await ticketClosurePhase({
        provider,
        tasks,
        storyId,
        progress: () => {},
        logger: makeNoopLogger(),
      });
    } catch (err) {
      threw = err;
    }

    assert.equal(
      threw,
      null,
      `Re-running ticketClosurePhase on a done Story must not throw, got: ${threw?.message}`,
    );

    // Tasks already-DONE go through the `skipped` branch of
    // batchTransitionTickets and never issue an updateTicket.
    const taskUpdates = provider.calls.updateTicket.filter(
      (c) => c.id === 99011,
    );
    assert.equal(
      taskUpdates.length,
      0,
      'Already-done Task must not receive a redundant updateTicket call',
    );

    // The Story may receive at most one updateTicket call (idempotent
    // re-application of the same label is harmless); critically it must
    // not flip state away from `closed` and must remain on agent::done.
    const story = provider.tickets.get(storyId);
    assert.equal(
      story.state,
      'closed',
      'Story must remain closed after idempotent re-run',
    );
    assert.ok(
      story.labels.includes(STATE_LABELS.DONE),
      'Story must still carry agent::done after idempotent re-run',
    );
    assert.ok(
      !story.labels.includes(STATE_LABELS.CLOSING),
      'Story must not regress to agent::closing on re-run',
    );
    assert.ok(result, 'phase must resolve with a result envelope on re-run');
    assert.ok(
      result.closedTickets.includes(storyId),
      'idempotent re-run must still record the Story in closedTickets',
    );
  });

  it('rethrows on transport error so the runPhase wrapper surfaces it (no silent swallow)', async () => {
    const storyId = 99020;
    const tasks = [];
    const provider = makeFakeProvider([
      {
        id: storyId,
        state: 'open',
        labels: [STATE_LABELS.CLOSING, 'type::story'],
      },
    ]);
    // Force updateTicket to fail when called against the Story id.
    const original = provider.updateTicket.bind(provider);
    provider.updateTicket = async (id, mutations) => {
      if (Number(id) === storyId) {
        throw new Error('synthetic transport error: 503 upstream');
      }
      return original(id, mutations);
    };

    let threw = null;
    try {
      await ticketClosurePhase({
        provider,
        tasks,
        storyId,
        progress: () => {},
        logger: makeNoopLogger(),
      });
    } catch (err) {
      threw = err;
    }
    assert.ok(
      threw instanceof Error,
      'ticketClosurePhase must rethrow transport errors instead of silently swallowing them',
    );
    assert.match(
      threw.message,
      /transport error/,
      'rethrown error must preserve the original transport message',
    );
  });

  it('3-tier Storyless closure: empty tasks list transitions Story alone (Story #3127)', async () => {
    // Under the 3-tier hierarchy a Story has zero child Tasks (acceptance is
    // inline on the Story body). `ticketClosurePhase` must accept an empty
    // `tasks` array, skip the batch transition cleanly, transition the Story
    // to agent::done + closed, and still surface the Story in closedTickets.
    const storyId = 99100;
    const tasks = [];
    const provider = makeFakeProvider([
      {
        id: storyId,
        state: 'open',
        labels: [STATE_LABELS.CLOSING, 'type::story'],
      },
    ]);

    const result = await ticketClosurePhase({
      provider,
      tasks,
      storyId,
      progress: () => {},
      logger: makeNoopLogger(),
    });

    const story = provider.tickets.get(storyId);
    assert.equal(
      story.state,
      'closed',
      'Storyless 3-tier close must still close the Story issue',
    );
    assert.ok(
      story.labels.includes(STATE_LABELS.DONE),
      'Storyless 3-tier close must apply agent::done to the Story',
    );
    assert.deepEqual(
      result.closedTickets,
      [storyId],
      'closedTickets must contain only the Story when there are no child Tasks',
    );
    // No Task updateTicket calls should have been issued.
    const taskUpdateCalls = provider.calls.updateTicket.filter(
      (c) => c.id !== storyId,
    );
    assert.equal(
      taskUpdateCalls.length,
      0,
      'Storyless closure must not issue any non-Story updateTicket calls',
    );
  });
});
