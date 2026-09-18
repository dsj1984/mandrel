/**
 * Whether a worktree's work is integrated upstream: HEAD is an ancestor of
 * the base ref, or (after a rebase/force-push moved the tip) every branch
 * commit is patch-equivalent upstream.
 */

/**
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
 * `merge-base --is-ancestor`: exit 0 ancestor, 1 not, else error (unsafe).
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
 * True when `git cherry` lists at least one commit and all are `- ` (already
 * upstream by patch-id under different SHAs).
 *
 * @param {object} ctx
 * @param {string} branch
 * @param {string} epicRef
 * @returns {boolean}
 */
export function hasRebasedEquivalents(ctx, branch, epicRef) {
  const res = ctx.git.gitSpawn(ctx.repoRoot, 'cherry', epicRef, branch);
  if (res.status !== 0) return false;
  const lines = (res.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every((line) => line.startsWith('- '));
}

/**
 * @param {object} ctx
 * @param {string} wtPath
 * @param {string} branch
 * @param {string} epicRef Base ref the work must be integrated into.
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

  if (hasRebasedEquivalents(ctx, branch, epicRef)) {
    return { safe: true, reason: 'rebased-equivalents' };
  }
  return {
    safe: false,
    reason: `unmerged-commits: head=${head.short} epic=${epicRef}`,
  };
}
