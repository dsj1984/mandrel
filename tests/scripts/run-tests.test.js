import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listTestFilesForTier } from '../../.agents/scripts/lib/test-tiers.js';
import {
  buildNodeTestArgs,
  chunkTestTargets,
  MAX_TARGET_CHARS,
  POSIX_MAX_TARGET_CHARS,
  resolveMaxTargetChars,
  resolveTestConcurrency,
  runTestSuite,
  TEST_CONCURRENCY_MAX,
  TEST_CONCURRENCY_MIN,
  TEST_RUNNER_FLAGS,
} from '../../.agents/scripts/run-tests.js';

// ---------------------------------------------------------------------------
// resolveTestConcurrency — host-aware clamping
// ---------------------------------------------------------------------------

test('resolveTestConcurrency clamps to TEST_CONCURRENCY_MIN when parallelism is 0', () => {
  assert.equal(resolveTestConcurrency(0), TEST_CONCURRENCY_MIN);
});

test('resolveTestConcurrency clamps to TEST_CONCURRENCY_MIN when parallelism is negative', () => {
  assert.equal(resolveTestConcurrency(-4), TEST_CONCURRENCY_MIN);
});

test('resolveTestConcurrency clamps to TEST_CONCURRENCY_MAX when parallelism exceeds the ceiling', () => {
  assert.equal(
    resolveTestConcurrency(TEST_CONCURRENCY_MAX + 10),
    TEST_CONCURRENCY_MAX,
  );
});

test('resolveTestConcurrency passes through an in-range value unchanged', () => {
  const mid = Math.floor((TEST_CONCURRENCY_MIN + TEST_CONCURRENCY_MAX) / 2);
  assert.equal(resolveTestConcurrency(mid), mid);
});

test('TEST_CONCURRENCY_MIN is 1 and TEST_CONCURRENCY_MAX is 16', () => {
  assert.equal(TEST_CONCURRENCY_MIN, 1);
  assert.equal(TEST_CONCURRENCY_MAX, 16);
});

test('TEST_RUNNER_FLAGS contains --test-concurrency in the [1,16] range', () => {
  const flag = TEST_RUNNER_FLAGS.find((f) =>
    f.startsWith('--test-concurrency='),
  );
  assert.ok(flag, 'TEST_RUNNER_FLAGS must include --test-concurrency=N');
  const n = Number(flag.split('=')[1]);
  assert.ok(
    n >= TEST_CONCURRENCY_MIN && n <= TEST_CONCURRENCY_MAX,
    `--test-concurrency=${n} is outside [${TEST_CONCURRENCY_MIN},${TEST_CONCURRENCY_MAX}]`,
  );
});

// ---------------------------------------------------------------------------
// buildNodeTestArgs — flag presence
// ---------------------------------------------------------------------------

test('buildNodeTestArgs preserves the default test glob and appends extra args', () => {
  const args = buildNodeTestArgs({
    extraArgs: ['tests/foo.test.js'],
    tier: 'full',
  });
  assert.ok(args.includes('--experimental-test-module-mocks'));
  assert.ok(args.includes('--test'));
  assert.ok(args.some((f) => f.startsWith('--test-concurrency=')));
  assert.ok(args.includes('tests/**/*.test.js'));
  assert.ok(args.includes('tests/foo.test.js'));
});

test('buildNodeTestArgs quick tier resolves explicit file targets', () => {
  const args = buildNodeTestArgs({ tier: 'quick', repoRoot: process.cwd() });
  assert.ok(args.some((f) => f.startsWith('--test-concurrency=')));
  assert.ok(!args.includes('tests/**/*.test.js'));
  assert.ok(args.some((a) => a.startsWith('tests/')));
  assert.ok(!args.includes('tests/hook-chain-reflog-invariant.test.js'));
});

test('runTestSuite cleans reserved temp even when the test process fails', () => {
  const calls = [];
  const status = runTestSuite({
    argv: ['tests/failing.test.js'],
    cwd: '/repo',
    spawn: (_cmd, args, opts) => {
      calls.push({ kind: 'spawn', args, opts });
      return { status: 12 };
    },
    cleanup: (opts) => {
      calls.push({ kind: 'cleanup', opts });
    },
  });

  assert.equal(status, 12);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].kind, 'spawn');
  assert.equal(calls[1].kind, 'cleanup');
  assert.deepEqual(calls[1].opts, { repoRoot: '/repo' });
});

// ---------------------------------------------------------------------------
// chunkTestTargets — Windows arg-length guard (the run-tests.js spawnSync
// ENAMETOOLONG regression: the `quick` tier crossed the Windows ~32 767-char
// CreateProcess ceiling once the enumerated target list grew past it).
// ---------------------------------------------------------------------------

test('chunkTestTargets keeps a short list in a single chunk', () => {
  const targets = ['tests/a.test.js', 'tests/b.test.js'];
  assert.deepEqual(chunkTestTargets(targets, 8000), [targets]);
});

test('chunkTestTargets yields one empty chunk for an empty list (single spawn)', () => {
  assert.deepEqual(chunkTestTargets([], 8000), [[]]);
});

