/**
 * Worktree removal: safety preconditions, `git worktree remove` with Windows
 * lock retries, `fs.rm` fallback, and hand-off to the pending-cleanup
 * manifest when that exhausts.
 */

import fs from 'node:fs';
import { rm as fsPromisesRm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isInsideWorktree, samePath } from '../inspector.js';
import { sleepSync } from '../node-modules-strategy.js';
import { checkMergeReachability } from './merge-reachability.js';
import { recordPendingCleanup } from './pending-cleanup.js';
import { checkLocalSafety } from './precheck.js';
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

/**
 * Safe to remove: clean tree and, when a base ref is given, the worktree's
 * HEAD reachable from it (see `checkMergeReachability`).
 *
 * @param {object} ctx
 * @param {string} wtPath
 * @param {{ epicBranch?: string|null }} [opts]
 * @returns {Promise<{ safe: boolean, reason?: string }>}
 */
export async function isSafeToRemove(ctx, wtPath, opts = {}) {
  const local = checkLocalSafety(ctx, wtPath);
  if (!local.safe) return local;
  if (local.reason === 'path-missing') return local;

  const epicRef = opts.epicBranch ?? opts.epicRef ?? null;
  if (!epicRef) return { safe: true };

  return checkMergeReachability(ctx, wtPath, local.branch, epicRef);
}

/**
 * True iff `branch` is provably integrated into `baseRef` (ancestor, or every
 * commit patch-id-equivalent upstream via `git cherry`). It licenses
 * discarding a dirty tree, so every failure is `false`. Not a squash
 * detector: a multi-commit squash reads as unmerged (refusal is the safe
 * direction).
 *
 * @param {object} ctx
 * @param {string} branch
 * @param {string} baseRef
 * @returns {boolean}
 */
function isBranchMergedIntoBase(ctx, branch, baseRef) {
  if (!branch || !baseRef) return false;
  const ancestor = ctx.git.gitSpawn(
    ctx.repoRoot,
    'merge-base',
    '--is-ancestor',
    branch,
    baseRef,
  );
  if (ancestor.status === 0) return true;

  const cherry = ctx.git.gitSpawn(ctx.repoRoot, 'cherry', baseRef, branch);
  if (cherry.status !== 0) return false;
  const lines = (cherry.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.every((line) => line.startsWith('-'));
}

function collectDirtyPaths(ctx, wtPath) {
  const res = ctx.git.gitSpawn(wtPath, 'status', '--porcelain');
  if (res.status !== 0) return [];
  return res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[^ ]{1,2}\s+/, ''));
}

function discardWorktreeChanges(ctx, wtPath) {
  const reset = ctx.git.gitSpawn(wtPath, 'reset', '--hard', 'HEAD');
  if (reset.status !== 0) return false;
  const clean = ctx.git.gitSpawn(wtPath, 'clean', '-fd');
  return clean.status === 0;
}

/** Stage 1 recovery: retry `fs.rm` after `git worktree remove` exhausts. */
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
      if (attempt < maxRetries && retryDelay > 0) {
        await new Promise((r) => setTimeout(r, retryDelay));
      }
    }
  }
  return { success: false, attempts: maxRetries, error: lastErr };
}

function classifyRemoveStderr(stderr) {
  return {
    isLockLike: WINDOWS_LOCK_RE.test(stderr),
    isCwdLike: WINDOWS_CWD_RE.test(stderr),
  };
}

function finalizeGitWorktreeRemove(ctx) {
  ctx.git.gitSpawn(ctx.repoRoot, 'worktree', 'prune');
  invalidateWorktreeCache(ctx);
}

function handleRemoveFailure(
  ctx,
  _wtPath,
  classification,
  attempt,
  maxAttempts,
  { retryDelaysMs = [0, 150, 350, 700, 1200, 2000], sleepFn = sleepSync } = {},
) {
  const { isLockLike, isCwdLike } = classification;
  if ((isLockLike || isCwdLike) && attempt < maxAttempts) {
    const delay = retryDelaysMs[attempt] ?? 300;
    const reasonClass = isCwdLike ? 'cwd-like' : 'lock-like';
    ctx.logger.warn(
      `worktree.reap remove hit ${reasonClass} error; retrying in ${delay}ms (${attempt}/${maxAttempts})`,
    );
    sleepFn(delay);
    return 'continue';
  }
  return 'break';
}

