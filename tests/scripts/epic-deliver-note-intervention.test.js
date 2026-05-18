import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseNoteArgs,
  runNoteIntervention,
} from '../../.agents/scripts/epic-deliver-note-intervention.js';

describe('parseNoteArgs', () => {
  it('parses --epic --reason --source into the normalized bag', () => {
    const out = parseNoteArgs([
      '--epic',
      '1178',
      '--reason',
      'discarded -593 drift',
      '--source',
      'host-llm',
    ]);
    assert.deepEqual(out, {
      epicId: 1178,
      reason: 'discarded -593 drift',
      source: 'host-llm',
      help: false,
    });
  });

  it('returns null fields for missing / invalid input', () => {
    const out = parseNoteArgs([]);
    assert.equal(out.epicId, null);
    assert.equal(out.reason, null);
    assert.equal(out.source, null);
  });

  it('rejects non-positive epic ids', () => {
    assert.equal(parseNoteArgs(['--epic', '0']).epicId, null);
    assert.equal(parseNoteArgs(['--epic', '-1']).epicId, null);
  });

  it('trims whitespace from reason / source', () => {
    const out = parseNoteArgs([
      '--epic',
      '7',
      '--reason',
      '   hello   ',
      '--source',
      '  retro-runner  ',
    ]);
    assert.equal(out.reason, 'hello');
    assert.equal(out.source, 'retro-runner');
  });
});

/**
 * Build a minimal fake bus that records emits and forwards them to the
 * one listener registered for the event. The real Bus validates payloads
 * against the lifecycle schema, but the fake here is intentionally
 * looser — the CLI's contract is "emit a payload, then surface what the
 * listener persisted." Schema conformance is pinned separately by the
 * Bus's own contract tests.
 */
function createFakeBus() {
  const listeners = new Map();
  const emits = [];
  let seqId = 1;
  return {
    emits,
    on(event, fn) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
      return () => {};
    },
    async emit(event, payload) {
      emits.push({ event, payload });
      const list = listeners.get(event) ?? [];
      for (const fn of list) {
        await fn({ event, seqId: seqId++, payload });
      }
      return { seqId: seqId - 1 };
    },
  };
}

describe('runNoteIntervention', () => {
  it('emits intervention.recorded with reason+source and returns total/intervention', async () => {
    const recorded = [];
    const out = await runNoteIntervention({
      epicId: 1178,
      reason: 'stash dance',
      source: 'merge-recovery',
      injectedConfig: { orchestration: { provider: 'fake' } },
      injectedProvider: {},
      busFactory: () => createFakeBus(),
      listenerFactory: ({ epicId }) => ({
        register(bus) {
          bus.on('intervention.recorded', async ({ payload }) => {
            if (payload.epicId !== epicId) return;
            recorded.push({ reason: payload.reason, source: payload.source });
          });
        },
      }),
      readEpicRunState: async () => ({
        manualInterventions: recorded.map((r, i) => ({
          reason: r.reason,
          source: r.source,
          ts: `2026-05-11T00:00:0${i}.000Z`,
        })),
      }),
      now: () => '2026-05-11T00:00:00.000Z',
    });
    assert.equal(out.epicId, 1178);
    assert.equal(out.total, 1);
    assert.equal(out.intervention.reason, 'stash dance');
    assert.equal(out.intervention.source, 'merge-recovery');
    assert.deepEqual(recorded, [
      { reason: 'stash dance', source: 'merge-recovery' },
    ]);
  });

  it('defaults source to host-llm when omitted', async () => {
    let captured = null;
    const out = await runNoteIntervention({
      epicId: 1,
      reason: 'r',
      injectedConfig: { orchestration: { provider: 'fake' } },
      injectedProvider: {},
      busFactory: () => createFakeBus(),
      listenerFactory: () => ({
        register(bus) {
          bus.on('intervention.recorded', async ({ payload }) => {
            captured = payload;
          });
        },
      }),
      readEpicRunState: async () => ({
        manualInterventions: [
          {
            reason: captured?.reason ?? 'r',
            source: captured?.source ?? 'host-llm',
            ts: 't',
          },
        ],
      }),
    });
    assert.equal(captured.source, 'host-llm');
    assert.equal(out.intervention.source, 'host-llm');
  });

  it('builds an intervention.recorded payload conforming to {epicId, reason, source, ts}', async () => {
    let captured = null;
    await runNoteIntervention({
      epicId: 42,
      reason: 'manual --no-ff recovery',
      source: 'host-llm',
      injectedConfig: { orchestration: { provider: 'fake' } },
      injectedProvider: {},
      busFactory: () => createFakeBus(),
      listenerFactory: () => ({
        register(bus) {
          bus.on('intervention.recorded', async ({ payload }) => {
            captured = payload;
          });
        },
      }),
      readEpicRunState: async () => ({ manualInterventions: [] }),
      now: () => '2026-05-11T01:02:03.000Z',
    });
    assert.deepEqual(captured, {
      epicId: 42,
      reason: 'manual --no-ff recovery',
      source: 'host-llm',
      ts: '2026-05-11T01:02:03.000Z',
    });
  });

  it('rejects bad args', async () => {
    await assert.rejects(
      () =>
        runNoteIntervention({
          epicId: 0,
          reason: 'r',
          injectedConfig: { orchestration: { provider: 'fake' } },
          injectedProvider: {},
        }),
      /positive integer/,
    );
    await assert.rejects(
      () =>
        runNoteIntervention({
          epicId: 1,
          reason: '',
          injectedConfig: { orchestration: { provider: 'fake' } },
          injectedProvider: {},
        }),
      /reason is required/,
    );
  });
});
