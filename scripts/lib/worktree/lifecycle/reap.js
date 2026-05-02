/**
 * worktree/lifecycle/reap.js
 *
 * Worktree removal end-to-end:
 *
 *   - `isSafeToRemove`: clean-tree + branch-merged precondition.
 *   - `removeWorktreeWithRecovery`: `git worktree remove` with submodule-guard
 *     and Windows-lock retries, Stage 1 `fs.rm` fallback, and the Stage 2
 *     hand-off to the `pending-cleanup.json` manifest when Stage 1 exhausts.
 *   - `reap`: precondition check, force-discard for already-merged dirty
 *     trees, and the post-remove belt-and-braces fs.rm sweep.
 *
 * No state is reached outside the supplied `ctx` bag.
 */

import fs from 'node:fs';
import { rm as fsPromisesRm } from 'node:fs/promises';
import {
  dropAllSubmoduleGitlinksFromIndex,
  purgePerWorktreeSubmoduleDir,
  removeCopiedAgents,
} from '../bootstrapper.js';
import { isInsideWorktree, samePath, storyIdFromPath } from '../inspector.js';
import { sleepSync } from '../node-modules-strategy.js';
import { recordPendingCleanup } from './pending-cleanup.js';
import {
  findByPath,
  invalidateWorktreeCache,
  pathFor,
} from './registry-sync.js';
import { validateStoryId } from './shared.js';

const WINDOWS_LOCK_RE =
  /(permission denied|access is denied|directory not empty|resource busy|device or resource busy|sharing violation|EACCES|EBUSY|ENOTEMPTY)/i;
const WINDOWS_CWD_RE =
  /(current working directory|inside the worktree|cannot remove.*current working directory|used by another process because it is the current working directory)/i;

export async function isSafeToRemove(ctx, wtPath, opts = {}) {
  if (!fs.existsSync(wtPath)) {
    return { safe: true, reason: 'path-missing' };
  }

  const status = ctx.git.gitSpawn(wtPath, 'status', '--porcelain');
  if (status.status !== 0) {
    return { safe: false, reason: `status-failed: ${status.stderr}` };
  }
  if (status.stdout.length > 0) {
    return { safe: false, reason: 'uncommitted-changes' };
  }

  const headRes = ctx.git.gitSpawn(wtPath, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (headRes.status !== 0) {
    return { safe: false, reason: `rev-parse-failed: ${headRes.stderr}` };
  }
  const branch = headRes.stdout;
  if (branch === 'HEAD') {
    return { safe: false, reason: 'detached-head' };
  }

  const epicBranch = opts.epicBranch ?? null;
  if (epicBranch) {
    const res = ctx.git.gitSpawn(
      ctx.repoRoot,
      'merge-base',
      '--is-ancestor',
      branch,
      epicBranch,
    );
    if (res.status === 1) {
      return { safe: false, reason: 'unmerged-commits' };
    }
    if (res.status !== 0) {
      return {
        safe: false,
        reason: `merge-check-failed: ${res.stderr || res.stdout || 'unknown'}`,
      };
    }
  }

  return { safe: true };
}

/**
 * Returns true iff `branch` is already fully merged into `epicBranch`
 * (i.e. `merge-base --is-ancestor branch epicBranch` exits 0). A missing
 * epicBranch or a git failure both yield false so callers default to the
 * safe, non-forcing behavior.
 */
export function isStoryAlreadyMergedIntoEpic(ctx, branch, epicBranch) {
  if (!branch || !epicBranch) return false;
  const res = ctx.git.gitSpawn(
    ctx.repoRoot,
    'merge-base',
    '--is-ancestor',
    branch,
    epicBranch,
  );
  return res.status === 0;
}

/**
 * Collect the set of paths reported dirty by `git status --porcelain` inside
 * a worktree. Returned paths are relative to the worktree root.
 */
function collectDirtyPaths(ctx, wtPath) {
  const res = ctx.git.gitSpawn(wtPath, 'status', '--porcelain');
  if (res.status !== 0) return [];
  return res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[^ ]{1,2}\s+/, ''));
}

