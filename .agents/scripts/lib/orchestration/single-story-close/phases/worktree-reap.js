/**
 * phases/worktree-reap.js — reap the per-Story worktree after close.
 *
 * The Story branch is still alive on `origin` so the PR can land; the
 * local worktree is no longer needed once the PR is open. Reap is
 * best-effort: any failure is logged loudly and the close result still
 * reports success because the operator can clean stale worktrees out of
 * band.
 *
 * Also clears the trace-hook env vars so subsequent tooling falls back to
 * the no-op branch instead of pointing at a (now-reaped) worktree.
 */

import { Logger } from '../../../Logger.js';
import { clearActiveStoryEnv } from '../../../observability/active-story-env.js';
import { WorktreeManager as DefaultWorktreeManager } from '../../../worktree-manager.js';

/**
 * Reap the worktree for a standalone Story when isolation is enabled and
 * `reapOnSuccess` is not explicitly disabled.
 *
 * @param {{
 *   cwd: string,
 *   storyId: number,
 *   worktreePath: string|null,
 *   wtIsolation: object|undefined,
 *   progress: (tag: string, msg: string) => void,
 * }} args
 * @returns {Promise<boolean>} true when reap completed
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
      await wm.reap(storyId);
      worktreeReaped = true;
      progress('WORKTREE', `🧹 Reaped worktree for story-${storyId}.`);
    } catch (err) {
      Logger.error(
        `[single-story-close] ⚠️ Failed to reap worktree: ${err?.message ?? err}`,
      );
    }
  }

  // Clear the trace-hook env vars so subsequent tooling falls back to the
  // no-op branch instead of pointing at a (now-reaped) worktree.
  try {
    clearActiveStoryEnv({
      logger: { warn: (m) => progress('ENV', `⚠️ ${m}`) },
    });
  } catch {
    // Non-fatal.
  }

  return worktreeReaped;
}
