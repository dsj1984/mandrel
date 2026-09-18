/**
 * Branch-reap detection signals beyond the PR probe, and the remote-only walk.
 *
 * @module lib/orchestration/git-cleanup/phases/branches-detect
 */

import { classifyLatestPr } from './git-probes.js';

/** Fields a planner verdict forwards onto its `skipped[]` entry. */
const SKIP_DETAIL_FIELDS = ['prNumber', 'tipSha', 'mergedSha', 'detail'];

export function skipEntryFromVerdict(branch, verdict) {
  const entry = { branch, reason: verdict.reason };
  for (const field of SKIP_DETAIL_FIELDS) {
    if (verdict[field] != null) entry[field] = verdict[field];
  }
  return entry;
}

/**
 * Last-resort signal: `content-merged` when merging the branch into base is a
 * no-op, else a `not-merged` skip. `rev` is what git sees; on the remote-only
 * walk it must be `<remote>/<branch>`, since the bare short name resolves to
 * no ref and would silence the signal.
 */
export function evaluateContentEquivalence({
  branch,
  rev = branch,
  baseBranch,
  cwd,
  contentEquivalentFn,
  branchLastCommitFn,
  lastCommitOpts,
  skipExtra,
}) {
  const verdict = contentEquivalentFn({ cwd, base: baseBranch, branch: rev });
  if (verdict?.supported && verdict.equivalent) {
    return { detectedBy: 'content-merged' };
  }
  return {
    skip: {
      branch,
      reason: 'not-merged',
      lastCommitAt: branchLastCommitFn(cwd, branch, lastCommitOpts),
      ...skipExtra,
    },
  };
}

/**
 * Remote-only no-PR cascade: ancestry via the `-r` merged set (the local
 * listing never contains remote names), then content-equivalence, else skip.
 * Offline: both read the local object database.
 */
function evaluateRemoteOnlyNoPr({
  branch,
  rev,
  baseBranch,
  cwd,
  mergedRemote,
  contentEquivalentFn,
  branchLastCommitFn,
  remoteName,
}) {
  if (mergedRemote.has(branch)) return { detectedBy: 'remote-git-merged' };
  return evaluateContentEquivalence({
    branch,
    rev,
    baseBranch,
    cwd,
    contentEquivalentFn,
    branchLastCommitFn,
    lastCommitOpts: { localExists: false, remoteName },
    skipExtra: { localExists: false },
  });
}

/** Total: always exactly one of `{ detectedBy, prInfo }` or `{ skip }`. */
function resolveRemoteOnlyBranch({ verdict, branch, rev, noPrArgs }) {
  if (verdict.kind === 'skip') {
    return { skip: skipEntryFromVerdict(branch, verdict) };
  }
  if (verdict.kind === 'candidate') {
    return { detectedBy: 'remote-only', prInfo: verdict.prInfo };
  }
  const out = evaluateRemoteOnlyNoPr({ ...noPrArgs, branch, rev });
  return out.skip ? out : { detectedBy: out.detectedBy, prInfo: null };
}

export function collectRemoteOnlyCandidates({
  remoteLister,
  remoteName,
  cwd,
  baseBranch,
  localSet,
  classify,
  filter,
  prProbe,
  branchTipShaFn,
  ancestryFn,
  mergedRemote,
  contentEquivalentFn,
  branchLastCommitFn,
  skipped,
}) {
  const noPrArgs = {
    baseBranch,
    cwd,
    mergedRemote,
    contentEquivalentFn,
    branchLastCommitFn,
    remoteName,
  };
  const out = [];
  for (const branch of remoteLister(cwd, remoteName)) {
    if (localSet.has(branch)) continue;
    if (classify(branch)) continue;
    if (!filter(branch)) continue;
    const verdict = classifyLatestPr({
      prInfo: prProbe(branch, cwd),
      branch,
      cwd,
      remoteName,
      localExists: false,
      branchTipShaFn,
      ancestryFn,
    });
    const resolved = resolveRemoteOnlyBranch({
      verdict,
      branch,
      rev: `${remoteName}/${branch}`,
      noPrArgs,
    });
    if (resolved.skip) {
      skipped.push(resolved.skip);
      continue;
    }
    out.push({
      branch,
      prNumber: resolved.prInfo?.number ?? null,
      mergedAt: resolved.prInfo?.mergedAt ?? null,
      hasWorktree: false,
      worktreePath: null,
      detectedBy: resolved.detectedBy,
      localExists: false,
      behindMerge: verdict.reason === 'tip-behind-merge',
    });
  }
  return out;
}
