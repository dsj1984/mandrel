/**
 * phases/branch-cleanup.js — post-merge Story branch deletion phase.
 *
 * Delegates the "delete this branch from local + remote, treat not-found
 * as success" idempotency contract to `lib/git-branch-cleanup.js` so the
 * deletion rules live in one place. A local delete failure is logged
 * loudly (operators usually need to investigate a stale worktree),
 * while a remote not-found is treated as a no-op.
 */

import { deleteBranchBoth } from '../../../git-branch-cleanup.js';

function reapPhaseLogger(progress) {
  return progress ?? (() => {});
}

export async function branchCleanupPhase(ctx, state = {}) {
  const {
    storyBranch,
    repoRoot,
    progress,
    logger,
    branchCleanup = deleteBranchBoth,
  } = ctx;
  const log = reapPhaseLogger(progress);
  log('CLEANUP', `Deleting story branch: ${storyBranch}`);

  const result = branchCleanup(storyBranch, {
    cwd: repoRoot,
    noVerify: true,
  });

  if (!result.local.deleted) {
    const stderr = (result.local.stderr || '').trim();
    const reapStatus = state.worktreeReap?.status;
    logger.error(
      `  Local branch ${storyBranch} delete failed: ${stderr || 'unknown'}. ` +
        `Check for stale worktrees (git worktree list).` +
        (reapStatus ? ` worktreeReap=${reapStatus}.` : ''),
    );
  }
  if (result.remote.deleted) {
    if (result.remote.reason === 'not-found') {
      log('CLEANUP', `Remote branch ${storyBranch} not found — skipped`);
    } else {
      log('CLEANUP', `✅ Remote branch ${storyBranch} deleted`);
    }
  }

  return {
    localDeleted: result.local.deleted,
    remoteDeleted: result.remote.deleted,
    localReason: result.local.reason,
    remoteReason: result.remote.reason,
  };
}
