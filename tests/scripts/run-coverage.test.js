import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  resolveTestConcurrency,
  TEST_CONCURRENCY_MAX,
  TEST_CONCURRENCY_MIN,
  TEST_RUNNER_FLAGS,
} from '../../.agents/scripts/lib/test-runner-contract.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import { FULL_TIER_GLOBS } from '../../.agents/scripts/lib/test-tiers.js';
import { buildNodeTestArgs } from '../../.agents/scripts/run-tests.js';
import {
  buildCoverageTestArgs,
  runCoveragePipeline,
} from '../../scripts/run-coverage.js';

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

// Story #5065 — the coverage spawn runs the FULL tier, always. Story #4981
// forwarded the changed-file set as `npm run test:coverage -- <files>` on the
// premise that trailing positionals filter the suite; this script has always
// discarded them, which is the only reason that never caused damage. Honouring
// them would be actively harmful, so the behaviour is pinned here rather than
// left looking like an oversight for someone to "fix".
test('buildCoverageTestArgs runs the full tier and ignores positional file arguments', () => {
  const baseline = buildCoverageTestArgs();

  // The globs it runs are the full-tier SSOT, not a caller-supplied subset.
  for (const glob of FULL_TIER_GLOBS) {
    assert.ok(
      baseline.includes(glob),
      `coverage argv must run the full tier glob ${glob}`,
    );
  }

  // Positionals reaching this process (npm forwards everything after `--`)
  // must not alter the argv. Node's runner treats a path as a test file to
  // EXECUTE, not a filter: forwarding a source file would run it as a
  // trivially-passing test, skip the real suite, and hand a near-empty
  // coverage artifact to the coverage baseline and the CRAP join.
  const argvBefore = process.argv;
  try {
    process.argv = [
      ...argvBefore.slice(0, 2),
      '.agents/scripts/coverage-capture.js',
      'scripts/run-coverage.js',
    ];
    assert.deepEqual(
      buildCoverageTestArgs(),
      baseline,
      'coverage argv must not change when positional file arguments are present — ' +
        'honouring them would execute those source files as tests instead of running the suite',
    );
  } finally {
    process.argv = argvBefore;
  }
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

// ---------------------------------------------------------------------------
// Story #4922 — the coverage runner must target the SAME file set the full
// tier runs. It previously restated `tests/**/*.test.js` as its own literal,
// so the colocated `__tests__` suites under lib/ and .agents/scripts/ ran
// under `npm test` but were absent from every coverage and CRAP reading.
// ---------------------------------------------------------------------------

test('buildCoverageTestArgs targets every full-tier glob after the runner flags', () => {
  const args = buildCoverageTestArgs();
  assert.ok(args.includes('--test'));

  // The trailing positionals are exactly FULL_TIER_GLOBS, in order.
  assert.deepEqual(args.slice(-FULL_TIER_GLOBS.length), [...FULL_TIER_GLOBS]);

  // Every runner flag still precedes the first positional.
  const firstGlobIdx = args.indexOf(FULL_TIER_GLOBS[0]);
  assert.equal(firstGlobIdx, args.length - FULL_TIER_GLOBS.length);
});

test('buildCoverageTestArgs restates no glob literal of its own', () => {
  // Injecting a sentinel glob set proves the builder has no hardcoded
  // fallback target: nothing but the injected globs reaches the argv tail.
  const args = buildCoverageTestArgs({ testGlobs: ['sentinel/**/*.test.js'] });
  assert.equal(args.at(-1), 'sentinel/**/*.test.js');
  assert.ok(
    !args.some((a) => a.includes('tests/**')),
    'coverage argv must not carry a hardcoded tests/** literal',
  );
});

test('buildCoverageTestArgs covers the colocated __tests__ roots', () => {
  const args = buildCoverageTestArgs();
  assert.ok(
    args.some((a) => a.startsWith('lib/') && a.includes('__tests__')),
    'coverage argv must reach the colocated lib/ __tests__ suites',
  );
  assert.ok(
    args.some(
      (a) => a.startsWith('.agents/scripts/') && a.includes('__tests__'),
    ),
    'coverage argv must reach the colocated .agents/scripts/ __tests__ suites',
  );
});

// ---------------------------------------------------------------------------
// Story #4936 — the two full-tier runners must not diverge on a `node --test`
// flag. `--experimental-test-module-mocks` decides whether a `t.mock.module`
// suite can execute at all, and `npm run test:coverage` is the *required* CI
// job: a flag present in one runner and absent from the other turns a healthy
// test into a CI-only failure with no source defect. The assertion below is
// the tripwire that was missing — it fails if a flag is added to either
// runner alone.
// ---------------------------------------------------------------------------

/** The flag portion of an argv: everything before the first positional. */
function flagsOf(args) {
  return args.filter((a) => a.startsWith('-'));
}

test('both runners build the same node --test flag set', () => {
  const coverageFlags = flagsOf(buildCoverageTestArgs());
  const testFlags = flagsOf(buildNodeTestArgs({ tier: 'full' }));

  assert.deepEqual(
    coverageFlags,
    testFlags,
    'run-coverage.js and run-tests.js must spawn `node --test` with an ' +
      'identical flag set — a flag added to one runner only is exactly the ' +
      'divergence Story #4936 closes',
  );
  assert.deepEqual(coverageFlags, [...TEST_RUNNER_FLAGS]);
});

test('the shared flag set carries --experimental-test-module-mocks into both runners', () => {
  // The concrete regression: `tests/single-story-close-orchestration.test.js`
  // and its siblings use `t.mock.module`, which is inert without this flag.
  for (const args of [
    buildCoverageTestArgs(),
    buildNodeTestArgs({ tier: 'full' }),
  ]) {
    assert.ok(args.includes('--experimental-test-module-mocks'));
  }
});

test('neither runner restates a flag literal of its own', () => {
  // Inject a sentinel flag set into the coverage builder: if it carried a
  // hardcoded flag of its own, that flag would survive the injection.
  const injected = buildCoverageTestArgs({ runnerFlags: ['--sentinel'] });
  assert.deepEqual(flagsOf(injected), ['--sentinel']);

  const testSrc = fs.readFileSync(
    new URL('../../.agents/scripts/run-tests.js', import.meta.url),
    'utf8',
  );
  const coverageSrc = fs.readFileSync(
    new URL('../../scripts/run-coverage.js', import.meta.url),
    'utf8',
  );
  for (const [label, src] of [
    ['run-tests.js', testSrc],
    ['run-coverage.js', coverageSrc],
  ]) {
    assert.ok(
      !/^(?!.*import).*'--experimental-test-module-mocks'/m.test(src),
      `${label} must not restate the module-mock flag — it comes from ` +
        'lib/test-runner-contract.js',
    );
  }
});

// ---------------------------------------------------------------------------
// Story #4936 — the coverage tier's preflight must execute, and execute
// first. It used to be a `pretest:coverage` npm script that only fired
// because CI named it by hand; `.npmrc`'s `ignore-scripts=true` (which stays)
// meant nothing else ever ran it.
// ---------------------------------------------------------------------------

test('the coverage pipeline runs the full-tier preflight before anything else', () => {
  const repoRoot = makeTempDir('coverage-pipeline-');
  const order = [];
  const status = runCoveragePipeline({
    repoRoot,
    preflight: (opts) => {
      order.push(`preflight:${opts.tier}`);
      return 0;
    },
    spawn: (_cmd, args) => {
      order.push(args.includes('report') ? 'report' : args[0]);
      return { status: 0 };
    },
    cleanup: () => order.push('cleanup'),
  });

  assert.equal(status, 0);
  assert.equal(order[0], 'preflight:full', 'the preflight must run first');
  assert.ok(order.includes('cleanup'));
  // The coverage temp directory is created only after the preflight passes.
  assert.ok(fs.existsSync(path.join(repoRoot, 'coverage', 'tmp')));
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('a refused coverage preflight aborts before the suite is spawned', () => {
  const repoRoot = makeTempDir('coverage-refused-');
  let spawned = false;
  const status = runCoveragePipeline({
    repoRoot,
    preflight: () => 2,
    spawn: () => {
      spawned = true;
      return { status: 0 };
    },
    cleanup: () => {},
  });

  assert.equal(status, 2, 'the refusal code must propagate');
  assert.equal(spawned, false, 'no measured run may start behind a refusal');
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'coverage', 'tmp')),
    false,
    'a refused preflight must not have created the coverage tree',
  );
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('the coverage suite spawn carries NODE_V8_COVERAGE and the shared argv', () => {
  const repoRoot = makeTempDir('coverage-argv-');
  const spawns = [];
  runCoveragePipeline({
    repoRoot,
    preflight: () => 0,
    spawn: (cmd, args, opts) => {
      spawns.push({ cmd, args, opts });
      return { status: 0 };
    },
    cleanup: () => {},
  });

  const suiteRun = spawns[0];
  assert.deepEqual(suiteRun.args, buildCoverageTestArgs());
  assert.equal(
    suiteRun.opts.env.NODE_V8_COVERAGE,
    path.join(repoRoot, 'coverage', 'tmp'),
  );
  // The report and the baseline gate follow, in that order.
  assert.ok(spawns[1].args.includes('report'));
  assert.ok(spawns[2].args.some((a) => a.endsWith('check-baselines.js')));
  assert.deepEqual(spawns[2].args.slice(-2), ['--gate', 'coverage']);
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('the pipeline returns the test status ahead of the report and gate statuses', () => {
  // Diagnostic ordering guard: a failing TEST must be what the exit code
  // reports, even though the coverage table and gate JSON print after it.
  const repoRoot = makeTempDir('coverage-status-');
  let call = 0;
  const status = runCoveragePipeline({
    repoRoot,
    preflight: () => 0,
    spawn: () => {
      call += 1;
      return { status: call === 1 ? 9 : 0 };
    },
    cleanup: () => {},
  });
  assert.equal(status, 9);
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('a failing coverage gate surfaces its own exit code', () => {
  const repoRoot = makeTempDir('coverage-gate-');
  let call = 0;
  const status = runCoveragePipeline({
    repoRoot,
    preflight: () => 0,
    spawn: () => {
      call += 1;
      return { status: call === 3 ? 1 : 0 };
    },
    cleanup: () => {},
  });
  assert.equal(status, 1);
  fs.rmSync(repoRoot, { recursive: true, force: true });
});
