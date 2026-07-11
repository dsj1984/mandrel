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
 *
 * Test seams (mirroring `single-story-sweep/sweep-lock.js`):
 *   - `nowFn`   — `() => number` (ms epoch); replaces `Date.now`.
 *   - `fsImpl`  — Node `fs` shim; replaces the imported `fs`.
 *   - `killFn`  — `(pid, signal) => void`; replaces `process.kill`,
 *                 so a test can make `pidDead` deterministic without
 *                 fabricating a real dead PID.
 *   - `sleepFn` — `(ms) => Promise<void>`; replaces the real
 *                 `setTimeout`-backed sleep, so the poll loop can spin
 *                 with no wall-clock waits.
 * All four default to the real implementations, so production callers
 * (`acquire(epicId, { repoRoot, timeoutMs })`) see no behavior change.
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
export function resolveGitCommonDir(repoRoot, fsImpl = fs) {
  const local = path.join(repoRoot, '.git');
  try {
    if (fsImpl.statSync(local).isDirectory()) return local;
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

function lockPathFor(epicId, repoRoot, fsImpl = fs) {
  return path.join(
    resolveGitCommonDir(repoRoot, fsImpl),
    `epic-${epicId}.merge.lock`,
  );
}

function isProcessRunning(pid, killFn = process.kill) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Signal 0 does not deliver a signal; it just checks existence.
    killFn(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process. EPERM = exists but we can't signal — still alive.
    return err.code === 'EPERM';
  }
}

function readLockMeta(filePath, fsImpl = fs) {
  try {
    const raw = fsImpl.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      pid: Number(parsed.pid),
      acquiredAt: Number(parsed.acquiredAt),
    };
  } catch {
    return null;
  }
}

