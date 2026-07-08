/* node:coverage ignore file -- MI 0 orchestration glue; reaps live worktrees + runs `git branch -D` — testing requires mocking real worktree/git state to the point of asserting only the mock structure */

/**
 * Epic-cleanup primitives — local branch + worktree reap for `/deliver`
 * Phase 8.
 *
 * Once a PR has merged (auto or operator-button), the Epic branch and every
 * Story branch is unmergeable history. This module enumerates them from the
 * `epic-run-state` checkpoint, reaps any worktree still pointing at them
 * with the Windows-lock fallback recipe, and runs `git branch -D` to drop the
 * local refs.
 *
 * Beyond the per-branch reap, the runner also:
 *   - switches the main checkout off `epic/<id>` to `baseBranch` when needed
 *     (otherwise `git branch -D epic/<id>` is refused by git);
 *   - prunes stale `<remote>/...` tracking refs left behind after the remote
 *     branches were deleted by `gh pr merge --delete-branch`;
 *   - deletes the `wt-branch` artifact left behind by `story-close.js`'s
 *     internal merge worktree when it is no longer checked out anywhere.
 *
 * Remote branches themselves are out of scope — `gh pr merge --delete-branch`
 * handles those. The "scrap and reset" use case for unmerged Epics is rare
 * enough that it is handled manually (or by ad-hoc operator instruction)
 * rather than by a dedicated script; this module narrows to the post-merge
 * cleanup path.
 *
 * Pure-ish — every IO side-effect is routed through injected hooks so unit
 * tests can drive the runner end-to-end without touching git or the disk.
 */

import { spawnSync } from 'node:child_process';
import { parseWorktreePorcelain } from '../worktree/inspector.js';
import {
  executeFastForward,
  planFastForward,
} from './git-cleanup/phases/fast-forward.js';
import { makeFfProbes } from './git-cleanup/phases/git-probes-ff.js';

const WT_SCRATCH_BRANCH = 'wt-branch';

/**
 * Probe GitHub for an OPEN, unmerged PR whose head is `epicBranch`.
 * Returns `true` when an open PR exists (→ caller MUST keep the branch).
 *
 * Hardening guard for Story #3367: an `epic/<id>` branch with an open
 * PR is the branch the PR needs — reaping it (local `git branch -D` +
 * remote prune) deletes the PR's head out from under it before the
 * merge lands. The reap path force-deletes with `git branch -D`, so
 * git's own "unmerged → refuse" safety is not in play; this probe is
 * the explicit gate. Fails CLOSED: any probe error (gh missing, network
 * failure, unparseable output) returns `true` so an indeterminate state
 * never green-lights a destructive reap.
 *
 * @param {{
 *   epicBranch: string,
 *   cwd: string,
 *   spawnFn?: typeof spawnSync,
 *   logger?: { warn?: Function },
 * }} opts
 * @returns {boolean}
 */
export function epicBranchHasOpenPr(opts) {
  const { epicBranch, cwd, spawnFn = spawnSync, logger } = opts;
  if (typeof epicBranch !== 'string' || epicBranch.length === 0) {
    return false;
  }
  let result;
  try {
    result = spawnFn(
      'gh',
      [
        'pr',
        'list',
        '--head',
        epicBranch,
        '--state',
        'open',
        '--json',
        'number,state',
        '--jq',
        'length',
      ],
      { cwd, encoding: 'utf-8', shell: false },
    );
  } catch (err) {
    // Fail closed — an indeterminate probe must keep the branch.
    logger?.warn?.(
      `[epic-cleanup] open-PR probe threw for ${epicBranch} (keeping branch): ${err?.message ?? err}`,
    );
    return true;
  }
  if (!result || result.status !== 0) {
    logger?.warn?.(
      `[epic-cleanup] open-PR probe failed for ${epicBranch} (status=${result?.status}; keeping branch): ${(result?.stderr ?? '').trim()}`,
    );
    return true;
  }
  const count = Number.parseInt(String(result.stdout ?? '').trim(), 10);
  if (!Number.isInteger(count)) {
    // Unparseable output — fail closed.
    logger?.warn?.(
      `[epic-cleanup] open-PR probe returned unparseable count for ${epicBranch} (keeping branch): ${String(result.stdout ?? '').trim()}`,
    );
    return true;
  }
  return count > 0;
}

