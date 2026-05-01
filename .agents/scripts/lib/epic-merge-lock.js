/**
 * lib/epic-merge-lock.js — Filesystem mutex for Epic-branch merges.
 *
 * Parallel-wave story closures can race on the Epic branch: two
 * `story-close.js` invocations both `git checkout <epic>`, both
 * `git pull --rebase`, and both attempt to merge — the second push
 * often ends up rejected or, worse, races past the first and produces
 * an incorrect history.
 *
 * This module provides a best-effort cooperative lock keyed per Epic.
 * The lock file lives at `<repoRoot>/.git/epic-<epicId>.merge.lock`
 * (inside `.git/` so it never lands in a commit). Acquisition uses
 * `fs.openSync(..., 'wx')` for atomicity; on contention we poll every
 * 250ms until `timeoutMs` elapses.
 *
 * Stale-lock stealing:
 *   - If the PID recorded in the lock is not running (per
 *     `process.kill(pid, 0)`), or
 *   - if the lock file is older than `timeoutMs * 2`,
 *   the lock is stolen (unlinked) and re-acquired.
 */

import fs from 'node:fs';
import path from 'node:path';

const POLL_INTERVAL_MS = 250;

function lockPathFor(epicId, repoRoot) {
  return path.join(repoRoot, '.git', `epic-${epicId}.merge.lock`);
}

function isProcessRunning(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Signal 0 does not deliver a signal; it just checks existence.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process. EPERM = exists but we can't signal — still alive.
    return err.code === 'EPERM';
  }
}

function readLockMeta(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      pid: Number(parsed.pid),
      acquiredAt: Number(parsed.acquiredAt),
    };
  } catch {
    return null;
  }
}

function tryStealStale(filePath, timeoutMs) {
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    return false;
  }

  const meta = readLockMeta(filePath);
  const ageMs = Date.now() - stats.mtimeMs;

  const pidDead = meta && !isProcessRunning(meta.pid);
  const ancient = ageMs > timeoutMs * 2;

  if (pidDead || ancient) {
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire an exclusive Epic merge lock.
 *
 * @param {number|string} epicId
 * @param {{ repoRoot: string, timeoutMs?: number }} opts
 * @returns {Promise<{ epicId: number|string, filePath: string, acquiredAt: number }>}
 * @throws {Error} on timeout.
 */
export async function acquireEpicMergeLock(
  epicId,
  { repoRoot, timeoutMs = 60_000 } = {},
) {
  if (!repoRoot) throw new Error('acquireEpicMergeLock: repoRoot is required');

  const filePath = lockPathFor(epicId, repoRoot);
  // Ensure the .git directory exists (it will, in a real repo, but the
  // tests use a temp dir and need us to be forgiving).
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const started = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(filePath, 'wx');
      const acquiredAt = Date.now();
      fs.writeSync(
        fd,
        JSON.stringify({ pid: process.pid, acquiredAt }, null, 2),
      );
      fs.closeSync(fd);
      return { epicId, filePath, acquiredAt };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Try stealing if the current holder is stale.
      if (tryStealStale(filePath, timeoutMs)) continue;
      if (Date.now() - started >= timeoutMs) {
        const meta = readLockMeta(filePath);
        const detail = meta
          ? ` (held by pid ${meta.pid} since ${new Date(meta.acquiredAt).toISOString()})`
          : '';
        throw new Error(
          `acquireEpicMergeLock timed out after ${timeoutMs}ms for epic ${epicId}${detail}`,
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

/**
 * Release a previously-acquired Epic merge lock.
 *
 * @param {{ filePath: string }} handle
 */
export function releaseEpicMergeLock(handle) {
  if (!handle?.filePath) return;
  try {
    fs.unlinkSync(handle.filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}