/**
 * Hard-reset and clean a worktree so subsequent remove calls no longer hit
 * `uncommitted-changes`. Returns `true` if both operations succeed.
 */
function discardWorktreeChanges(ctx, wtPath) {
  const reset = ctx.git.gitSpawn(wtPath, 'reset', '--hard', 'HEAD');
  if (reset.status !== 0) return false;
  const clean = ctx.git.gitSpawn(wtPath, 'clean', '-fd');
  return clean.status === 0;
}

/**
 * Stage 1 recovery after `git worktree remove` exhausts its retries with a
 * Windows-lock-class error: retry `fs.rm` up to `maxRetries` times. Returns
 * `{ success: true, attempts }` on first success or
 * `{ success: false, attempts, error }` on final failure.
 */
async function fsRmWithRetry(
  fsRm,
  wtPath,
  { maxRetries = 5, retryDelay = 200 } = {},
) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await fsRm(wtPath, { recursive: true, force: true });
      return { success: true, attempts: attempt };
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, retryDelay));
      }
    }
  }
  return { success: false, attempts: maxRetries, error: lastErr };
}

export async function removeWorktreeWithRecovery(ctx, wtPath, opts = {}) {
  const { storyId = null, branch = null, push = false } = opts;
  const maxAttempts = ctx.platform === 'win32' ? 6 : 2;
  const retryDelaysMs = [0, 150, 350, 700, 1200, 2000];
  const forceRemoveBackoffMs = opts.forceRemoveBackoffMs ?? 3000;
  let lastReason = 'worktree-remove-failed';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = ctx.git.gitSpawn(ctx.repoRoot, 'worktree', 'remove', wtPath);
    if (res.status === 0) {
      // Always prune after a successful `remove`. On Windows, `git worktree
      // remove` regularly exits 0 while leaving `.git/worktrees/story-<id>/`
      // admin metadata on disk (a residual file held by AV / the Windows
      // Search indexer / a Node module handle). Without the prune, a
      // subsequent `git worktree list` still reports the worktree and the
      // close script lands in `still-registered-after-reap`; `git branch -D`
      // then refuses because the branch is "still checked out" in the ghost
      // registration.
      ctx.git.gitSpawn(ctx.repoRoot, 'worktree', 'prune');
      invalidateWorktreeCache(ctx);
      return { removed: true };
    }

    const stderr = (res.stderr || res.stdout || '').trim();
    lastReason = stderr || 'worktree-remove-failed';
    const isSubmoduleGuard =
      /working trees containing submodules cannot be moved or removed/i.test(
        stderr,
      );
    const isLockLike = WINDOWS_LOCK_RE.test(stderr);
    const isCwdLike = WINDOWS_CWD_RE.test(stderr);
    const isRecoverable = isLockLike || isCwdLike;

    if (isSubmoduleGuard && attempt < maxAttempts) {
      ctx.logger.warn(
        `worktree.reap remove blocked by submodule guard; retrying (${attempt}/${maxAttempts})`,
      );
      dropAllSubmoduleGitlinksFromIndex(ctx, wtPath);
      purgePerWorktreeSubmoduleDir(ctx, wtPath);
      continue;
    }
    if (isRecoverable && attempt < maxAttempts) {
      const delay = retryDelaysMs[attempt] ?? 300;
      const reasonClass = isCwdLike ? 'cwd-like' : 'lock-like';
      ctx.logger.warn(
        `worktree.reap remove hit ${reasonClass} error; retrying in ${delay}ms (${attempt}/${maxAttempts})`,
      );
      sleepSync(delay);
      continue;
    }
    break;
  }

  if (
    ctx.platform === 'win32' &&
    opts.forceRemoveFallback !== false &&
    (WINDOWS_LOCK_RE.test(lastReason) || WINDOWS_CWD_RE.test(lastReason))
  ) {
    ctx.logger.warn(
      `worktree.reap remove exhausted Windows lock retry; retrying with --force in ${forceRemoveBackoffMs}ms path=${wtPath}`,
    );
    sleepSync(forceRemoveBackoffMs);
    const forced = ctx.git.gitSpawn(
      ctx.repoRoot,
      'worktree',
      'remove',
      '--force',
      wtPath,
    );
    if (forced.status === 0) {
      ctx.git.gitSpawn(ctx.repoRoot, 'worktree', 'prune');
      invalidateWorktreeCache(ctx);
      ctx.logger.warn(
        `worktree.reap recovered via force-remove-retry path=${wtPath} lockReason=${lastReason}`,
      );
      return {
        removed: true,
        success: true,
        method: 'force-remove-retry',
        attempts: maxAttempts + 1,
      };
    }
    const forceReason = (forced.stderr || forced.stdout || '').trim();
    if (forceReason) lastReason = forceReason;
  }

  // Stage 1 recovery is unconditional. Every path into this block has
  // already cleared `reap()`'s `isSafeToRemove` gate — merged or
  // force-discarded — so we are committed to removal. The previous gating
  // on `WINDOWS_LOCK_RE || WINDOWS_CWD_RE` dropped us into a do-nothing tail
  // whenever `git worktree remove` failed with a stderr that didn't match
  // either regex (localized error strings, generic I/O failures, stale
  // registrations the operator's environment produced), leaving the worktree
  // half-reaped and the close script stuck on `still-registered-after-reap`.
  const fsRm = ctx.fsRm ?? fsPromisesRm;
  const rmResult = await fsRmWithRetry(fsRm, wtPath, {
    maxRetries: 5,
    retryDelay: 200,
  });

  if (!rmResult.success) {
    // Stage 1.5 — coverage-leak quiesce + extended fs.rm budget.
    //
    // On Windows the close-validation chain runs the project's c8 coverage
    // capture. c8 keeps file descriptors open against the worktree it
    // measured, and even after the test runner exits there is a brief
    // window where Windows still reports `directory not empty` /
    // `EBUSY` on `fs.rm`. The Stage 1 retry budget (5 × 200ms = 1s) is
    // long enough for the test runner to exit but too short for Windows
    // to release the AV / Search-indexer holds on `node_modules/.cache`
    // and `coverage/`.
    //
    // Sleep one beat longer than the Windows lock recovery window
    // (`forceRemoveBackoffMs`, default 3s), then retry `fs.rm` with a
    // higher built-in retry budget (Node's own `maxRetries` × `retryDelay`
    // applies *inside* one call). This lifts the wall-clock budget to
    // ~10s on the failure path without touching the happy-path latency.
    if (ctx.platform === 'win32') {
      sleepSync(forceRemoveBackoffMs);
      try {
        await fsRm(wtPath, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 500,
        });
        ctx.git.gitSpawn(ctx.repoRoot, 'worktree', 'prune');
        invalidateWorktreeCache(ctx);
        const branchCleanup = await deleteBranchAfterReap(ctx, {
          branch,
          push,
        });
        ctx.logger.warn(
          `worktree.reap recovered via stage-1.5 fs-rm-extended path=${wtPath} lockReason=${lastReason}`,
        );
        return {
          removed: true,
          success: true,
          method: 'fs-rm-extended',
          attempts: rmResult.attempts + 1,
          ...branchCleanup,
        };
      } catch (err) {
        // Fall through to Stage 2; preserve the original rmResult error
        // for the operator-facing message so they see the lock-class
        // signal rather than the post-quiesce one.
        ctx.logger.warn(
          `worktree.reap stage-1.5 fs-rm-extended failed: ${err?.message ?? err} (handing off to sweep)`,
        );
      }
    }

    ctx.git.gitSpawn(ctx.repoRoot, 'worktree', 'prune');
    invalidateWorktreeCache(ctx);
    const errMsg =
      rmResult.error?.message || String(rmResult.error) || 'fs-rm-failed';
    // Stage 2 hand-off: append the entry to `.worktrees/.pending-cleanup.json`
    // so the plan-time worktree-sweep can drain it on the next run.
    let manifestEntry = null;
    if (storyId != null && ctx.worktreeRoot) {
      try {
        manifestEntry = recordPendingCleanup(ctx.worktreeRoot, {
          storyId,
          branch,
          path: wtPath,
          push,
        });
      } catch (err) {
        ctx.logger.warn(
          `worktree.reap pending-cleanup manifest write failed: ${err.message}`,
        );
      }
    }
    // Best-effort branch cleanup even when the directory is stuck — the
    // local ref + the remote ref are independent of the on-disk worktree
    // and stranding them forced operators to run manual `git branch -D` /
    // `push --delete` sequences (memory: feedback_sprint_story_close_reap).
    const branchCleanup = await deleteBranchAfterReap(ctx, { branch, push });
    ctx.logger.error(
      `OPERATOR ACTION REQUIRED: worktree reap exhausted Stage 1 (fs-rm-retry) after ${rmResult.attempts} ` +
        `attempts path=${wtPath} — deferred to plan-time worktree-sweep. Reason: ${errMsg}`,
    );
    return {
      removed: false,
      method: 'deferred-to-sweep',
      reason: errMsg,
      lockReason: lastReason,
      attempts: rmResult.attempts,
      pendingCleanup: manifestEntry ?? {
        storyId,
        branch,
        path: wtPath,
        push,
      },
      ...branchCleanup,
    };
  }

  ctx.git.gitSpawn(ctx.repoRoot, 'worktree', 'prune');
  invalidateWorktreeCache(ctx);

  const branchCleanup = await deleteBranchAfterReap(ctx, { branch, push });

  ctx.logger.warn(
    `worktree.reap recovered via fs-rm-retry path=${wtPath} attempts=${rmResult.attempts} lockReason=${lastReason}`,
  );
  return {
    removed: true,
    success: true,
    method: 'fs-rm-retry',
    attempts: rmResult.attempts,
    ...branchCleanup,
  };
}

