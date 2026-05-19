/**
 * sync-from-base.js — Fetch and merge `origin/<baseBranch>` into the
 * current branch of a worktree, so a Story or Epic PR opens with the
 * latest base commits already integrated (Story #2580).
 *
 * The race this addresses: when multiple `/single-story-deliver` sessions
 * run in parallel, each Story branch is forked from the same `main` SHA.
 * Whichever PR auto-merges first bumps `main`; the lagging PRs are then
 * "behind base" and (with branch-protection's `up-to-date branch` rule)
 * stall at the merge gate. Pulling the latest base commits into the
 * Story branch before push makes the initial CI run reflect a fresh
 * merge and reduces (does not eliminate) the residual race-with-merge
 * window. The merge queue is the proper fix for the residual race.
 *
 * Why merge (not rebase): Story branches are pushed and reviewed across
 * iterations of the watch + fix loop; a rebase would force-push and risk
 * losing in-flight reviewer context. The merge commit is squashed away
 * when the PR lands, so the cosmetic cost is zero.
 *
 * Outcomes (`{ synced, kind, ... }`):
 *
 *   - `{ synced: true, kind: 'noop-already-current' }` — `origin/<base>`
 *     is already an ancestor of HEAD; nothing to do.
 *   - `{ synced: true, kind: 'fast-forward' }` — merge fast-forwarded.
 *   - `{ synced: true, kind: 'merge-commit' }` — non-trivial merge
 *     succeeded; a merge commit landed on the active branch.
 *   - `{ synced: false, kind: 'fetch-failed', stderr }` — `git fetch`
 *     could not retrieve `origin/<base>`. No mutation occurred.
 *   - `{ synced: false, kind: 'conflict', conflictFiles }` — merge
 *     conflicted and was aborted; caller must surface a recoverable
 *     surface (structured comment + `agent::blocked`) and stop.
 *   - `{ synced: false, kind: 'merge-failed', stderr }` — merge exited
 *     non-zero for a reason other than a parseable conflict (rare; treat
 *     as a hard blocker on the caller's side).
 *
 * The helper does not mutate any ticket state, post comments, or write
 * to anything other than the worktree's git refs / index. Callers own
 * the recovery surface.
 */

import {
  gitFetchWithRetry as defaultGitFetchWithRetry,
  gitSpawn as defaultGitSpawn,
} from '../git-utils.js';

/**
 * Sync the active branch in `cwd` against `origin/<baseBranch>`. See
 * the module docstring for the full outcome envelope.
 *
 * @param {object} opts
 * @param {string} opts.cwd Absolute path to the worktree (or main
 *   checkout) on which the merge should run. The caller is responsible
 *   for ensuring the desired branch is checked out — this helper does
 *   not switch branches.
 * @param {string} opts.baseBranch Name of the base branch on `origin`
 *   (e.g. `'main'` or `'epic/123'`). The helper fetches and merges
 *   `origin/<baseBranch>`.
 * @param {(tag: string, msg: string) => void} [opts.log] Progress sink.
 *   Receives `(tag, message)` for each non-trivial step. Defaults to a
 *   no-op so the helper is silent when called from a test.
 * @param {typeof defaultGitFetchWithRetry} [opts.gitFetchWithRetry]
 *   Override for unit tests.
 * @param {typeof defaultGitSpawn} [opts.gitSpawn] Override for unit
 *   tests.
 *
 * @returns {Promise<
 *   | { synced: true, kind: 'noop-already-current' }
 *   | { synced: true, kind: 'fast-forward' }
 *   | { synced: true, kind: 'merge-commit' }
 *   | { synced: false, kind: 'fetch-failed', stderr: string }
 *   | { synced: false, kind: 'conflict', conflictFiles: string[] }
 *   | { synced: false, kind: 'merge-failed', stderr: string }
 * >}
 */
export async function syncBranchFromBase({
  cwd,
  baseBranch,
  log = () => {},
  gitFetchWithRetry = defaultGitFetchWithRetry,
  gitSpawn = defaultGitSpawn,
} = {}) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new TypeError('syncBranchFromBase: cwd must be a non-empty string');
  }
  if (typeof baseBranch !== 'string' || baseBranch.length === 0) {
    throw new TypeError(
      'syncBranchFromBase: baseBranch must be a non-empty string',
    );
  }

  log('SYNC', `Fetching origin/${baseBranch}...`);
  const fetch = await gitFetchWithRetry(cwd, 'origin', baseBranch);
  if (fetch.status !== 0) {
    return {
      synced: false,
      kind: 'fetch-failed',
      stderr: (fetch.stderr ?? '').toString(),
    };
  }

  // Probe whether the merge would be a no-op (origin already an ancestor
  // of HEAD) or a fast-forward (HEAD an ancestor of origin). The two
  // probes are cheap and let us avoid invoking `git merge` when nothing
  // needs to change.
  const originAlreadyMerged = gitSpawn(
    cwd,
    'merge-base',
    '--is-ancestor',
    `origin/${baseBranch}`,
    'HEAD',
  );
  if (originAlreadyMerged.status === 0) {
    log('SYNC', `origin/${baseBranch} already merged into HEAD — no-op.`);
    return { synced: true, kind: 'noop-already-current' };
  }

  const headBehindOrigin = gitSpawn(
    cwd,
    'merge-base',
    '--is-ancestor',
    'HEAD',
    `origin/${baseBranch}`,
  );
  const willFastForward = headBehindOrigin.status === 0;

  log(
    'SYNC',
    willFastForward
      ? `Fast-forwarding to origin/${baseBranch}...`
      : `Merging origin/${baseBranch} into current branch...`,
  );
  const merge = gitSpawn(cwd, 'merge', '--no-edit', `origin/${baseBranch}`);
  if (merge.status === 0) {
    return {
      synced: true,
      kind: willFastForward ? 'fast-forward' : 'merge-commit',
    };
  }

  // Non-zero merge exit — collect the conflicting file list before
  // aborting so the caller can present a recoverable surface.
  const unmerged = gitSpawn(cwd, 'diff', '--name-only', '--diff-filter=U');
  const conflictFiles = (unmerged.stdout ?? '')
    .toString()
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Always abort, even when the conflict list is empty — leaving the
  // worktree in a half-merged state would block the operator's recovery
  // loop on the next iteration.
  gitSpawn(cwd, 'merge', '--abort');

  if (conflictFiles.length > 0) {
    return { synced: false, kind: 'conflict', conflictFiles };
  }
  return {
    synced: false,
    kind: 'merge-failed',
    stderr: (merge.stderr ?? '').toString(),
  };
}
