/**
 * Epic-cleanup primitives — local branch + worktree reap for `/epic-deliver`
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
 * handles those. The existing `delete-epic-branches.js` script remains the
 * right tool for the heavy "scrap and reset" use case; this module narrows to
 * the post-merge cleanup path.
 *
 * Pure-ish — every IO side-effect is routed through injected hooks so unit
 * tests can drive the runner end-to-end without touching git or the disk.
 */

const WT_SCRATCH_BRANCH = 'wt-branch';

/**
 * Build the list of branches owned by the Epic from the checkpoint.
 *
 * @param {{ epicId: number, waves?: Array<{ stories?: Array<{ id: number }> }> } | null} state
 * @returns {{ epicBranch: string, storyBranches: string[] }}
 */
export function listEpicBranchesFromState(state) {
  const epicId = state?.epicId;
  if (!Number.isInteger(epicId) || epicId <= 0) {
    return { epicBranch: null, storyBranches: [] };
  }
  const storyIds = new Set();
  for (const wave of state.waves ?? []) {
    for (const story of wave?.stories ?? []) {
      if (story && Number.isInteger(story.id) && story.id > 0) {
        storyIds.add(story.id);
      }
    }
  }
  return {
    epicBranch: `epic/${epicId}`,
    storyBranches: [...storyIds]
      .sort((a, b) => a - b)
      .map((id) => `story-${id}`),
  };
}

/**
 * Parse `git worktree list --porcelain` output. Pure. Exported for tests.
 *
 * @param {string} raw
 * @returns {Array<{ path: string, branch: string|null }>}
 */
export function parseWorktreeList(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const entries = [];
  let current = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length).trim(), branch: null };
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      if (current) {
        current.branch = ref.replace(/^refs\/heads\//, '');
      }
    } else if (line.length === 0 && current) {
      entries.push(current);
      current = null;
    }
  }
  if (current) entries.push(current);
  return entries;
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
 * @returns {{ branch: string, worktreeReaped: boolean, branchDeleted: boolean, method: string, stderr?: string }}
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
        // `feedback_sprint_story_close_reap`).
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

  // Drop the local branch.
  const branchDel = gitSpawn(cwd, 'branch', '-D', branch);
  const branchDeleted = branchDel.status === 0;
  const stderr =
    !branchDeleted && branchDel.stderr ? branchDel.stderr.trim() : undefined;

  return {
    branch,
    worktreeReaped,
    branchDeleted,
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
 *   logger?: { info?: Function, warn?: Function },
 * }} opts
 * @returns {{
 *   epicId: number|null,
 *   reaped: Array<object>,
 *   failures: Array<object>,
 *   switched: { switched: boolean, from: string|null, to: string|null, stderr?: string } | null,
 *   pruned: { pruned: string[], stderr?: string } | null,
 *   wtBranch: { deleted: boolean, present: boolean, reason?: string, stderr?: string } | null,
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
      ok: true,
    };
  }

  // If the main checkout is still on epic/<id>, switch off first so the
  // subsequent `git branch -D` isn't refused by "used by worktree".
  const switched = switchCheckoutOffBranch({
    fromBranch: epicBranch,
    toBranch: baseBranch,
    cwd,
    gitSpawn,
    logger,
  });

  const wtList = gitSpawn(cwd, 'worktree', 'list', '--porcelain');
  const worktrees =
    wtList.status === 0 ? parseWorktreeList(wtList.stdout ?? '') : [];

  const reaped = [];
  for (const branch of [...storyBranches, epicBranch]) {
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

  const pruned = pruneRemoteTrackingRefs({ cwd, gitSpawn, remote });
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

  const failures = reaped.filter((r) => !r.branchDeleted);
  return {
    epicId: state?.epicId ?? null,
    reaped,
    failures,
    switched,
    pruned,
    wtBranch,
    ok: failures.length === 0,
  };
}
