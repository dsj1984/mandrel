/**
 * worktree/lifecycle/merge-reachability.js
 *
 * The "is the worktree's work integrated upstream?" half of
 * `isSafeToRemove`. Runs the two-phase reachability gate the parent
 * documents: primary `merge-base --is-ancestor HEAD epicRef`, and a
 * fallback `git log --grep=resolves #<storyId>` against the Epic ref when
 * the ancestry check returns "not an ancestor".
 *
 * The fallback exists because a post-merge rebase or force-push can drop
 * the local branch ref off the merged tip — the `(resolves #N)` token on
 * the Epic's `--no-ff` merge commit (emitted by
 * `story-close/merge-runner.js`) is the durable proof the Story was
 * integrated.
 *
 * Pure with respect to the supplied `ctx` bag; the only side effects are
 * the `gitSpawn` calls.
 */

/**
 * Resolve a worktree's `HEAD` to a full commit SHA via
 * `git rev-parse HEAD` (run inside the worktree). Returns
 * `{ ok: true, sha, short }` on success, or `{ ok: false, reason }` when
 * the spawn fails. The short form is sliced from the full SHA so callers
 * can build operator-facing reason strings without a second round-trip.
 *
 * @param {object} ctx
 * @param {string} wtPath
 * @returns {{ok: true, sha: string, short: string} | {ok: false, reason: string}}
 */
export function resolveHeadSha(ctx, wtPath) {
  const res = ctx.git.gitSpawn(wtPath, 'rev-parse', 'HEAD');
  if (res.status !== 0) {
    return { ok: false, reason: `rev-parse-failed: ${res.stderr || 'HEAD'}` };
  }
  const sha = res.stdout.trim();
  return { ok: true, sha, short: sha.slice(0, 7) || 'HEAD' };
}

/**
 * Run `git merge-base --is-ancestor headSha epicRef` from the main
 * checkout. Returns one of:
 *
 *   - `{ outcome: 'ancestor' }` — exit 0, head is reachable.
 *   - `{ outcome: 'not-ancestor' }` — exit 1, head is not reachable; the
 *     caller should fall back to the merge-commit-grep path.
 *   - `{ outcome: 'error', reason }` — any other exit; treat as unsafe.
 *
 * @param {object} ctx
 * @param {string} headSha
 * @param {string} epicRef
 * @returns {{outcome: 'ancestor'} | {outcome: 'not-ancestor'} | {outcome: 'error', reason: string}}
 */
export function checkHeadAncestor(ctx, headSha, epicRef) {
  const res = ctx.git.gitSpawn(
    ctx.repoRoot,
    'merge-base',
    '--is-ancestor',
    headSha,
    epicRef,
  );
  if (res.status === 0) return { outcome: 'ancestor' };
  if (res.status === 1) return { outcome: 'not-ancestor' };
  return {
    outcome: 'error',
    reason: res.stderr || res.stdout || 'unknown',
  };
}

/**
 * Predicate: did the Epic ref accumulate a `--no-ff` merge commit whose
 * subject names this Story (e.g. `... (resolves #1851)`)? Returns `true`
 * when the grep finds at least one matching merge commit, `false` when it
 * returns empty or fails.
 *
 * Returns `false` for branches that do not match the canonical
 * `story-<id>` shape — the merge-commit subject contract is only
 * guaranteed for story branches.
 *
 * @param {object} ctx
 * @param {string} branch Worktree branch (e.g. `story-1851`).
 * @param {string} epicRef Epic branch ref (e.g. `epic/1831`).
 * @returns {boolean}
 */
export function hasMergeCommitForStory(ctx, branch, epicRef) {
  const storyMatch = /^story-(\d+)$/.exec(branch);
  if (!storyMatch) return false;
  const storyId = storyMatch[1];
  const grep = ctx.git.gitSpawn(
    ctx.repoRoot,
    'log',
    epicRef,
    '--merges',
    '-n',
    '1',
    '--pretty=%H',
    `--grep=resolves #${storyId}`,
  );
  return grep.status === 0 && grep.stdout.trim().length > 0;
}

/**
 * Run the full two-phase merge-reachability gate. Returns the same
 * `{ safe, reason }` envelope `isSafeToRemove` does, so callers can chain
 * the verdict directly into the parent return value.
 *
 * @param {object} ctx
 * @param {string} wtPath
 * @param {string} branch Working branch name from the precheck.
 * @param {string} epicRef Epic ref (e.g. `epic/1831`).
 * @returns {Promise<{safe: boolean, reason: string}>}
 */
export async function checkMergeReachability(ctx, wtPath, branch, epicRef) {
  const head = resolveHeadSha(ctx, wtPath);
  if (!head.ok) return { safe: false, reason: head.reason };

  const ancestor = checkHeadAncestor(ctx, head.sha, epicRef);
  if (ancestor.outcome === 'ancestor') {
    return { safe: true, reason: 'head-reachable-from-epic' };
  }
  if (ancestor.outcome === 'error') {
    return {
      safe: false,
      reason: `merge-check-failed: head=${head.short} epic=${epicRef}: ${ancestor.reason}`,
    };
  }

  if (hasMergeCommitForStory(ctx, branch, epicRef)) {
    return { safe: true, reason: 'merge-commit-reachable' };
  }
  return {
    safe: false,
    reason: `unmerged-commits: head=${head.short} epic=${epicRef}`,
  };
}
