/**
 * tests/workflows/epic-execute-record-wave-cli.test.js — unit tests for
 * the extracted `runRecordWaveCli` (orchestration body of `main`).
 *
 * Story #4155 — the recorder lost its wave semantics; the CLI no longer
 * takes a `--wave` flag. Covers two structural paths without spawning a
 * process:
 *   - happy path: parsed values flow through to the injected runner; the
 *     wrapper returns `{ exitCode: 0, result.kind: 'envelope' }`.
 *   - validation-failure path: missing/invalid `--epic` returns
 *     `exitCode: 2` with `kind: 'validation-error'` before the business
 *     runner is reached.
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
        recorded: true,
        status: 'complete',
        stories: [{ id: 1, status: 'done' }],
        blockedStoryIds: [],
        nextAction: 'dispatch-next',
        renderedBody: '### Epic Progress',
      };
    };

    const out = await runRecordWaveCli(
      {
        epicId: 555,
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
    assert.deepEqual(captured[0].results, [{ storyId: 1, status: 'done' }]);
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
      { epicId: undefined },
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
    const out = await runRecordWaveCli({ epicId: 0 });
    assert.equal(out.exitCode, 2);
    assert.match(out.result.message, /--epic/);
  });
});