async function runGitWorktreeRemoveLoop(ctx, wtPath, retryOpts = {}) {
  const maxAttempts = ctx.platform === 'win32' ? 6 : 2;
  let lastReason = 'worktree-remove-failed';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = ctx.git.gitSpawn(ctx.repoRoot, 'worktree', 'remove', wtPath);
    if (res.status === 0) {
      finalizeGitWorktreeRemove(ctx);
      return { removed: true };
    }
    const stderr = (res.stderr || res.stdout || '').trim();
    lastReason = stderr || 'worktree-remove-failed';
    const classification = classifyRemoveStderr(stderr);
    const action = handleRemoveFailure(
      ctx,
      wtPath,
      classification,
      attempt,
      maxAttempts,
      retryOpts,
    );
    if (action === 'break') break;
  }
  return { removed: false, lastReason, maxAttempts };
}

function tryForceRemoveFallback(
  ctx,
  wtPath,
  lastReason,
  forceRemoveBackoffMs,
  maxAttempts,
  sleepFn = sleepSync,
) {
  if (!(WINDOWS_LOCK_RE.test(lastReason) || WINDOWS_CWD_RE.test(lastReason))) {
    return { handled: false, lastReason };
  }
  ctx.logger.warn(
    `worktree.reap remove exhausted Windows lock retry; retrying with --force in ${forceRemoveBackoffMs}ms path=${wtPath}`,
  );
  sleepFn(forceRemoveBackoffMs);
  const forced = ctx.git.gitSpawn(
    ctx.repoRoot,
    'worktree',
    'remove',
    '--force',
    wtPath,
  );
  if (forced.status === 0) {
    finalizeGitWorktreeRemove(ctx);
    ctx.logger.warn(
      `worktree.reap recovered via force-remove-retry path=${wtPath} lockReason=${lastReason}`,
    );
    return {
      handled: true,
      result: {
        removed: true,
        success: true,
        method: 'force-remove-retry',
        attempts: maxAttempts + 1,
      },
    };
  }
  const forceReason = (forced.stderr || forced.stdout || '').trim();
  return { handled: false, lastReason: forceReason || lastReason };
}

async function tryStage15WindowsFsRm({
  ctx,
  wtPath,
  fsRm,
  forceRemoveBackoffMs,
  branch,
  push,
  lastReason,
  priorAttempts,
  sleepFn = sleepSync,
}) {
  sleepFn(forceRemoveBackoffMs);
  try {
    await fsRm(wtPath, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 500,
    });
  } catch (err) {
    ctx.logger.warn(
      `worktree.reap stage-1.5 fs-rm-extended failed: ${err?.message ?? err} (handing off to sweep)`,
    );
    return null;
  }
  finalizeGitWorktreeRemove(ctx);
  const branchCleanup = await deleteBranchAfterReap(ctx, { branch, push });
  ctx.logger.warn(
    `worktree.reap recovered via stage-1.5 fs-rm-extended path=${wtPath} lockReason=${lastReason}`,
  );
  return {
    removed: true,
    success: true,
    method: 'fs-rm-extended',
    attempts: priorAttempts + 1,
    ...branchCleanup,
  };
}

function recordPendingCleanupSafe(ctx, { storyId, branch, wtPath, push }) {
  if (storyId == null || !ctx.worktreeRoot) return null;
  try {
    return recordPendingCleanup(ctx.worktreeRoot, {
      storyId,
      branch,
      path: wtPath,
      push,
    });
  } catch (err) {
    ctx.logger.warn(
      `worktree.reap pending-cleanup manifest write failed: ${err.message}`,
    );
    return null;
  }
}

async function handleFsRmFailure({
  ctx,
  wtPath,
  rmResult,
  branch,
  push,
  storyId,
  lastReason,
  forceRemoveBackoffMs,
  fsRm,
  sleepFn,
}) {
  // Stage 1.5 (Windows): quiesce, then an extended fs.rm budget.
  if (ctx.platform === 'win32') {
    const stage15 = await tryStage15WindowsFsRm({
      ctx,
      wtPath,
      fsRm,
      forceRemoveBackoffMs,
      branch,
      push,
      lastReason,
      priorAttempts: rmResult.attempts,
      sleepFn,
    });
    if (stage15) return stage15;
  }
  finalizeGitWorktreeRemove(ctx);
  const errMsg =
    rmResult.error?.message || String(rmResult.error) || 'fs-rm-failed';
  const manifestEntry = recordPendingCleanupSafe(ctx, {
    storyId,
    branch,
    wtPath,
    push,
  });
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
    pendingCleanup: manifestEntry ?? { storyId, branch, path: wtPath, push },
    ...branchCleanup,
  };
}

