// tests/lib/orchestration/epic-run-state-store-slice.test.js
//
// Unit tier (Epic #4475, M4-A): the single-delivery slice-map checkpoint —
// the analogue of the per-Story status map (Story #4155). Pins the pure
// helpers (`buildSliceStatusMap`, `mergeSliceStatuses`) and the
// checkpoint round-trip / resume contract of `initializeSingle` (a re-run
// preserves every already-`done` slice so the executor skips it).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildSliceStatusMap,
  initializeSingle,
  mergeSliceStatuses,
  read,
  recordSliceStatus,
  SLICE_STATUSES,
  write,
} from '../../../.agents/scripts/lib/orchestration/epic-run-state-store.js';

function createFakeProvider() {
  let autoId = 1;
  const comments = new Map();
  return {
    async getTicketComments(ticketId) {
      return comments.get(ticketId) ?? [];
    },
    async postComment(ticketId, payload) {
      const list = comments.get(ticketId) ?? [];
      const comment = { id: autoId++, body: payload.body };
      list.push(comment);
      comments.set(ticketId, list);
      return comment;
    },
    async deleteComment(commentId) {
      for (const [, list] of comments) {
        const idx = list.findIndex((c) => c.id === commentId);
        if (idx !== -1) list.splice(idx, 1);
      }
    },
  };
}

describe('slice-map — pure helpers', () => {
  it('buildSliceStatusMap seeds every slice pending, keyed slice-<n> with a title', () => {
    const map = buildSliceStatusMap([
      { slice: 'Seed the schema', independent: false },
      { slice: 'Wire the reader', independent: true },
    ]);
    assert.deepEqual(map, {
      'slice-1': { status: 'pending', title: 'Seed the schema' },
      'slice-2': { status: 'pending', title: 'Wire the reader' },
    });
  });

  it('buildSliceStatusMap tolerates bare-string slices and non-arrays', () => {
    assert.deepEqual(buildSliceStatusMap(['A']), {
      'slice-1': { status: 'pending', title: 'A' },
    });
    assert.deepEqual(buildSliceStatusMap(null), {});
    assert.deepEqual(buildSliceStatusMap(undefined), {});
  });

  it('mergeSliceStatuses preserves prior status, refreshes title, adds new slices', () => {
    const prior = {
      'slice-1': { status: 'done', title: 'old' },
      'slice-2': { status: 'pending' },
    };
    const seed = {
      'slice-1': { status: 'pending', title: 'new' },
      'slice-2': { status: 'pending' },
      'slice-3': { status: 'pending', title: 'added' },
    };
    assert.deepEqual(mergeSliceStatuses(prior, seed), {
      'slice-1': { status: 'done', title: 'new' },
      'slice-2': { status: 'pending' },
      'slice-3': { status: 'pending', title: 'added' },
    });
  });

  it('SLICE_STATUSES covers the durable + stalled states', () => {
    assert.deepEqual(
      [...SLICE_STATUSES],
      ['pending', 'done', 'blocked', 'failed'],
    );
  });
});

describe('initializeSingle — first run', () => {
  it('writes the single-delivery slice-map shape', async () => {
    const provider = createFakeProvider();
    const epicId = 4475;
    const state = await initializeSingle({
      provider,
      epicId,
      slices: [
        { slice: 'A', independent: false },
        { slice: 'B', independent: false },
      ],
    });
    assert.equal(state.deliveryShape, 'single');
    assert.equal(state.storyCount, 0);
    assert.equal(state.concurrencyCap, 1);
    assert.deepEqual(state.slices, {
      'slice-1': { status: 'pending', title: 'A' },
      'slice-2': { status: 'pending', title: 'B' },
    });
    // Round-trips through the structured comment.
    const readBack = await read({ provider, epicId });
    assert.deepEqual(readBack.slices, state.slices);
  });
});

