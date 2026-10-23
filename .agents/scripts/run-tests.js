#!/usr/bin/env node
/* node:coverage ignore file -- the suite driver itself */

/**
 * Cross-platform driver for `npm test`. Cleanup runs in-process so reserved
 * temp artefacts are removed even when tests fail (`posttest` would not run).
 *
 * The tier runs through one in-process `node:test` `run()` call with process
 * isolation: files reach each child one path at a time, so no command line
 * ever carries the whole tier. Children inherit this process's env and cwd
 * (Node 22's `run()` takes neither option), so both are swapped for the run.
 * The env unsets `NOTIFICATION_WEBHOOK_URL` so no test POSTs to a live
 * webhook from `.env` (`MANDREL_ALLOW_TEST_WEBHOOKS=1` opts back in).
 *
 * A green full-tier run in a `story-<id>` checkout deposits close's `test`
 * gate evidence.
 */

import path from 'node:path';
import { run } from 'node:test';
import { spec, tap } from 'node:test/reporters';
import { fileURLToPath } from 'node:url';
import { assertNoReservedIdStreams } from './check-test-temp-hygiene.js';
import { cleanupRepoTestTempArtifacts } from './cleanup-repo-test-temp.js';
import { runAsCli } from './lib/cli-utils.js';
import { buildWebhookSafeTestEnv } from './lib/test-env.js';
import { reportTestRunCredit } from './lib/test-run-credit.js';
import {
  resolveTestConcurrency,
  runTierPreflight,
  TEST_CONCURRENCY_MAX,
  TEST_CONCURRENCY_MIN,
  TEST_RUNNER_FLAGS,
} from './lib/test-runner-contract.js';
import {
  listTestFilesForTier,
  PASSTHROUGH_FLAGS,
  parseTierArgv,
  unrecognizedArgument,
} from './lib/test-tiers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

/** Child node flags, derived from the shared declaration (module mocks). */
const CHILD_EXEC_ARGV = TEST_RUNNER_FLAGS.filter((f) =>
  f.startsWith('--experimental-'),
);

export {
  resolveTestConcurrency,
  TEST_CONCURRENCY_MAX,
  TEST_CONCURRENCY_MIN,
  TEST_RUNNER_FLAGS,
};

/**
 * Every flag must precede the targets: Node stops parsing options at the
 * first positional and reads a later flag as a file pattern. Hence
 * `reporter` is an option here, not something a caller appends.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.extraArgs]
 * @param {'full' | 'quick' | 'integration'} [opts.tier]
 * @param {string} [opts.repoRoot]
 * @param {string} [opts.reporter]
 * @returns {string[]}
 */
export function buildNodeTestArgs({
  extraArgs = [],
  tier = 'full',
  repoRoot = ROOT,
  reporter,
} = {}) {
  return [
    ...(reporter
      ? [...TEST_RUNNER_FLAGS, '--test-reporter', reporter]
      : TEST_RUNNER_FLAGS),
    ...extraArgs,
    ...listTestFilesForTier(tier, repoRoot),
  ];
}

const SHARD_RE = /^(\d+)\/(\d+)$/;

/** `i/n` with 1 ≤ i ≤ n, else null. */
function parseShardValue(raw) {
  const match = SHARD_RE.exec(raw ?? '');
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  return index >= 1 && index <= total ? { index, total } : null;
}

/**
 * Pull `--shard <i>/<n>` or `--shard=<i>/<n>` out of argv; a malformed or
 * out-of-range value throws the unrecognized-argument error.
 */
export function extractShard(argv) {
  const at = argv.findIndex((a) => a === '--shard' || a.startsWith('--shard='));
  if (at === -1) return { shard: null, argv };
  const span = argv[at] === '--shard' ? 2 : 1;
  const flag = argv.slice(at, at + span).join(' ');
  const shard = parseShardValue(flag.slice('--shard '.length));
  if (!shard) throw unrecognizedArgument([flag]);
  return { shard, argv: argv.filter((_, i) => i < at || i >= at + span) };
}

/**
 * Shard `i` of `n` keeps every file whose index ≡ i-1 (mod n) — the rule
 * `node --test --test-shard` applies — so shards partition the list.
 */
export function shardTestFiles(files, shard) {
  if (!shard) return files;
  return files.filter((_, i) => i % shard.total === shard.index - 1);
}

/**
 * Map the pass-through argv onto `run()` options. A bare positional is an
 * extra file, as it was on the old `node --test` command line.
 *
 * @param {string[]} rest
 * @returns {{ testNamePatterns?: string[], only: boolean, files: string[] }}
 */
