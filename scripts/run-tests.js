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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupRepoTestTempArtifacts } from './cleanup-repo-test-temp.js';
import { runAsCli } from './lib/cli-utils.js';
import { listTestFilesForTier, parseTierArgv } from './lib/test-tiers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

/**
 * @param {object} [opts]
 * @param {string[]} [opts.extraArgs]
 * @param {'full' | 'quick' | 'integration'} [opts.tier]
 * @param {string} [opts.repoRoot]
 */
export function buildNodeTestArgs({
  extraArgs = [],
  tier = 'full',
  repoRoot = ROOT,
} = {}) {
  const targets = listTestFilesForTier(tier, repoRoot);
  return [
    '--experimental-test-module-mocks',
    '--test',
    '--test-concurrency=8',
    ...targets,
    ...extraArgs,
  ];
}

export function runTestSuite({
  argv = process.argv.slice(2),
  cwd = ROOT,
  spawn = spawnSync,
  cleanup = cleanupRepoTestTempArtifacts,
} = {}) {
  const { tier, rest } = parseTierArgv(argv);
  const testRun = spawn(
    process.execPath,
    buildNodeTestArgs({ extraArgs: rest, tier, repoRoot: cwd }),
    {
      cwd,
      stdio: 'inherit',
    },
  );

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