describe('initializeSingle — checkpoint round-trip / resume', () => {
  it('preserves an already-done slice across a re-prepare', async () => {
    const provider = createFakeProvider();
    const epicId = 4475;
    const slices = [
      { slice: 'A', independent: false },
      { slice: 'B', independent: false },
      { slice: 'C', independent: false },
    ];

    const first = await initializeSingle({ provider, epicId, slices });
    // Executor marks slice-1 done (its work now sits on epic/<id>).
    await write({
      provider,
      epicId,
      state: {
        ...first,
        slices: { ...first.slices, 'slice-1': { status: 'done', title: 'A' } },
      },
    });

    // Re-prepare over the SAME table (crash-resume): done slice survives,
    // pending slices stay pending.
    const resumed = await initializeSingle({ provider, epicId, slices });
    assert.equal(resumed.slices['slice-1'].status, 'done');
    assert.equal(resumed.slices['slice-2'].status, 'pending');
    assert.equal(resumed.slices['slice-3'].status, 'pending');
    // startedAt is preserved from the first run (idempotent).
    assert.equal(resumed.startedAt, first.startedAt);
  });

  it('is a no-op rewrite when nothing changed (idempotent)', async () => {
    const provider = createFakeProvider();
    const epicId = 900;
    const slices = [{ slice: 'A', independent: false }];
    const first = await initializeSingle({ provider, epicId, slices });
    const second = await initializeSingle({ provider, epicId, slices });
    assert.equal(second.startedAt, first.startedAt);
    assert.deepEqual(second.slices, first.slices);
  });
});

describe('recordSliceStatus — the executor slice-walk marker flip (M4-B)', () => {
  it('flips one slice pending → done, preserving siblings + run-level fields', async () => {
    const provider = createFakeProvider();
    const epicId = 4475;
    const slices = [
      { slice: 'A', independent: false },
      { slice: 'B', independent: false },
    ];
    const seeded = await initializeSingle({ provider, epicId, slices });

    const after = await recordSliceStatus({
      provider,
      epicId,
      sliceId: 'slice-1',
      status: 'done',
    });

    assert.equal(after.slices['slice-1'].status, 'done');
    // Sibling + run-level fields untouched.
    assert.equal(after.slices['slice-2'].status, 'pending');
    assert.equal(after.deliveryShape, 'single');
    assert.equal(after.storyCount, 0);
    assert.equal(after.startedAt, seeded.startedAt);
    // Persisted (a resumed run reads this back and skips slice-1).
    const readBack = await read({ provider, epicId });
    assert.equal(readBack.slices['slice-1'].status, 'done');
  });

  it('preserves the prior title when the flip omits one', async () => {
    const provider = createFakeProvider();
    const epicId = 4475;
    await initializeSingle({
      provider,
      epicId,
      slices: [{ slice: 'Seed schema', independent: false }],
    });
    const after = await recordSliceStatus({
      provider,
      epicId,
      sliceId: 'slice-1',
      status: 'done',
    });
    assert.equal(after.slices['slice-1'].title, 'Seed schema');
  });

  it('records a blocked slice (stalled walk)', async () => {
    const provider = createFakeProvider();
    const epicId = 4475;
    await initializeSingle({
      provider,
      epicId,
      slices: [{ slice: 'A', independent: false }],
    });
    const after = await recordSliceStatus({
      provider,
      epicId,
      sliceId: 'slice-1',
      status: 'blocked',
    });
    assert.equal(after.slices['slice-1'].status, 'blocked');
  });

  it('rejects an unknown status and an empty sliceId', async () => {
    const provider = createFakeProvider();
    const epicId = 4475;
    await initializeSingle({
      provider,
      epicId,
      slices: [{ slice: 'A', independent: false }],
    });
    await assert.rejects(
      () =>
        recordSliceStatus({
          provider,
          epicId,
          sliceId: 'slice-1',
          status: 'mystery',
        }),
      /must be one of/,
    );
    await assert.rejects(
      () =>
        recordSliceStatus({ provider, epicId, sliceId: '', status: 'done' }),
      /non-empty string/,
    );
  });

  it('upgrades a legacy checkpoint with no slices map in place', async () => {
    const provider = createFakeProvider();
    const epicId = 4475;
    // A checkpoint that predates the slices field.
    await write({
      provider,
      epicId,
      state: { epicId, deliveryShape: 'single', storyCount: 0 },
    });
    const after = await recordSliceStatus({
      provider,
      epicId,
      sliceId: 'slice-1',
      status: 'done',
      title: 'A',
    });
    assert.deepEqual(after.slices, {
      'slice-1': { status: 'done', title: 'A' },
    });
  });
});