/**
 * Build the list of branches owned by the Epic from the checkpoint.
 *
 * Story #4155 — the ready-set runtime records a flat per-Story status map
 * (`stories: { [storyId]: { status, ... } }`) on the checkpoint instead of a
 * per-wave `waves[]` history. The owned Story branches are the keys of that
 * map.
 *
 * @param {{ epicId: number, stories?: Record<string, object> } | null} state
 * @returns {{ epicBranch: string, storyBranches: string[] }}
 */
export function listEpicBranchesFromState(state) {
  const epicId = state?.epicId;
  if (!Number.isInteger(epicId) || epicId <= 0) {
    return { epicBranch: null, storyBranches: [] };
  }
  const storyMap =
    state?.stories && typeof state.stories === 'object' ? state.stories : {};
  const storyIds = new Set();
  for (const key of Object.keys(storyMap)) {
    const id = Number(key);
    if (Number.isInteger(id) && id > 0) storyIds.add(id);
  }
  return {
    epicBranch: `epic/${epicId}`,
    storyBranches: [...storyIds]
      .sort((a, b) => a - b)
      .map((id) => `story-${id}`),
  };
}

/**
 * Find the worktree path (if any) for `branch`. Pure given the worktree-list
 * accessor. Exported for tests.
 *
 * @param {string} branch
 * @param {Array<{ path: string, branch: string|null }>} worktrees
 * @returns {string|null}
 */
export function findWorktreePathForBranch(branch, worktrees) {
  for (const wt of worktrees) {
    if (wt && wt.branch === branch) return wt.path;
  }
  return null;
}

/**
 * Classify a `git branch -D <branch>` result. Pure — no IO. Exported as the
 * clean unit-test seam for the not-found rule (this module carries a
 * `node:coverage ignore file` header, so the git-side glue is not directly
 * covered).
 *
 * Story #4393 — on the `/deliver` post-merge reap path a branch is routinely
 * *already gone* (a prior sweep, a re-run, or GitHub's `--delete-branch`
 * already dropped it). `git branch -D` then exits non-zero with a "not found"
 * stderr. That is an **already-reaped success**, not a reap failure: counting
 * it as a failure forces `reapEpicBranches().ok` false, which makes
 * BranchCleaner classify `failed`, which flips the merged Epic to
 * `agent::blocked` and reopens it. Only a not-found stderr is absorbed as
 * success; every other non-zero exit stays a genuine failure.
 *
 * @param {{ status: number, stderr?: string }} branchDel
 * @returns {{ branchDeleted: boolean, alreadyAbsent: boolean, stderr?: string }}
 */
export function classifyBranchDeletion(branchDel) {
  if (branchDel?.status === 0) {
    return { branchDeleted: true, alreadyAbsent: false };
  }
  const stderr = (branchDel?.stderr ?? '').trim();
  // git's own message for a missing ref: "error: branch 'foo' not found."
  if (/\bnot found\b/i.test(stderr)) {
    return { branchDeleted: true, alreadyAbsent: true };
  }
  return {
    branchDeleted: false,
    alreadyAbsent: false,
    ...(stderr ? { stderr } : {}),
  };
}

/**
 * Reap a single branch. Best-effort worktree remove → fallback to `--force`
 * → fallback to filesystem rm → `git worktree prune` → `git branch -D`.
 *
 * @param {{
 *   branch: string,
 *   cwd: string,
 *   worktreePath: string|null,
 *   gitSpawn: (cwd: string, ...args: string[]) => { status: number, stdout: string, stderr: string },
 *   rmSyncFn?: (path: string, opts: object) => void,
 *   logger?: { info?: Function, warn?: Function },
 * }} opts
 * @returns {{ branch: string, worktreeReaped: boolean, branchDeleted: boolean, alreadyAbsent: boolean, method: string, stderr?: string }}
 */
