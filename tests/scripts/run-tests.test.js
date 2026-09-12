import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { respondToHelp } from '../../.agents/scripts/lib/cli-usage.js';
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
  USAGE,
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

test('buildNodeTestArgs carries the runner flags, the tier targets and extra args', () => {
  const args = buildNodeTestArgs({
    extraArgs: ['tests/foo.test.js'],
    tier: 'full',
  });
  assert.ok(args.includes('--experimental-test-module-mocks'));
  assert.ok(args.includes('--test'));
  assert.ok(args.some((f) => f.startsWith('--test-concurrency=')));
  // Story #5111: the full tier enumerates files rather than returning the
  // `tests/**/*.test.js` glob — `node --test` has no negative pattern, so
  // excluding tests/e2e/** is only sayable as a file set.
  assert.ok(args.some((a) => a.startsWith('tests/') && a.endsWith('.test.js')));
  assert.equal(
    args.some((a) => a.startsWith('tests/e2e/')),
    false,
    'the full tier must not target the e2e suites',
  );
  assert.ok(args.includes('tests/foo.test.js'));
});

// ---------------------------------------------------------------------------
// buildNodeTestArgs — flag POSITION. Node stops parsing options at the first
// positional, so a runner flag appended after the file targets is read as
// another file pattern. That is exactly how `run-test-profile.js` lost its
// `--test-reporter tap`: the default reporter ran and the profiler parsed
// zero timed entries out of a full suite run.
// ---------------------------------------------------------------------------

test('buildNodeTestArgs places --test-reporter ahead of the first file target', () => {
  const args = buildNodeTestArgs({ tier: 'full', reporter: 'tap' });
  const reporterIdx = args.indexOf('--test-reporter');
  const firstTargetIdx = args.findIndex((a) => !a.startsWith('-'));

  assert.ok(reporterIdx >= 0, '--test-reporter must be present');
  assert.equal(args[reporterIdx + 1], 'tap');
  assert.ok(firstTargetIdx >= 0, 'a file target must be present');
  assert.ok(
    reporterIdx < firstTargetIdx,
    `--test-reporter (index ${reporterIdx}) must precede the first target ` +
      `(index ${firstTargetIdx}); after it, Node reads the flag as a pattern`,
  );
});

test('buildNodeTestArgs omits --test-reporter when no reporter is requested', () => {
  const args = buildNodeTestArgs({ tier: 'full' });
  assert.equal(args.includes('--test-reporter'), false);
});

test('buildNodeTestArgs keeps extraArgs in flag position, before the targets', () => {
  const args = buildNodeTestArgs({
    tier: 'full',
    extraArgs: ['--test-name-pattern', 'foo'],
  });
  const firstTargetIdx = args.findIndex(
    (a, i) => !a.startsWith('-') && args[i - 1] !== '--test-name-pattern',
  );
  assert.ok(firstTargetIdx >= 0, 'a file target must be present');
  assert.ok(
    args.indexOf('--test-name-pattern') < firstTargetIdx,
    'pass-through flags must precede the file targets',
  );
});

test('buildNodeTestArgs quick tier resolves explicit file targets', () => {
  const args = buildNodeTestArgs({ tier: 'quick', repoRoot: process.cwd() });
  assert.ok(args.some((f) => f.startsWith('--test-concurrency=')));
  assert.ok(!args.includes('tests/**/*.test.js'));
  assert.ok(args.some((a) => a.startsWith('tests/')));
  assert.ok(!args.includes('tests/hook-chain-reflog-invariant.test.js'));
});

test('runTestSuite deposits the close test credit after a green full run (Story #5313)', () => {
  const deposits = [];
  const status = runTestSuite({
    argv: [],
    cwd: '/repo',
    spawn: () => ({ status: 0 }),
    cleanup: () => {},
    fixtureStreamGuard: () => 0,
    preflight: () => 0,
    listTargets: () => ['tests/a.test.js'],
    depositCredit: (args) => {
      deposits.push(args);
      return {
        deposited: true,
        reason: 'recorded',
        storyId: 7,
        sha: 'abcdef0',
      };
    },
  });
  assert.equal(status, 0);
  assert.equal(deposits.length, 1);
  assert.equal(deposits[0].cwd, '/repo');
  assert.equal(deposits[0].tier, 'full');
  assert.equal(deposits[0].status, 0);
  assert.ok(Number.isInteger(deposits[0].durationMs));
});

test('runTestSuite hands a red run to the depositor and keeps its exit code', () => {
  const seen = [];
  const status = runTestSuite({
    argv: [],
    cwd: '/repo',
    spawn: () => ({ status: 3 }),
    cleanup: () => {},
    fixtureStreamGuard: () => 0,
    preflight: () => 0,
    listTargets: () => ['tests/a.test.js'],
    depositCredit: (args) => {
      seen.push(args.status);
      return { deposited: false, reason: 'run-not-green' };
    },
  });
  assert.equal(status, 3);
  assert.deepEqual(seen, [3]);
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
    preflight: () => 0,
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
    preflight: () => 0,
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

test('runTestSuite spawns pass-through flags ahead of the chunk targets', () => {
  let spawnedArgs = null;
  runTestSuite({
    argv: ['--test-name-pattern', 'foo'],
    cwd: '/repo',
    listTargets: () => ['tests/a.test.js'],
    spawn: (_cmd, args) => {
      spawnedArgs = args;
      return { status: 0 };
    },
    cleanup: () => {},
    preflight: () => 0,
  });

  assert.ok(
    spawnedArgs.indexOf('--test-name-pattern') <
      spawnedArgs.indexOf('tests/a.test.js'),
    'a flag after a target is silently read as another file pattern',
  );
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
    preflight: () => 0,
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
        preflight: () => 0,
      }),
    /ENOENT/,
  );
  assert.ok(cleaned, 'cleanup must run before the throw');
});

