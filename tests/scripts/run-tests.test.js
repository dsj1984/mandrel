import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { respondToHelp } from '../../.agents/scripts/lib/cli-usage.js';
import { listTestFilesForTier } from '../../.agents/scripts/lib/test-tiers.js';
import {
  buildNodeTestArgs,
  extractShard,
  resolveTestConcurrency,
  runNodeTests,
  runTestSuite,
  shardTestFiles,
  TEST_CONCURRENCY_MAX,
  TEST_CONCURRENCY_MIN,
  TEST_RUNNER_FLAGS,
  toRunOptions,
  USAGE,
} from '../../.agents/scripts/run-tests.js';
import { fcParams } from '../helpers/fast-check-config.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const FIXTURES = 'tests/fixtures/run-tests';

/** Stub every runTestSuite seam; `runTests` defaults to a green run. */
function suiteDeps(overrides = {}) {
  return {
    cwd: '/repo',
    runTests: async () => 0,
    cleanup: () => {},
    fixtureStreamGuard: () => 0,
    preflight: () => 0,
    depositCredit: () => ({ deposited: false, reason: 'stub' }),
    listTargets: () => ['tests/a.test.js'],
    ...overrides,
  };
}

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

test('runTestSuite deposits the close test credit after a green full run (Story #5313)', async () => {
  const deposits = [];
  const status = await runTestSuite(
    suiteDeps({
      argv: [],
      depositCredit: (args) => {
        deposits.push(args);
        return { deposited: true, reason: 'recorded', storyId: 7, sha: 'a' };
      },
    }),
  );
  assert.equal(status, 0);
  assert.equal(deposits.length, 1);
  assert.equal(deposits[0].cwd, '/repo');
  assert.equal(deposits[0].tier, 'full');
  assert.equal(deposits[0].status, 0);
  assert.ok(Number.isInteger(deposits[0].durationMs));
});

test('runTestSuite hands a red run to the depositor and keeps its exit code', async () => {
  const seen = [];
  const status = await runTestSuite(
    suiteDeps({
      argv: [],
      runTests: async () => 1,
      depositCredit: (args) => {
        seen.push(args.status);
        return { deposited: false, reason: 'run-not-green' };
      },
    }),
  );
  assert.equal(status, 1);
  assert.deepEqual(seen, [1]);
});

test('a sharded run deposits no credit: a shard is not a full run', async () => {
  let deposited = false;
  await runTestSuite(
    suiteDeps({
      argv: ['--shard', '1/2'],
      depositCredit: () => {
        deposited = true;
      },
    }),
  );
  assert.equal(deposited, false);
});

test('runTestSuite cleans reserved temp after a failing run, then guards fixture streams', async () => {
  const calls = [];
  const status = await runTestSuite(
    suiteDeps({
      argv: [],
      runTests: async () => {
        calls.push('run');
        return 1;
      },
      cleanup: (opts) => calls.push(`cleanup:${opts.repoRoot}`),
      fixtureStreamGuard: () => {
        calls.push('guard');
        return 0;
      },
    }),
  );
  assert.equal(status, 1);
  assert.deepEqual(calls, ['run', 'cleanup:/repo', 'guard']);
});

test('runTestSuite cleans up then rethrows when the runner throws', async () => {
  let cleaned = false;
  await assert.rejects(
    runTestSuite(
      suiteDeps({
        argv: [],
        runTests: async () => {
          throw new Error('ENOENT');
        },
        cleanup: () => {
          cleaned = true;
        },
      }),
    ),
    /ENOENT/,
  );
  assert.ok(cleaned, 'cleanup must run before the rethrow');
});

test('a polluted fixture stream fails an otherwise green run', async () => {
  const status = await runTestSuite(
    suiteDeps({ argv: [], fixtureStreamGuard: () => 4 }),
  );
  assert.equal(status, 4);
});

test('runTestSuite makes one runner call over the whole tier, with the safe env', async () => {
  const targets = Array.from(
    { length: 900 },
    (_, i) => `tests/dir/file-${String(i).padStart(4, '0')}.test.js`,
  );
  const calls = [];
  await runTestSuite(
    suiteDeps({
      argv: ['--tier', 'quick'],
      listTargets: () => targets,
      runTests: async (opts) => {
        calls.push(opts);
        return 0;
      },
    }),
  );
  assert.equal(calls.length, 1, 'one run() call, never an argv chunk loop');
  assert.deepEqual(calls[0].files, targets);
  assert.equal(calls[0].cwd, '/repo');
  assert.equal(calls[0].only, false);
  assert.equal('testNamePatterns' in calls[0], false);
  assert.ok(calls[0].env.NODE_ENV, 'the child env carries NODE_ENV');
  assert.equal(
    Object.keys(calls[0].env).some((k) => k.startsWith('GIT_')),
    false,
  );
});

