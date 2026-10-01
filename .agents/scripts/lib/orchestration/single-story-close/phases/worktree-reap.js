/**
 * phases/worktree-reap.js — best-effort reap of the per-Story worktree, run
 * only by the post-land tail. `reap` refuses by RETURNING
 * `{ removed: false }`, so report what happened, not that nothing threw.
 */

import { Logger } from '../../../Logger.js';
import { WorktreeManager as DefaultWorktreeManager } from '../../../worktree-manager.js';

function skippedOutcome(worktreePath) {
  const reason = worktreePath ? 'reap-disabled' : 'no-worktree';
  return { removed: false, skipped: true, reason };
}

function reapOutcome(result) {
  const removed = result?.removed === true;
  return {
    removed,
    skipped: result?.skipped === true,
    reason: result?.reason ?? null,
  };
}

function failedOutcome(err) {
  const reason = String(err?.message ?? err);
  Logger.error(`[worktree-reap] ⚠️ Failed to reap worktree: ${reason}`);
  return { removed: false, skipped: false, reason };
}

function reportReap(outcome, { storyId, worktreePath, progress }) {
  if (outcome.removed) {
    progress('WORKTREE', `🧹 Reaped worktree for story-${storyId}.`);
    return;
  }
  progress(
    'WORKTREE',
    `⚠️ Worktree for story-${storyId} not reaped (${outcome.reason ?? 'unknown reason'}) — ` +
      `${worktreePath} left in place for the next sweep.`,
  );
}

function createManager({ WorktreeManager, cwd, wtIsolation, progress }) {
  return new WorktreeManager({
    repoRoot: cwd,
    config: wtIsolation,
    logger: {
      info: (m) => progress('WORKTREE', m),
      warn: (m) => progress('WORKTREE', `⚠️ ${m}`),
      error: (m) => Logger.error(`[worktree-reap] ${m}`),
    },
  });
}

async function reapNow(args) {
  const wm = createManager(args);
  // NO base ref: a squash merge never makes the branch reachable from the
  // base. Safe because the work is merged; a dirty tree is still refused.
  const outcome = reapOutcome(await wm.reap(args.storyId));
  reportReap(outcome, args);
  return outcome;
}

/**
 * `skipped`: nothing to do (no worktree, reap disabled, isolation off).
 *
 * @returns {Promise<{ removed: boolean, skipped: boolean, reason: string|null }>}
 */
export function reapWorktreePhase({
  WorktreeManager = DefaultWorktreeManager,
  ...args
}) {
  if (!args.worktreePath || args.wtIsolation?.reapOnSuccess === false) {
    return Promise.resolve(skippedOutcome(args.worktreePath));
  }
  return reapNow({ ...args, WorktreeManager }).catch(failedOutcome);
}
