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
 * and pushes failures onto `failures`; return values are booleans
 * indicating whether to continue with the next reap step.
 *
 * @module lib/orchestration/git-cleanup/phases/branches-reap
 */

const TAG = '[git-cleanup]';

export function reapWorktree({
  cand,
  removeWorktreeFn,
  cwd,
  logger,
  worktrees,
  failures,
}) {
  if (!cand.hasWorktree || !cand.worktreePath) return true;
  const wtRes = removeWorktreeFn(cand.worktreePath, cwd);
  worktrees.push({
    path: cand.worktreePath,
    ok: wtRes.ok,
    dirty: wtRes.dirty,
    stderr: wtRes.stderr,
  });
  if (wtRes.dirty) {
    logger.warn?.(
      `${TAG} ⚠️ dirty worktree force-removed: ${cand.worktreePath}`,
    );
  }
  if (!wtRes.ok) {
    failures.push({
      branch: cand.branch,
      scope: 'worktree',
      stderr: wtRes.stderr,
    });
    return false;
  }
  return true;
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
