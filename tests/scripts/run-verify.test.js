import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runVerifySteps } from '../../.agents/scripts/run-verify.js';

const REPO_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

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
    ['node', '.agents/scripts/check-dead-exports.js'],
    ['node', '.agents/scripts/check-context-budget.js'],
  ]);
});

// Story #4549: verify advertises itself as a true CI mirror, so every gate CI's
// `baselines` job runs must be reachable from it. A clean verify that skipped
// the dead-export ratchet is exactly what let PR #4548 reach a red CI.
test('runVerifySteps runs the ratchets CI’s "Architecture Cycle Check" step covers', () => {
  const calls = [];
  runVerifySteps({
    spawn: (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      return { status: 0 };
    },
    shell: false,
  });
  for (const script of ['check-dead-exports.js', 'check-context-budget.js']) {
    assert.ok(
      calls.some((call) => call.includes(script)),
      `expected verify to run ${script}`,
    );
  }
});

// The third check in that CI step, check-arch-cycles.js, is already run by the
// `lint` step (run-lint.js). Adding it to STEPS as well would double-pay a gate
// verify already covers — this guards against that regression.
test('runVerifySteps does not re-run arch-cycles, which the lint step already covers', () => {
  const calls = [];
  runVerifySteps({
    spawn: (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      return { status: 0 };
    },
    shell: false,
  });
  assert.equal(
    calls.filter((call) => call.includes('check-arch-cycles.js')).length,
    0,
  );
  assert.ok(calls.includes('npm run lint'));
});

// The test above is only safe while `lint` really does carry arch-cycles. Pin
// that, or dropping it from run-lint.js would silently reopen the very gap
// this Story closed. Asserted against the source text rather than an import:
// run-lint.js is a top-level-await driver that would spawn biome on import.
test('run-lint.js still carries the arch-cycles ratchet verify relies on it for', () => {
  const source = readFileSync(
    path.join(REPO_ROOT, '.agents/scripts/run-lint.js'),
    'utf8',
  );
  assert.ok(
    source.includes('check-arch-cycles.js'),
    'run-lint.js no longer runs check-arch-cycles.js — verify now has no ' +
      'arch-cycles coverage; add it to run-verify.js STEPS.',
  );
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
