/**
 * tests/scripts/story-init-install-soak.test.js
 *
 * Soak test for the pnpm-store install ladder. Simulates 5 consecutive
 * worktree inits and asserts:
 *
 *   - the prime sentinel runs exactly once (first iteration), is cached
 *     thereafter,
 *   - zero `npm ci` fallbacks fire across the run (i.e. no Logger.error
 *     calls naming the recovery command),
 *   - every iteration completes successfully.
 *
 * The test drives the pure helpers directly so it can run in any CI sandbox
 * without spawning real pnpm processes. Each iteration calls primePnpmStore
 * followed by a runInstallWithRetry that succeeds on attempt 1 — modelling
 * the post-hardening steady state the parent Story is engineering toward.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PNPM_STORE_PRIME_SENTINEL,
  installRetryPolicy,
  primePnpmStore,
  runInstallWithRetry,
} from '../../.agents/scripts/lib/worktree/node-modules-strategy.js';

function collectingLogger() {
  const calls = { info: [], warn: [], error: [] };
  return {
    calls,
    info: (msg) => calls.info.push(msg),
    warn: (msg) => calls.warn.push(msg),
    error: (msg) => calls.error.push(msg),
  };
}

test('soak: 5 consecutive worktree inits produce zero npm ci fallbacks', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-prime-'));
  const logger = collectingLogger();
  let primeSpawns = 0;
  let installSpawns = 0;

  const iterations = 5;
  for (let i = 0; i < iterations; i += 1) {
    // Each iteration represents a fresh `story-init.js` worktree creation.
    // Prime first (no-op after the first iteration writes the sentinel).
    const primeResult = primePnpmStore({
      strategy: 'pnpm-store',
      repoRoot,
      logger,
      spawnFn: () => {
        primeSpawns += 1;
        return { status: 0, stderr: '' };
      },
    });
    if (i === 0) {
      assert.equal(primeResult.primed, 'primed', 'first iteration primes');
    } else {
      assert.equal(primeResult.primed, 'cached', 'subsequent iterations cached');
    }

    // Then run the worktree-local install; success on attempt 1 models the
    // post-hardening steady state we want to soak-test.
    const install = runInstallWithRetry({
      cmd: 'pnpm',
      args: ['install', '--frozen-lockfile'],
      cwd: `/tmp/wt-${i}`,
      shell: false,
      policy: installRetryPolicy('pnpm'),
      spawnFn: () => {
        installSpawns += 1;
        return { status: 0, stderr: '' };
      },
      sleepFn: () => {},
      logger,
      strategy: 'pnpm-store',
    });
    assert.equal(install.ok, true, `iteration ${i} install ok`);
    assert.equal(install.attempts, 1, `iteration ${i} no retries needed`);
  }

  // The whole point of the hardened ladder: zero fallback errors across the soak.
  assert.equal(
    logger.calls.error.length,
    0,
    `expected zero Logger.error fallbacks, got ${logger.calls.error.length}: ${JSON.stringify(
      logger.calls.error,
    )}`,
  );
  // And zero "npm ci" recovery references anywhere in the log surface — the
  // failure-recovery message is the canonical signal that the ladder collapsed.
  const npmCiMentions = [...logger.calls.error, ...logger.calls.warn].filter(
    (m) => /npm ci/.test(m),
  );
  assert.equal(npmCiMentions.length, 0, 'no npm ci recovery messages emitted');

  // Prime ran exactly once; install ran exactly N times.
  assert.equal(primeSpawns, 1, 'prime spawned exactly once across the soak');
  assert.equal(installSpawns, iterations, 'one install spawn per iteration');

  // Sentinel persisted on disk.
  assert.equal(
    fs.existsSync(path.join(repoRoot, PNPM_STORE_PRIME_SENTINEL)),
    true,
    'sentinel persists for downstream worktrees on the same machine',
  );
});

test('soak: a single transient hiccup in the middle still avoids npm ci fallback', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-hiccup-'));
  const logger = collectingLogger();
  let primeSpawns = 0;

  const iterations = 5;
  for (let i = 0; i < iterations; i += 1) {
    primePnpmStore({
      strategy: 'pnpm-store',
      repoRoot,
      logger,
      spawnFn: () => {
        primeSpawns += 1;
        return { status: 0, stderr: '' };
      },
    });

    // Iteration 2 fails once then succeeds on retry — the retry ladder
    // catches it and no fallback fires.
    let perIterCalls = 0;
    const install = runInstallWithRetry({
      cmd: 'pnpm',
      args: ['install', '--frozen-lockfile'],
      cwd: `/tmp/wt-${i}`,
      shell: false,
      policy: installRetryPolicy('pnpm'),
      spawnFn: () => {
        perIterCalls += 1;
        if (i === 2 && perIterCalls === 1) {
          return { status: 1, stderr: 'transient EAGAIN' };
        }
        return { status: 0, stderr: '' };
      },
      sleepFn: () => {},
      logger,
      strategy: 'pnpm-store',
    });
    assert.equal(install.ok, true);
  }

  assert.equal(logger.calls.error.length, 0, 'still zero npm ci fallbacks');
  assert.equal(primeSpawns, 1, 'still exactly one prime');
});