test('runTestSuite maps the pass-through flags onto run() options', async () => {
  let seen = null;
  await runTestSuite(
    suiteDeps({
      argv: [
        '--test-name-pattern',
        'foo',
        '--test-name-pattern=bar',
        '--test-only',
      ],
      runTests: async (opts) => {
        seen = opts;
        return 0;
      },
    }),
  );
  assert.deepEqual(seen.testNamePatterns, ['foo', 'bar']);
  assert.equal(seen.only, true);
  assert.deepEqual(seen.files, ['tests/a.test.js']);
});

test('runTestSuite runs only its shard of the tier', async () => {
  let seen = null;
  await runTestSuite(
    suiteDeps({
      argv: ['--shard=2/3'],
      listTargets: () => ['a', 'b', 'c', 'd', 'e'],
      runTests: async (opts) => {
        seen = opts.files;
        return 0;
      },
    }),
  );
  assert.deepEqual(seen, ['b', 'e']);
});

test('a malformed --shard fails before the preflight or any file runs', async () => {
  let ran = false;
  await assert.rejects(
    runTestSuite(
      suiteDeps({
        argv: ['--shard', '3/2'],
        preflight: () => {
          ran = true;
          return 0;
        },
        runTests: async () => {
          ran = true;
          return 0;
        },
      }),
    ),
    /unrecognized argument/,
  );
  assert.equal(ran, false);
});

// ---------------------------------------------------------------------------
// toRunOptions / shardTestFiles — pure argv and partition helpers.
// ---------------------------------------------------------------------------

test('toRunOptions keeps a bare positional as an extra file target', () => {
  assert.deepEqual(toRunOptions(['tests/x.test.js']), {
    only: false,
    files: ['tests/x.test.js'],
  });
});

test('extractShard extracts --shard in both spellings', () => {
  assert.deepEqual(extractShard(['--tier', 'quick', '--shard', '1/2']), {
    shard: { index: 1, total: 2 },
    argv: ['--tier', 'quick'],
  });
  assert.deepEqual(extractShard(['--shard=2/2', '--test-only']), {
    shard: { index: 2, total: 2 },
    argv: ['--test-only'],
  });
  assert.deepEqual(extractShard(['--test-only']), {
    shard: null,
    argv: ['--test-only'],
  });
});

test('extractShard rejects a malformed --shard with the unrecognized-argument error', () => {
  for (const argv of [
    ['--shard'],
    ['--shard', '0/2'],
    ['--shard', '3/2'],
    ['--shard=1-2'],
    ['--shard', 'x/2'],
    ['--shard=1/0'],
  ]) {
    assert.throws(
      () => extractShard(argv),
      /unrecognized argument.*--shard/,
      `${argv.join(' ')} must be rejected`,
    );
  }
});

test('shardTestFiles returns the list unchanged without a shard', () => {
  assert.deepEqual(shardTestFiles(['a', 'b'], null), ['a', 'b']);
});

test('shardTestFiles: the n shards are pairwise disjoint and their union is the list', () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), {
        maxLength: 40,
      }),
      fc.integer({ min: 1, max: 8 }),
      (raw, total) => {
        const files = [...raw].sort();
        const shards = Array.from({ length: total }, (_, i) =>
          shardTestFiles(files, { index: i + 1, total }),
        );
        const seen = shards.flat();
        assert.equal(seen.length, files.length, 'no file in two shards');
        assert.deepEqual([...seen].sort(), files, 'every file in a shard');
      },
    ),
    fcParams(),
  );
});

test('the live quick tier splits into two disjoint, complete shards', () => {
  const files = listTestFilesForTier('quick', REPO_ROOT);
  const one = shardTestFiles(files, { index: 1, total: 2 });
  const two = shardTestFiles(files, { index: 2, total: 2 });
  assert.ok(one.length > 0 && two.length > 0);
  assert.deepEqual([...one, ...two].sort(), files);
});

// ---------------------------------------------------------------------------
// runNodeTests — the real in-process run() over fixture files. Exit status
// and filtering must match what `node --test` produced before the rewrite.
// ---------------------------------------------------------------------------

/** The parent env minus NODE_TEST_CONTEXT, whose presence makes run() refuse to recurse. */
function childEnv(extra = {}) {
  const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
  return { ...env, ...extra };
}