// ---------------------------------------------------------------------------
// Story #4936 — the tier preflight must actually execute. `.npmrc` sets
// `ignore-scripts=true` (CWE-1357 defence, which stays), and that suppresses
// npm's `pre*` hooks for `npm run` too, so `pretest`, `pretest:quick` and
// `pretest:integration` fired for no tier at all. The runner owns the
// invocation now; these are the assertions that hold it to that.
// ---------------------------------------------------------------------------

test('runTestSuite runs the preflight for the tier before spawning the suite', () => {
  const order = [];
  const status = runTestSuite({
    argv: ['--tier', 'quick'],
    cwd: '/repo',
    listTargets: () => ['tests/a.test.js'],
    preflight: (opts) => {
      order.push(`preflight:${opts.tier}:${opts.repoRoot}`);
      return 0;
    },
    spawn: () => {
      order.push('spawn');
      return { status: 0 };
    },
    cleanup: () => {},
  });

  assert.equal(status, 0);
  assert.deepEqual(order, ['preflight:quick:/repo', 'spawn']);
});

test('runTestSuite passes each tier through to the preflight', () => {
  for (const tier of ['full', 'quick', 'integration']) {
    const seen = [];
    runTestSuite({
      argv: ['--tier', tier],
      cwd: '/repo',
      listTargets: () => [],
      preflight: (opts) => {
        seen.push(opts.tier);
        return 0;
      },
      spawn: () => ({ status: 0 }),
      cleanup: () => {},
    });
    assert.deepEqual(seen, [tier], `tier ${tier} must reach the preflight`);
  }
});

test('a refused preflight aborts before the test runner is ever spawned', () => {
  let spawned = false;
  const status = runTestSuite({
    argv: [],
    cwd: '/repo',
    listTargets: () => ['tests/a.test.js'],
    // 2 is the project-wide "preflight refused" reservation.
    preflight: () => 2,
    spawn: () => {
      spawned = true;
      return { status: 0 };
    },
    cleanup: () => {},
  });

  assert.equal(status, 2, 'the preflight exit code must propagate');
  assert.equal(spawned, false, 'no suite may run behind a refused preflight');
});

// ---------------------------------------------------------------------------
// `--help` is a query, never a suite run. Without a `usage` spec the flag
// fell through to `runTestSuite`: preflight, ~10 000 tests, and a `temp/`
// sweep in answer to a question about flags. `runAsCli` fires the same
// `respondToHelp` gate asserted here **before** main, so the "no side
// effects" half holds structurally.
// ---------------------------------------------------------------------------

test('--help short-circuits: usage on stdout, and zero runner spawns', () => {
  for (const flag of ['--help', '-h']) {
    let printed = '';
    let spawns = 0;
    const out = {
      write: (s) => {
        printed += s;
      },
    };

    // The exact composition `runAsCli` performs: the help gate runs first,
    // and main is never invoked when it answers.
    if (!respondToHelp([flag], USAGE, out)) {
      runTestSuite({
        argv: [flag],
        cwd: '/repo',
        listTargets: () => ['tests/a.test.js'],
        spawn: () => {
          spawns += 1;
          return { status: 0 };
        },
        cleanup: () => {},
        preflight: () => 0,
      });
    }

    assert.equal(spawns, 0, `${flag} must spawn no test runner`);
    assert.match(printed, /^Usage: node \.agents\/scripts\/run-tests\.js/);
    assert.match(printed, /--tier <full\|quick\|integration\|e2e>/);
    assert.match(printed, /--test-name-pattern/);
  }
});

test('run-tests.js hands its usage spec to runAsCli, so main never runs for --help', () => {
  // The short-circuit lives in `runAsCli`; a script only gets it by passing
  // `usage`. Losing that line silently restores the full-suite `--help`.
  const src = readFileSync(
    new URL('../../.agents/scripts/run-tests.js', import.meta.url),
    'utf8',
  );
  assert.match(src, /usage: USAGE/);
  assert.match(USAGE, /^Usage: node \.agents\/scripts\/run-tests\.js/);
  assert.match(USAGE, /--tier <full\|quick\|integration\|e2e>/);
  // Story #5111 — the usage block must describe the argv contract
  // `parseTierArgv` actually enforces. It previously promised that "every
  // unrecognized argument is forwarded verbatim", which is now the opposite
  // of what happens, and a --help that contradicts the CLI is worse than no
  // --help: it is the surface an operator trusts instead of reading the code.
  assert.match(USAGE, /--test-only/);
  assert.match(USAGE, /rejected rather than forwarded/);
  assert.equal(
    /forwarded verbatim, in flag position/.test(USAGE),
    false,
    'the retired "every unrecognized argument is forwarded" promise must not survive',
  );
});

test('the runner defaults to the shared preflight rather than a no-op', () => {
  // Injecting nothing must not silently skip the preflight: the default is
  // the real `runTierPreflight`, which is what makes `npm test` and a bare
  // `node .agents/scripts/run-tests.js` behave identically.
  const src = readFileSync(
    new URL('../../.agents/scripts/run-tests.js', import.meta.url),
    'utf8',
  );
  assert.match(src, /preflight = runTierPreflight/);
});
