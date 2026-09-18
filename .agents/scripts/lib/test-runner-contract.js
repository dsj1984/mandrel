/**
 * The contract both full-tier runners (`run-tests.js`, `run-coverage.js`)
 * share: the `node --test` flag set and the per-tier preflight. A flag
 * divergence (e.g. module mocks) makes a suite pass under one runner and fail
 * under the other, so neither restates a literal.
 *
 * The preflight is invoked by the runners, never an npm `pre*` hook:
 * `.npmrc`'s `ignore-scripts=true` (CWE-1357 defence) suppresses those.
 */

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const TEST_CONCURRENCY_MIN = 1;
export const TEST_CONCURRENCY_MAX = 16;

/**
 * Host parallelism clamped to the concurrency bounds.
 *
 * @param {number} [parallelism]
 * @returns {number}
 */
export function resolveTestConcurrency(
  parallelism = os.availableParallelism(),
) {
  return Math.min(
    TEST_CONCURRENCY_MAX,
    Math.max(TEST_CONCURRENCY_MIN, parallelism),
  );
}

/** The single `node --test` flag declaration for every runner spawn. */
export const TEST_RUNNER_FLAGS = Object.freeze([
  '--experimental-test-module-mocks',
  '--test',
  `--test-concurrency=${resolveTestConcurrency()}`,
]);

/**
 * Per-tier preflight scripts; `full` (release-shaped, also the coverage
 * tier) adds the skills validator. Not exported: tests assert the mapping
 * through the spawns `runTierPreflight` issues.
 */
const STATE_PROBE_ONLY = Object.freeze(['.agents/scripts/test-wrapper.js']);

const TIER_PREFLIGHT_SCRIPTS = Object.freeze({
  full: Object.freeze([
    ...STATE_PROBE_ONLY,
    '.agents/scripts/validate-skills.js',
  ]),
  quick: STATE_PROBE_ONLY,
  integration: STATE_PROBE_ONLY,
  // A tier missing here silently runs no preflight at all.
  e2e: STATE_PROBE_ONLY,
});

/**
 * Run a tier's preflight in order, stopping at (and returning) the first
 * failure's exit code, like npm `pre<script>`.
 *
 * @param {object} [opts]
 * @param {'full' | 'quick' | 'integration' | 'e2e'} [opts.tier]
 * @param {string} [opts.repoRoot]
 * @param {typeof spawnSync} [opts.spawn]
 * @param {string} [opts.execPath]
 * @returns {number} 0 when every preflight script passed, else the first
 *   non-zero exit code.
 */
export function runTierPreflight({
  tier = 'full',
  repoRoot = process.cwd(),
  spawn = spawnSync,
  execPath = process.execPath,
} = {}) {
  for (const script of TIER_PREFLIGHT_SCRIPTS[tier] ?? []) {
    const run = spawn(execPath, [path.join(repoRoot, script)], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    if (run.error) throw run.error;
    // A signal-killed child reports `status: null`.
    if (run.status !== 0) return run.status ?? 1;
  }
  return 0;
}