async function runFixtures(names, opts = {}) {
  let text = '';
  const stdout = new Writable({
    write(chunk, _enc, done) {
      text += chunk;
      done();
    },
  });
  const status = await runNodeTests({
    files: names.map((n) => `${FIXTURES}/${n}.fixture.js`),
    cwd: REPO_ROOT,
    env: childEnv(),
    stdout,
    ...opts,
  });
  return { status, text };
}

test('runNodeTests exits 0 on a green file and reports TAP off a TTY', async () => {
  const { status, text } = await runFixtures(['pass']);
  assert.equal(status, 0);
  assert.match(text, /^TAP version 13/m);
  assert.match(text, /ok \d+ - alpha-kept/);
});

test('runNodeTests exits 1 on a failing test', async () => {
  const { status, text } = await runFixtures(['pass', 'fail']);
  assert.equal(status, 1);
  assert.match(text, /not ok \d+ - fails/);
});

test('runNodeTests exits 1 on a file that crashes at load', async () => {
  const { status } = await runFixtures(['crash']);
  assert.equal(status, 1);
});

test('runNodeTests does not fail the run on a failing todo test', async () => {
  const { status } = await runFixtures(['todo']);
  assert.equal(status, 0);
});

test('runNodeTests applies --test-name-pattern', async () => {
  const { status, text } = await runFixtures(['pass'], {
    testNamePatterns: ['alpha'],
  });
  assert.equal(status, 0);
  assert.match(text, /ok \d+ - alpha-kept/);
  assert.doesNotMatch(text, /ok \d+ - beta-dropped/);
});

test('runNodeTests applies --test-only', async () => {
  const { status, text } = await runFixtures(['only'], { only: true });
  assert.equal(status, 0);
  assert.match(text, /ok \d+ - focused/);
  assert.doesNotMatch(text, /ok \d+ - unfocused/);
});

test('runNodeTests restores the parent env and cwd after the run', async () => {
  const cwd = process.cwd();
  const before = process.env.RUN_TESTS_PROBE;
  await runFixtures(['pass'], {
    env: childEnv({ RUN_TESTS_PROBE: 'set-for-children' }),
  });
  assert.equal(process.cwd(), cwd);
  assert.equal(process.env.RUN_TESTS_PROBE, before);
});

// ---------------------------------------------------------------------------
// Story #4936 — the tier preflight must actually execute. `.npmrc` sets
// `ignore-scripts=true` (CWE-1357 defence, which stays), and that suppresses
// npm's `pre*` hooks for `npm run` too, so `pretest`, `pretest:quick` and
// `pretest:integration` fired for no tier at all. The runner owns the
// invocation now; these are the assertions that hold it to that.
// ---------------------------------------------------------------------------

test('runTestSuite runs the preflight for the tier before running the suite', async () => {
  const order = [];
  const status = await runTestSuite(
    suiteDeps({
      argv: ['--tier', 'quick'],
      preflight: (opts) => {
        order.push(`preflight:${opts.tier}:${opts.repoRoot}`);
        return 0;
      },
      runTests: async () => {
        order.push('run');
        return 0;
      },
    }),
  );
  assert.equal(status, 0);
  assert.deepEqual(order, ['preflight:quick:/repo', 'run']);
});

test('runTestSuite passes each tier through to the preflight', async () => {
  for (const tier of ['full', 'quick', 'integration']) {
    const seen = [];
    await runTestSuite(
      suiteDeps({
        argv: ['--tier', tier],
        listTargets: () => [],
        preflight: (opts) => {
          seen.push(opts.tier);
          return 0;
        },
      }),
    );
    assert.deepEqual(seen, [tier], `tier ${tier} must reach the preflight`);
  }
});

test('a refused preflight aborts before the test runner is ever called', async () => {
  let ran = false;
  const status = await runTestSuite(
    suiteDeps({
      argv: [],
      // 2 is the project-wide "preflight refused" reservation.
      preflight: () => 2,
      runTests: async () => {
        ran = true;
        return 0;
      },
    }),
  );
  assert.equal(status, 2, 'the preflight exit code must propagate');
  assert.equal(ran, false, 'no suite may run behind a refused preflight');
});

// ---------------------------------------------------------------------------
// `--help` is a query, never a suite run. Without a `usage` spec the flag
// fell through to `runTestSuite`: preflight, ~10 000 tests, and a `temp/`
// sweep in answer to a question about flags. `runAsCli` fires the same
// `respondToHelp` gate asserted here **before** main, so the "no side
// effects" half holds structurally.
// ---------------------------------------------------------------------------

test('--help short-circuits: usage on stdout, and zero runner calls', async () => {
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
      await runTestSuite(
        suiteDeps({
          argv: [flag],
          runTests: async () => {
            spawns += 1;
            return 0;
          },
        }),
      );
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
