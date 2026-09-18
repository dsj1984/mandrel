/**
 * git-branch-lifecycle.js — branch existence and seed/checkout helpers;
 * names are validated before they reach git.
 */

import { assertBranchSafe } from './branch-name-guard.js';
import { gitPullWithRetry, gitSpawn, gitSync } from './git-utils.js';

/**
 * @param {string} cwd
 * @returns {string|null} null in detached HEAD state
 */
export function currentBranch(cwd) {
  const result = gitSpawn(cwd, 'branch', '--show-current');
  if (result.status !== 0 || result.stdout.length === 0) return null;
  return result.stdout;
}

/**
 * @param {string} branch
 * @param {string} cwd
 * @returns {boolean}
 */
export function branchExistsLocally(branch, cwd) {
  assertBranchSafe(branch);
  return (
    gitSpawn(cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)
      .status === 0
  );
}

/**
 * Network call; prefer `branchExistsViaTrackingRef` after a fetch.
 *
 * @param {string} branch
 * @param {string} cwd
 * @returns {boolean}
 */
export function branchExistsRemotely(branch, cwd) {
  assertBranchSafe(branch);
  const result = gitSpawn(cwd, 'ls-remote', '--heads', 'origin', branch);
  return result.status === 0 && result.stdout.length > 0;
}

/**
 * Local-only; authoritative once `git fetch origin` has run.
 *
 * @param {string} branch
 * @param {string} cwd
 * @returns {boolean}
 */
export function branchExistsViaTrackingRef(branch, cwd) {
  assertBranchSafe(branch);
  return (
    gitSpawn(
      cwd,
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/remotes/origin/${branch}`,
    ).status === 0
  );
}

/**
 * On `local`, do not `git branch` (it throws on an existing ref) or fetch.
 *
 * @param {{ localHas: boolean, remoteHas: boolean }} presence
 * @returns {'local'|'fetch'|'create'}
 */
export function classifyBranchSeed({ localHas, remoteHas }) {
  if (localHas) return 'local';
  if (remoteHas) return 'fetch';
  return 'create';
}

/**
 * Git seams default to the real implementation bound to `cwd`.
 *
 * @param {object} opts
 * @param {string} opts.storyBranch
 * @param {string} opts.baseRef
 * @param {string} [opts.cwd]
 * @param {boolean} [opts.swallowCreateRace=false] "already exists" = reuse.
 * @param {(args: string[]) => { status: number, stdout?: string, stderr?: string }} [opts.spawn]
 * @param {(branch: string) => boolean} [opts.existsLocally]
 * @param {(branch: string) => boolean} [opts.existsRemotely]
 * @param {(level: string, message: string) => void} [opts.progress]
 * @param {object} opts.messages
 * @param {(b: string) => string} opts.messages.reuse
 * @param {(b: string) => string} opts.messages.fetch
 * @param {(b: string, ref: string) => string} opts.messages.create
 * @param {(b: string) => string} [opts.messages.createRace]
 * @param {(b: string, ref: string, stderr: string) => string} opts.messages.createError
 * @param {(b: string, stderr: string) => string} [opts.messages.fetchError]
 *   When absent, the fetch exit status is not inspected.
 */
export function seedStoryBranchRef({
  storyBranch,
  baseRef,
  cwd,
  swallowCreateRace = false,
  spawn = (args) => gitSpawn(cwd, ...args),
  existsLocally = (branch) => branchExistsLocally(branch, cwd),
  existsRemotely = (branch) => branchExistsViaTrackingRef(branch, cwd),
  progress = () => {},
  messages,
}) {
  const action = classifyBranchSeed({
    localHas: existsLocally(storyBranch),
    remoteHas: existsRemotely(storyBranch),
  });

  if (action === 'local') {
    progress('GIT', messages.reuse(storyBranch));
    return;
  }

  if (action === 'fetch') {
    progress('GIT', messages.fetch(storyBranch));
    const r = spawn(['fetch', 'origin', `${storyBranch}:${storyBranch}`]);
    if (messages.fetchError && r.status !== 0) {
      throw new Error(
        messages.fetchError(storyBranch, r.stderr || '(no stderr)'),
      );
    }
    return;
  }

  progress('GIT', messages.create(storyBranch, baseRef));
  const r = spawn(['branch', storyBranch, baseRef]);
  if (r.status !== 0) {
    const stderr = r.stderr || r.stdout || '';
    if (swallowCreateRace && /already exists/i.test(stderr)) {
      progress('GIT', messages.createRace(storyBranch));
      return;
    }
    throw new Error(messages.createError(storyBranch, baseRef, stderr));
  }
}

/**
 * Check out a Story branch, creating it from `epicBranch` when absent.
 * Non-destructive: an existing branch is plain-checked-out, never `-B`-reset.
 *
 * @param {string} storyBranch
 * @param {string} epicBranch
 * @param {string} cwd
 * @param {{ progress?: (phase: string, message: string) => void }} [opts]
 */
export async function checkoutStoryBranch(
  storyBranch,
  epicBranch,
  cwd,
  opts = {},
) {
  assertBranchSafe(storyBranch, epicBranch);
  const progress = opts.progress ?? (() => {});

  if (currentBranch(cwd) === storyBranch) {
    const remote = branchExistsRemotely(storyBranch, cwd);
    if (remote) {
      progress('GIT', `Already on ${storyBranch}. Syncing with remote.`);
      await gitPullWithRetry(cwd, 'origin', storyBranch);
    } else {
      progress('GIT', `Already on ${storyBranch}. No remote to sync.`);
    }
    return;
  }

  const local = branchExistsLocally(storyBranch, cwd);
  const remote = branchExistsRemotely(storyBranch, cwd);

  if (local || remote) {
    progress(
      'GIT',
      `Story branch already exists (local=${local}, remote=${remote}). Checking out non-destructively: ${storyBranch}`,
    );
    if (local) {
      gitSync(cwd, 'checkout', storyBranch);
      if (remote) {
        await gitPullWithRetry(cwd, 'origin', storyBranch);
      }
    } else {
      gitSync(cwd, 'checkout', '-b', storyBranch, `origin/${storyBranch}`);
    }
    return;
  }

  progress('GIT', `Creating Story branch: ${storyBranch} (from ${epicBranch})`);
  gitSync(cwd, 'checkout', '-b', storyBranch, epicBranch);
}

/**
 * Ensure a branch ref exists, creating it from `baseBranch`; HEAD is left on
 * `baseBranch`.
 *
 * @param {string} branchName
 * @param {string} baseBranch
 * @param {string} cwd
 * @param {{ log?: (message: string) => void }} [opts]
 */
export function ensureLocalBranch(branchName, baseBranch, cwd, opts = {}) {
  assertBranchSafe(branchName, baseBranch);
  const log = opts.log ?? (() => {});

  const exists =
    gitSpawn(cwd, 'rev-parse', '--verify', branchName).status === 0;
  if (exists) {
    log(`Branch already exists: ${branchName}`);
    return;
  }
  gitSync(cwd, 'checkout', '-b', branchName, baseBranch);
  gitSync(cwd, 'checkout', baseBranch);
  log(`Created branch: ${branchName} from ${baseBranch}`);
}
