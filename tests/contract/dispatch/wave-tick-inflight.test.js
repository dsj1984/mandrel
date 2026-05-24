// tests/contract/dispatch/wave-tick-inflight.test.js
/**
 * Contract test — Story #2891 Task #2901.
 *
 * wave-tick.js MUST surface `nextAction['in-flight']` derived from the
 * lifecycle ledger so /epic-deliver can reconcile dispatched-but-
 * uncompleted Stories. The field is always present (empty array when
 * the ledger is silent) so callers never need an existence check.
 *
 * The test injects a fake `inFlightReader` collaborator (deterministic,
 * no filesystem coupling) plus the existing fake checkpointer and
 * provider so the reconciliation contract is asserted in isolation.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { tick } from '../../../.agents/scripts/lib/wave-runner/tick.js';

function fakeCheckpointer(state) {
  return { read: async () => state };
}

function fakeProvider(labelsById = new Map()) {
  return {
    async getTicket(id) {
      return {
        id,
        labels: labelsById.get(id) ?? [],
        title: `Story #${id}`,
      };
    },
  };
}

describe('contract/dispatch/wave-tick-inflight', () => {
  it('surfaces nextAction["in-flight"] from the injected ledger reader', async () => {
    const checkpointer = fakeCheckpointer({
      epicId: 9001,
      currentWave: 0,
      totalWaves: 1,
      plan: [[{ id: 9101 }, { id: 9102 }]],
      waves: [],
    });
    const provider = fakeProvider();
    // Ledger says A and B both dispatched; only A completed.
    const inFlightReader = async () => [9102];

    const result = await tick({
      epic: 9001,
      collaborators: {
        provider,
        epicRunStateStore: checkpointer,
        signalEmit: async () => {},
        inFlightReader,
      },
    });

    assert.deepEqual(result.nextAction['in-flight'], [9102]);
  });

  it('returns an empty array (not undefined) when no Stories are in flight', async () => {
    const checkpointer = fakeCheckpointer({
      epicId: 9001,
      currentWave: 0,
      totalWaves: 1,
      plan: [[{ id: 9101 }]],
      waves: [],
    });
    const provider = fakeProvider();
    const inFlightReader = async () => [];

    const result = await tick({
      epic: 9001,
      collaborators: {
        provider,
        epicRunStateStore: checkpointer,
        signalEmit: async () => {},
        inFlightReader,
      },
    });

    assert.ok(
      Array.isArray(result.nextAction['in-flight']),
      'in-flight must be an array',
    );
    assert.equal(result.nextAction['in-flight'].length, 0);
  });

  it('defaults a missing inFlightReader to [] (no ledger on disk)', async () => {
    // Use a unique epicId that has no temp/epic-<id>/lifecycle.ndjson on
    // disk in the test sandbox so the default reader returns [].
    const checkpointer = fakeCheckpointer({
      epicId: 999_001,
      currentWave: 0,
      totalWaves: 1,
      plan: [[{ id: 9101 }]],
      waves: [],
    });
    const provider = fakeProvider();

    const result = await tick({
      epic: 999_001,
      collaborators: {
        provider,
        epicRunStateStore: checkpointer,
        signalEmit: async () => {},
      },
    });

    assert.ok(Array.isArray(result.nextAction['in-flight']));
    assert.equal(result.nextAction['in-flight'].length, 0);
  });

  it('reconciles a real on-disk ledger (start without matching end)', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import(
      'node:fs'
    );
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');

    const sandbox = mkdtempSync(path.join(tmpdir(), 'wave-tick-inflight-'));
    const prevCwd = process.cwd();
    try {
      process.chdir(sandbox);
      const epicDir = path.join(sandbox, 'temp', 'epic-9001');
      mkdirSync(epicDir, { recursive: true });
      const ledgerPath = path.join(epicDir, 'lifecycle.ndjson');
      const lines = [
        {
          kind: 'emitted',
          seqId: 1,
          ts: '2026-05-22T00:00:00.000Z',
          event: 'story.dispatch.start',
          payload: { storyId: 9101, waveIndex: 0 },
        },
        {
          kind: 'emitted',
          seqId: 2,
          ts: '2026-05-22T00:00:01.000Z',
          event: 'story.dispatch.start',
          payload: { storyId: 9102, waveIndex: 0 },
        },
        {
          kind: 'emitted',
          seqId: 3,
          ts: '2026-05-22T00:00:02.000Z',
          event: 'story.dispatch.end',
          payload: { storyId: 9101, outcome: 'done' },
        },
      ];
      writeFileSync(
        ledgerPath,
        `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
        'utf8',
      );

      const checkpointer = fakeCheckpointer({
        epicId: 9001,
        currentWave: 0,
        totalWaves: 1,
        plan: [[{ id: 9101 }, { id: 9102 }]],
        waves: [],
      });
      const provider = fakeProvider();

      const result = await tick({
        epic: 9001,
        collaborators: {
          provider,
          epicRunStateStore: checkpointer,
          signalEmit: async () => {},
        },
      });

      assert.deepEqual(result.nextAction['in-flight'], [9102]);
    } finally {
      process.chdir(prevCwd);
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
