/**
 * sync-from-base.js — merge `origin/<baseBranch>` into a worktree's branch
 * before the PR opens. Merge, not rebase (settled): a rebase force-pushes
 * away review state and spends the capture stamp just the same.
 *
 * Mutates only git refs/index. `changedPaths` tells the caller whether the
 * sync spent a capture stamp; `[]` on every non-mutating or failing outcome.
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
 * Refuse when the declared baseline merge driver is unregistered: git would
 * text-merge generated baselines and silently land a wrong one on `main`.
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
 * A failed probe answers `[]` so the stamp warning never cries wolf.
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
 * A conflict is aborted before returning; the caller surfaces it.
 *
 * @param {object} opts
 * @param {string} opts.cwd Branch must already be checked out.
 * @param {string} opts.baseBranch
 * @param {(tag: string, msg: string) => void} [opts.log]
 * @param {typeof defaultGitFetchWithRetry} [opts.gitFetchWithRetry]
 * @param {typeof defaultGitSpawn} [opts.gitSpawn]
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

  // Must be read before the merge.
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

  const unmerged = gitSpawn(cwd, 'diff', '--name-only', '--diff-filter=U');
  const conflictFiles = (unmerged.stdout ?? '')
    .toString()
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Always abort: a half-merged worktree blocks the next recovery.
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