export function reapBranch(opts) {
  const { branch, cwd, worktreePath, gitSpawn, rmSyncFn, logger } = opts;
  let worktreeReaped = !worktreePath;
  let method = worktreePath ? null : 'no-worktree';

  if (worktreePath) {
    // First attempt: standard remove.
    let res = gitSpawn(cwd, 'worktree', 'remove', worktreePath);
    if (res.status === 0) {
      worktreeReaped = true;
      method = 'worktree-remove';
    } else {
      // Second: force.
      res = gitSpawn(cwd, 'worktree', 'remove', '--force', worktreePath);
      if (res.status === 0) {
        worktreeReaped = true;
        method = 'worktree-remove-force';
      } else if (typeof rmSyncFn === 'function') {
        // Third: fs rm + prune (Windows lock fallback from memory
        // partial-reap recovery incident).
        try {
          rmSyncFn(worktreePath, { recursive: true, force: true });
          worktreeReaped = true;
          method = 'fs-rm-fallback';
        } catch (err) {
          logger?.warn?.(
            `[epic-cleanup] fs-rm fallback failed for ${worktreePath}: ${err?.message ?? err}`,
          );
        }
      }
    }
    // Always prune after any remove attempt.
    gitSpawn(cwd, 'worktree', 'prune');
  }

  // Drop the local branch. An already-absent branch (git → "not found") is
  // already reaped — classifyBranchDeletion absorbs it as success so a benign
  // missing ref never counts as a reap failure (Story #4393).
  const branchDel = gitSpawn(cwd, 'branch', '-D', branch);
  const { branchDeleted, alreadyAbsent, stderr } =
    classifyBranchDeletion(branchDel);

  return {
    branch,
    worktreeReaped,
    branchDeleted,
    alreadyAbsent,
    method: method ?? 'unknown',
    ...(stderr ? { stderr } : {}),
  };
}

/**
 * Read the branch currently checked out at `cwd` (the main checkout).
 * Returns `null` for a detached HEAD or when `git symbolic-ref` fails.
 *
 * @param {{ cwd: string, gitSpawn: Function }} opts
 * @returns {string|null}
 */
export function getCheckedOutBranch({ cwd, gitSpawn }) {
  const res = gitSpawn(cwd, 'symbolic-ref', '--short', '--quiet', 'HEAD');
  if (res.status !== 0) return null;
  const name = (res.stdout ?? '').trim();
  return name === '' ? null : name;
}

/**
 * If the main checkout sits on `fromBranch`, switch it to `toBranch` so the
 * caller can subsequently delete `fromBranch`. No-op when the checkout is
 * already on a different branch.
 *
 * @param {{
 *   fromBranch: string,
 *   toBranch: string,
 *   cwd: string,
 *   gitSpawn: Function,
 *   logger?: { info?: Function, warn?: Function },
 * }} opts
 * @returns {{ switched: boolean, from: string|null, to: string|null, stderr?: string }}
 */
export function switchCheckoutOffBranch(opts) {
  const { fromBranch, toBranch, cwd, gitSpawn, logger } = opts;
  if (!fromBranch || !toBranch) {
    return { switched: false, from: null, to: null };
  }
  const current = getCheckedOutBranch({ cwd, gitSpawn });
  if (current !== fromBranch) {
    return { switched: false, from: current, to: null };
  }
  const res = gitSpawn(cwd, 'checkout', toBranch);
  if (res.status === 0) {
    logger?.info?.(
      `[epic-cleanup] switched main checkout ${fromBranch} → ${toBranch}`,
    );
    return { switched: true, from: fromBranch, to: toBranch };
  }
  const stderr = (res.stderr ?? '').trim();
  logger?.warn?.(
    `[epic-cleanup] could not switch main checkout off ${fromBranch}: ${stderr}`,
  );
  return { switched: false, from: fromBranch, to: toBranch, stderr };
}

/**
 * Prune stale remote-tracking refs. After `gh pr merge --delete-branch`
 * removes the remote branches, the local `<remote>/<branch>` refs linger
 * until an explicit prune. This is equivalent to `git fetch --prune` without
 * the network round-trip.
 *
 * @param {{
 *   cwd: string,
 *   gitSpawn: Function,
 *   remote?: string,
 * }} opts
 * @returns {{ pruned: string[], stderr?: string }}
 */
