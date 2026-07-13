// tests/scripts/slice-phase.test.js
//
// Unit tier (Epic #4475, M4-B): the single-delivery slice-phase CLI — the
// executor's wiring to (a) emit a slice.start/end/heartbeat ledger record and
// (b) flip the epic-run-state slice marker. DI shape: an injected provider +
// a ledgerPath override (no real GitHub / no real temp path).

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  initializeSingle,
  read as readEpicRunState,
} from '../../.agents/scripts/lib/orchestration/epic-run-state-store.js';
import { parseArgv, runSlicePhase } from '../../.agents/scripts/slice-phase.js';

function createFakeProvider() {
  let autoId = 1;
  const comments = new Map();
  return {
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

describe('slice-phase — ledger emit', () => {
  let dir;
  let ledgerPath;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'slice-phase-'));
    ledgerPath = path.join(dir, 'lifecycle.ndjson');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits slice.start and returns an envelope', async () => {
    const provider = createFakeProvider();
    const out = await runSlicePhase({
      epicId: 4475,
      sliceId: 'slice-1',
      event: 'start',
      sliceIndex: 0,
      title: 'Seed schema',
      provider,
      config: null,
      ledgerPath,
    });
    assert.equal(out.ok, true);
    assert.equal(out.event, 'start');
    assert.equal(out.emitted, true);
    assert.equal(out.recorded, false);
    const record = JSON.parse(readFileSync(ledgerPath, 'utf8').trim());
    assert.equal(record.event, 'slice.start');
    assert.equal(record.payload.sliceId, 'slice-1');
  });

  it('emits slice.heartbeat with the requested phase', async () => {
    const provider = createFakeProvider();
    await runSlicePhase({
      epicId: 4475,
      sliceId: 'slice-2',
      event: 'heartbeat',
      phase: 'implementing',
      provider,
      config: null,
      ledgerPath,
    });
    const record = JSON.parse(readFileSync(ledgerPath, 'utf8').trim());
    assert.equal(record.event, 'slice.heartbeat');
    assert.equal(record.payload.phase, 'implementing');
  });

  it('emits slice.end with an outcome', async () => {
    const provider = createFakeProvider();
    await runSlicePhase({
      epicId: 4475,
      sliceId: 'slice-1',
      event: 'end',
      outcome: 'done',
      provider,
      config: null,
      ledgerPath,
    });
    const record = JSON.parse(readFileSync(ledgerPath, 'utf8').trim());
    assert.equal(record.event, 'slice.end');
    assert.equal(record.payload.outcome, 'done');
  });

  it('--no-emit suppresses the ledger write', async () => {
    const provider = createFakeProvider();
    const out = await runSlicePhase({
      epicId: 4475,
      sliceId: 'slice-1',
      event: 'heartbeat',
      noEmit: true,
      provider,
      config: null,
      ledgerPath,
    });
    assert.equal(out.emitted, false);
    assert.throws(() => readFileSync(ledgerPath, 'utf8'));
  });
});

describe('slice-phase — checkpoint marker flip (--record)', () => {
  it('flips the slice marker pending → done when --record done', async () => {
    const provider = createFakeProvider();
    const epicId = 4475;
    await initializeSingle({
      provider,
      epicId,
      slices: [
        { slice: 'A', independent: false },
        { slice: 'B', independent: false },
      ],
    });

    const out = await runSlicePhase({
      epicId,
      sliceId: 'slice-1',
      event: 'end',
      outcome: 'done',
      record: 'done',
      noEmit: true, // isolate the checkpoint flip from the ledger emit
      provider,
      config: null,
    });
    assert.equal(out.recorded, true);
    assert.equal(out.status, 'done');

    const state = await readEpicRunState({ provider, epicId });
    assert.equal(state.slices['slice-1'].status, 'done');
    assert.equal(state.slices['slice-2'].status, 'pending');
  });

  it('does not touch the checkpoint when --record is omitted', async () => {
    const provider = createFakeProvider();
    const epicId = 4475;
    await initializeSingle({
      provider,
      epicId,
      slices: [{ slice: 'A', independent: false }],
    });
    const out = await runSlicePhase({
      epicId,
      sliceId: 'slice-1',
      event: 'heartbeat',
      noEmit: true,
      provider,
      config: null,
    });
    assert.equal(out.recorded, false);
    const state = await readEpicRunState({ provider, epicId });
    assert.equal(state.slices['slice-1'].status, 'pending');
  });
});

describe('slice-phase — validation', () => {
  it('rejects a bad event / missing outcome / bad epicId', async () => {
    const provider = createFakeProvider();
    await assert.rejects(
      () =>
        runSlicePhase({
          epicId: 4475,
          sliceId: 'slice-1',
          event: 'nope',
          provider,
          config: null,
        }),
      /--event/,
    );
    await assert.rejects(
      () =>
        runSlicePhase({
          epicId: 4475,
          sliceId: 'slice-1',
          event: 'end',
          provider,
          config: null,
        }),
      /requires --outcome/,
    );
    await assert.rejects(
      () =>
        runSlicePhase({
          epicId: 0,
          sliceId: 'slice-1',
          event: 'start',
          provider,
          config: null,
        }),
      /positive integer/,
    );
  });
});

describe('slice-phase — parseArgv', () => {
  it('parses the end + record invocation', () => {
    const parsed = parseArgv([
      '--epic',
      '4475',
      '--slice',
      'slice-3',
      '--event',
      'end',
      '--outcome',
      'done',
      '--record',
      'done',
      '--slice-index',
      '2',
    ]);
    assert.equal(parsed.epicId, 4475);
    assert.equal(parsed.sliceId, 'slice-3');
    assert.equal(parsed.event, 'end');
    assert.equal(parsed.outcome, 'done');
    assert.equal(parsed.record, 'done');
    assert.equal(parsed.sliceIndex, 2);
  });
});