export function toRunOptions(rest) {
  const [namePattern, onlyFlag] = PASSTHROUGH_FLAGS;
  const patterns = [];
  const files = [];
  let only = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === namePattern) {
      i += 1;
      patterns.push(rest[i]);
    } else if (arg.startsWith(`${namePattern}=`)) {
      patterns.push(arg.slice(namePattern.length + 1));
    } else if (arg === onlyFlag) {
      only = true;
    } else {
      files.push(arg);
    }
  }
  return {
    ...(patterns.length > 0 ? { testNamePatterns: patterns } : {}),
    only,
    files,
  };
}

function replaceProcessEnv(next) {
  for (const key of Object.keys(process.env)) {
    if (!Object.hasOwn(next, key)) delete process.env[key];
  }
  Object.assign(process.env, next);
}

/**
 * The default runner: one `run()` over `files`, reported as TAP off a TTY
 * (CI logs, `test-output.txt`) and spec on one. Resolves 1 when any non-todo
 * test fails — a crashing file reports as a failed file-level test.
 */
export async function runNodeTests({
  files,
  cwd,
  env,
  testNamePatterns,
  only = false,
  stdout = process.stdout,
}) {
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  replaceProcessEnv(env);
  process.chdir(cwd);
  let failed = false;
  try {
    const stream = run({
      files,
      isolation: 'process',
      concurrency: resolveTestConcurrency(),
      execArgv: CHILD_EXEC_ARGV,
      testNamePatterns,
      only,
    });
    stream.on('test:fail', (data) => {
      if (!data.todo) failed = true;
    });
    for await (const chunk of stream.compose(stdout.isTTY ? new spec() : tap)) {
      stdout.write(chunk);
    }
  } finally {
    process.chdir(savedCwd);
    replaceProcessEnv(savedEnv);
  }
  return failed ? 1 : 0;
}

export async function runTestSuite({
  argv = process.argv.slice(2),
  cwd = ROOT,
  runTests = runNodeTests,
  cleanup = cleanupRepoTestTempArtifacts,
  listTargets = listTestFilesForTier,
  fixtureStreamGuard = assertNoReservedIdStreams,
  preflight = runTierPreflight,
  depositCredit = reportTestRunCredit,
  stdout = process.stdout,
} = {}) {
  const { shard, argv: unsharded } = extractShard(argv);
  const { tier, rest } = parseTierArgv(unsharded);

  // Nothing has been created yet, so a refusal needs no cleanup.
  const preflightStatus = preflight({ tier, repoRoot: cwd });
  if (preflightStatus !== 0) return preflightStatus;

  const { files: extraFiles, ...options } = toRunOptions(rest);
  const files = shardTestFiles(
    [...new Set([...listTargets(tier, cwd), ...extraFiles])],
    shard,
  );

  const startedAt = Date.now();
  let status = 1;
  try {
    status = await runTests({
      ...options,
      files,
      cwd,
      env: buildWebhookSafeTestEnv(process.env),
      stdout,
    });
  } finally {
    cleanup({ repoRoot: cwd });
  }

  // Fail a run whose fixture telemetry leaked into the live signals tree,
  // where the retro graduator would count it as real evidence.
  const polluted = fixtureStreamGuard({ cwd });
  if (polluted !== 0 && status === 0) status = polluted;

  // Best-effort; never affects the exit code. A shard is not a full run.
  if (!shard) {
    depositCredit({ cwd, tier, status, durationMs: Date.now() - startedAt });
  }

  return status;
}

/**
 * `runAsCli` prints this and returns before `main`, so `--help` never runs
 * the suite.
 */
export const USAGE = `Usage: node .agents/scripts/run-tests.js [--tier <full|quick|integration|e2e>] [runner args...]

Run the test suite: tier preflight, \`node --test\` over the tier's targets,
then reserved-temp cleanup — which runs even when the suite fails.

Flags:
  --tier <full|quick|integration|e2e>
                        Tier to run. Default: full — every test file except
                        \`tests/e2e/**\`, which only \`--tier e2e\` runs.
  --test-name-pattern <re>, --test-only
                        The documented \`node --test\` pass-throughs, mapped
                        onto the \`run()\` options \`testNamePatterns\` / \`only\`.
                        Any other \`--flag\` is rejected rather than forwarded,
                        so a typo never runs nothing and still exits 0.
  --shard <i>/<n>       Run shard i of n (1 ≤ i ≤ n) of the tier's sorted
                        file list; the n shards partition it.
  --help                Show this message.

Exits 1 when any non-todo test fails, or 2 when the tier preflight refuses
to start the suite.
`;

runAsCli(import.meta.url, async () => runTestSuite(), {
  source: 'run-tests',
  propagateExitCode: true,
  usage: USAGE,
});