export function pruneRemoteTrackingRefs(opts) {
  const { cwd, gitSpawn, remote = 'origin' } = opts;
  const res = gitSpawn(cwd, 'remote', 'prune', remote);
  if (res.status !== 0) {
    return { pruned: [], stderr: (res.stderr ?? '').trim() };
  }
  // Output shape: "Pruning <remote>\nURL: ...\n * [pruned] <remote>/<branch>".
  const pruned = [];
  for (const line of (res.stdout ?? '').split(/\r?\n/)) {
    const match = line.match(/\[pruned\]\s+(\S+)/);
    if (match) pruned.push(match[1]);
  }
  return { pruned };
}

/**
 * Delete the `wt-branch` scratch ref left behind by `story-close.js`'s
 * internal merge worktree. No-op when the ref doesn't exist locally or when
 * a worktree still points at it (the latter would block `git branch -D`).
 *
 * @param {{
 *   cwd: string,
 *   gitSpawn: Function,
 *   worktrees?: Array<{ branch: string|null }>,
 *   logger?: { warn?: Function },
 * }} opts
 * @returns {{ deleted: boolean, present: boolean, reason?: string, stderr?: string }}
 */
export function deleteWtBranchIfPresent(opts) {
  const { cwd, gitSpawn, worktrees = [], logger } = opts;
  const verify = gitSpawn(
    cwd,
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${WT_SCRATCH_BRANCH}`,
  );
  if (verify.status !== 0) {
    return { deleted: false, present: false };
  }
  if (findWorktreePathForBranch(WT_SCRATCH_BRANCH, worktrees) !== null) {
    return { deleted: false, present: true, reason: 'checked-out' };
  }
  const del = gitSpawn(cwd, 'branch', '-D', WT_SCRATCH_BRANCH);
  if (del.status === 0) return { deleted: true, present: true };
  const stderr = (del.stderr ?? '').trim();
  logger?.warn?.(
    `[epic-cleanup] could not delete ${WT_SCRATCH_BRANCH}: ${stderr}`,
  );
  return { deleted: false, present: true, stderr };
}

/**
 * Fast-forward the base branch to its remote after a confirmed merge, so a
 * post-`/deliver` local checkout converges to `origin/<baseBranch>` without a
 * manual `git pull`. Reuses `planFastForward` + `executeFastForward` from the
 * git-cleanup phase library (the single source of the FF state machine),
 * feeding them probes bound to the injected `gitSpawn`.
 *
 * @param {{
 *   cwd: string,
 *   baseBranch?: string,
 *   remoteName?: string,
 *   gitSpawn: (cwd: string, ...args: string[]) => { status: number, stdout: string, stderr: string },
 *   logger?: { info?: Function, warn?: Function },
 * }} opts
 * @returns {{ ok: boolean, applied: boolean, skipped: boolean, reason?: string, behind?: number, stderr?: string }}
 */
export function fastForwardBaseBranch(opts) {
  const {
    cwd,
    baseBranch = 'main',
    remoteName = 'origin',
    gitSpawn,
    logger,
  } = opts;
  const probe = makeFfProbes(gitSpawn);
  const plan = planFastForward({
    cwd,
    baseBranch,
    remoteName,
    isCleanFn: probe.isClean,
    currentBranchFn: probe.currentBranch,
    fetchFn: probe.fetch,
    canFastForwardFn: probe.canFastForward,
  });
  return executeFastForward({
    cwd,
    baseBranch,
    remoteName,
    plan,
    checkoutFn: probe.checkout,
    mergeFn: probe.merge,
    ...(logger ? { logger } : {}),
  });
}

/**
 * Reap every branch owned by the Epic. Best-effort — failures aggregate into
 * the result rather than throwing.
 *
 * @param {{
 *   state: object|null,
 *   cwd: string,
 *   gitSpawn: (cwd: string, ...args: string[]) => { status: number, stdout: string, stderr: string },
 *   rmSyncFn?: Function,
 *   baseBranch?: string,
 *   remote?: string,
 *   spawnFn?: Function,
 *   epicBranchHasOpenPrFn?: typeof epicBranchHasOpenPr,
 *   logger?: { info?: Function, warn?: Function },
 * }} opts
 * @returns {{
 *   epicId: number|null,
 *   reaped: Array<object>,
 *   failures: Array<object>,
 *   switched: { switched: boolean, from: string|null, to: string|null, stderr?: string } | null,
 *   pruned: { pruned: string[], stderr?: string } | null,
 *   wtBranch: { deleted: boolean, present: boolean, reason?: string, stderr?: string } | null,
 *   fastForward: { ok: boolean, applied: boolean, skipped: boolean, reason?: string, behind?: number, stderr?: string } | null,
 *   epicBranchKept: boolean,
 *   ok: boolean,
 * }}
 */
export function reapEpicBranches(opts) {
  const {
    state,
    cwd,
    gitSpawn,
    rmSyncFn,
    baseBranch = 'main',
    remote = 'origin',
    spawnFn,
    epicBranchHasOpenPrFn = epicBranchHasOpenPr,
    logger,
  } = opts;
  const { epicBranch, storyBranches } = listEpicBranchesFromState(state);
  if (!epicBranch) {
    return {
      epicId: null,
      reaped: [],
      failures: [],
      switched: null,
      pruned: null,
      wtBranch: null,
      fastForward: null,
      epicBranchKept: false,
      ok: true,
    };
  }

  // Story #3367 hardening — never reap an epic branch whose PR is still
  // open and unmerged. Reaping it (local `git branch -D` + remote prune)
  // would delete the PR's head out from under it before the merge lands.
  // The guard fails closed: an indeterminate probe keeps the branch. The
  // story branches are still reaped (their history is captured in the
  // epic branch's merge commits and the open PR), but the epic branch,
  // the checkout-off-branch switch, and the remote prune are all skipped
  // so neither the local ref nor `origin/epic/<id>` is destroyed.
  const epicHasOpenPr = epicBranchHasOpenPrFn({
    epicBranch,
    cwd,
    spawnFn,
    logger,
  });
  if (epicHasOpenPr) {
    logger?.warn?.(
      `[epic-cleanup] ${epicBranch} has an open, unmerged PR — keeping the epic branch + its remote ref; reaping story branches only.`,
    );
  }

  // If the main checkout is still on epic/<id>, switch off first so the
  // subsequent `git branch -D` isn't refused by "used by worktree". When
  // the epic branch is being kept (open PR) we leave the checkout where
  // it is — there is no epic-branch delete to unblock.
  const switched = epicHasOpenPr
    ? { switched: false, from: null, to: null }
    : switchCheckoutOffBranch({
        fromBranch: epicBranch,
        toBranch: baseBranch,
        cwd,
        gitSpawn,
        logger,
      });

  const wtList = gitSpawn(cwd, 'worktree', 'list', '--porcelain');
  const worktrees =
    wtList.status === 0 ? parseWorktreePorcelain(wtList.stdout ?? '') : [];

  // When the epic branch has an open PR, drop it from the reap list so
  // neither the local ref nor (via the remote prune below) its tracking
  // ref is destroyed.
  const branchesToReap = epicHasOpenPr
    ? [...storyBranches]
    : [...storyBranches, epicBranch];

  const reaped = [];
  for (const branch of branchesToReap) {
    const wtPath = findWorktreePathForBranch(branch, worktrees);
    const result = reapBranch({
      branch,
      cwd,
      worktreePath: wtPath,
      gitSpawn,
      rmSyncFn,
      logger,
    });
    reaped.push(result);
    logger?.info?.(
      `[epic-cleanup] ${branch} → wt=${result.method} branch=${result.branchDeleted ? 'deleted' : 'kept'}`,
    );
  }

  // Skip the remote prune entirely when the epic branch is kept: a prune
  // would drop the `origin/epic/<id>` tracking ref the open PR depends on.
  const pruned = epicHasOpenPr
    ? { pruned: [] }
    : pruneRemoteTrackingRefs({ cwd, gitSpawn, remote });
  if (pruned.pruned.length > 0) {
    logger?.info?.(
      `[epic-cleanup] pruned ${pruned.pruned.length} stale tracking ref(s): ${pruned.pruned.join(', ')}`,
    );
  }

  const wtBranch = deleteWtBranchIfPresent({
    cwd,
    gitSpawn,
    worktrees,
    logger,
  });
  if (wtBranch.deleted) {
    logger?.info?.(`[epic-cleanup] deleted stale ${WT_SCRATCH_BRANCH} ref`);
  }

  // After a confirmed merge (epic branch NOT kept), fast-forward the base
  // branch so the local checkout converges to `origin/<baseBranch>` with no
  // manual `git pull`. When the epic branch is kept (open PR), the merge is
  // not confirmed, so the FF is skipped with an explicit reason rather than
  // moving `main` under an in-flight PR.
  const fastForward = epicHasOpenPr
    ? { ok: true, applied: false, skipped: true, reason: 'epic-branch-kept' }
    : fastForwardBaseBranch({
        cwd,
        baseBranch,
        remoteName: remote,
        gitSpawn,
        logger,
      });
  if (fastForward.applied) {
    logger?.info?.(
      `[epic-cleanup] fast-forwarded ${baseBranch} by ${fastForward.behind} commit(s) to ${remote}/${baseBranch}`,
    );
  }

  const failures = reaped.filter((r) => !r.branchDeleted);
  return {
    epicId: state?.epicId ?? null,
    reaped,
    failures,
    switched,
    pruned,
    wtBranch,
    fastForward,
    epicBranchKept: epicHasOpenPr,
    ok: failures.length === 0,
  };
}

/**
 * Does a local branch head ref exist? Thin `git rev-parse --verify` wrapper
 * exported for the resume-detect path (and its tests).
 *
 * @param {{ cwd: string, gitSpawn: Function, branch: string }} opts
 * @returns {boolean}
 */
export function localRefExists({ cwd, gitSpawn, branch }) {
  const res = gitSpawn(
    cwd,
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  );
  return res.status === 0;
}

/**
 * Probe whether the Epic branch's PR is MERGED and, if so, its URL (needed
 * for the `epic.merge.armed` payload). Fails CLOSED to
 * `{ merged: false, prUrl: null }` on any probe error — an indeterminate
 * probe must never auto-arm a destructive reap.
 *
 * @param {{
 *   epicBranch: string,
 *   cwd: string,
 *   spawnFn?: typeof spawnSync,
 *   logger?: { warn?: Function },
 * }} opts
 * @returns {{ merged: boolean, prUrl: string|null }}
 */
export function epicPrMergeState(opts) {
  const { epicBranch, cwd, spawnFn = spawnSync, logger } = opts;
  if (typeof epicBranch !== 'string' || epicBranch.length === 0) {
    return { merged: false, prUrl: null };
  }
  let result;
  try {
    result = spawnFn(
      'gh',
      [
        'pr',
        'list',
        '--head',
        epicBranch,
        '--state',
        'merged',
        '--json',
        'number,url,mergedAt',
        '--limit',
        '1',
      ],
      { cwd, encoding: 'utf-8', shell: false },
    );
  } catch (err) {
    logger?.warn?.(
      `[epic-cleanup] merged-PR probe threw for ${epicBranch} (treating as unmerged): ${err?.message ?? err}`,
    );
    return { merged: false, prUrl: null };
  }
  if (!result || result.status !== 0) {
    logger?.warn?.(
      `[epic-cleanup] merged-PR probe failed for ${epicBranch} (status=${result?.status}): ${(result?.stderr ?? '').trim()}`,
    );
    return { merged: false, prUrl: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout ?? '').trim() || '[]');
  } catch {
    return { merged: false, prUrl: null };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { merged: false, prUrl: null };
  }
  const row = parsed[0];
  const prUrl =
    typeof row?.url === 'string' && row.url.length > 0 ? row.url : null;
  // A merged-state row with no usable URL cannot arm (the schema requires a
  // `prUrl`), so treat it as not-armable.
  return { merged: prUrl !== null, prUrl };
}

/**
 * Detect a merged-but-uncleaned Epic: the PR merged but one or more local
 * `epic/<id>` / `story-<id>` refs still linger. This is the signal `/deliver`
 * idempotent resume uses to auto-fire `epic.merge.armed` so Phase 9 reaps
 * without a manual command. Pure given its injected ports.
 *
 * @param {{
 *   state: object|null,
 *   cwd: string,
 *   gitSpawn: Function,
 *   spawnFn?: Function,
 *   prMergeStateFn?: typeof epicPrMergeState,
 *   logger?: { warn?: Function, info?: Function },
 * }} opts
 * @returns {{
 *   epicId: number|null,
 *   epicBranch: string|null,
 *   presentRefs: string[],
 *   localRefsPresent: boolean,
 *   merged: boolean,
 *   prUrl: string|null,
 *   shouldArm: boolean,
 *   reason: string,
 * }}
 */
export function detectMergedUncleanedEpic(opts) {
  const {
    state,
    cwd,
    gitSpawn,
    spawnFn,
    prMergeStateFn = epicPrMergeState,
    logger,
  } = opts;
  const { epicBranch, storyBranches } = listEpicBranchesFromState(state);
  if (!epicBranch) {
    return {
      epicId: null,
      epicBranch: null,
      presentRefs: [],
      localRefsPresent: false,
      merged: false,
      prUrl: null,
      shouldArm: false,
      reason: 'no-state',
    };
  }
  const presentRefs = [epicBranch, ...storyBranches].filter((branch) =>
    localRefExists({ cwd, gitSpawn, branch }),
  );
  if (presentRefs.length === 0) {
    // Already clean — nothing to arm. This is the idempotent no-op that
    // makes re-running `/deliver` on an already-reaped Epic safe.
    return {
      epicId: state.epicId,
      epicBranch,
      presentRefs,
      localRefsPresent: false,
      merged: false,
      prUrl: null,
      shouldArm: false,
      reason: 'no-local-refs',
    };
  }
  const { merged, prUrl } = prMergeStateFn({
    epicBranch,
    cwd,
    spawnFn,
    logger,
  });
  const shouldArm = merged && prUrl !== null;
  return {
    epicId: state.epicId,
    epicBranch,
    presentRefs,
    localRefsPresent: true,
    merged,
    prUrl,
    shouldArm,
    reason: shouldArm ? 'merged-uncleaned' : 'not-merged',
  };
}

/**
 * `/deliver` idempotent-resume auto-arm: detect a merged-but-uncleaned Epic
 * and, when found, fire `epic.merge.armed` on the injected lifecycle `bus` so
 * the Cleaner → BranchCleaner chain reaps Phase 9 without an operator command.
 * A no-op (and never throws on a clean/unmerged Epic) so re-running resume is
 * safe.
 *
 * @param {{
 *   state: object|null,
 *   cwd: string,
 *   gitSpawn: Function,
 *   spawnFn?: Function,
 *   bus: { emit: (event: string, payload: object) => Promise<unknown> },
 *   detectFn?: typeof detectMergedUncleanedEpic,
 *   logger?: { warn?: Function, info?: Function },
 * }} opts
 * @returns {Promise<{ armed: boolean, reason: string, prUrl: string|null, detection: object }>}
 */
export async function armCleanupIfMerged(opts) {
  const { state, cwd, gitSpawn, spawnFn, bus, detectFn, logger } = opts;
  if (!bus || typeof bus.emit !== 'function') {
    throw new TypeError('armCleanupIfMerged requires a bus exposing emit()');
  }
  const detect = detectFn ?? detectMergedUncleanedEpic;
  const detection = detect({ state, cwd, gitSpawn, spawnFn, logger });
  if (!detection.shouldArm) {
    return {
      armed: false,
      reason: detection.reason,
      prUrl: detection.prUrl,
      detection,
    };
  }
  const payload = { prUrl: detection.prUrl };
  if (Number.isInteger(detection.epicId) && detection.epicId > 0) {
    payload.epicId = detection.epicId;
  }
  await bus.emit('epic.merge.armed', payload);
  logger?.info?.(
    `[epic-cleanup] resume auto-arm: fired epic.merge.armed for ${detection.epicBranch} (${detection.prUrl})`,
  );
  return {
    armed: true,
    reason: 'merged-uncleaned',
    prUrl: detection.prUrl,
    detection,
  };
}
