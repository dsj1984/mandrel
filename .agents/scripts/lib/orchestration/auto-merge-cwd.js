/**
 * auto-merge-cwd.js — pick a cwd for arming auto-merge that cannot hit the
 * worktree collision. `gh pr merge --delete-branch` runs `git checkout <base>`;
 * from a Story worktree that fails because the primary worktree already holds
 * the base branch. Arming from the primary worktree makes that checkout a
 * no-op while keeping `--delete-branch`. Any resolution failure returns the
 * original `cwd`; never throws.
 */

import { gitSpawn as defaultGitSpawn } from '../git-utils.js';

/**
 * Parse `git worktree list --porcelain` stanzas; a detached worktree has
 * `branch: null`.
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
  }
  if (current) records.push(current);
  return records;
}

/**
 * The first stanza is the primary (non-linked) worktree, which holds the base
 * branch during delivery.
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
 * @param {string} cwd — the cwd the caller would otherwise arm from.
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
    return cwd;
  }
}
