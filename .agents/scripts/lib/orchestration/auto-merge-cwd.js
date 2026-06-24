/**
 * auto-merge-cwd.js — resolve a worktree-collision-safe cwd for arming
 * GitHub native auto-merge (Story #4282).
 *
 * Root cause this module exists to defeat:
 *   Arming auto-merge runs, in effect,
 *   `gh pr merge <pr> --auto --squash --delete-branch`. The
 *   `--delete-branch` flag makes `gh` shell out to local `git` to leave
 *   and delete the PR head branch — including a `git checkout <base>` to
 *   switch the working tree off the head branch. When the arm runs from a
 *   per-Story worktree cwd (checked out on the head branch `story-<id>`)
 *   while the base branch (`main`) is already occupied by the primary
 *   worktree, `gh`'s internal `git checkout <base>` collides:
 *
 *     fatal: '<base>' is already used by worktree at '<primary>'
 *
 *   The arm fails (non-fatally), defeating the unattended auto-merge
 *   contract — the operator must re-run the merge manually from a clean cwd.
 *
 * Fix (advisory direction #1 from the Story — "ensure the cwd is already
 * on the base branch so gh's `git checkout <base>` is a no-op"):
 *   Re-point the arm at the **primary worktree root** — the working tree
 *   that holds the base branch — discovered via `git worktree list
 *   --porcelain`. From the primary worktree, `gh`'s `--delete-branch`
 *   cleanup never has to `git checkout <base>` (it is already there), so
 *   the collision cannot occur. `--delete-branch` is preserved verbatim,
 *   so the PR head branch is still removed on merge with no dependency on
 *   the consumer's repo-level "auto-delete head branches" toggle.
 *
 * Non-fatal by construction: any failure to resolve the primary worktree
 * (not a git repo, `git` missing, single-worktree layout, parse failure)
 * degrades to returning the original `cwd` unchanged. Worst case is the
 * pre-fix behaviour; this helper never throws and never blocks arming.
 */

import { gitSpawn as defaultGitSpawn } from '../git-utils.js';

/**
 * Parse `git worktree list --porcelain` output into structured records.
 *
 * The porcelain format emits one stanza per worktree, blank-line
 * separated, e.g.:
 *
 *   worktree /abs/path/to/primary
 *   HEAD <sha>
 *   branch refs/heads/main
 *
 *   worktree /abs/path/to/.worktrees/story-4282
 *   HEAD <sha>
 *   branch refs/heads/story-4282
 *
 * A linked worktree with a detached HEAD emits `detached` instead of a
 * `branch` line. Pure — exported for tests.
 *
 * @param {string} stdout
 * @returns {Array<{ path: string, branch: string|null }>}
 */
export function parseWorktreeList(stdout) {
  const text = String(stdout ?? '');
  const records = [];
  let current = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('worktree ')) {
      if (current) records.push(current);
      current = { path: line.slice('worktree '.length).trim(), branch: null };
    } else if (line.startsWith('branch ') && current) {
      current.branch = line
        .slice('branch '.length)
        .trim()
        .replace(/^refs\/heads\//, '');
    }
    // `HEAD <sha>`, `detached`, `bare`, `locked`, `prunable` lines carry
    // no field we need; ignored.
  }
  if (current) records.push(current);
  return records;
}

/**
 * Pick the primary worktree from a parsed worktree list. The primary
 * worktree is the first stanza `git worktree list` emits — it is the
 * original (non-linked) working tree and, during delivery, the one that
 * holds the base branch. Returns its absolute path, or `null` when the
 * list is empty / unparseable.
 *
 * Pure — exported for tests.
 *
 * @param {Array<{ path: string, branch: string|null }>} records
 * @returns {string|null}
 */
export function pickPrimaryWorktreePath(records) {
  if (!Array.isArray(records) || records.length === 0) return null;
  const first = records[0];
  return first && typeof first.path === 'string' && first.path.length > 0
    ? first.path
    : null;
}

/**
 * Resolve a worktree-collision-safe cwd for arming auto-merge.
 *
 * Returns the primary worktree root (which holds the base branch) when it
 * can be discovered AND it differs from `cwd`; otherwise returns `cwd`
 * unchanged. Never throws.
 *
 * @param {string} cwd — the cwd the caller would otherwise arm from
 *   (often a per-Story worktree on the head branch).
 * @param {{ gitSpawn?: typeof import('../git-utils.js').gitSpawn }} [deps]
 * @returns {string} a cwd safe to run `gh pr merge --delete-branch` from.
 */
export function resolveAutoMergeArmCwd(
  cwd,
  { gitSpawn = defaultGitSpawn } = {},
) {
  if (typeof cwd !== 'string' || cwd.length === 0) return cwd;
  try {
    const result = gitSpawn(cwd, 'worktree', 'list', '--porcelain');
    if (!result || result.status !== 0) return cwd;
    const primary = pickPrimaryWorktreePath(parseWorktreeList(result.stdout));
    if (!primary) return cwd;
    return primary;
  } catch {
    // Any unexpected failure (git missing, non-repo cwd, etc.) degrades
    // to the original cwd — arming stays best-effort.
    return cwd;
  }
}
