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
 * Why merge, not rebase (Story #5267 — settled, do not re-open):
 *
 *   1. Mandrel states no rebase rule anywhere. `git-conventions.md`
 *      mandates branch shapes and commit subjects and is silent on how a
 *      branch takes on base commits, so there is no convention to honour
 *      here — only a trade-off to pick.
 *   2. Story branches are pushed and reviewed across iterations of the
 *      watch + fix loop. A rebase force-pushes, discarding in-flight
 *      reviewer context and any review state pinned to the old SHAs.
 *   3. A rebase would NOT save the pre-push capture stamp people reach
 *      for it to save. The stamp is keyed on the tree, and rebasing onto
 *      a moved base changes the tree exactly as merging it does — both
 *      invalidate the stamp, so the credit argument is a wash. The real
 *      remedy is the `changedPaths` reporting below: say out loud when
 *      the sync spent the stamp, rather than change how it is spent.
 *
 * The merge commit is squashed away when the PR lands, so the cosmetic
 * cost is zero.
 *
 * Outcomes (`{ synced, kind, ... }`):
 *
 *   - `{ synced: true, kind: 'noop-already-current', changedPaths: [] }`
 *     — `origin/<base>` is already an ancestor of HEAD; nothing to do.
 *   - `{ synced: true, kind: 'fast-forward', changedPaths }` — merge
 *     fast-forwarded.
 *   - `{ synced: true, kind: 'merge-commit', changedPaths }` — non-trivial
 *     merge succeeded; a merge commit landed on the active branch.
 *
 * `changedPaths` is the tracked paths the sync brought into the branch —
 * `git diff --name-only <pre-merge HEAD> HEAD` — and is what lets a caller
 * tell a sync that spent a pre-push capture stamp from one that did not.
 * It is `[]` for every non-mutating and every failing outcome.
 *   - `{ synced: false, kind: 'fetch-failed', stderr }` — `git fetch`
 *     could not retrieve `origin/<base>`. No mutation occurred.
 *   - `{ synced: false, kind: 'conflict', conflictFiles }` — merge
 *     conflicted and was aborted; caller must surface a recoverable
 *     surface (structured comment + `agent::blocked`) and stop.
 *   - `{ synced: false, kind: 'merge-failed', stderr }` — merge exited
 *     non-zero for a reason other than a parseable conflict (rare; treat
 *     as a hard blocker on the caller's side).
 *   - `{ synced: false, kind: 'merge-driver-missing', stderr }` — the
 *     worktree's `.gitattributes` routes `baselines/*.json` through the
 *     `mandrel-baseline` merge driver and this clone has no
 *     `merge.mandrel-baseline.driver` config, so git would text-merge
 *     generated baselines. Nothing was fetched or merged (Story #5277).
 *
 * The helper does not mutate any ticket state, post comments, or write
 * to anything other than the worktree's git refs / index. Callers own
 * the recovery surface.
 */

import {
  BASELINE_MERGE_DRIVER_CONFIG_KEY,
  BASELINE_MERGE_DRIVER_REMEDY,
  probeBaselineMergeDriver,
} from '../bootstrap/baseline-merge-driver.js';
import {
  gitFetchWithRetry as defaultGitFetchWithRetry,
  gitSpawn as defaultGitSpawn,
} from '../git-utils.js';

/**
 * Refuse the sync when the baseline merge driver is declared but unregistered
 * (Story #5277). `probeBaselineMergeDriver` owns the two-part question and why
 * each half matters; this is where the answer becomes a refusal.
 *
 * Base-sync is the one place the failure is catchable before it happens: it is
 * the merge that runs unattended, immediately before the push, on exactly the
 * files a concurrent sibling Story most often also refreshed. Refusing costs
 * one operator command; proceeding costs a silently wrong baseline on `main`
 * that nothing downstream re-derives.
 *
 * @param {string} cwd
 * @param {typeof defaultGitSpawn} gitSpawn
 * @returns {{ synced: false, kind: 'merge-driver-missing', stderr: string, remedy: string }|null}
 */
function refuseWithoutMergeDriver(cwd, gitSpawn) {
  const { declared, command } = probeBaselineMergeDriver({
    projectRoot: cwd,
    runGit: (args) => gitSpawn(cwd, ...args),
  });
  if (!declared || command.length > 0) return null;
  return {
    synced: false,
    kind: 'merge-driver-missing',
    stderr:
      `.gitattributes routes baselines/*.json through the mandrel-baseline merge ` +
      `driver, but ${BASELINE_MERGE_DRIVER_CONFIG_KEY} is unset in this clone. ` +
      'Merging origin now would text-merge generated baselines, which conflicts on ' +
      'the generatedAt stamp and can splice rows neither branch scored. Register the ' +
      `driver, then re-run:\n  ${BASELINE_MERGE_DRIVER_REMEDY}\n` +
      '  (or: npm run baselines:merge-driver)',
    remedy: BASELINE_MERGE_DRIVER_REMEDY,
  };
}

/**
 * Resolve the current HEAD SHA, or `null` when git cannot answer.
 *
 * @param {typeof defaultGitSpawn} gitSpawn
 * @param {string} cwd
 * @returns {string|null}
 */
function readHead(gitSpawn, cwd) {
  const head = gitSpawn(cwd, 'rev-parse', 'HEAD');
  if (head.status !== 0) return null;
  const sha = (head.stdout ?? '').toString().trim();
  return sha.length > 0 ? sha : null;
}

/**
 * The tracked paths that differ between `fromSha` and the current HEAD.
 *
 * Returns `[]` when the pre-merge SHA could not be read or the diff itself
 * failed. That is deliberately the quiet answer: the only consumer is the
 * caller's "your capture stamp may be dead" warning, and manufacturing that
 * warning out of a failed probe would cry wolf on every sync in a repo where
 * `rev-parse` is broken — a condition the merge one line earlier would
 * already have failed on.
 *
 * @param {typeof defaultGitSpawn} gitSpawn
 * @param {string} cwd
 * @param {string|null} fromSha
 * @returns {string[]}
 */
function diffPaths(gitSpawn, cwd, fromSha) {
  if (!fromSha) return [];
  const diff = gitSpawn(cwd, 'diff', '--name-only', fromSha, 'HEAD');
  if (diff.status !== 0) return [];
  return (diff.stdout ?? '')
    .toString()
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

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
 *   | { synced: true, kind: 'noop-already-current', changedPaths: string[] }
 *   | { synced: true, kind: 'fast-forward', changedPaths: string[] }
 *   | { synced: true, kind: 'merge-commit', changedPaths: string[] }
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

  const driverGap = refuseWithoutMergeDriver(cwd, gitSpawn);
  if (driverGap) {
    log('SYNC', driverGap.stderr);
    return driverGap;
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
    return { synced: true, kind: 'noop-already-current', changedPaths: [] };
  }

  // Pin the pre-merge HEAD so a successful sync can name what it brought
  // in. Read BEFORE the merge, because afterwards the only handle on the
  // old tree is this SHA.
  const preMergeHead = readHead(gitSpawn, cwd);

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
      changedPaths: diffPaths(gitSpawn, cwd, preMergeHead),
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