export async function removeWorktreeWithRecovery(ctx, wtPath, opts = {}) {
  const { storyId = null, branch = null, push = false } = opts;
  const forceRemoveBackoffMs = opts.forceRemoveBackoffMs ?? 3000;
  const retryDelay = opts.retryDelay ?? 200;
  const { retryDelaysMs, sleepFn } = opts;
  const removeLoop = await runGitWorktreeRemoveLoop(ctx, wtPath, {
    ...(retryDelaysMs ? { retryDelaysMs } : {}),
    ...(sleepFn ? { sleepFn } : {}),
  });
  if (removeLoop.removed) return { removed: true };
  let { lastReason } = removeLoop;
  if (ctx.platform === 'win32' && opts.forceRemoveFallback !== false) {
    const fallback = tryForceRemoveFallback(
      ctx,
      wtPath,
      lastReason,
      forceRemoveBackoffMs,
      removeLoop.maxAttempts,
      sleepFn,
    );
    if (fallback.handled) return fallback.result;
    lastReason = fallback.lastReason;
  }
  // Unconditional: callers already cleared the safety gate.
  const fsRm = ctx.fsRm ?? fsPromisesRm;
  const rmResult = await fsRmWithRetry(fsRm, wtPath, {
    maxRetries: 5,
    retryDelay,
  });
  if (!rmResult.success) {
    return handleFsRmFailure({
      ctx,
      wtPath,
      rmResult,
      branch,
      push,
      storyId,
      lastReason,
      forceRemoveBackoffMs,
      fsRm,
      sleepFn,
    });
  }
  finalizeGitWorktreeRemove(ctx);
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
 * Best-effort branch deletion after a reap: failures log and return `false`,
 * never throw; "already gone" counts as deleted.
 */
function reapDeleteLocal(ctx, branch) {
  const localDel = ctx.git.gitSpawn(ctx.repoRoot, 'branch', '-D', branch);
  if (localDel.status === 0) return true;
  const stderr = (localDel.stderr || localDel.stdout || '').trim();
  if (/not found|not match|no such/i.test(stderr)) return true;
  ctx.logger.warn(
    `worktree.reap branch -D ${branch} failed: ${stderr || 'unknown'} (continuing)`,
  );
  return false;
}

function reapDeleteRemote(ctx, branch) {
  const remoteDel = ctx.git.gitSpawn(
    ctx.repoRoot,
    'push',
    '--no-verify',
    'origin',
    '--delete',
    branch,
  );
  if (remoteDel.status === 0) return true;
  const stderr = (remoteDel.stderr || remoteDel.stdout || '').trim();
  if (/remote ref does not exist|not found|unable to delete/i.test(stderr)) {
    return true;
  }
  ctx.logger.warn(
    `worktree.reap push --delete ${branch} failed: ${stderr || 'unknown'} (continuing)`,
  );
  return false;
}

async function deleteBranchAfterReap(ctx, { branch, push }) {
  if (!branch) return { branchDeleted: false, remoteBranchDeleted: false };
  const branchDeleted = reapDeleteLocal(ctx, branch);
  const remoteBranchDeleted = push ? reapDeleteRemote(ctx, branch) : false;
  return { branchDeleted, remoteBranchDeleted };
}

/**
 * Paths of the running entry script and this module.
 *
 * @returns {string[]}
 */
function runningCodePaths() {
  const paths = [];
  const entry = process.argv[1];
  if (typeof entry === 'string' && entry !== '') paths.push(entry);
  try {
    paths.push(fileURLToPath(import.meta.url));
  } catch {
    // A non-file module URL cannot be inside a worktree.
  }
  return paths;
}

/**
 * The running-code path inside `wtPath`, or `null`. Reaping the tree the
 * running script was loaded from kills the process later, at its first lazy
 * read or dynamic `import()`; refusing only defers the tree to the next sweep.
 *
 * @param {object} ctx
 * @param {string} wtPath
 * @returns {string|null}
 */
function findRunningCodeInside(ctx, wtPath) {
  return (
    runningCodePaths().find((p) => isInsideWorktree(p, wtPath, ctx.platform)) ??
    null
  );
}

/**
 * First pre-git refusal envelope, or `null`.
 *
 * @param {object} ctx
 * @param {object} opts
 * @param {string} wtPath
 * @returns {object|null}
 */
function firstReapRefusal(ctx, opts, wtPath) {
  const known = opts.worktrees
    ? opts.worktrees.some((r) => samePath(r.path, wtPath, ctx.platform))
    : findByPath(ctx, wtPath) !== null;
  if (!known) return { removed: false, reason: 'not-a-worktree', path: wtPath };

  const selfPath = findRunningCodeInside(ctx, wtPath);
  if (!selfPath) return null;
  ctx.logger.warn(
    `reap-skipped reason=running-from-target-tree path=${wtPath} selfPath=${selfPath} — ` +
      `the running process was loaded from this worktree; removing it would break every ` +
      `later lazy read and dynamic import in this run. Left for the next sweep. ` +
      `Invoke the script by its MAIN-checkout path to reap in-run.`,
  );
  return {
    removed: false,
    reason: 'running-from-target-tree',
    path: wtPath,
    selfPath,
  };
}

function checkReapPreconditions(ctx, _storyId, opts, wtPath) {
  if (opts.force) {
    throw new Error(
      'WorktreeManager.reap: --force is not permitted by the framework',
    );
  }
  const refusal = firstReapRefusal(ctx, opts, wtPath);
  if (refusal) return { ok: false, result: refusal };
  // No base-branch requirement: close reaps after pushing the branch, and
  // `isSafeToRemove` still refuses a dirty tree.
  return { ok: true };
}

async function ensureSafeOrForceDiscard(ctx, storyId, wtPath, opts) {
  const baseRef = opts.baseRef ?? opts.epicBranch ?? null;
  const safety = await isSafeToRemove(ctx, wtPath, {
    epicBranch: baseRef,
  });
  if (safety.safe) return { ok: true, discardedPaths: null };

  const discardAfterMerge = opts.discardAfterMerge !== false;
  const branchName = `story-${validateStoryId(storyId)}`;
  // Discard a dirty tree only when the work is provably integrated.
  const canForceReap =
    discardAfterMerge &&
    safety.reason === 'uncommitted-changes' &&
    baseRef &&
    isBranchMergedIntoBase(ctx, branchName, baseRef);
  if (!canForceReap) {
    ctx.logger.warn(
      `reap-skipped storyId=${storyId} reason=${safety.reason} path=${wtPath}`,
    );
    return {
      ok: false,
      result: { removed: false, reason: safety.reason, path: wtPath },
    };
  }
  const discardedPaths = collectDirtyPaths(ctx, wtPath);
  if (!discardWorktreeChanges(ctx, wtPath)) {
    ctx.logger.warn(
      `reap-skipped storyId=${storyId} reason=discard-failed path=${wtPath}`,
    );
    return {
      ok: false,
      result: {
        removed: false,
        reason: 'discard-failed',
        path: wtPath,
        discardedPaths,
      },
    };
  }
  ctx.logger.info(
    `worktree.reap discard-after-merge storyId=${storyId} paths=${discardedPaths.length}`,
  );
  return { ok: true, discardedPaths };
}

function escapeWorktreeCwd(ctx, wtPath) {
  if (!isInsideWorktree(process.cwd(), wtPath, ctx.platform)) return;
  try {
    process.chdir(ctx.repoRoot);
  } catch (err) {
    ctx.logger.warn(
      `worktree.reap chdir-to-root failed: ${err.message} (continuing)`,
    );
  }
}

async function postRemoveBeltSweep(ctx, wtPath) {
  if (!fs.existsSync(wtPath)) return;
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

function buildReapSuccess(wtPath, removeResult, discardedPaths) {
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

export async function reap(ctx, storyId, opts = {}) {
  const wtPath = pathFor(ctx, storyId);
  const pre = checkReapPreconditions(ctx, storyId, opts, wtPath);
  if (!pre.ok) return pre.result;
  const safetyCheck = await ensureSafeOrForceDiscard(
    ctx,
    storyId,
    wtPath,
    opts,
  );
  if (!safetyCheck.ok) return safetyCheck.result;
  const { discardedPaths } = safetyCheck;

  escapeWorktreeCwd(ctx, wtPath);

  const storyIdN = validateStoryId(storyId);
  const branch = `story-${storyIdN}`;
  const removeResult = await removeWorktreeWithRecovery(ctx, wtPath, {
    storyId: storyIdN,
    branch,
    push: opts.push === true,
    ...(opts.retryDelaysMs ? { retryDelaysMs: opts.retryDelaysMs } : {}),
    ...(opts.retryDelay !== undefined ? { retryDelay: opts.retryDelay } : {}),
    ...(opts.sleepFn ? { sleepFn: opts.sleepFn } : {}),
    ...(opts.forceRemoveBackoffMs !== undefined
      ? { forceRemoveBackoffMs: opts.forceRemoveBackoffMs }
      : {}),
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
  await postRemoveBeltSweep(ctx, wtPath);
  ctx.logger.info(`worktree.reaped storyId=${storyId} path=${wtPath}`);
  return buildReapSuccess(wtPath, removeResult, discardedPaths);
}
