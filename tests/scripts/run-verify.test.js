import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runVerifySteps } from '../../.agents/scripts/run-verify.js';

test('runVerifySteps stops on first failing step', () => {
  const calls = [];
  const outcome = runVerifySteps({
    spawn: (cmd, args) => {
      calls.push([cmd, args].flat().join(' '));
      if (calls.length === 3) {
        return { status: 3 };
      }
      return { status: 0 };
    },
    shell: false,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failedStep, 'test');
  assert.equal(outcome.exitCode, 3);
  assert.equal(calls.length, 3);
});

test('runVerifySteps runs audit, lint, test, and baselines in order', () => {
  const calls = [];
  const outcome = runVerifySteps({
    spawn: (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0 };
    },
    shell: false,
  });
  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(calls[0], ['npm', 'audit', '--audit-level=high']);
  assert.deepEqual(calls[1], ['npm', 'run', 'lint']);
  assert.deepEqual(calls[2], ['npm', 'test']);
  assert.deepEqual(calls[3], ['node', '.agents/scripts/check-baselines.js']);
});

test('runVerifySteps surfaces a failing high-severity audit first', () => {
  const calls = [];
  const outcome = runVerifySteps({
    spawn: (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 1 };
    },
    shell: false,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failedStep, 'audit');
  assert.equal(outcome.exitCode, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['npm', 'audit', '--audit-level=high']);
});
