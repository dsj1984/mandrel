#!/usr/bin/env node
// cli-opt-out: top-level CLI driver invoked via npm run test:coverage; spawns child processes rather than parsing argv, so runAsCli() does not apply.
/**
 * Cross-platform driver for `npm run test:coverage`.
 *
 * Why this exists: setting `NODE_V8_COVERAGE` directly in a package.json
 * script string (`NODE_V8_COVERAGE=... node ...`) is bash-only — Windows
 * cmd.exe (npm's default script-shell on Windows) treats it as a literal
 * argument and node never sees the env var. Wrapping the run in this
 * Node script keeps the env injection portable.
 *
 * Pipeline:
 *   0. Run the full tier's preflight (`runTierPreflight`). Story #4936: this
 *      used to be a `pretest:coverage` npm script that CI had to name
 *      explicitly, because `.npmrc`'s `ignore-scripts=true` (CWE-1357
 *      defence, which stays) suppresses every `pre*` hook. The runner
 *      invokes it now, so it executes however the coverage run is started.
 *   1. Run the test suite under `NODE_V8_COVERAGE` so each worker writes
 *      raw V8 dumps under `coverage/tmp/`. The suite targets are the
 *      shared `FULL_TIER_GLOBS` from `lib/test-tiers.js` — the same set
 *      `run-tests.js` walks — so the measured surface and `npm test`'s
 *      surface are the same set by construction.
 *   2. `c8 report` post-processes the dumps into `coverage/coverage-final.json`
 *      plus the printed text table. Include/exclude scope from `.c8rc.cjs`
 *      is passed explicitly because `c8 report` does not auto-load the
 *      config file.
 *   3. `check-baselines.js --gate coverage` compares the per-file
 *      lines/branches/functions percentages in `coverage-final.json`
 *      against the recorded floors in `baselines/coverage.json` and
 *      fails on any regression. Update the baseline with
 *      `npm run coverage:update` when you intentionally change scope.
 *
 * The previous shape of this script wrapped tests in `c8 <cmd>`. A
 * one-off A/B benchmark (now retired) showed the NODE_V8_COVERAGE +
 * `c8 report` path is ~19% faster end-to-end on a Windows dev host
 * while producing an identical `coverage-final.json` artifact for the
 * CRAP gate.
 *
 * Test-runner flags: the suite spawn reuses `TEST_RUNNER_FLAGS` from
 * `lib/test-runner-contract.js` — the single source of truth for the
 * `node --test` flag set, including the host-derived
 * `--test-concurrency` value clamped to `[TEST_CONCURRENCY_MIN,
 * TEST_CONCURRENCY_MAX]`. Story #4936: sharing the whole flag set (not
 * just the concurrency number) is what stops this runner and
 * `run-tests.js` disagreeing about whether a test can execute at all —
 * `--experimental-test-module-mocks` decides whether `t.mock.module`
 * works, and this is the *required* CI job.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanupRepoTestTempArtifacts } from '../.agents/scripts/cleanup-repo-test-temp.js';
import { buildWebhookSafeTestEnv } from '../.agents/scripts/lib/test-env.js';
import {
  runTierPreflight,
  TEST_RUNNER_FLAGS,
} from '../.agents/scripts/lib/test-runner-contract.js';
import { FULL_TIER_GLOBS } from '../.agents/scripts/lib/test-tiers.js';
import { C8_CLI } from './lib/c8-cli-path.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const C8_CONFIG = require('../.c8rc.cjs');

/**
 * Build the `node --test` argv for the coverage suite spawn.
 *
 * Reuses two shared constants so the coverage path cannot drift from
 * `run-tests.js`:
 *
 *   - `TEST_RUNNER_FLAGS` — the single source of truth for the host-aware,
 *     clamped `--test-concurrency` value.
 *   - `FULL_TIER_GLOBS` — the single source of truth for *which files the
 *     full tier runs*. Story #4922: this script used to restate
 *     `tests/**\/*.test.js` on its own, so the 47 colocated `__tests__`
 *     suites under `lib/` and `.agents/scripts/` executed under `npm test`
 *     but never under the measuring run — the coverage and CRAP numbers
 *     were computed over code the coverage run had not executed.
 *
 * Both parameters are injected in tests so the argv can be asserted without
 * touching the OS.
 *
 * @param {object} [opts]
 * @param {readonly string[]} [opts.runnerFlags]
 * @param {readonly string[]} [opts.testGlobs]
 * @returns {string[]}
 */
