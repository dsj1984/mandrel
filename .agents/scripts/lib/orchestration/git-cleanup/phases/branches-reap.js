/**
 * branches-reap.js — per-candidate reap helpers for the branches phase
 * of git-cleanup (Story #2466).
 *
 * Split out of `branches.js` so each phase file stays under Story
 * #2466's 200-LOC ceiling. Exports four small functions that the
 * branches-phase orchestrator (`executeCleanup`) composes:
 *
 *   - `reapWorktree({ cand, … })` — `git worktree remove` (with force
 *     fallback) and push the result onto `worktrees`.
 *   - `reapLocalRef({ cand, … })` — `git branch -D`, skipped on
 *     remote-only candidates.
 *   - `reapRemoteRef({ cand, … })` — `git push --delete <remote>`.
 *   - `buildPruneSummary({ … })` — trailing `git fetch --prune` to
 *     drop tracking refs left behind by remote deletes.
 *
 * Every helper records its outcome on the supplied accumulator arrays
 * and pushes hard failures onto `failures`.
 *
 * ## Ref-reap is decoupled from worktree-reap (Story #3598)
 *
 * The candidate set is, by construction, already-merged (the planner
 * resolves each candidate's merged PR / `git merge-base` state). A
 * failure to physically remove the worktree *directory* must NOT strand
 * the merged branch *ref*: a leftover directory is recoverable garbage,
 * a stranded merged ref clutters every subsequent run. So `reapWorktree`
 * no longer gates the ref reap — `executeCleanup` always proceeds to
 * `reapLocalRef` / `reapRemoteRef` after it, regardless of the worktree
 * outcome. Lock-class removal failures (Windows handles on
 * `node_modules` / test artifacts) are recorded as **deferred** entries
 * and handed off to the `pending-cleanup` manifest rather than pushed
 * onto `failures`, so an OS file lock on an already-merged branch's
 * directory does not make `git-cleanup` exit non-zero.
 *
 * @module lib/orchestration/git-cleanup/phases/branches-reap
 */

const TAG = '[git-cleanup]';

/**
 * Attempt to remove a candidate's worktree directory. Records the outcome
 * on `worktrees`. A successful (or absent) removal is silent. A failed
 * removal is split by class:
 *
 *   - **lock-class** (`wtRes.lockClass`) → recorded on `deferred` and, when
 *     a `recordPendingCleanupFn` + `worktreeRoot` are supplied, handed off
 *     to the pending-cleanup manifest. Non-fatal — the run does not exit 1.
 *   - **non-lock** → pushed onto `failures` (a genuine, operator-visible
 *     git error worth surfacing as a failure).
 *
 * Unlike the pre-#3598 contract, the return value does **not** gate the
 * subsequent ref reap; `executeCleanup` always proceeds to delete the
 * (already-merged) ref. The boolean is retained only as a "removal
 * succeeded" signal for callers that want it.
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

/**
 * Record a lock-class worktree-removal failure as a non-fatal deferred
 * entry and hand it off to the pending-cleanup manifest when wired. The
 * merged branch ref is still reaped by `executeCleanup`; only the locked
 * directory is left for the next plan-time worktree-sweep to drain.
 */
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

/**
 * Parse the numeric story id out of a `story-<id>` branch name. Returns
 * `null` for non-story branches (the pending-cleanup manifest is keyed by
 * `storyId`, so only `story-*` candidates get a manifest handoff).
 */
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