test('chunkTestTargets splits a large list into chunks bounded by maxChars, preserving order', () => {
  // 729-ish realistic paths well past the Windows ceiling.
  const targets = Array.from(
    { length: 800 },
    (_, i) =>
      `tests/some/nested/dir/file-${String(i).padStart(4, '0')}.test.js`,
  );
  const maxChars = 8000;
  const chunks = chunkTestTargets(targets, maxChars);

  assert.ok(chunks.length > 1, 'a large list must split into multiple chunks');

  // Every chunk's joined length stays within budget.
  for (const chunk of chunks) {
    const joinedLen = chunk.join(' ').length;
    assert.ok(
      joinedLen <= maxChars,
      `chunk joined length ${joinedLen} exceeds budget ${maxChars}`,
    );
  }

  // Order and completeness preserved across chunks.
  assert.deepEqual(chunks.flat(), targets);
});

test('chunkTestTargets places an over-budget single target in its own chunk', () => {
  const huge = `tests/${'x'.repeat(50)}.test.js`;
  const chunks = chunkTestTargets([huge], 10);
  assert.deepEqual(chunks, [[huge]]);
});

test('the real quick tier never exceeds the Windows arg budget per chunk', () => {
  // Regression guard: with the live quick-tier file set, every spawned chunk
  // must stay under MAX_TARGET_CHARS so spawnSync cannot throw ENAMETOOLONG
  // on Windows. (This is the exact failure that reddened the Windows Smoke
  // CI job — see run-tests.js header.)
  const targets = listTestFilesForTier('quick', process.cwd());
  const chunks = chunkTestTargets(targets, MAX_TARGET_CHARS);
  for (const chunk of chunks) {
    assert.ok(
      chunk.join(' ').length <= MAX_TARGET_CHARS,
      'a quick-tier chunk exceeded the Windows arg budget',
    );
  }
  // Sanity: all live targets are still covered.
  assert.equal(chunks.flat().length, targets.length);
});

// ---------------------------------------------------------------------------
// resolveMaxTargetChars — platform-aware target budget (Story #3989): the
// 8 000-char Windows CreateProcess guard must not serialize POSIX runs.
// ---------------------------------------------------------------------------

test('resolveMaxTargetChars keeps the Windows budget on win32', () => {
  assert.equal(resolveMaxTargetChars('win32'), MAX_TARGET_CHARS);
});

test('resolveMaxTargetChars uses the larger POSIX budget elsewhere', () => {
  assert.equal(resolveMaxTargetChars('darwin'), POSIX_MAX_TARGET_CHARS);
  assert.equal(resolveMaxTargetChars('linux'), POSIX_MAX_TARGET_CHARS);
  assert.ok(POSIX_MAX_TARGET_CHARS > MAX_TARGET_CHARS);
});

test('the real quick tier collapses to a single chunk under the POSIX budget', () => {
  const targets = listTestFilesForTier('quick', process.cwd());
  const chunks = chunkTestTargets(targets, POSIX_MAX_TARGET_CHARS);
  assert.equal(chunks.length, 1, 'POSIX quick tier must be a single spawn');
  assert.deepEqual(chunks.flat(), targets);
});

test('runTestSuite issues one spawn per chunk and never builds an unbounded argv', () => {
  // Inject a target list that spans multiple chunks.
  const targets = Array.from(
    { length: 600 },
    (_, i) => `tests/dir/file-${String(i).padStart(4, '0')}.test.js`,
  );
  const spawns = [];
  const status = runTestSuite({
    argv: [], // full tier — but listTargets is injected below
    cwd: '/repo',
    listTargets: () => targets,
    maxTargetChars: 8000,
    spawn: (_cmd, args) => {
      spawns.push(args);
      return { status: 0 };
    },
    cleanup: () => {},
  });

  assert.equal(status, 0);
  assert.ok(spawns.length > 1, 'large target set must fan out across spawns');

  for (const args of spawns) {
    // Fixed flags lead every spawn.
    for (const flag of TEST_RUNNER_FLAGS) assert.ok(args.includes(flag));
    // The target portion (args minus the fixed flags) stays bounded.
    const targetPortion = args.filter((a) => a.startsWith('tests/'));
    assert.ok(
      targetPortion.join(' ').length <= 8000,
      'a spawn argv exceeded the target char budget',
    );
  }
  // Completeness: union of all spawned targets equals the input set.
  const spawnedTargets = spawns.flatMap((a) =>
    a.filter((x) => x.startsWith('tests/')),
  );
  assert.deepEqual(spawnedTargets, targets);
});

test('runTestSuite returns the first non-zero chunk exit code', () => {
  const targets = Array.from(
    { length: 600 },
    (_, i) => `tests/dir/file-${String(i).padStart(4, '0')}.test.js`,
  );
  let call = 0;
  const status = runTestSuite({
    argv: [],
    cwd: '/repo',
    listTargets: () => targets,
    maxTargetChars: 8000,
    spawn: () => {
      call += 1;
      return { status: call === 2 ? 7 : 0 };
    },
    cleanup: () => {},
  });
  assert.equal(status, 7);
});

test('runTestSuite cleans up then throws on a spawn error', () => {
  let cleaned = false;
  assert.throws(
    () =>
      runTestSuite({
        argv: ['tests/x.test.js'],
        cwd: '/repo',
        listTargets: () => ['tests/x.test.js'],
        spawn: () => ({ error: new Error('ENOENT') }),
        cleanup: () => {
          cleaned = true;
        },
      }),
    /ENOENT/,
  );
  assert.ok(cleaned, 'cleanup must run before the throw');
});
