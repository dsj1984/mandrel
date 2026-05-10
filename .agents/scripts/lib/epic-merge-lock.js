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

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const POLL_INTERVAL_MS = 250;

/**
 * Resolve the *common* gitdir for a given working directory.
 *
 * In a linked worktree (`git worktree add ...`), `<repoRoot>/.git` is a
 * one-line gitlink **file**, not a directory. `path.join(repoRoot, '.git')`
 * therefore points at the gitlink file and any `mkdir`/`openSync` against
 * it fails with `EEXIST: file already exists`.
 *
 * Resolution order:
 *   1. If `<repoRoot>/.git` is already a directory, return it. Covers the
 *      main-checkout case and the test fixtures, which create a bare
 *      `.git/` under a temp root — no need to spawn git for those.
 *   2. Otherwise (gitlink file, or `.git` absent), shell out to
 *      `git rev-parse --git-common-dir`. In a worktree this returns the
 *      parent repo's `.git/`, so lock files placed there are shared
 *      across every worktree racing on the same Epic — which is the
 *      correct semantics for an epic-merge mutex.
 *   3. If neither succeeds, fall back to `<repoRoot>/.git`. Lock
 *      acquisition will then surface the underlying error to the
 *      operator with the literal path that failed.
 */
export function resolveGitCommonDir(repoRoot) {
  const local = path.join(repoRoot, '.git');
  try {
    if (fs.statSync(local).isDirectory()) return local;
  } catch {
    // .git does not exist — fall through to git rev-parse.
  }
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return path.isAbsolute(out) ? out : path.resolve(repoRoot, out);
  } catch {
    // not a git repo, or git is unavailable — fall through.
  }
  return local;
}

function lockPathFor(epicId, repoRoot) {
  return path.join(resolveGitCommonDir(repoRoot), `epic-${epicId}.merge.lock`);
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
  // Corrupted lock file (null meta): we can't verify the writer's PID and
  // the age comparison is unsafe on Windows where NTFS mtime vs Date.now()
  // can disagree by hundreds of milliseconds, falsely flipping `ancient`
  // true at short timeouts. Treat the file as held; the caller times out.
  // A truly stuck corrupted lock has to be cleared manually — that's the
  // safer failure mode than wrongly stealing a lock another process owns.
  if (!meta) return false;

  const ageMs = Date.now() - stats.mtimeMs;
  const pidDead = !isProcessRunning(meta.pid);
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

// In-process registry of acquirers waiting on a given lock path. Populated
// the first time a call hits EEXIST (i.e. real contention) and decremented
// in `finally` when the call returns or throws. The holder itself never
// counts — it acquires on the first openSync attempt and exits the
// function, so its count never gets incremented. Exposed via
// `pendingAcquires` so tests can deterministically observe contention
// instead of racing a wall-clock sentinel.
const pendingByPath = new Map();

function incPending(filePath) {
  pendingByPath.set(filePath, (pendingByPath.get(filePath) ?? 0) + 1);
}

function decPending(filePath) {
  const next = (pendingByPath.get(filePath) ?? 0) - 1;
  if (next <= 0) pendingByPath.delete(filePath);
  else pendingByPath.set(filePath, next);
}

/**
 * Number of in-flight `acquireEpicMergeLock` calls currently waiting on
 * the given epic's lock — i.e. callers that hit EEXIST and have not yet
 * acquired or thrown. Excludes the current holder (which acquired on its
 * first attempt and is no longer inside `acquireEpicMergeLock`).
 *
 * Tests use this to assert blocking behaviour without racing real time.
 *
 * @param {number|string} epicId
 * @param {{ repoRoot: string }} opts
 * @returns {number}
 */
export function pendingAcquires(epicId, { repoRoot } = {}) {
  if (!repoRoot) throw new Error('pendingAcquires: repoRoot is required');
  const filePath = lockPathFor(epicId, repoRoot);
  return pendingByPath.get(filePath) ?? 0;
}

// Inner polling loop. Reports contention via `onWait`, which is invoked
// the first time openSync returns EEXIST (i.e. when the call has truly
// started waiting). Kept separate from `acquireEpicMergeLock` so the
// public function's cyclomatic complexity stays flat under CRAP — the
// pending-count bookkeeping lives in the outer wrapper, where its
// branches don't compound with the polling logic.
async function pollForLock(epicId, filePath, timeoutMs, onWait) {
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
      onWait();
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

  let counted = false;
  const onWait = () => {
    if (counted) return;
    incPending(filePath);
    counted = true;
  };
  try {
    return await pollForLock(epicId, filePath, timeoutMs, onWait);
  } finally {
    if (counted) decPending(filePath);
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