function tryStealStale(filePath, timeoutMs, seams) {
  const { fsImpl, nowFn, killFn } = seams;
  let stats;
  try {
    stats = fsImpl.statSync(filePath);
  } catch {
    return false;
  }

  const meta = readLockMeta(filePath, fsImpl);
  // Corrupted lock file (null meta): we can't verify the writer's PID and
  // the age comparison is unsafe on Windows where NTFS mtime vs Date.now()
  // can disagree by hundreds of milliseconds, falsely flipping `ancient`
  // true at short timeouts. Treat the file as held; the caller times out.
  // A truly stuck corrupted lock has to be cleared manually — that's the
  // safer failure mode than wrongly stealing a lock another process owns.
  if (!meta) return false;

  const ageMs = nowFn() - stats.mtimeMs;
  const pidDead = !isProcessRunning(meta.pid, killFn);
  const ancient = ageMs > timeoutMs * 2;

  if (pidDead || ancient) {
    try {
      fsImpl.unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Inner polling loop. Acquires the lock file with `wx` (atomic
// create-or-error); on EEXIST it tries to steal a stale lock, then
// either times out or sleeps and retries. Kept separate from
// `acquireEpicMergeLock` so the public function's cyclomatic complexity
// stays flat under CRAP.
async function pollForLock(epicId, filePath, timeoutMs, seams) {
  const { fsImpl, nowFn, sleepFn } = seams;
  const started = nowFn();
  while (true) {
    try {
      const fd = fsImpl.openSync(filePath, 'wx');
      const acquiredAt = nowFn();
      fsImpl.writeSync(
        fd,
        JSON.stringify({ pid: process.pid, acquiredAt }, null, 2),
      );
      fsImpl.closeSync(fd);
      return { epicId, filePath, acquiredAt };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (tryStealStale(filePath, timeoutMs, seams)) continue;
      if (nowFn() - started >= timeoutMs) {
        const meta = readLockMeta(filePath, fsImpl);
        const detail = meta
          ? ` (held by pid ${meta.pid} since ${new Date(meta.acquiredAt).toISOString()})`
          : '';
        throw new Error(
          `acquireEpicMergeLock timed out after ${timeoutMs}ms for epic ${epicId}${detail}`,
        );
      }
      await sleepFn(POLL_INTERVAL_MS);
    }
  }
}

/**
 * Acquire an exclusive Epic merge lock.
 *
 * @param {number|string} epicId
 * @param {object} opts
 * @param {string} opts.repoRoot            Repo working dir; the lock lands
 *                                          in its common `.git/`.
 * @param {number} [opts.timeoutMs=60000]   Poll-until deadline.
 * @param {() => number} [opts.nowFn]       Clock seam (ms epoch).
 * @param {object} [opts.fsImpl]            Node `fs` shim.
 * @param {(pid:number, signal:number)=>void} [opts.killFn]
 *                                          `process.kill` shim for the
 *                                          pid-liveness probe.
 * @param {(ms:number)=>Promise<void>} [opts.sleepFn]
 *                                          Poll-interval sleep shim.
 * @returns {Promise<{ epicId: number|string, filePath: string, acquiredAt: number }>}
 * @throws {Error} on timeout.
 */
export async function acquireEpicMergeLock(
  epicId,
  {
    repoRoot,
    timeoutMs = 60_000,
    nowFn = Date.now,
    fsImpl = fs,
    killFn = process.kill.bind(process),
    sleepFn = defaultSleep,
  } = {},
) {
  if (!repoRoot) throw new Error('acquireEpicMergeLock: repoRoot is required');

  const filePath = lockPathFor(epicId, repoRoot, fsImpl);
  // Ensure the .git directory exists (it will, in a real repo, but the
  // tests use a temp dir and need us to be forgiving).
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });

  const seams = { fsImpl, nowFn, killFn, sleepFn };
  return pollForLock(epicId, filePath, timeoutMs, seams);
}

/**
 * Release a previously-acquired Epic merge lock.
 *
 * @param {{ filePath: string }} handle
 * @param {object} [fsImpl] Node `fs` shim for tests.
 */
export function releaseEpicMergeLock(handle, fsImpl = fs) {
  if (!handle?.filePath) return;
  try {
    fsImpl.unlinkSync(handle.filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

const LOCK_FILE_PREFIX = 'epic-';
const LOCK_FILE_SUFFIX = '.merge.lock';

// Extract the epic id from a lock filename, or `null` when `entry` isn't a
// `epic-*.merge.lock` file. Split out of `findForeignActiveEpicLock` so
// that function stays a flat filter+map instead of a nested-conditional
// loop body (Story #4460).
function parseLockFileEpicId(entry) {
  if (
    !entry.startsWith(LOCK_FILE_PREFIX) ||
    !entry.endsWith(LOCK_FILE_SUFFIX)
  ) {
    return null;
  }
  return entry.slice(
    LOCK_FILE_PREFIX.length,
    entry.length - LOCK_FILE_SUFFIX.length,
  );
}

// Read `<dir>/<entry>`'s lock meta and report it only when the recorded
// pid is still alive — a foreign lock whose pid is dead (or whose meta is
// unreadable/corrupt) is stale debris, not an active holder, mirroring the
// pid-liveness half of `tryStealStale`'s heuristic.
function readLiveLock(dir, entry, otherEpicId, fsImpl, killFn) {
  const filePath = path.join(dir, entry);
  const meta = readLockMeta(filePath, fsImpl);
  if (!meta || !isProcessRunning(meta.pid, killFn)) return null;
  return {
    epicId: otherEpicId,
    filePath,
    pid: meta.pid,
    acquiredAt: meta.acquiredAt,
  };
}

/**
 * Scan the shared common `.git/` dir for a *different* epic's live
 * merge lock (Story #4460 — cross-epic shared-checkout guard).
 *
 * `acquireEpicMergeLock` only ever contends against locks for the *same*
 * `epicId` (its own lock filename). This helper is the cross-epic
 * counterpart: it lists every `epic-*.merge.lock` file in the common
 * gitdir, skips the caller's own `epicId` namespace, and returns the
 * first foreign lock whose recorded `pid` is still alive.
 *
 * @param {number|string} epicId Caller's own epic id (excluded from the scan).
 * @param {{
 *   repoRoot: string,
 *   fsImpl?: object,
 *   killFn?: (pid:number, signal:number)=>void,
 * }} opts
 * @returns {{ epicId: string, filePath: string, pid: number, acquiredAt: number }|null}
 */
export function findForeignActiveEpicLock(
  epicId,
  { repoRoot, fsImpl = fs, killFn = process.kill.bind(process) } = {},
) {
  if (!repoRoot) {
    throw new Error('findForeignActiveEpicLock: repoRoot is required');
  }
  const dir = resolveGitCommonDir(repoRoot, fsImpl);
  let entries;
  try {
    entries = fsImpl.readdirSync(dir);
  } catch {
    return null;
  }

  const foreignEntries = entries
    .map((entry) => ({ entry, otherEpicId: parseLockFileEpicId(entry) }))
    .filter(
      ({ otherEpicId }) =>
        otherEpicId !== null && String(otherEpicId) !== String(epicId),
    );

  for (const { entry, otherEpicId } of foreignEntries) {
    const live = readLiveLock(dir, entry, otherEpicId, fsImpl, killFn);
    if (live) return live;
  }
  return null;
}
