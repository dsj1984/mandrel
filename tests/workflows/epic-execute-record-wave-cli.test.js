/**
 * tests/workflows/epic-execute-record-wave-cli.test.js — unit tests for
 * the extracted `runRecordWaveCli` (orchestration body of `main`).
 *
 * Covers two structural paths without spawning a process:
 *   - happy path: parsed values flow through to the injected runner; the
 *     wrapper returns `{ exitCode: 0, result.kind: 'envelope' }`.
 *   - validation-failure path: missing/invalid `--epic` and `--wave`
 *     return `exitCode: 2` with `kind: 'validation-error'` before the
 *     business runner is reached.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runRecordWaveCli } from '../../.agents/scripts/epic-execute-record-wave.js';

describe('runRecordWaveCli', () => {
  it('happy path: forwards parsed values to runRecordWave and wraps the envelope', async () => {
    const captured = [];
    const fakeRun = async (args) => {
      captured.push(args);
      return {
        epicId: args.epicId,
        wave: args.wave,
        recorded: true,
        status: 'complete',
        stories: [{ id: 1, status: 'done' }],
        blockedStoryIds: [],
        nextAction: 'dispatch-next',
        remainingWaves: 1,
        renderedBody: '### Epic Progress',
      };
    };

    const out = await runRecordWaveCli(
      {
        epicId: 555,
        wave: 0,
        concurrencyCap: 4,
        resultsRaw: '[{"storyId":1,"status":"done"}]',
      },
      {
        runRecordWave: fakeRun,
        resolveRecordInput: (v) => ({ results: JSON.parse(v.resultsRaw) }),
      },
    );

    assert.equal(out.exitCode, 0);
    assert.equal(out.result.kind, 'envelope');
    assert.equal(out.result.envelope.recorded, true);
    assert.equal(out.result.envelope.nextAction, 'dispatch-next');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].epicId, 555);
    assert.equal(captured[0].wave, 0);
    assert.equal(captured[0].concurrencyCap, 4);
    assert.deepEqual(captured[0].results, [{ storyId: 1, status: 'done' }]);
  });

  it('happy path: accepts wave: 0 (zero-indexed) without rejecting it', async () => {
    const out = await runRecordWaveCli(
      { epicId: 1, wave: 0 },
      {
        runRecordWave: async () => ({
          epicId: 1,
          wave: 0,
          recorded: true,
          status: 'complete',
        }),
        resolveRecordInput: () => ({ results: [] }),
      },
    );
    assert.equal(out.exitCode, 0);
    assert.equal(out.result.kind, 'envelope');
  });

  it('help flag short-circuits with exitCode 0 and kind=help', async () => {
    const out = await runRecordWaveCli(
      { help: true },
      {
        runRecordWave: () => {
          throw new Error('runRecordWave must not run when --help is set');
        },
      },
    );
    assert.equal(out.exitCode, 0);
    assert.equal(out.result.kind, 'help');
    assert.match(out.result.text, /Usage:/);
  });

  it('validation-failure: missing epicId returns exitCode 2', async () => {
    const out = await runRecordWaveCli(
      { epicId: undefined, wave: 0 },
      {
        runRecordWave: () => {
          throw new Error('runRecordWave must not run before validation');
        },
      },
    );
    assert.equal(out.exitCode, 2);
    assert.equal(out.result.kind, 'validation-error');
    assert.match(out.result.message, /--epic <epicId> is required/);
  });

  it('validation-failure: non-positive epicId is rejected', async () => {
    const out = await runRecordWaveCli({ epicId: 0, wave: 0 });
    assert.equal(out.exitCode, 2);
    assert.match(out.result.message, /--epic/);
  });

  it('validation-failure: missing wave returns exitCode 2', async () => {
    const out = await runRecordWaveCli({ epicId: 100, wave: undefined });
    assert.equal(out.exitCode, 2);
    assert.match(out.result.message, /--wave <index> is required/);
  });

  it('validation-failure: negative wave is rejected', async () => {
    const out = await runRecordWaveCli({ epicId: 100, wave: -1 });
    assert.equal(out.exitCode, 2);
    assert.match(out.result.message, /--wave/);
  });
});