export function buildCoverageTestArgs({
  runnerFlags = TEST_RUNNER_FLAGS,
  testGlobs = FULL_TIER_GLOBS,
} = {}) {
  return [...runnerFlags, ...testGlobs];
}

/**
 * Execute the coverage pipeline: run the full tier's preflight, run the
 * suite under `NODE_V8_COVERAGE`, post-process the dumps with `c8 report`,
 * then gate on the coverage baseline. Returns the first non-zero exit code
 * across the stages (or the baseline check's status when the prior stages
 * pass); a refused preflight short-circuits before anything is spawned or
 * removed.
 *
 * Every collaborator is injected so the pipeline's wiring — above all
 * *that the preflight actually runs, and runs first* — is assertable
 * without spawning the real suite.
 *
 * @param {object} [opts]
 * @param {typeof spawnSync} [opts.spawn]
 * @param {(opts: { tier: string, repoRoot: string }) => number} [opts.preflight]
 * @param {(opts: { repoRoot: string }) => unknown} [opts.cleanup]
 * @param {string} [opts.repoRoot]
 * @returns {number}
 */
export function runCoveragePipeline({
  spawn = spawnSync,
  preflight = runTierPreflight,
  cleanup = cleanupRepoTestTempArtifacts,
  repoRoot = ROOT,
} = {}) {
  const coverageDir = path.join(repoRoot, 'coverage');
  const v8Tmp = path.join(coverageDir, 'tmp');

  const preflightStatus = preflight({ tier: 'full', repoRoot });
  if (preflightStatus !== 0) return preflightStatus;

  rmSync(coverageDir, { recursive: true, force: true });
  mkdirSync(v8Tmp, { recursive: true });

  const testRun = spawn(process.execPath, buildCoverageTestArgs(), {
    cwd: repoRoot,
    stdio: 'inherit',
    // GIT_*-scrubbed: under a husky pre-push from a linked worktree the
    // inherited GIT_DIR poisons fixture `git init` runs (#4580).
    env: { ...buildWebhookSafeTestEnv(process.env), NODE_V8_COVERAGE: v8Tmp },
  });

  cleanup({ repoRoot });

  const includeArgs = (C8_CONFIG.include ?? []).flatMap((p) => [
    '--include',
    p,
  ]);
  const excludeArgs = (C8_CONFIG.exclude ?? []).flatMap((p) => [
    '--exclude',
    p,
  ]);

  // `c8 report` does not auto-load `.c8rc.cjs`, so every scope knob it needs
  // is forwarded explicitly from the config object — including `all`, which
  // is what puts a 0 % row on a source file no test ever loaded (Story
  // #4922). Reading it off the config keeps `.c8rc.cjs` the one declaration.
  const allArgs = C8_CONFIG.all ? ['--all'] : [];

  const reportRun = spawn(
    process.execPath,
    [
      C8_CLI,
      'report',
      '--reporter=json',
      '--reporter=text',
      ...allArgs,
      '--temp-directory',
      v8Tmp,
      ...includeArgs,
      ...excludeArgs,
    ],
    { cwd: repoRoot, stdio: 'inherit', shell: false },
  );

  const checkRun = spawn(
    process.execPath,
    [
      path.join(repoRoot, '.agents', 'scripts', 'check-baselines.js'),
      '--gate',
      'coverage',
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  );

  return testRun.status !== 0
    ? (testRun.status ?? 1)
    : reportRun.status !== 0
      ? (reportRun.status ?? 1)
      : (checkRun.status ?? 1);
}

// Run the pipeline only when invoked directly as a CLI; importing the
// module (e.g. from a test asserting the spawn argv) must not spawn the
// real suite.
if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  process.exit(runCoveragePipeline());
}
