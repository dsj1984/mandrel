/**
 * bookkeeping-outbox.test.js — Epic #4476 (M5): buffered GitHub bookkeeping.
 *
 * Pins the three load-bearing contracts:
 *   1. headless buffers to the local outbox; attended posts live;
 *   2. finalize (`reconcileOutbox`) drains every buffered comment + label to
 *      GitHub and clears the outbox;
 *   3. the `agent::blocked` HITL gate is NEVER buffered — it surfaces
 *      immediately even in headless mode.
 */

import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  enqueueComment,
  enqueueLabel,
  postCommentOrBuffer,
  readOutbox,
  reconcileOutbox,
  transitionStateOrBuffer,
} from '../../../.agents/scripts/lib/orchestration/bookkeeping-outbox.js';

let dir;
let outboxPath;

/**
 * Minimal fake provider that records the calls the reconcile sinks make.
 * `upsertStructuredComment` reaches `provider.getComments`/`postComment`;
 * `transitionTicketState` reaches `provider.getTicket`/`updateTicket`. We stub
 * the surface each needs and log the mutating calls.
 */
function makeFakeProvider() {
  const calls = { comments: [], labels: [] };
  let autoId = 1;
  const store = new Map();
  return {
    calls,
    async getTicketComments(ticketId) {
      return store.get(ticketId) ?? [];
    },
    async postComment(ticketId, payload) {
      const list = store.get(ticketId) ?? [];
      const c = { id: autoId++, body: payload.body };
      list.push(c);
      store.set(ticketId, list);
      calls.comments.push({ ticketId, body: payload.body });
      return c;
    },
    async deleteComment(commentId) {
      for (const [, list] of store) {
        const idx = list.findIndex((c) => c.id === commentId);
        if (idx !== -1) list.splice(idx, 1);
      }
    },
    async getTicket(ticketId) {
      return { number: ticketId, labels: [], body: '' };
    },
    async updateTicket(ticketId, mutations) {
      calls.labels.push({ ticketId, mutations });
      return { number: ticketId };
    },
    // Projects-v2 Status-column sync is best-effort inside
    // transitionTicketState; a no-op graphql keeps the label flip on the
    // fast path without a real GraphQL backend.
    async graphql() {
      return {};
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bookkeeping-outbox-'));
  outboxPath = path.join(dir, 'epic-1', 'bookkeeping-outbox.ndjson');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('enqueue + readOutbox', () => {
  it('appends comment and label ops in FIFO order', () => {
    enqueueComment({
      outboxPath,
      ticketId: 10,
      marker: 'progress',
      body: 'hello',
    });
    enqueueLabel({ outboxPath, ticketId: 10, state: 'agent::done' });
    const ops = readOutbox(outboxPath);
    assert.equal(ops.length, 2);
    assert.equal(ops[0].kind, 'comment');
    assert.equal(ops[0].marker, 'progress');
    assert.equal(ops[1].kind, 'label');
    assert.equal(ops[1].state, 'agent::done');
  });

  it('readOutbox tolerates a torn line and a missing file', () => {
    assert.deepEqual(readOutbox(path.join(dir, 'nope.ndjson')), []);
    enqueueComment({ outboxPath, ticketId: 1, marker: 'progress', body: 'x' });
    // Simulate a crash mid-write: append a torn (unparseable) line.
    mkdirSync(path.dirname(outboxPath), { recursive: true });
    appendFileSync(outboxPath, '{ "kind": "comment"', 'utf8');
    const ops = readOutbox(outboxPath);
    // The one well-formed op survives; the torn tail is skipped.
    assert.equal(ops.length, 1);
    assert.equal(ops[0].ticketId, 1);
  });
});

describe('postCommentOrBuffer', () => {
  it('buffers when headless (no live GitHub call)', async () => {
    const provider = makeFakeProvider();
    const res = await postCommentOrBuffer({
      provider,
      ticketId: 10,
      marker: 'progress',
      body: 'snapshot',
      headless: true,
      outboxPath,
    });
    assert.equal(res.buffered, true);
    assert.equal(provider.calls.comments.length, 0);
    assert.equal(readOutbox(outboxPath).length, 1);
  });

  it('posts live when attended (headless=false)', async () => {
    const provider = makeFakeProvider();
    const res = await postCommentOrBuffer({
      provider,
      ticketId: 10,
      marker: 'progress',
      body: 'snapshot',
      headless: false,
      outboxPath,
    });
    assert.equal(res.buffered, false);
    assert.equal(provider.calls.comments.length, 1);
    assert.equal(existsSync(outboxPath), false);
  });
});

describe('transitionStateOrBuffer', () => {
  it('buffers a non-urgent label flip when headless', async () => {
    const provider = makeFakeProvider();
    const res = await transitionStateOrBuffer({
      provider,
      ticketId: 10,
      state: 'agent::done',
      headless: true,
      outboxPath,
    });
    assert.equal(res.buffered, true);
    assert.equal(provider.calls.labels.length, 0);
    assert.equal(readOutbox(outboxPath).length, 1);
  });

  it('NEVER buffers agent::blocked — surfaces immediately even headless', async () => {
    const provider = makeFakeProvider();
    const res = await transitionStateOrBuffer({
      provider,
      ticketId: 10,
      state: 'agent::blocked',
      headless: true,
      outboxPath,
    });
    assert.equal(res.buffered, false);
    // Live transition happened; nothing was buffered.
    assert.equal(provider.calls.labels.length, 1);
    assert.equal(
      provider.calls.labels[0].mutations.labels.add[0],
      'agent::blocked',
    );
    assert.equal(existsSync(outboxPath), false);
  });

  it('honours an explicit urgent flag for a non-blocked state', async () => {
    const provider = makeFakeProvider();
    const res = await transitionStateOrBuffer({
      provider,
      ticketId: 10,
      state: 'agent::executing',
      headless: true,
      outboxPath,
      urgent: true,
    });
    assert.equal(res.buffered, false);
    assert.equal(provider.calls.labels.length, 1);
  });
});

describe('reconcileOutbox (finalize drain)', () => {
  it('drains every buffered comment + label to GitHub and clears the outbox', async () => {
    const provider = makeFakeProvider();
    // Buffer a headless run's worth of bookkeeping.
    await postCommentOrBuffer({
      provider,
      ticketId: 10,
      marker: 'progress',
      body: 'p1',
      headless: true,
      outboxPath,
    });
    await postCommentOrBuffer({
      provider,
      ticketId: 10,
      marker: 'friction',
      body: 'f1',
      headless: true,
      outboxPath,
    });
    await transitionStateOrBuffer({
      provider,
      ticketId: 10,
      state: 'agent::done',
      headless: true,
      outboxPath,
    });
    assert.equal(readOutbox(outboxPath).length, 3);
    // Nothing hit GitHub yet.
    assert.equal(provider.calls.comments.length, 0);
    assert.equal(provider.calls.labels.length, 0);

    const result = await reconcileOutbox({ outboxPath, provider });
    assert.equal(result.drained, 3);
    assert.equal(result.comments, 2);
    assert.equal(result.labels, 1);
    assert.deepEqual(result.errors, []);
    assert.equal(result.cleared, true);

    // GitHub now carries the buffered mutations.
    assert.equal(provider.calls.comments.length, 2);
    assert.equal(provider.calls.labels.length, 1);
    // Outbox drained to empty.
    assert.equal(readOutbox(outboxPath).length, 0);
  });

  it('is a no-op on an empty / absent outbox', async () => {
    const provider = makeFakeProvider();
    const result = await reconcileOutbox({ outboxPath, provider });
    assert.equal(result.drained, 0);
    assert.equal(result.cleared, true);
  });

  it('retains the outbox when an op fails (crash-recovery)', async () => {
    const provider = makeFakeProvider();
    provider.updateTicket = async () => {
      throw new Error('gh 503');
    };
    enqueueComment({ outboxPath, ticketId: 10, marker: 'progress', body: 'p' });
    enqueueLabel({ outboxPath, ticketId: 10, state: 'agent::done' });

    const result = await reconcileOutbox({ outboxPath, provider });
    assert.equal(result.comments, 1);
    assert.equal(result.errors.length, 1);
    assert.equal(result.cleared, false);
    // The whole batch is retained for the next reconcile.
    assert.equal(readOutbox(outboxPath).length, 2);
  });
});
