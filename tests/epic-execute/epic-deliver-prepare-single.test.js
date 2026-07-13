import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runEpicDeliverPrepareSingle } from '../../.agents/scripts/epic-deliver-prepare.js';
import {
  EPIC_RUN_STATE_TYPE,
  read as readEpicRunState,
  write as writeEpicRunState,
} from '../../.agents/scripts/lib/orchestration/epic-run-state-store.js';
import { structuredCommentMarker } from '../../.agents/scripts/lib/orchestration/ticketing.js';

/**
 * tests/epic-execute/epic-deliver-prepare-single.test.js — the `--single`
 * prepare contract (Epic #4475, M4-A).
 *
 * The DI shape mirrors the fan-out prepare suite: an in-memory provider + a
 * config with no git seam. Under that shape `runEpicDeliverPrepareSingle`
 * suppresses the preflight guards AND the real worktree seed (no git spawns),
 * so the test exercises the pure prepare logic — the slice-map checkpoint, the
 * acceptance::n-a refusal, and the Story-enumeration short-circuit.
 */

function createFakeProvider({ epic }) {
  let autoId = 1;
  const comments = new Map();
  return {
    _comments: comments,
    async getTicket(id) {
      return id === epic.id ? epic : null;
    },
    // If the single path ever reached the fan-out enumeration, it would call
    // getSubTickets — make that a loud failure so the short-circuit is proven.
    async getSubTickets() {
      throw new Error('getSubTickets must not be called under --single');
    },
    async getTicketComments(ticketId) {
      return comments.get(ticketId) ?? [];
    },
    async postComment(ticketId, payload) {
      const list = comments.get(ticketId) ?? [];
      const c = { id: autoId++, body: payload.body };
      list.push(c);
      comments.set(ticketId, list);
      return c;
    },
    async deleteComment(commentId) {
      for (const [, list] of comments) {
        const idx = list.findIndex((c) => c.id === commentId);
        if (idx !== -1) list.splice(idx, 1);
      }
    },
  };
}

function readPersistedCheckpoint(provider, epicId) {
  const comments = provider._comments.get(epicId) ?? [];
  const checkpoint = comments.find((c) =>
    c.body.includes(structuredCommentMarker(EPIC_RUN_STATE_TYPE)),
  );
  if (!checkpoint) return null;
  const fenced = checkpoint.body.match(/```json\n([\s\S]+?)\n```/);
  return JSON.parse(fenced[1]);
}

const baseConfig = {
  github: { owner: 'test-owner', repo: 'test-repo' },
  project: { baseBranch: 'main' },
};

const slicingBody = [
  '## Delivery Slicing',
  '',
  '| Slice | Independent? |',
  '| --- | --- |',
  '| Seed the schema | No |',
  '| Wire the reader | No |',
  '| Ship the executor | No |',
  '',
].join('\n');

describe('runEpicDeliverPrepareSingle — slice-map checkpoint', () => {
  it('writes deliveryShape:single, storyCount:0, cap:1, and the slice map', async () => {
    const epic = {
      id: 4475,
      labels: ['type::epic', 'delivery::single'],
      body: slicingBody,
      title: 'Single-delivery Epic',
    };
    const provider = createFakeProvider({ epic });

    const result = await runEpicDeliverPrepareSingle({
      epicId: 4475,
      injectedProvider: provider,
      injectedConfig: baseConfig,
    });

    assert.equal(result.deliveryShape, 'single');
    assert.equal(result.storyCount, 0);
    assert.equal(result.concurrencyCap, 1);
    assert.equal(result.sliceCount, 3);
    assert.deepEqual(Object.keys(result.slices), [
      'slice-1',
      'slice-2',
      'slice-3',
    ]);

    const persisted = readPersistedCheckpoint(provider, 4475);
    assert.equal(persisted.deliveryShape, 'single');
    assert.equal(persisted.storyCount, 0);
    assert.equal(persisted.slices['slice-1'].status, 'pending');
    assert.equal(persisted.slices['slice-1'].title, 'Seed the schema');
  });

  it('does NOT feed stories through the fan-out enumeration path', async () => {
    // getSubTickets throws in the fake; a successful prepare proves the
    // short-circuit (the fan-out path enumerates children, the single path
    // never does).
    const epic = {
      id: 42,
      labels: ['type::epic', 'delivery::single'],
      body: slicingBody,
    };
    const provider = createFakeProvider({ epic });
    const result = await runEpicDeliverPrepareSingle({
      epicId: 42,
      injectedProvider: provider,
      injectedConfig: baseConfig,
    });
    assert.equal(result.storyCount, 0);
  });

  it('tolerates a missing Delivery Slicing table (empty slice map)', async () => {
    const epic = {
      id: 7,
      labels: ['type::epic', 'delivery::single'],
      body: '## Overview\n\nNo slicing table here.\n',
    };
    const provider = createFakeProvider({ epic });
    const result = await runEpicDeliverPrepareSingle({
      epicId: 7,
      injectedProvider: provider,
      injectedConfig: baseConfig,
    });
    assert.equal(result.sliceCount, 0);
    assert.deepEqual(result.slices, {});
  });
});

describe('runEpicDeliverPrepareSingle — fail-closed gates', () => {
  it('refuses acceptance::n-a with the blocker message', async () => {
    const epic = {
      id: 99,
      labels: ['type::epic', 'delivery::single', 'acceptance::n-a'],
      body: slicingBody,
    };
    const provider = createFakeProvider({ epic });
    await assert.rejects(
      runEpicDeliverPrepareSingle({
        epicId: 99,
        injectedProvider: provider,
        injectedConfig: baseConfig,
      }),
      /BLOCKER.*acceptance::n-a|acceptance::n-a.*only acceptance gate/s,
    );
    // No checkpoint written — the refusal is a front gate.
    assert.equal(readPersistedCheckpoint(provider, 99), null);
  });

  it('refuses a non-Epic ticket', async () => {
    const epic = {
      id: 5,
      labels: ['type::story'],
      body: slicingBody,
    };
    const provider = createFakeProvider({ epic });
    await assert.rejects(
      runEpicDeliverPrepareSingle({
        epicId: 5,
        injectedProvider: provider,
        injectedConfig: baseConfig,
      }),
      /is not a type::epic/,
    );
  });
});

describe('runEpicDeliverPrepareSingle — resume', () => {
  it('preserves an already-done slice on a re-prepare', async () => {
    const epic = {
      id: 4475,
      labels: ['type::epic', 'delivery::single'],
      body: slicingBody,
    };
    const provider = createFakeProvider({ epic });

    await runEpicDeliverPrepareSingle({
      epicId: 4475,
      injectedProvider: provider,
      injectedConfig: baseConfig,
    });

    // Simulate the executor completing slice-1 by persisting a done slice
    // through the store (the same path the M4-B executor will write through).
    const state = await readEpicRunState({ provider, epicId: 4475 });
    await writeEpicRunState({
      provider,
      epicId: 4475,
      state: {
        ...state,
        slices: {
          ...state.slices,
          'slice-1': { status: 'done', title: 'Seed the schema' },
        },
      },
    });

    const resumed = await runEpicDeliverPrepareSingle({
      epicId: 4475,
      injectedProvider: provider,
      injectedConfig: baseConfig,
    });
    assert.equal(resumed.slices['slice-1'].status, 'done');
    assert.equal(resumed.slices['slice-2'].status, 'pending');
  });
});
