#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * Cross-platform driver for `npm test`.
 *
 * npm lifecycle `posttest` scripts only run after a successful `test` script.
 * This wrapper keeps cleanup in the same process path as the Node test runner
 * so reserved test temp artefacts are removed even when tests fail.
 */

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupRepoTestTempArtifacts } from './cleanup-repo-test-temp.js';
import { runAsCli } from './lib/cli-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// Past ~16 concurrent runners the V8 heap pressure on this suite (370
// files, mostly I/O-light fixtures) outpaces the wall-clock gain.
const TEST_CONCURRENCY_CAP = 16;

export function resolveTestConcurrency(
  parallelism = os.availableParallelism?.() ?? os.cpus().length ?? 1,
  cap = TEST_CONCURRENCY_CAP,
) {
  const n = Math.max(1, Math.min(parallelism, cap));
  return Number.isFinite(n) ? n : 1;
}

export function buildNodeTestArgs(extraArgs = []) {
  return [
    '--experimental-test-module-mocks',
    '--test',
    `--test-concurrency=${resolveTestConcurrency()}`,
    'tests/**/*.test.js',
    ...extraArgs,
  ];
}

export function runTestSuite({
  argv = process.argv.slice(2),
  cwd = ROOT,
  spawn = spawnSync,
  cleanup = cleanupRepoTestTempArtifacts,
} = {}) {
  const testRun = spawn(process.execPath, buildNodeTestArgs(argv), {
    cwd,
    stdio: 'inherit',
  });

  cleanup({ repoRoot: cwd });

  if (testRun.error) {
    throw testRun.error;
  }

  return testRun.status ?? 1;
}

runAsCli(import.meta.url, async () => runTestSuite(), {
  source: 'run-tests',
  propagateExitCode: true,
});
