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

describe('runNoteIntervention', () => {
  it('calls appendIntervention with reason+source and returns total/intervention', async () => {
    const recorded = [];
    const fakeCheckpointer = {
      appendIntervention: async (entry) => {
        recorded.push(entry);
        return {
          manualInterventions: [
            ...recorded.map((r) => ({
              reason: r.reason,
              source: r.source ?? 'host-llm',
              ts: '2026-05-11T00:00:00.000Z',
            })),
          ],
        };
      },
    };
    const out = await runNoteIntervention({
      epicId: 1178,
      reason: 'stash dance',
      source: 'merge-recovery',
      injectedConfig: { orchestration: { provider: 'fake' } },
      injectedProvider: {},
      checkpointerFactory: () => fakeCheckpointer,
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
    const fakeCheckpointer = {
      appendIntervention: async (entry) => ({
        manualInterventions: [
          { reason: entry.reason, source: entry.source ?? 'host-llm', ts: 't' },
        ],
      }),
    };
    const out = await runNoteIntervention({
      epicId: 1,
      reason: 'r',
      injectedConfig: { orchestration: { provider: 'fake' } },
      injectedProvider: {},
      checkpointerFactory: () => fakeCheckpointer,
    });
    assert.equal(out.intervention.source, 'host-llm');
  });

  it('rejects bad args', async () => {
    await assert.rejects(
      () =>
        runNoteIntervention({
          epicId: 0,
          reason: 'r',
          injectedConfig: { orchestration: { provider: 'fake' } },
          injectedProvider: {},
          checkpointerFactory: () => ({ appendIntervention: async () => ({}) }),
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
          checkpointerFactory: () => ({ appendIntervention: async () => ({}) }),
        }),
      /reason is required/,
    );
  });
});
