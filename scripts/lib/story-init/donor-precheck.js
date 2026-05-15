/**
 * donor-precheck.js — verify the symlink-strategy donor is primed.
 *
 * When `delivery.worktreeIsolation.nodeModulesStrategy === 'symlink'`, every
 * Story worktree junctions/symlinks its `node_modules/` from a donor (the
 * `primeFromPath` directory, typically the repo root). If the donor lacks
 * `node_modules/` the symlink will resolve to nothing and the worktree
 * cannot install or run tests. This module runs once, just before
 * `applyNodeModulesStrategy`, to make sure the donor is primed.
 *
 * The pre-check is idempotent across concurrent wave dispatches via a
 * filesystem lock directory at `<donor>/.agents-donor-precheck.lock`. The
 * first arrival creates the lock atomically (`fs.mkdirSync`), runs
 * `npm ci`, and removes the lock. Concurrent callers either skip
 * (donor already primed) or wait for the lock to clear and re-check
 * existence — they do not double-run the installer.
 *
 * The helpers are split so the pure decision logic (`planDonorAction`) is
 * trivially testable without filesystem or child-process side-effects.
 */

import { spawnSync } from 'node:child_process';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

const LOCK_DIRNAME = '.agents-donor-precheck.lock';
const LOCK_POLL_INTERVAL_MS = 100;
const LOCK_WAIT_TIMEOUT_MS = 5 * 60_000;

/**
 * Pure: decide whether the donor needs a one-shot install.
 *
 * Returns one of:
 *   - `{ action: 'skip', reason }` — strategy is not symlink, or donor
 *     already has node_modules.
 *   - `{ action: 'install', donorPath }` — caller should run install at
 *     `donorPath`.
 *
 * @param {object} opts
 * @param {string} opts.strategy         The configured `nodeModulesStrategy`.
 * @param {string|null} opts.primeFromPath  Relative donor path.
 * @param {string} opts.repoRoot         Absolute repo root.
 * @param {{ existsSync: (p: string) => boolean }} [opts.fs]
 *   Filesystem facade for tests.
 * @returns {{ action: 'skip', reason: string } | { action: 'install', donorPath: string }}
 */
export function planDonorAction({
  strategy,
  primeFromPath,
  repoRoot,
  fs = nodeFs,
  path = nodePath,
}) {
  if (strategy !== 'symlink') {
    return { action: 'skip', reason: 'strategy-not-symlink' };
  }
  if (!primeFromPath) {
    return { action: 'skip', reason: 'no-prime-from-path' };
  }
  const donorPath = path.resolve(repoRoot, primeFromPath);
  if (fs.existsSync(path.join(donorPath, 'node_modules'))) {
    return { action: 'skip', reason: 'donor-already-primed' };
  }
  return { action: 'install', donorPath };
}

/**
 * Wait for the donor lock directory to be removed by the lock holder.
 * Returns true if the lock cleared in time, false on timeout.
 *
 * Exported for tests.
 */
export function waitForLockClear({
  lockPath,
  fs = nodeFs,
  pollIntervalMs = LOCK_POLL_INTERVAL_MS,
  timeoutMs = LOCK_WAIT_TIMEOUT_MS,
  now = () => Date.now(),
  sleepFn,
}) {
  const start = now();
  const sleep =
    sleepFn ??
    ((ms) => {
      const signal = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(signal, 0, 0, ms);
    });
  while (fs.existsSync(lockPath)) {
    if (now() - start >= timeoutMs) return false;
    sleep(pollIntervalMs);
  }
  return true;
}

/**
 * Ensure the symlink-strategy donor is primed. Runs at most once per
 * dispatch wave because the lock directory is created atomically with
 * `fs.mkdirSync` (EEXIST = another concurrent process already won).
 *
 * Behaviour by lock outcome:
 *   - Lock acquired → run `npm ci`, then remove the lock.
 *   - Lock contended → wait for the lock to clear, then re-check
 *     existence. If `node_modules` is now present, skip; otherwise,
 *     surface an error (the lock holder failed and the caller cannot
 *     safely proceed).
 *
 * @param {object} opts
 * @param {string} opts.strategy
 * @param {string|null} opts.primeFromPath
 * @param {string} opts.repoRoot
 * @param {{ progress?: (kind: string, msg: string) => void }} [opts.logger]
 * @param {{ existsSync: typeof nodeFs.existsSync, mkdirSync: typeof nodeFs.mkdirSync, rmSync: typeof nodeFs.rmSync }} [opts.fs]
 * @param {typeof spawnSync} [opts.spawnFn]   Injected installer for tests.
 * @param {(opts: object) => boolean} [opts.waitFn]  Injected lock waiter.
 * @returns {{ action: 'skip' | 'installed' | 'waited', reason?: string, donorPath?: string, durationMs?: number }}
 */
export function ensureDonorPrimed({
  strategy,
  primeFromPath,
  repoRoot,
  logger,
  fs = nodeFs,
  path = nodePath,
  spawnFn = spawnSync,
  waitFn = waitForLockClear,
  now = () => Date.now(),
}) {
  const t0 = now();
  const progress = logger?.progress ?? (() => {});
  const plan = planDonorAction({ strategy, primeFromPath, repoRoot, fs, path });
  if (plan.action === 'skip') {
    return { action: 'skip', reason: plan.reason, durationMs: now() - t0 };
  }

  const { donorPath } = plan;
  const lockPath = path.join(donorPath, LOCK_DIRNAME);
  let lockAcquired = false;
  try {
    fs.mkdirSync(lockPath);
    lockAcquired = true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  if (!lockAcquired) {
    progress('DONOR-PRECHECK', `donor=${donorPath} lock contended, waiting...`);
    const cleared = waitFn({ lockPath, fs });
    if (!cleared) {
      throw new Error(
        `donor-precheck: timed out waiting for lock ${lockPath} to clear after ${LOCK_WAIT_TIMEOUT_MS}ms`,
      );
    }
    if (!fs.existsSync(path.join(donorPath, 'node_modules'))) {
      throw new Error(
        `donor-precheck: lock holder released ${lockPath} without priming node_modules at ${donorPath}`,
      );
    }
    progress(
      'DONOR-PRECHECK',
      `donor=${donorPath} primed by concurrent dispatch, proceeding.`,
    );
    return { action: 'waited', donorPath, durationMs: now() - t0 };
  }

  try {
    // Re-check between mkdir and install: another process could have run
    // and finished while we were racing on mkdirSync.
    if (fs.existsSync(path.join(donorPath, 'node_modules'))) {
      progress(
        'DONOR-PRECHECK',
        `donor=${donorPath} already primed (post-lock recheck), skipping install.`,
      );
      return {
        action: 'skip',
        reason: 'donor-primed-post-lock',
        donorPath,
        durationMs: now() - t0,
      };
    }
    progress(
      'DONOR-PRECHECK',
      `donor=${donorPath} missing node_modules — running one-shot npm ci...`,
    );
    const result = spawnFn('npm', ['ci'], {
      cwd: donorPath,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      timeout: 10 * 60_000,
    });
    if (result.status !== 0) {
      throw new Error(
        `donor-precheck: 'npm ci' at ${donorPath} exited with status ${result.status}`,
      );
    }
    progress('DONOR-PRECHECK', `donor=${donorPath} primed in ${now() - t0}ms.`);
    return { action: 'installed', donorPath, durationMs: now() - t0 };
  } finally {
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
    } catch (_err) {
      // Best-effort lock release; subsequent runs will recover by
      // re-checking node_modules existence.
    }
  }
}

export const __LOCK_DIRNAME = LOCK_DIRNAME;
