/**
 * Per-candidate reap helpers for git-cleanup's branches phase. Each records
 * its outcome on the supplied accumulators and hard failures on `failures`.
 *
 * @module lib/orchestration/git-cleanup/phases/branches-reap
 */

const TAG = '[git-cleanup]';

/**
 * Remove a candidate's worktree. A lock-class failure is deferred to the
 * pending-cleanup manifest (non-fatal); any other failure is a hard failure.
 * The return value never gates the ref reap: a leftover directory must not
 * strand an already-merged ref.
 */
export function reapWorktree({
  cand,
  removeWorktreeFn,
  cwd,
  logger,
  worktrees,
  failures,
  deferred = [],
  recordPendingCleanupFn = null,
  worktreeRoot = null,
}) {
  if (!cand.hasWorktree || !cand.worktreePath) return true;
  const wtRes = removeWorktreeFn(cand.worktreePath, cwd);
  worktrees.push({
    path: cand.worktreePath,
    ok: wtRes.ok,
    dirty: wtRes.dirty,
    lockClass: wtRes.lockClass ?? false,
    stderr: wtRes.stderr,
  });
  if (wtRes.dirty && wtRes.ok) {
    logger.warn?.(
      `${TAG} ⚠️ dirty worktree force-removed: ${cand.worktreePath}`,
    );
  }
  if (wtRes.ok) return true;
  if (wtRes.lockClass) {
    recordDeferredWorktree({
      cand,
      wtRes,
      logger,
      deferred,
      recordPendingCleanupFn,
      worktreeRoot,
    });
    return false;
  }
  failures.push({
    branch: cand.branch,
    scope: 'worktree',
    stderr: wtRes.stderr,
  });
  return false;
}

function recordDeferredWorktree({
  cand,
  wtRes,
  logger,
  deferred,
  recordPendingCleanupFn,
  worktreeRoot,
}) {
  let pendingCleanup = null;
  const storyId = storyIdFromBranch(cand.branch);
  if (recordPendingCleanupFn && worktreeRoot && storyId != null) {
    try {
      pendingCleanup = recordPendingCleanupFn(worktreeRoot, {
        storyId,
        branch: cand.branch,
        path: cand.worktreePath,
        push: false,
      });
    } catch (err) {
      logger.warn?.(
        `${TAG} ⚠️ pending-cleanup handoff failed for ${cand.branch}: ${err?.message ?? err}`,
      );
    }
  }
  deferred.push({
    branch: cand.branch,
    path: cand.worktreePath,
    reason: 'worktree-lock',
    stderr: wtRes.stderr,
    pendingCleanup,
  });
  logger.warn?.(
    `${TAG} ⚠️ worktree ${cand.worktreePath} could not be removed (file lock); ` +
      `ref reaped, directory deferred to pending-cleanup sweep`,
  );
}

/** Story id of a `story-<id>` branch (the manifest key), else `null`. */
function storyIdFromBranch(branch) {
  const m = /^story-(\d+)$/.exec(branch ?? '');
  return m ? Number(m[1]) : null;
}

export function reapLocalRef({ cand, deleteLocalFn, cwd, local, failures }) {
  if (cand.localExists === false) return true;
  const localRes = deleteLocalFn(cand.branch, cwd);
  local.push({
    branch: cand.branch,
    ok: localRes.deleted,
    reason: localRes.reason,
    alreadyGone: localRes.reason === 'not-found',
    stderr: localRes.stderr,
  });
  if (!localRes.deleted) {
    failures.push({
      branch: cand.branch,
      scope: 'local',
      reason: localRes.reason,
      stderr: localRes.stderr,
    });
    return false;
  }
  return true;
}

export function reapRemoteRef({
  cand,
  deleteRemoteFn,
  cwd,
  remoteResults,
  failures,
}) {
  const remoteRes = deleteRemoteFn(cand.branch, cwd);
  remoteResults.push({
    branch: cand.branch,
    ok: remoteRes.deleted,
    reason: remoteRes.reason,
    alreadyGone: remoteRes.reason === 'not-found',
    stderr: remoteRes.stderr,
  });
  if (!remoteRes.deleted) {
    failures.push({
      branch: cand.branch,
      scope: 'remote',
      reason: remoteRes.reason,
      stderr: remoteRes.stderr,
    });
  }
}

export function buildPruneSummary({
  pruneRemoteFn,
  cwd,
  remoteName,
  failures,
}) {
  const pruneRes = pruneRemoteFn(cwd, remoteName);
  const prune = {
    attempted: true,
    ok: pruneRes.ok,
    remote: remoteName,
    pruned: pruneRes.pruned ?? [],
    stderr: pruneRes.stderr,
  };
  if (!pruneRes.ok) {
    failures.push({ branch: null, scope: 'prune', stderr: pruneRes.stderr });
  }
  return prune;
}