/**
 * Delete the story branch locally (and optionally on origin) after a reap
 * attempt. Pure best-effort — every failure mode is logged and surfaces
 * as `branchDeleted: false` rather than throwing, because branch cleanup
 * is the *follow-up* to a reap, not a precondition for declaring the
 * post-merge work complete.
 *
 * Returns `{ branchDeleted, remoteBranchDeleted }`. Both default to `false`
 * when `branch` is falsy. `branchDeleted: true` includes the "already gone"
 * outcome (refs-not-found from a prior partial reap) — semantically the
 * caller can treat the story branch as cleared in either case.
 */
async function deleteBranchAfterReap(ctx, { branch, push }) {
  if (!branch) return { branchDeleted: false, remoteBranchDeleted: false };

  let branchDeleted = false;
  const localDel = ctx.git.gitSpawn(ctx.repoRoot, 'branch', '-D', branch);
  if (localDel.status === 0) {
    branchDeleted = true;
  } else {
    const stderr = (localDel.stderr || localDel.stdout || '').trim();
    if (/not found|not match|no such/i.test(stderr)) {
      branchDeleted = true;
    } else {
      ctx.logger.warn(
        `worktree.reap branch -D ${branch} failed: ${stderr || 'unknown'} (continuing)`,
      );
    }
  }

  let remoteBranchDeleted = false;
  if (push) {
    const remoteDel = ctx.git.gitSpawn(
      ctx.repoRoot,
      'push',
      '--no-verify',
      'origin',
      '--delete',
      branch,
    );
    if (remoteDel.status === 0) {
      remoteBranchDeleted = true;
    } else {
      const stderr = (remoteDel.stderr || remoteDel.stdout || '').trim();
      if (
        /remote ref does not exist|not found|unable to delete/i.test(stderr)
      ) {
        remoteBranchDeleted = true;
      } else {
        ctx.logger.warn(
          `worktree.reap push --delete ${branch} failed: ${stderr || 'unknown'} (continuing)`,
        );
      }
    }
  }

  return { branchDeleted, remoteBranchDeleted };
}

