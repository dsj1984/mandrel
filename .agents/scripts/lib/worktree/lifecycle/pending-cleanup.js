/**
 * Stage 2 of the reap fallback: worktrees whose removal exhausted Stage 1
 * are recorded in the gitignored `.worktrees/.pending-cleanup.json` and
 * retried by the next plan-time sweep, once OS file locks have usually gone.
 *
 * Concurrent sessions read-modify-write this manifest, so every write is
 * atomic (temp + rename), runs under a lock, and the drain merges by
 * `storyId` against the current file before writing.
 */

import fs from 'node:fs';
import { rm as fsPromisesRm } from 'node:fs/promises';
import path from 'node:path';
import { NOOP_LOGGER } from '../../Logger.js';
import { acquireSweepLock } from '../../single-story-sweep/sweep-lock.js';

const MANIFEST_FILENAME = '.pending-cleanup.json';
const MANIFEST_LOCK_FILENAME = '.pending-cleanup.lock';

/** Short: the guarded section takes milliseconds, so older means crashed. */
const MANIFEST_LOCK_TIMEOUT_MS = 5_000;
/** Failed drains (hand-off starts at 0) before an entry is `persistent`. */
export const MAX_SWEEP_ATTEMPTS = 3;

export function manifestPath(worktreeRoot) {
  return path.join(worktreeRoot, MANIFEST_FILENAME);
}

/**
 * @param {string} worktreeRoot
 * @returns {string}
 */
function manifestLockPath(worktreeRoot) {
  return path.join(worktreeRoot, MANIFEST_LOCK_FILENAME);
}

/**
 * Run `fn` under the manifest lock. Best-effort: on contention `fn` still
 * runs (merge-before-write keeps a lost race harmless), so a stuck lockfile
 * never wedges a reap.
 *
 * @template T
 * @param {string} worktreeRoot
 * @param {() => T} fn
 * @returns {T}
 */
function withManifestLock(worktreeRoot, fn) {
  const lock = acquireSweepLock({
    lockPath: manifestLockPath(worktreeRoot),
    timeoutMs: MANIFEST_LOCK_TIMEOUT_MS,
  });
  try {
    return fn();
  } finally {
    if (lock.acquired) {
      try {
        lock.release();
      } catch {
        // Release is best-effort; a stale lockfile expires on its own.
      }
    }
  }
}

