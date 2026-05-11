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
 * Remote branches are out of scope — `gh pr merge --delete-branch` handles
 * `origin/epic/<id>` and the story branches were already deleted at story-
 * close time. The existing `delete-epic-branches.js` script remains the right
 * tool for the heavy "scrap and reset" use case; this module narrows to the
 * post-merge cleanup path.
 *
 * Pure-ish — every IO side-effect is routed through injected hooks so unit
 * tests can drive the runner end-to-end without touching git or the disk.
 */

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
 * Reap every branch owned by the Epic. Best-effort — failures aggregate into
 * the result rather than throwing.
 *
 * @param {{
 *   state: object|null,
 *   cwd: string,
 *   gitSpawn: (cwd: string, ...args: string[]) => { status: number, stdout: string, stderr: string },
 *   rmSyncFn?: Function,
 *   logger?: { info?: Function, warn?: Function },
 * }} opts
 * @returns {{
 *   epicId: number|null,
 *   reaped: Array<object>,
 *   failures: Array<object>,
 *   ok: boolean,
 * }}
 */
export function reapEpicBranches(opts) {
  const { state, cwd, gitSpawn, rmSyncFn, logger } = opts;
  const { epicBranch, storyBranches } = listEpicBranchesFromState(state);
  if (!epicBranch) {
    return { epicId: null, reaped: [], failures: [], ok: true };
  }

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

  const failures = reaped.filter((r) => !r.branchDeleted);
  return {
    epicId: state?.epicId ?? null,
    reaped,
    failures,
    ok: failures.length === 0,
  };
}
