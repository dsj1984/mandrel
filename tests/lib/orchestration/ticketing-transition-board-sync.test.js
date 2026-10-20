/**
 * Story #5784 — a label transition reports its Projects v2 Status outcome.
 *
 * `transitionTicketState` resolves to `{ boardSync }` and emits one warn line
 * for every sync that did not happen, naming the ticket, the target label,
 * the reason and, where the operator can act, the command that fixes it. A
 * board that did not move is never thrown: the label write still lands.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Logger } from '../../../.agents/scripts/lib/Logger.js';
import { transitionTicketState } from '../../../.agents/scripts/lib/orchestration/ticketing/transition.js';

/** Records label writes; reads return a bare open ticket. */
function makeProvider() {
  const updates = [];
  return {
    updates,
    async getTicket(id) {
      return { id, labels: ['agent::ready'], body: '', title: 't' };
    },
    async updateTicket(id, mutations) {
      updates.push({ id, mutations });
    },
  };
}

/** A ColumnSync stand-in that returns, or throws, a fixed outcome. */
function columnSyncReturning(outcome) {
  return () => ({
    sync: async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  });
}

async function transitionWith(t, outcome) {
  const warned = [];
  t.mock.method(Logger, 'warn', (m) => warned.push(String(m)));
  const provider = makeProvider();
  const result = await transitionTicketState(
    provider,
    5784,
    'agent::executing',
    { cascade: false, _makeColumnSync: columnSyncReturning(outcome) },
  );
  return { result, warned, provider };
}

describe('transitionTicketState — board-sync outcome (Story #5784)', () => {
  it('returns a synced outcome and warns about nothing', async (t) => {
    const { result, warned } = await transitionWith(t, {
      status: 'synced',
      column: 'In Progress',
    });
    assert.deepEqual(result, {
      boardSync: { status: 'synced', column: 'In Progress' },
    });
    assert.deepEqual(warned, []);
  });

  it('reports a token without the project scope with its remedy', async (t) => {
    const { result, warned } = await transitionWith(t, {
      status: 'failed',
      reason: 'insufficient-scope',
      scope: 'project',
    });
    assert.equal(result.boardSync.status, 'failed');
    assert.equal(result.boardSync.reason, 'insufficient-scope');
    assert.equal(warned.length, 1);
    assert.match(warned[0], /#5784/);
    assert.match(warned[0], /agent::executing/);
    assert.match(warned[0], /insufficient-scope/);
    assert.match(warned[0], /gh auth refresh -h github\.com -s project/);
  });

  it('reports an issue missing from the board with the backfill remedy', async (t) => {
    const { result, warned } = await transitionWith(t, {
      status: 'skipped',
      reason: 'not-on-project',
    });
    assert.equal(result.boardSync.status, 'skipped');
    assert.equal(warned.length, 1);
    assert.match(warned[0], /not-on-project/);
    assert.match(warned[0], /board-backfill\.js/);
  });

  it('reports a board without a Status field, with no remedy to name', async (t) => {
    const { warned } = await transitionWith(t, {
      status: 'skipped',
      reason: 'no-meta',
    });
    assert.equal(warned.length, 1);
    assert.match(warned[0], /no-meta/);
    assert.doesNotMatch(warned[0], /fix:/);
  });

  it('stays silent when no board is configured', async (t) => {
    const { result, warned } = await transitionWith(t, {
      status: 'skipped',
      reason: 'no-project',
    });
    assert.equal(result.boardSync.reason, 'no-project');
    assert.deepEqual(warned, []);
  });

  it('leaves a GraphQL-blocked skip to the board-access latch (Story #5794)', async (t) => {
    const { result, warned } = await transitionWith(t, {
      status: 'skipped',
      reason: 'graphql-blocked',
    });
    assert.equal(result.boardSync.reason, 'graphql-blocked');
    // The latch already warned once for the process; no per-flip line.
    assert.deepEqual(warned, []);
  });

  it('reports a sync that threw as failed, and the label write still lands', async (t) => {
    const { result, warned, provider } = await transitionWith(
      t,
      new Error('GraphQL 502'),
    );
    assert.deepEqual(result.boardSync, {
      status: 'failed',
      reason: 'error',
      detail: 'GraphQL 502',
    });
    assert.equal(warned.length, 1);
    assert.match(warned[0], /GraphQL 502/);
    assert.equal(provider.updates.length, 1);
    assert.deepEqual(provider.updates[0].mutations.labels.add, [
      'agent::executing',
    ]);
  });
});