export function readManifest(worktreeRoot) {
  const p = manifestPath(worktreeRoot);
  if (!fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Atomic write: a torn file would read as empty and silently drop the backlog.
 */
function writeManifest(worktreeRoot, entries) {
  const p = manifestPath(worktreeRoot);
  if (!Array.isArray(entries) || entries.length === 0) {
    try {
      fs.unlinkSync(p);
    } catch {
      // Manifest already absent — nothing to drop.
    }
    return;
  }
  fs.mkdirSync(worktreeRoot, { recursive: true });
  writeFileAtomic(p, `${JSON.stringify(entries, null, 2)}\n`);
}

/**
 * Pid-scoped temp file in the same directory (so rename is atomic), renamed
 * into place; on failure the temp is reaped and the error propagates.
 *
 * @param {string} targetPath
 * @param {string} contents
 */
function writeFileAtomic(targetPath, contents) {
  const tmp = `${targetPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, contents, 'utf8');
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    reapTempFile(tmp);
    throw err;
  }
}

function reapTempFile(tmp) {
  try {
    fs.unlinkSync(tmp);
  } catch {
    // Already gone.
  }
}

/**
 * Upsert by storyId, keeping `firstFailedAt`; new rows start at `attempts: 0`.
 */
export function recordPendingCleanup(
  worktreeRoot,
  { storyId, branch, path: wtPath, push = false },
) {
  return withManifestLock(worktreeRoot, () => {
    const now = new Date().toISOString();
    const entries = readManifest(worktreeRoot);
    const idx = entries.findIndex((e) => e.storyId === storyId);
    if (idx >= 0) {
      entries[idx] = {
        ...entries[idx],
        branch,
        path: wtPath,
        push,
        lastFailedAt: now,
        attempts: (entries[idx].attempts ?? 0) + 1,
      };
    } else {
      entries.push({
        storyId,
        branch,
        path: wtPath,
        push,
        firstFailedAt: now,
        lastFailedAt: now,
        attempts: 0,
      });
    }
    writeManifest(worktreeRoot, entries);
    return entries.find((e) => e.storyId === storyId);
  });
}

export function removePendingCleanup(worktreeRoot, storyId) {
  withManifestLock(worktreeRoot, () => {
    const entries = readManifest(worktreeRoot).filter(
      (e) => e.storyId !== storyId,
    );
    writeManifest(worktreeRoot, entries);
  });
}

async function removeStuckWorktreePath(wtPath, { git, repoRoot, fsRm }) {
  if (!fs.existsSync(wtPath)) return { ok: true };
  let rm = git.gitSpawn(repoRoot, 'worktree', 'remove', wtPath);
  if (rm.status !== 0) {
    rm = git.gitSpawn(repoRoot, 'worktree', 'remove', '--force', wtPath);
  }
  if (fs.existsSync(wtPath)) {
    try {
      await fsRm(wtPath, { recursive: true, force: true });
    } catch (err) {
      return { ok: false, error: err };
    }
  }
  if (fs.existsSync(wtPath)) {
    return {
      ok: false,
      error: new Error(
        `path still exists after worktree remove + fs.rm: ${wtPath}`,
      ),
    };
  }
  return { ok: true };
}

function sweepBranchLocal(branch, { git, repoRoot, logger }) {
  const localDel = git.gitSpawn(repoRoot, 'branch', '-D', branch);
  if (localDel.status === 0) return true;
  const stderr = (localDel.stderr || localDel.stdout || '').trim();
  if (/not found|no such|not match/i.test(stderr)) return true;
  logger.warn(
    `worktree-sweep: branch -D ${branch} failed: ${stderr || 'unknown'} (continuing)`,
  );
  return false;
}

function sweepBranchRemote(branch, { git, repoRoot, logger }) {
  const remoteDel = git.gitSpawn(
    repoRoot,
    'push',
    '--no-verify',
    'origin',
    '--delete',
    branch,
  );
  if (remoteDel.status === 0) return true;
  const stderr = (remoteDel.stderr || remoteDel.stdout || '').trim();
  if (/remote ref does not exist|not found/i.test(stderr)) return true;
  logger.warn(
    `worktree-sweep: push --delete ${branch} failed: ${stderr || 'unknown'} (continuing)`,
  );
  return false;
}

function sweepBranchCleanup(entry, ctx) {
  const { branch, push } = entry;
  if (!branch) return { localBranchDeleted: null, remoteBranchDeleted: null };
  const localBranchDeleted = sweepBranchLocal(branch, ctx);
  const remoteBranchDeleted = push ? sweepBranchRemote(branch, ctx) : null;
  return { localBranchDeleted, remoteBranchDeleted };
}

async function retryStage1ForEntry(entry, ctx) {
  const removal = await removeStuckWorktreePath(entry.path, ctx);
  if (!removal.ok) {
    return { success: false, error: removal.error };
  }
  ctx.git.gitSpawn(ctx.repoRoot, 'worktree', 'prune');
  const cleanup = sweepBranchCleanup(entry, ctx);
  return { success: true, ...cleanup };
}

/**
 * Write the drain result merged by `storyId` against the manifest as it is
 * now, so an entry recorded during the (slow) drain survives.
 *
 * @param {string} worktreeRoot
 * @param {object[]} next          Rows still pending after this drain.
 * @param {Set<number|string>} drainedIds
 */
function commitDrainedManifest(worktreeRoot, next, drainedIds) {
  withManifestLock(worktreeRoot, () => {
    const byId = new Map(next.map((entry) => [entry.storyId, entry]));
    for (const entry of readManifest(worktreeRoot)) {
      if (byId.has(entry.storyId)) continue;
      if (drainedIds.has(entry.storyId)) continue;
      byId.set(entry.storyId, entry);
    }
    writeManifest(worktreeRoot, [...byId.values()]);
  });
}

/**
 * Retry each entry; persistent entries log OPERATOR ACTION REQUIRED but stay
 * in the manifest so the signal persists.
 */
export async function drainPendingCleanup({
  repoRoot,
  worktreeRoot,
  git,
  fsRm = fsPromisesRm,
  logger = NOOP_LOGGER,
}) {
  const entries = readManifest(worktreeRoot);
  if (entries.length === 0) {
    return {
      drained: [],
      drainedDetails: [],
      persistent: [],
      persistentDetails: [],
      stillPending: [],
      stillPendingDetails: [],
    };
  }

  const drained = [];
  const drainedDetails = [];
  const persistent = [];
  const persistentDetails = [];
  const stillPending = [];
  const stillPendingDetails = [];
  const next = [];

  for (const entry of entries) {
    const result = await retryStage1ForEntry(entry, {
      git,
      repoRoot,
      fsRm,
      logger,
    });
    if (result.success) {
      drained.push(entry.storyId);
      drainedDetails.push({
        storyId: entry.storyId,
        path: entry.path,
        branch: entry.branch,
        localBranchDeleted: result.localBranchDeleted,
        remoteBranchDeleted: result.remoteBranchDeleted,
      });
      logger.info(
        `worktree-sweep: drained pending-cleanup storyId=${entry.storyId} path=${entry.path}`,
      );
      continue;
    }
    const updatedAttempts = (entry.attempts ?? 0) + 1;
    const updated = {
      ...entry,
      attempts: updatedAttempts,
      lastFailedAt: new Date().toISOString(),
    };
    if (updatedAttempts >= MAX_SWEEP_ATTEMPTS) {
      logger.error(
        `OPERATOR ACTION REQUIRED: persistent-lock on worktree path=${entry.path} ` +
          `branch=${entry.branch} storyId=${entry.storyId} — manual cleanup required ` +
          `(attempts=${updatedAttempts}, firstFailedAt=${entry.firstFailedAt}).`,
      );
      persistent.push(entry.storyId);
      persistentDetails.push(updated);
    } else {
      stillPending.push(entry.storyId);
      stillPendingDetails.push(updated);
    }
    next.push(updated);
  }

  commitDrainedManifest(worktreeRoot, next, new Set(drained));
  return {
    drained,
    drainedDetails,
    persistent,
    persistentDetails,
    stillPending,
    stillPendingDetails,
  };
}
