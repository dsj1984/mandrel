/**
 * tests/contract/finalize/close-planning-tickets.test.js
 *
 * Contract test for `closePlanningTickets` — Story #2894 / Task #2904
 * (Epic #2880).
 *
 * Asserts:
 *   1. Happy path — the two open planning tickets (Tech Spec +
 *      Acceptance Spec) are closed; helper returns
 *      `{ closed: 2, alreadyClosed: 0, failed: 0 }`.
 *   2. Idempotency — two already-closed planning tickets return
 *      `{ closed: 0, alreadyClosed: 2, failed: 0 }` and no transition
 *      is attempted.
 *   3. Partial fail — a thrown transition on one ticket counts as
 *      `failed` and does NOT abort the remaining closes.
 *   4. Body-only parsing — when `linkedIssues` is absent the helper
 *      falls back to parsing the Epic body's `## Planning Artifacts`
 *      lines via `parseLinkedIssues`.
 *
 * Story #4314: the PRD artifact class is retired, so `kinds` covers only
 * Tech Spec + Acceptance Spec (no `prd`).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { closePlanningTickets } from '../../../.agents/scripts/lib/orchestration/finalize/close-planning-tickets.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

function makeProvider({ epic, tickets }) {
  return {
    async getTicket(id) {
      if (id === epic.id) return epic;
      const t = tickets[id];
      if (!t) throw new Error(`unknown ticket #${id}`);
      return t;
    },
  };
}

describe('closePlanningTickets', () => {
  it('closes two open planning tickets and reports closed=2', async () => {
    const epic = {
      id: 2880,
      body: '',
      linkedIssues: { techSpec: 2885, acceptanceSpec: 2886 },
    };
    const tickets = {
      2885: { id: 2885, state: 'open' },
      2886: { id: 2886, state: 'open' },
    };
    const provider = makeProvider({ epic, tickets });
    const transitions = [];
    const result = await closePlanningTickets({
      epicId: 2880,
      provider,
      transitionFn: async (_p, id) => {
        transitions.push(id);
      },
      logger: quietLogger(),
    });
    assert.equal(result.closed, 2);
    assert.equal(result.alreadyClosed, 0);
    assert.equal(result.failed, 0);
    assert.deepEqual(
      transitions.sort((a, b) => a - b),
      [2885, 2886],
    );
  });

  it('returns alreadyClosed=2 and skips transitions when all tickets are closed', async () => {
    const epic = {
      id: 2880,
      body: '',
      linkedIssues: { techSpec: 2885, acceptanceSpec: 2886 },
    };
    const tickets = {
      2885: { id: 2885, state: 'closed' },
      2886: { id: 2886, state: 'closed' },
    };
    const provider = makeProvider({ epic, tickets });
    let transitionCalls = 0;
    const result = await closePlanningTickets({
      epicId: 2880,
      provider,
      transitionFn: async () => {
        transitionCalls += 1;
      },
      logger: quietLogger(),
    });
    assert.deepEqual(
      {
        closed: result.closed,
        alreadyClosed: result.alreadyClosed,
        failed: result.failed,
      },
      { closed: 0, alreadyClosed: 2, failed: 0 },
    );
    assert.equal(transitionCalls, 0);
  });

  it('records partial failures without aborting the remaining closes', async () => {
    const epic = {
      id: 2880,
      body: '',
      linkedIssues: { techSpec: 2885, acceptanceSpec: 2886 },
    };
    const tickets = {
      2885: { id: 2885, state: 'open' },
      2886: { id: 2886, state: 'open' },
    };
    const provider = makeProvider({ epic, tickets });
    const result = await closePlanningTickets({
      epicId: 2880,
      provider,
      transitionFn: async (_p, id) => {
        if (id === 2885) throw new Error('rate-limited');
      },
      logger: quietLogger(),
    });
    assert.equal(result.closed, 1);
    assert.equal(result.failed, 1);
    const failed = result.details.find((d) => d.status === 'failed');
    assert.equal(failed?.id, 2885);
    assert.match(failed?.detail ?? '', /rate-limited/);
  });

  it('parses planning ids from the Epic body when linkedIssues is absent', async () => {
    // A historical `- [ ] PRD: #100` line may still appear in a legacy body,
    // but the parser ignores it (Story #4314) — only the Tech Spec closes.
    const epic = {
      id: 2880,
      body: [
        '## Planning Artifacts',
        '- [ ] PRD: #100',
        '- [ ] Tech Spec: #101',
      ].join('\n'),
    };
    const tickets = {
      101: { id: 101, state: 'open' },
    };
    const provider = makeProvider({ epic, tickets });
    const transitions = [];
    const result = await closePlanningTickets({
      epicId: 2880,
      provider,
      transitionFn: async (_p, id) => {
        transitions.push(id);
      },
      logger: quietLogger(),
    });
    assert.equal(result.closed, 1);
    assert.deepEqual(transitions, [101]);
  });

  it('throws on invalid epicId', async () => {
    await assert.rejects(
      () => closePlanningTickets({ epicId: 0, provider: {} }),
      /epicId/,
    );
  });

  it('throws when provider lacks getTicket', async () => {
    await assert.rejects(
      () => closePlanningTickets({ epicId: 1, provider: {} }),
      /getTicket/,
    );
  });
});
