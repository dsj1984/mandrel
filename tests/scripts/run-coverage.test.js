import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCoverageTestArgs } from '../../.agents/scripts/run-coverage.js';
import {
  resolveTestConcurrency,
  TEST_CONCURRENCY_MAX,
  TEST_CONCURRENCY_MIN,
  TEST_RUNNER_FLAGS,
} from '../../.agents/scripts/run-tests.js';

// ---------------------------------------------------------------------------
// buildCoverageTestArgs — host-aware --test-concurrency (Story #4254): the
// coverage suite spawn must reuse the shared, clamped concurrency value from
// run-tests.js rather than the historical literal `--test-concurrency=8`.
// ---------------------------------------------------------------------------

test('buildCoverageTestArgs carries the shared runner flags, not a literal 8', () => {
  const args = buildCoverageTestArgs();

  // Single source of truth: every shared runner flag is present, in order.
  for (const flag of TEST_RUNNER_FLAGS) {
    assert.ok(
      args.includes(flag),
      `coverage argv must include shared runner flag ${flag}`,
    );
  }

  // The concurrency flag is derived from the host, not pinned to 8.
  const flag = args.find((a) => a.startsWith('--test-concurrency='));
  assert.ok(flag, 'coverage argv must carry --test-concurrency=N');
  assert.notEqual(
    flag,
    '--test-concurrency=8',
    'coverage argv must not pin the historical literal 8',
  );
});

test('buildCoverageTestArgs concurrency equals the shared resolver output and is clamped', () => {
  const args = buildCoverageTestArgs();
  const flag = args.find((a) => a.startsWith('--test-concurrency='));
  const value = Number(flag.split('=')[1]);

  // Derived value matches resolveTestConcurrency() — the SSOT used by
  // run-tests.js — proving the coverage path shares the same resolver.
  assert.equal(value, resolveTestConcurrency());

  // Clamp is preserved: never below MIN, never above MAX (no raw
  // availableParallelism() that could over-subscribe constrained CI).
  assert.ok(
    value >= TEST_CONCURRENCY_MIN && value <= TEST_CONCURRENCY_MAX,
    `--test-concurrency=${value} is outside [${TEST_CONCURRENCY_MIN},${TEST_CONCURRENCY_MAX}]`,
  );
});

test('buildCoverageTestArgs honours an injected clamped runner-flag set', () => {
  // Inject a flag set whose concurrency sits at the upper bound to prove the
  // builder reflects the resolver's clamp rather than hardcoding a value.
  const injected = [
    '--experimental-test-module-mocks',
    '--test',
    `--test-concurrency=${resolveTestConcurrency(TEST_CONCURRENCY_MAX + 99)}`,
  ];
  const args = buildCoverageTestArgs({ runnerFlags: injected });
  assert.ok(args.includes(`--test-concurrency=${TEST_CONCURRENCY_MAX}`));
  assert.ok(!args.includes('--test-concurrency=8'));
});

test('buildCoverageTestArgs targets the full test glob after the runner flags', () => {
  const args = buildCoverageTestArgs();
  assert.equal(args.at(-1), 'tests/**/*.test.js');
  assert.ok(args.includes('--test'));
});
