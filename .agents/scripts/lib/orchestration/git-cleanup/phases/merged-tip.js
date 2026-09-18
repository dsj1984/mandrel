/**
 * Resolve a MERGED PR's head against the branch tip by ancestry.
 *
 * @module lib/orchestration/git-cleanup/phases/merged-tip
 */

import { gitSpawn } from '../../../git-utils.js';

/**
 * Tri-state: is `ancestorSha` reachable from `descendantSha`? Both revs are
 * verified first so an unresolvable rev (merge-base exit 128) fails closed to
 * `error` rather than reading as a divergence.
 *
 * @param {{ cwd: string, ancestorSha: string, descendantSha: string, spawn?: typeof gitSpawn }} args
 * @returns {{ outcome: 'ancestor' } | { outcome: 'not-ancestor' } | { outcome: 'error', reason: string }}
 */
export function probeAncestry({
  cwd,
  ancestorSha,
  descendantSha,
  spawn = gitSpawn,
}) {
  for (const rev of [ancestorSha, descendantSha]) {
    const res = spawn(
      cwd,
      'rev-parse',
      '--quiet',
      '--verify',
      `${rev}^{commit}`,
    );
    if (res.status !== 0) {
      return { outcome: 'error', reason: `unresolvable rev ${rev}` };
    }
  }
  const res = spawn(
    cwd,
    'merge-base',
    '--is-ancestor',
    ancestorSha,
    descendantSha,
  );
  if (res.status === 0) return { outcome: 'ancestor' };
  if (res.status === 1) return { outcome: 'not-ancestor' };
  return {
    outcome: 'error',
    reason: (res.stderr || res.stdout || 'unknown').trim(),
  };
}

/**
 * `null` when nothing to resolve (no head, unreadable tip, or tips match).
 * Otherwise by ancestry, since SHA inequality cannot tell "behind" from
 * "force-pushed past": ancestor → `tip-behind-merge` candidate;
 * not-ancestor (≥1 commit ahead) → `tip-diverged-from-merge` skip;
 * error → `unverifiable` skip.
 *
 * @param {object} args
 * @returns {{ kind: 'candidate', prInfo: object, reason: string, tipSha: string, mergedSha: string } | { kind: 'skip', reason: string, prNumber: number|null, tipSha: string, mergedSha: string, detail?: string } | null}
 */
export function resolveMergedTip({
  prInfo,
  branch,
  cwd,
  remoteName,
  localExists,
  branchTipShaFn,
  ancestryFn = probeAncestry,
}) {
  const mergedSha = prInfo.headRefOid;
  if (!mergedSha) return null;
  const tipSha = branchTipShaFn({ cwd, branch, remoteName, localExists });
  if (!tipSha || tipSha === mergedSha) return null;
  const ancestry = ancestryFn({
    cwd,
    ancestorSha: tipSha,
    descendantSha: mergedSha,
  });
  if (ancestry.outcome === 'ancestor') {
    return {
      kind: 'candidate',
      prInfo,
      reason: 'tip-behind-merge',
      tipSha,
      mergedSha,
    };
  }
  const errored = ancestry.outcome === 'error';
  return {
    kind: 'skip',
    reason: errored ? 'unverifiable' : 'tip-diverged-from-merge',
    prNumber: prInfo.number ?? null,
    tipSha,
    mergedSha,
    ...(errored ? { detail: ancestry.reason } : {}),
  };
}
