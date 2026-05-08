/**
 * tests/workflows/lint-baseline-cli.test.js — unit tests for the
 * extracted `runLintBaselineCli` (orchestration body of `main`).
 *
 * Covers two structural paths without spawning a process:
 *   - happy path: each mode (capture / check / diff) routes to the
 *     injected runner and returns `{ exitCode: 0, result.kind: 'envelope' }`.
 *   - validation-failure path: an invalid `mode` short-circuits with
 *     `exitCode: 1` and `kind: 'validation-error'` before any runner or
 *     config resolution is reached.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runLintBaselineCli } from '../../.agents/scripts/lint-baseline.js';

const FAKE_CONFIG = {
  settings: {
    quality: {
      commands: { lintBaseline: 'echo []' },
      baselines: { lint: { path: 'baselines/lint.json' } },
      limits: { executionTimeoutMs: 1000, executionMaxBuffer: 1024 },
    },
  },
};

const FAKE_RESOLVE_CONFIG = () => FAKE_CONFIG;

describe('runLintBaselineCli', () => {
  it('happy path: mode=capture routes to the capture runner', async () => {
    const calls = [];
    const out = await runLintBaselineCli(
      { mode: 'capture', gateModeArgv: [] },
      {
        resolveConfig: FAKE_RESOLVE_CONFIG,
        runners: {
          capture: (...args) => {
            calls.push({ which: 'capture', args });
            return { errorCount: 0, warningCount: 0, byFile: {} };
          },
          check: () => {
            throw new Error('check must not run for mode=capture');
          },
          diff: () => {
            throw new Error('diff must not run for mode=capture');
          },
        },
      },
    );
    assert.equal(out.exitCode, 0);
    assert.equal(out.result.kind, 'envelope');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].which, 'capture');
  });

  it('happy path: mode=check routes to the check runner', async () => {
    const calls = [];
    const out = await runLintBaselineCli(
      { mode: 'check', gateModeArgv: [] },
      {
        resolveConfig: FAKE_RESOLVE_CONFIG,
        runners: {
          capture: () => {
            throw new Error('capture must not run for mode=check');
          },
          check: () => {
            calls.push('check');
            return { errorCount: 0, warningCount: 0 };
          },
          diff: () => {
            throw new Error('diff must not run for mode=check');
          },
        },
      },
    );
    assert.equal(out.exitCode, 0);
    assert.deepEqual(calls, ['check']);
  });

  it('happy path: mode=diff routes to the diff runner', async () => {
    const calls = [];
    const out = await runLintBaselineCli(
      { mode: 'diff', gateModeArgv: [] },
      {
        resolveConfig: FAKE_RESOLVE_CONFIG,
        runners: {
          capture: () => {
            throw new Error('capture must not run for mode=diff');
          },
          check: () => {
            throw new Error('check must not run for mode=diff');
          },
          diff: () => {
            calls.push('diff');
            return { errorCount: 0, warningCount: 0, regressions: [] };
          },
        },
      },
    );
    assert.equal(out.exitCode, 0);
    assert.deepEqual(calls, ['diff']);
  });

  it('happy path: degraded envelope yields exitCode 1', async () => {
    const out = await runLintBaselineCli(
      { mode: 'check', gateModeArgv: [] },
      {
        resolveConfig: FAKE_RESOLVE_CONFIG,
        runners: {
          check: () => ({
            ok: false,
            degraded: true,
            reason: 'LINT_OUTPUT_PARSE_FAILED',
            detail: 'simulated parse failure for test',
          }),
        },
      },
    );
    assert.equal(out.exitCode, 1);
    assert.equal(out.result.envelope.degraded, true);
  });

  it('happy path: gateModeArgv is forwarded through to the runner', async () => {
    let captured;
    await runLintBaselineCli(
      { mode: 'check', gateModeArgv: ['--gate-mode'] },
      {
        resolveConfig: FAKE_RESOLVE_CONFIG,
        env: { CI: '1' },
        runners: {
          check: (
            _cmd,
            _timeout,
            _buffer,
            _baselinePath,
            _baselinePathRel,
            gateModeOpts,
          ) => {
            captured = gateModeOpts;
            return { errorCount: 0, warningCount: 0 };
          },
        },
      },
    );
    assert.deepEqual(captured.argv, ['--gate-mode']);
    assert.deepEqual(captured.env, { CI: '1' });
  });

  it('validation-failure: missing mode returns exitCode 1', async () => {
    const out = await runLintBaselineCli(
      { mode: undefined },
      {
        resolveConfig: () => {
          throw new Error('resolveConfig must not run before validation');
        },
        runners: {
          check: () => {
            throw new Error('runners must not run before validation');
          },
        },
      },
    );
    assert.equal(out.exitCode, 1);
    assert.equal(out.result.kind, 'validation-error');
    assert.match(out.result.message, /capture\|check\|diff/);
  });

  it('validation-failure: unknown mode returns exitCode 1', async () => {
    const out = await runLintBaselineCli(
      { mode: 'glorbo' },
      { resolveConfig: () => FAKE_CONFIG },
    );
    assert.equal(out.exitCode, 1);
    assert.equal(out.result.kind, 'validation-error');
    assert.match(out.result.message, /<capture\|check\|diff>/);
  });
});
