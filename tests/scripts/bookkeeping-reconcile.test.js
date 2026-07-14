/**
 * bookkeeping-reconcile.test.js — Epic #4476 (M5).
 *
 * The finalize-time drainer CLI core (`runBookkeepingReconcile`): resolves the
 * per-Epic outbox and replays it to GitHub via the shared library. Uses an
 * injected outbox path + fake provider — no real GitHub, no real temp path.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  main,
  parseArgv,
  runBookkeepingReconcile,
} from '../../.agents/scripts/bookkeeping-reconcile.js';
import {
  enqueueComment,
  enqueueLabel,
  readOutbox,
} from '../../.agents/scripts/lib/orchestration/bookkeeping-outbox.js';

let dir;
let outboxPath;

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
      calls.comments.push({ ticketId });
      return c;
    },
    async deleteComment() {},
    async getTicket(ticketId) {
      return { number: ticketId, labels: [], body: '' };
    },
    async updateTicket(ticketId) {
      calls.labels.push({ ticketId });
      return { number: ticketId };
    },
    async graphql() {
      return {};
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bookkeeping-reconcile-'));
  outboxPath = path.join(dir, 'bookkeeping-outbox.ndjson');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseArgv / main', () => {
  it('parseArgv reads --epic and --help', () => {
    const values = parseArgv(['--epic', '12', '--help']);
    assert.equal(values.epic, '12');
    assert.equal(values.help, true);
  });

  it('main --help writes usage and returns', async () => {
    const chunks = [];
    const orig = process.stdout.write;
    process.stdout.write = (chunk) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      await main(['--help']);
    } finally {
      process.stdout.write = orig;
    }
    assert.match(chunks.join(''), /bookkeeping-reconcile/);
  });

  it('main without --epic exits 2', async () => {
    const prev = process.exit;
    let code;
    process.exit = (c) => {
      code = c;
      throw new Error(`exit:${c}`);
    };
    const errChunks = [];
    const origErr = process.stderr.write;
    process.stderr.write = (chunk) => {
      errChunks.push(String(chunk));
      return true;
    };
    try {
      await assert.rejects(() => main([]), /exit:2/);
      assert.equal(code, 2);
      assert.match(errChunks.join(''), /--epic/);
    } finally {
      process.exit = prev;
      process.stderr.write = origErr;
    }
  });
});

describe('runBookkeepingReconcile', () => {
  it('drains the outbox and reports ok', async () => {
    enqueueComment({ outboxPath, ticketId: 5, marker: 'progress', body: 'x' });
    enqueueLabel({ outboxPath, ticketId: 5, state: 'agent::done' });
    const provider = makeFakeProvider();

    const envelope = await runBookkeepingReconcile({
      epicId: 5,
      provider,
      outboxPath,
    });

    assert.equal(envelope.ok, true);
    assert.equal(envelope.epicId, 5);
    assert.equal(envelope.drained, 2);
    assert.equal(provider.calls.comments.length, 1);
    assert.equal(provider.calls.labels.length, 1);
    assert.equal(readOutbox(outboxPath).length, 0);
  });

  it('reports not-ok and retains the outbox when an op fails', async () => {
    enqueueLabel({ outboxPath, ticketId: 5, state: 'agent::done' });
    const provider = makeFakeProvider();
    provider.updateTicket = async () => {
      throw new Error('boom');
    };

    const envelope = await runBookkeepingReconcile({
      epicId: 5,
      provider,
      outboxPath,
    });

    assert.equal(envelope.ok, false);
    assert.equal(envelope.errors.length, 1);
    assert.equal(readOutbox(outboxPath).length, 1);
  });
});