export async function reap(ctx, storyId, opts = {}) {
  if (opts.force) {
    throw new Error(
      'WorktreeManager.reap: --force is not permitted by the framework',
    );
  }
  const wtPath = pathFor(ctx, storyId);

  const known = opts.worktrees
    ? opts.worktrees.some((r) => samePath(r.path, wtPath, ctx.platform))
    : findByPath(ctx, wtPath) !== null;
  if (!known) {
    return { removed: false, reason: 'not-a-worktree', path: wtPath };
  }

  if (storyIdFromPath(wtPath, ctx.worktreeRoot) !== null && !opts.epicBranch) {
    return { removed: false, reason: 'epic-branch-required', path: wtPath };
  }

  const safety = await isSafeToRemove(ctx, wtPath, {
    epicBranch: opts.epicBranch ?? null,
  });
  let discardedPaths = null;
  if (!safety.safe) {
    const discardAfterMerge = opts.discardAfterMerge !== false;
    const branchName = `story-${validateStoryId(storyId)}`;
    const canForceReap =
      discardAfterMerge &&
      safety.reason === 'uncommitted-changes' &&
      opts.epicBranch &&
      isStoryAlreadyMergedIntoEpic(ctx, branchName, opts.epicBranch);

    if (canForceReap) {
      discardedPaths = collectDirtyPaths(ctx, wtPath);
      if (!discardWorktreeChanges(ctx, wtPath)) {
        ctx.logger.warn(
          `reap-skipped storyId=${storyId} reason=discard-failed path=${wtPath}`,
        );
        return {
          removed: false,
          reason: 'discard-failed',
          path: wtPath,
          discardedPaths,
        };
      }
      ctx.logger.info(
        `worktree.reap discard-after-merge storyId=${storyId} paths=${discardedPaths.length}`,
      );
    } else {
      ctx.logger.warn(
        `reap-skipped storyId=${storyId} reason=${safety.reason} path=${wtPath}`,
      );
      return { removed: false, reason: safety.reason, path: wtPath };
    }
  }

  removeCopiedAgents(ctx, wtPath);
  dropAllSubmoduleGitlinksFromIndex(ctx, wtPath);

  if (isInsideWorktree(process.cwd(), wtPath, ctx.platform)) {
    try {
      process.chdir(ctx.repoRoot);
    } catch (err) {
      ctx.logger.warn(
        `worktree.reap chdir-to-root failed: ${err.message} (continuing)`,
      );
    }
  }

  const storyIdN = validateStoryId(storyId);
  const branch = `story-${storyIdN}`;
  const removeResult = await removeWorktreeWithRecovery(ctx, wtPath, {
    storyId: storyIdN,
    branch,
    push: opts.push === true,
  });
  if (!removeResult.removed) {
    return {
      removed: false,
      reason: `remove-failed: ${removeResult.reason}`,
      path: wtPath,
      method: removeResult.method,
      pendingCleanup: removeResult.pendingCleanup,
    };
  }
  invalidateWorktreeCache(ctx);

  if (fs.existsSync(wtPath)) {
    const fsRm = ctx.fsRm ?? fsPromisesRm;
    const belt = await fsRmWithRetry(fsRm, wtPath, {
      maxRetries: 5,
      retryDelay: 200,
    });
    if (!belt.success) {
      ctx.logger.warn(
        `worktree.reap post-remove fs-rm-retry failed path=${wtPath}: ${belt.error?.message ?? belt.error}`,
      );
    }
    invalidateWorktreeCache(ctx);
  }

  ctx.logger.info(`worktree.reaped storyId=${storyId} path=${wtPath}`);
  return {
    removed: true,
    path: wtPath,
    ...(removeResult.method ? { method: removeResult.method } : {}),
    ...(removeResult.branchDeleted !== undefined
      ? { branchDeleted: removeResult.branchDeleted }
      : {}),
    ...(discardedPaths && discardedPaths.length > 0 ? { discardedPaths } : {}),
  };
}
