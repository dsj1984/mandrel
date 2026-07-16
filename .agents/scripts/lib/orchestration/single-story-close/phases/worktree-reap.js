/**
 * phases/worktree-reap.js — reap the per-Story worktree after close.
 *
 * The Story branch is still alive on `origin` so the PR can land; the
 * local worktree is no longer needed once the PR is open. Reap is
 * best-effort: any failure is logged loudly and the close result still
 * reports success because the operator can clean stale worktrees out of
 * band.
 *
 * **Report what happened, not what was attempted** (Story #4539). This
 * phase used to set `worktreeReaped = true` and log "🧹 Reaped worktree"
 * on any non-throwing call — without reading the returned envelope. Since
 * `reap` signals refusal by *returning* `{ removed: false, reason }`
 * rather than throwing, and a v2-era precondition refused every
 * `story-<id>` worktree outright, the result was that no close ever
 * actually reaped and every close said it did. Best-effort means the close
 * still succeeds on refusal; it does not mean the close may claim an
 * outcome it never checked.
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
      // Deliberately NO base ref. This phase runs BEFORE the merge (see
      // `../runner.js` — reap precedes the confirm phase), so "is this work
      // integrated into the base?" is the wrong question: the answer is
      // always no, and supplying a ref would activate `isSafeToRemove`'s
      // merge-reachability gate and refuse every reap with
      // `unmerged-commits` — trading one always-refuse precondition for
      // another.
      //
      // What actually makes the reap safe here is that close has already
      // pushed `story-<id>` to origin and opened the PR, so the work is
      // durable off-machine; and `isSafeToRemove` still refuses a dirty
      // tree (`uncommitted-changes`), which is the check that protects
      // unsaved work. Refusal is signalled by the returned envelope rather
      // than by throwing — so read it.
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
