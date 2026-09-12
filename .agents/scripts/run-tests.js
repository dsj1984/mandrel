#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * Cross-platform driver for `npm test`.
 *
 * npm lifecycle `posttest` scripts only run after a successful `test` script.
 * This wrapper keeps cleanup in the same process path as the Node test runner
 * so reserved test temp artefacts are removed even when tests fail.
 *
 * Webhook scrub: the test child inherits an environment where
 * `NOTIFICATION_WEBHOOK_URL` is unset and `NODE_ENV=test`. Operators keep a
 * real webhook URL in `.env` for development (resolveConfig loads it into
 * process.env); without this scrub, any test that transitively reaches
 * `notify()` POSTs to the live endpoint. Set `MANDREL_ALLOW_TEST_WEBHOOKS=1`
 * to opt back in for the rare case where a contract test deliberately
 * exercises a sandbox endpoint.
 *
 * Windows arg-length safety: every tier enumerates explicit test-file
 * targets. `quick` / `integration` always did (they exclude specific slow
 * suites, so a single glob will not do), and `full` joined them in Story
 * #5111 — `node --test` has no negative pattern, so "everything except
 * `tests/e2e/**`" is only sayable as a file set. With ~700+ targets the
 * joined command line crosses the Windows `CreateProcess` ~32 767-char
 * `lpCommandLine` ceiling, and `spawnSync` throws `ENAMETOOLONG` before a
 * single test runs. To stay safe on every platform the runner partitions the
 * targets into chunks whose joined length stays well under that ceiling
 * (`MAX_TARGET_CHARS`) and spawns one `node --test` process per chunk,
 * aggregating the exit codes. On POSIX the far larger
 * `POSIX_MAX_TARGET_CHARS` budget collapses every tier back into one spawn.
 *
 * Suite credit (Story #5313): a green full-tier run inside a `story-<id>`
 * checkout deposits the `test` gate's evidence record — the one
 * `single-story-close.js` reads — so a bare `npm test` in the worktree is
 * credited at unchanged HEAD. See `lib/test-run-credit.js`.
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

// The runner contract (flag set, concurrency clamp, tier preflight) is
// declared once in `lib/test-runner-contract.js` so `run-coverage.js` shares
// it by construction. Re-exported here because this module is the runner's
// public face for its own unit tests.
export {
  resolveTestConcurrency,
  TEST_CONCURRENCY_MAX,
  TEST_CONCURRENCY_MIN,
  TEST_RUNNER_FLAGS,
};

/**
 * Per-spawn character budget for the joined *targets* portion of the argv.
 *
 * The Windows `CreateProcess` command-line ceiling is 32 767 chars for the
 * whole `lpCommandLine` (node exe path + flags + targets + extra args +
 * quoting). Budgeting the targets to 8 000 chars keeps every spawn's full
 * command line at roughly a quarter of the ceiling — ample headroom for the
 * exe path and any pass-through `--test-name-pattern` args — while keeping
 * the chunk count (and thus the extra `node` start-ups) low.
 *
 * `MAX_TARGET_CHARS` is the **Windows** budget. On POSIX hosts `ARG_MAX` is
 * far higher (~256 KB on macOS, ~1 MB on Linux), so applying the Windows
 * budget there needlessly serializes the quick tier into several sequential
 * `node --test` spawns — each chunk pays a fresh runner start-up, and cores
 * idle at every chunk's tail. `POSIX_MAX_TARGET_CHARS` (100 000) lets the
 * whole quick-tier target list (~33 000 chars today) collapse into a single
 * spawn on POSIX while staying far below `ARG_MAX`.
 * `resolveMaxTargetChars` picks the budget per platform; the Windows
 * semantics of `MAX_TARGET_CHARS` are unchanged.
 */
export const MAX_TARGET_CHARS = 8000;
export const POSIX_MAX_TARGET_CHARS = 100_000;

/**
 * Resolve the per-spawn target-character budget for the host platform.
 * The `platform` parameter is injected in tests.
 *
 * @param {NodeJS.Platform} [platform]
 * @returns {number}
 */
export function resolveMaxTargetChars(platform = process.platform) {
  return platform === 'win32' ? MAX_TARGET_CHARS : POSIX_MAX_TARGET_CHARS;
}

/**
 * Partition an ordered list of test-file targets into chunks whose joined
 * length (targets + single-space separators) stays at or below `maxChars`.
 * Order is preserved. A single target longer than the budget still lands in
 * its own chunk rather than being dropped. An empty target list yields a
 * single empty chunk so the caller still issues exactly one spawn (matching
 * the historical single-spawn behaviour, e.g. the `full`-tier glob path).
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
    // +1 for the separator that would join this target to the previous one.
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
 * Build the argv for one `node --test` invocation.
 *
 * **Flag position is load-bearing.** Node stops treating tokens as options
 * at the first positional, so every runner flag — the fixed
 * `TEST_RUNNER_FLAGS`, the optional `--test-reporter`, and any caller
 * `extraArgs` — has to sit *before* the test-file targets. Appending
 * `--test-reporter tap` after the targets (what `run-test-profile.js` used
 * to do) made Node read the two tokens as two more file patterns: the
 * default reporter ran, no TAP was emitted, and the profiler parsed zero
 * timed entries out of a full suite run. `reporter` is therefore an option
 * of this builder rather than something a caller concatenates on the end.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.extraArgs] Extra runner arguments (flag position).
 * @param {'full' | 'quick' | 'integration'} [opts.tier]
 * @param {string} [opts.repoRoot]
 * @param {string} [opts.reporter] `--test-reporter` value, e.g. `'tap'`.
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

  // Preflight first, and abort on refusal — the tier's checks exist to stop
  // the suite starting from a known-bad state, so running them after the
  // spawn would be pointless. Nothing has been created yet, so there is
  // nothing to clean up on this path.
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
      // `rest` carries the documented `node --test` pass-throughs
      // (`--test-name-pattern`, `--test-only`) — `parseTierArgv` has already
      // rejected anything else. They precede the targets for the same reason
      // `buildNodeTestArgs` orders them that way: Node stops parsing options
      // at the first positional, so a flag after a target is silently read as
      // another file pattern.
      [...TEST_RUNNER_FLAGS, ...rest, ...chunk],
      { cwd, stdio: 'inherit', env },
    );
    if (testRun.error) {
      spawnError = testRun.error;
      break;
    }
    const chunkStatus = testRun.status ?? 1;
    // First non-zero exit code wins; later chunks still run so the full
    // failure surface is reported in one CI pass.
    if (chunkStatus !== 0 && status === 0) status = chunkStatus;
  }

  cleanup({ repoRoot: cwd });

  // A test that spawns a real CLI at the repository root inherits the real
  // state directory, so its fixture telemetry can land in the operator's live
  // signals tree — where the retro graduator counts it as recurrence evidence
  // and files a ticket citing a fixture Story id. Fail the run that caused it
  // rather than discovering it from that ticket.
  const polluted = fixtureStreamGuard({ cwd });
  if (polluted !== 0 && status === 0) status = polluted;

  if (spawnError) {
    throw spawnError;
  }

  // Story #5313 — a green full run earns close's `test` credit; best-effort,
  // never the exit code.
  depositCredit({ cwd, tier, status, durationMs: Date.now() - startedAt });

  return status;
}

/**
 * `--help` contract for the runner — the pre-rendered shape
 * `lib/cli-usage.js` accepts alongside a spec object, matching how
 * `check-baselines.js` declares its own.
 *
 * Handed to `runAsCli`, which prints it and returns **before** `main` runs.
 * That ordering is the whole point: with no `usage` the flag fell through to
 * `runTestSuite`, which ran the tier preflight, spawned the full ~10 000-test
 * suite, and swept `temp/` — 25+ seconds and a mutated working tree in
 * answer to a question about flags.
 *
 * Exported so the unit test can assert the documented surface without
 * spawning the CLI.
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
