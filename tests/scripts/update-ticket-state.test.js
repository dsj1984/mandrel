// tests/scripts/update-ticket-state.test.js
/**
 * Unit tests for the sanctioned label-mutation CLI's decision body,
 * `runUpdateTicketState`: argument validation, the remove-label-only path
 * and the state(+remove-label) path, each against an injected provider and
 * transition — no GitHub call is made.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { setLevel } from '../../.agents/scripts/lib/Logger.js';
import { runUpdateTicketState } from '../../.agents/scripts/update-ticket-state.js';

const SCRIPT = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '.agents',
  'scripts',
  'update-ticket-state.js',
);

function fakeProvider() {
  const updates = [];
  return {
    updates,
    updateTicket: async (id, patch) => {
      updates.push([id, patch]);
    },
  };
}

function fakeTransition() {
  const calls = [];
  const transition = async (provider, id, state) => {
    calls.push([provider, id, state]);
  };
  return { calls, transition };
}

describe('runUpdateTicketState — argument validation', () => {
  beforeEach(() => setLevel('silent'));
  afterEach(() => setLevel(null));

  for (const [label, argv] of [
    ['a missing --ticket', ['--state', 'agent::ready']],
    ['a non-numeric --ticket', ['--ticket', 'abc', '--state', 'agent::ready']],
    ['neither --state nor --remove-label', ['--ticket', '42']],
  ]) {
    it(`rejects ${label} before touching the provider`, async () => {
      const provider = fakeProvider();
      const { calls, transition } = fakeTransition();

      await assert.rejects(
        runUpdateTicketState({ argv, provider, transition }),
        /Usage: node update-ticket-state\.js --ticket <id>/,
      );
      assert.deepEqual(provider.updates, []);
      assert.deepEqual(calls, []);
    });
  }
});

describe('runUpdateTicketState — mutation paths', () => {
  beforeEach(() => setLevel('silent'));
  afterEach(() => setLevel(null));

  it('removes only the label when --remove-label is given without --state', async () => {
    const provider = fakeProvider();
    const { calls, transition } = fakeTransition();

    const res = await runUpdateTicketState({
      argv: ['--ticket', '42', '--remove-label', 'status::blocked'],
      provider,
      transition,
    });

    assert.deepEqual(calls, [], 'no state transition on the label-only path');
    assert.deepEqual(provider.updates, [
      [42, { labels: { remove: ['status::blocked'] } }],
    ]);
    assert.deepEqual(res, {
      ticketId: 42,
      state: null,
      removedLabel: 'status::blocked',
    });
  });

  it('transitions the state alone when only --state is given', async () => {
    const provider = fakeProvider();
    const { calls, transition } = fakeTransition();

    const res = await runUpdateTicketState({
      argv: ['--ticket', '7', '--state', 'agent::executing'],
      provider,
      transition,
    });

    assert.deepEqual(calls, [[provider, 7, 'agent::executing']]);
    assert.deepEqual(provider.updates, []);
    assert.deepEqual(res, {
      ticketId: 7,
      state: 'agent::executing',
      removedLabel: null,
    });
  });

  it('transitions the state, then removes the secondary label', async () => {
    const order = [];
    const provider = {
      updateTicket: async (id, patch) => {
        order.push(['update', id, patch]);
      },
    };
    const transition = async (_p, id, state) => {
      order.push(['transition', id, state]);
    };

    await runUpdateTicketState({
      argv: [
        '--ticket',
        '9',
        '--state',
        'agent::ready',
        '--remove-label',
        'status::blocked',
      ],
      provider,
      transition,
    });

    assert.deepEqual(order, [
      ['transition', 9, 'agent::ready'],
      ['update', 9, { labels: { remove: ['status::blocked'] } }],
    ]);
  });

  it('propagates a transition failure', async () => {
    const provider = fakeProvider();

    await assert.rejects(
      runUpdateTicketState({
        argv: ['--ticket', '9', '--state', 'agent::done'],
        provider,
        transition: async () => {
          throw new Error('rate limited');
        },
      }),
      /rate limited/,
    );
    assert.deepEqual(provider.updates, []);
  });
});

describe('update-ticket-state CLI entry', () => {
  it('--help prints the usage block without running the work path', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--help'], {
      encoding: 'utf8',
    });

    assert.equal(run.status, 0, run.stderr);
    assert.match(
      run.stdout,
      /^Usage: node \.agents\/scripts\/update-ticket-state\.js /m,
    );
  });

  it('exits non-zero with the usage error on invalid argv', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--ticket', 'x'], {
      encoding: 'utf8',
    });

    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /Usage: node update-ticket-state\.js/);
  });
});
