#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * Cross-platform driver for `npm test`. Cleanup runs in-process so reserved
 * temp artefacts are removed even when tests fail (`posttest` would not run).
 *
 * The child env unsets `NOTIFICATION_WEBHOOK_URL` so no test POSTs to a live
 * webhook from `.env` (`MANDREL_ALLOW_TEST_WEBHOOKS=1` opts back in).
 *
 * Every tier enumerates explicit file targets (`node --test` has no negative
 * pattern), which overflows the Windows ~32 767-char command line, so targets
 * are chunked into one spawn per chunk.
 *
 * A green full-tier run in a `story-<id>` checkout deposits close's `test`
 * gate evidence.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
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
import { listTestFilesForTier, parseTierArgv } from './lib/test-tiers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

export {
  resolveTestConcurrency,
  TEST_CONCURRENCY_MAX,
  TEST_CONCURRENCY_MIN,
  TEST_RUNNER_FLAGS,
};

/**
 * Per-spawn budget for the joined targets. Windows: ~a quarter of the
 * 32 767-char ceiling, leaving room for exe path and flags. POSIX `ARG_MAX` is
 * far larger, so its budget keeps a tier in one spawn (each extra chunk pays a
 * runner start-up and idles cores at its tail).
 */
export const MAX_TARGET_CHARS = 8000;
export const POSIX_MAX_TARGET_CHARS = 100_000;

/**
 * @param {NodeJS.Platform} [platform]
 * @returns {number}
 */
export function resolveMaxTargetChars(platform = process.platform) {
  return platform === 'win32' ? MAX_TARGET_CHARS : POSIX_MAX_TARGET_CHARS;
}

/**
 * Order-preserving chunks with joined length ≤ `maxChars`. An oversized
 * target gets its own chunk; an empty list yields one empty chunk so the
 * caller still spawns once.
 *
 * @param {string[]} targets
 * @param {number} [maxChars]
 * @returns {string[][]}
 */
export function chunkTestTargets(targets, maxChars = MAX_TARGET_CHARS) {
  const chunks = [];
  let current = [];
  let currentLen = 0;

  for (const target of targets) {
    const addition = target.length + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && currentLen + addition > maxChars) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(target);
    currentLen += target.length + (current.length > 1 ? 1 : 0);
  }

  if (current.length > 0) chunks.push(current);
  return chunks.length > 0 ? chunks : [[]];
}

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

export function runTestSuite({
  argv = process.argv.slice(2),
  cwd = ROOT,
  spawn = spawnSync,
  cleanup = cleanupRepoTestTempArtifacts,
  listTargets = listTestFilesForTier,
  maxTargetChars = resolveMaxTargetChars(),
  fixtureStreamGuard = assertNoReservedIdStreams,
  preflight = runTierPreflight,
  depositCredit = reportTestRunCredit,
} = {}) {
  const { tier, rest } = parseTierArgv(argv);

  // Nothing has been created yet, so a refusal needs no cleanup.
  const preflightStatus = preflight({ tier, repoRoot: cwd });
  if (preflightStatus !== 0) return preflightStatus;

  const targets = listTargets(tier, cwd);
  const chunks = chunkTestTargets(targets, maxTargetChars);

  const env = buildWebhookSafeTestEnv(process.env);
  const startedAt = Date.now();
  let status = 0;
  let spawnError = null;

  for (const chunk of chunks) {
    const testRun = spawn(
      process.execPath,
      // Pass-through flags precede the targets (see `buildNodeTestArgs`).
      [...TEST_RUNNER_FLAGS, ...rest, ...chunk],
      { cwd, stdio: 'inherit', env },
    );
    if (testRun.error) {
      spawnError = testRun.error;
      break;
    }
    const chunkStatus = testRun.status ?? 1;
    // First non-zero wins; later chunks still run to report every failure.
    if (chunkStatus !== 0 && status === 0) status = chunkStatus;
  }

  cleanup({ repoRoot: cwd });

  // Fail a run whose fixture telemetry leaked into the live signals tree,
  // where the retro graduator would count it as real evidence.
  const polluted = fixtureStreamGuard({ cwd });
  if (polluted !== 0 && status === 0) status = polluted;

  if (spawnError) {
    throw spawnError;
  }

  // Best-effort; never affects the exit code.
  depositCredit({ cwd, tier, status, durationMs: Date.now() - startedAt });

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
                        The documented \`node --test\` pass-throughs, forwarded
                        verbatim in flag position, ahead of the file targets.
                        Any other \`--flag\` is rejected rather than forwarded:
                        \`node --test\` reads an unrecognized flag as another
                        file pattern, so forwarding one ran nothing and
                        still exited 0.
  --help                Show this message.

Exits with the first non-zero \`node --test\` chunk status, or 2 when the tier
preflight refuses to start the suite.
`;

runAsCli(import.meta.url, async () => runTestSuite(), {
  source: 'run-tests',
  propagateExitCode: true,
  usage: USAGE,
});
