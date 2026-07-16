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

test('runVerifySteps runs audit, lint, test, baselines, then the ratchets in order', () => {
  const calls = [];
  const outcome = runVerifySteps({
    spawn: (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0 };
    },
    shell: false,
  });
  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(calls, [
    ['npm', 'audit', '--audit-level=high'],
    ['npm', 'run', 'lint'],
    ['npm', 'test'],
    ['node', '.agents/scripts/check-baselines.js'],
    ['node', '.agents/scripts/check-arch-cycles.js', '--format', 'text'],
    ['node', '.agents/scripts/check-dead-exports.js'],
    ['node', '.agents/scripts/check-context-budget.js'],
  ]);
});

// Story #4549: verify advertises itself as a true CI mirror, so every gate CI's
// `baselines` job runs must be reachable from it. A clean verify that skipped
// the dead-export ratchet is exactly what let PR #4548 reach a red CI.
test('runVerifySteps mirrors every check in CI’s "Architecture Cycle Check" step', () => {
  const calls = [];
  runVerifySteps({
    spawn: (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      return { status: 0 };
    },
    shell: false,
  });
  for (const script of [
    'check-arch-cycles.js',
    'check-dead-exports.js',
    'check-context-budget.js',
  ]) {
    assert.ok(
      calls.some((call) => call.includes(script)),
      `expected verify to run ${script}`,
    );
  }
});

test('runVerifySteps reports a failing ratchet by its own step label', () => {
  const outcome = runVerifySteps({
    spawn: (_cmd, args) =>
      args.some((arg) => arg.includes('check-dead-exports.js'))
        ? { status: 1 }
        : { status: 0 },
    shell: false,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failedStep, 'dead-exports');
  assert.equal(outcome.exitCode, 1);
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
