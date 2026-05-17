/**
 * single-story-sweep/sweep-lock.js
 *
 * Story #2011: best-effort cross-session lock for the
 * `single-story-sweep` step in `single-story-init.js`. Without a lock,
 * two concurrent `/single-story-deliver` invocations can each compute
 * candidate sets, then each call `executeCleanup` against branches the
 * other was about to act on — producing the "story-2004 toggles in and
 * out of `git worktree list`" pattern observed during Story #2007's
 * session.
 *
 * The lock primitive is a single-file rendezvous:
 *
 *   - `acquireSweepLock({ lockPath, timeoutMs })` opens the file with
 *     `wx` so concurrent attempts fail at the syscall layer (atomic
 *     create-or-error).
 *   - A stale lockfile (mtime older than `timeoutMs`) is treated as
 *     expired and replaced — protects against operators who Ctrl-C
 *     mid-init.
 *   - The returned `release` callback unlinks the file. A process
 *     `'exit'` listener also unlinks as a belt-and-braces guard.
 *
 * The lock is never load-bearing: the caller (`single-story-init.js`)
 * skips the sweep when the lock is contended and continues with init.
 * That matches the existing "sweep never blocks init" contract.
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Pure: read the lockfile mtime. Returns `null` when the file is
 * absent or stat fails (treat as "no holder"). Exported for tests.
 */
export function readLockMtime(lockPath, fsImpl = fs) {
  try {
    const stat = fsImpl.statSync(lockPath);
    return stat.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Pure: is the lockfile mtime older than `timeoutMs`? A `null` mtime
 * (no file) returns `false` — the lock isn't held, there's nothing to
 * be stale. Exported for tests.
 */
export function isLockStale(mtime, nowMs, timeoutMs) {
  if (mtime === null) return false;
  return nowMs - mtime > timeoutMs;
}

/**
 * Attempt to atomically create the lockfile. Returns `true` on success,
 * `false` when another process holds it. Any other I/O error throws.
 *
 * Uses `fs.openSync(path, 'wx')` — the `'wx'` flag combination is
 * `O_CREAT | O_EXCL | O_WRONLY` which fails with `EEXIST` if the file
 * already exists. Atomic on POSIX and on Windows ReFS/NTFS.
 */
function tryCreateLock(lockPath, ownerId, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(lockPath), { recursive: true });
  let fd;
  try {
    fd = fsImpl.openSync(lockPath, 'wx');
  } catch (err) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  }
  try {
    fsImpl.writeSync(
      fd,
      `${ownerId}\n${new Date().toISOString()}\n${process.pid}\n`,
    );
  } finally {
    fsImpl.closeSync(fd);
  }
  return true;
}

/**
 * Acquire the sweep lock. Returns one of:
 *
 *   - `{ acquired: true, release: () => void, ownerId }`
 *   - `{ acquired: false, reason: 'contended' | 'error', detail?: string }`
 *
 * When a stale lockfile is found (mtime older than `timeoutMs`), it is
 * unlinked and a fresh acquire is retried once. If the retry also
 * loses the race (another caller acquired between the unlink and the
 * retry), the caller gets `acquired: false, reason: 'contended'` and
 * may decide to skip the sweep — same as a fresh contention.
 *
 * @param {object} opts
 * @param {string} opts.lockPath           Absolute path to the lockfile.
 * @param {number} [opts.timeoutMs=60000]  Stale-lock threshold.
 * @param {string} [opts.ownerId]          Identifier persisted into the
 *                                         lockfile body for postmortem;
 *                                         defaults to a pid+timestamp
 *                                         string.
 * @param {object} [opts.nowFn]            `() => number` (ms epoch);
 *                                         injection seam for tests.
 * @param {object} [opts.fsImpl]           Node `fs` shim for tests.
 * @returns {{ acquired: true, release: () => void, ownerId: string }
 *          | { acquired: false, reason: 'contended' | 'error', detail?: string }}
 */
export function acquireSweepLock({
  lockPath,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ownerId,
  nowFn = Date.now,
  fsImpl = fs,
} = {}) {
  if (typeof lockPath !== 'string' || lockPath.length === 0) {
    return {
      acquired: false,
      reason: 'error',
      detail: 'lockPath is required',
    };
  }
  const id = ownerId ?? `pid-${process.pid}-${nowFn()}`;
  try {
    if (tryCreateLock(lockPath, id, fsImpl)) {
      return buildAcquired(lockPath, id, fsImpl);
    }
    // Contended. Check for stale and retry once if so.
    const mtime = readLockMtime(lockPath, fsImpl);
    if (isLockStale(mtime, nowFn(), timeoutMs)) {
      try {
        fsImpl.unlinkSync(lockPath);
      } catch {
        // Race: another holder may have refreshed the lock between
        // our stat and our unlink. Fall through and report contended.
      }
      if (tryCreateLock(lockPath, id, fsImpl)) {
        return buildAcquired(lockPath, id, fsImpl);
      }
    }
    return { acquired: false, reason: 'contended' };
  } catch (err) {
    return {
      acquired: false,
      reason: 'error',
      detail: err?.message ?? String(err),
    };
  }
}

function buildAcquired(lockPath, ownerId, fsImpl) {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      fsImpl.unlinkSync(lockPath);
    } catch {
      // Already gone — nothing to do.
    }
  };
  // Belt-and-braces: process exit also clears the lockfile so a
  // crashed run doesn't leave a stale-but-not-yet-old artifact behind.
  const exitCleanup = () => release();
  if (typeof process.once === 'function') {
    process.once('exit', exitCleanup);
  }
  return { acquired: true, release, ownerId };
}
