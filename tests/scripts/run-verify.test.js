import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runVerifySteps } from '../../.agents/scripts/run-verify.js';

test('runVerifySteps stops on first failing step', () => {
  const calls = [];
  const outcome = runVerifySteps({
    spawn: (cmd, args) => {
      calls.push([cmd, args].flat().join(' '));
      if (calls.length === 2) {
        return { status: 3 };
      }
      return { status: 0 };
    },
    shell: false,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failedStep, 'test');
  assert.equal(outcome.exitCode, 3);
  assert.equal(calls.length, 2);
});

test('runVerifySteps runs lint, test, and baselines in order', () => {
  const calls = [];
  const outcome = runVerifySteps({
    spawn: (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0 };
    },
    shell: false,
  });
  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(calls[0], ['npm', 'run', 'lint']);
  assert.deepEqual(calls[1], ['npm', 'test']);
  assert.deepEqual(calls[2], [
    'node',
    '.agents/scripts/check-baselines.js',
  ]);
});
