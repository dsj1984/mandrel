/**
 * phases/worktree-reap.js — best-effort reap of the per-Story worktree once
 * the PR is open. `reap` refuses by RETURNING `{ removed: false }`, so report
 * what happened, never merely that the call did not throw.
 */

import { Logger } from '../../../Logger.js';
import { WorktreeManager as DefaultWorktreeManager } from '../../../worktree-manager.js';

/**
 * @param {{
 *   cwd: string,
 *   storyId: number,
 *   worktreePath: string|null,
 *   wtIsolation: object|undefined,
 *   progress: (tag: string, msg: string) => void,
 * }} args
 * @returns {Promise<boolean>} `true` only when the worktree was actually
 *   removed — never merely because the call did not throw.
 */
export async function reapWorktreePhase({
  cwd,
  storyId,
  worktreePath,
  wtIsolation,
  progress,
  WorktreeManager = DefaultWorktreeManager,
}) {
  let worktreeReaped = false;
  const reapEnabled = wtIsolation?.reapOnSuccess !== false;
  if (worktreePath && reapEnabled) {
    try {
      const wm = new WorktreeManager({
        repoRoot: cwd,
        config: wtIsolation,
        logger: {
          info: (m) => progress('WORKTREE', m),
          warn: (m) => progress('WORKTREE', `⚠️ ${m}`),
          error: (m) => Logger.error(`[single-story-close] ${m}`),
        },
      });
      // NO base ref: this runs before the merge, so a merge-reachability
      // check would refuse every reap. Safe because the work is pushed, and
      // a dirty tree is still refused.
      const result = await wm.reap(storyId);
      worktreeReaped = result?.removed === true;
      if (worktreeReaped) {
        progress('WORKTREE', `🧹 Reaped worktree for story-${storyId}.`);
      } else {
        progress(
          'WORKTREE',
          `⚠️ Worktree for story-${storyId} not reaped (${result?.reason ?? 'unknown reason'}) — ` +
            `${worktreePath} left in place for the next sweep.`,
        );
      }
    } catch (err) {
      Logger.error(
        `[single-story-close] ⚠️ Failed to reap worktree: ${err?.message ?? err}`,
      );
    }
  }

  return worktreeReaped;
}
