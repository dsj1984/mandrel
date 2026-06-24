/**
 * git-branch-lifecycle.js — Shared git branch state machine helpers.
 *
 * Consolidates the "does this branch exist locally / remotely?" and
 * "ensure this branch exists and is checked out" logic that
 * `story-init.js` and `dispatch-engine.js` had each re-implemented.
 *
 * All helpers take an explicit `cwd`. Callers with worktree isolation
 * enabled pass the worktree path; single-tree callers pass `PROJECT_ROOT`.
 *
 * No helper here reads config, spawns its own logger, or knows about
 * GitHub. They are pure git-subprocess wrappers with validation on the
 * branch names they forward to git.
 */

import { assertBranchSafe } from './branch-name-guard.js';
import { gitPullWithRetry, gitSpawn, gitSync } from './git-utils.js';

/**
 * Return the current branch name, or null if in detached HEAD state.
 * @param {string} cwd
 * @returns {string|null}
 */
export function currentBranch(cwd) {
  const result = gitSpawn(cwd, 'branch', '--show-current');
  if (result.status !== 0 || result.stdout.length === 0) return null;
  return result.stdout;
}

/**
 * Return true iff the given branch exists as a local ref in `cwd`'s repo.
 *
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
 * Return true iff the given branch exists on the `origin` remote.
 *
 * Issues a network `ls-remote` call. Prefer `branchExistsViaTrackingRef`
 * after a `git fetch` has already populated the remote-tracking refs.
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
 * Return true iff the given branch exists on `origin` according to the
 * local remote-tracking ref (`refs/remotes/origin/<branch>`).
 *
 * This is a purely-local check (no network) that is authoritative whenever
 * a `git fetch origin` has already been run — e.g. inside `bootstrapWorktree`
 * and `bootstrapBranch` which always call `cachedGitFetch` first. Use this
 * instead of `branchExistsRemotely` in those paths to avoid a redundant
 * network round-trip.
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
 * Pure: classify how a `story-<id>` branch should be seeded from the (local,
 * remote) ref-presence matrix. This is the single source of truth shared by
 * both story-init paths (Story #3513):
 *   - `single-story-init.js#decideStoryBranchSeed` (standalone path)
 *   - `story-init/branch-initializer.js#planStoryBranchSeed` (Epic path)
 *
 * Both call sites previously re-implemented the same `local → no-op, remote →
 * fetch, else create` decision tree; they now delegate here so the branching
 * logic lives in exactly one place. The two callers keep their own keyword for
 * the "local ref already exists" outcome (`reuse` vs `none`) — synonyms for
 * "do not re-create / do not re-seed" preserved for their existing public/test
 * contracts — so this classifier returns the neutral `'local'` keyword and
 * each caller maps it onto its own vocabulary.
 *
 * @param {{ localHas: boolean, remoteHas: boolean }} presence
 * @returns {'local'|'fetch'|'create'}
 *   - `local`  — a local ref already exists; the caller must not run
 *                `git branch` (which throws on the existing ref) and must not
 *                fetch.
 *   - `fetch`  — only the remote ref exists; materialise the local ref.
 *   - `create` — neither exists; branch from the base/Epic branch.
 */
export function classifyBranchSeed({ localHas, remoteHas }) {
  if (localHas) return 'local';
  if (remoteHas) return 'fetch';
  return 'create';
}

/**
 * Single-home for the story-branch seed-action *switch shell* that
 * `single-story-init.js#seedStoryBranch` (standalone path) and
 * `story-init/branch-initializer.js#ensureStoryBranchSeed` (Epic path) had
 * each re-implemented (Story #4255). Both already delegated the (local,
 * remote) decision to `classifyBranchSeed`; only the act-on-the-decision
 * shell (reuse / fetch / create) was duplicated, and that shell was the
 * drift surface for the seed-decision contract.
 *
 * The two callers differ in exactly two behavioural axes, both of which are
 * parameters here — no other conditional branching is introduced:
 *   - **`baseRef`** — the ref to branch from on `create` (`main` for the
 *     standalone path, the Epic branch for the Epic path).
 *   - **`swallowCreateRace`** — when `true`, a `git branch` that exits
 *     non-zero with an "already exists" stderr is treated as reuse rather
 *     than a fatal error (closes the probe→create race the Epic path runs
 *     under concurrent wave dispatch). When `false`, any create failure
 *     throws (the standalone path has no concurrent creator to race).
 *
 * The asymmetric surrounding wrappers (merged-sweep, fast-forward,
 * donor-prime, workspace-verify, phase-timer) are deliberately NOT folded
 * in — they stay in their respective callers.
 *
 * Caller-specific log lines and error text are passed in as the `messages`
 * data bag so behaviour stays byte-identical to the pre-extraction switches.
 * The git seams (`spawn`, `existsLocally`, `existsRemotely`) are injected so
 * each caller can bind its own cwd (and tests can mock them).
 *
 * @param {object} opts
 * @param {string} opts.storyBranch
 * @param {string} opts.baseRef            Ref to branch from on `create`.
 * @param {boolean} [opts.swallowCreateRace=false]
 * @param {(args: string[]) => { status: number, stdout?: string, stderr?: string }} opts.spawn
 * @param {(branch: string) => boolean} opts.existsLocally
 * @param {(branch: string) => boolean} opts.existsRemotely
 * @param {(level: string, message: string) => void} [opts.progress]
 * @param {object} opts.messages
 * @param {(b: string) => string} opts.messages.reuse
 * @param {(b: string) => string} opts.messages.fetch
 * @param {(b: string, ref: string) => string} opts.messages.create
 * @param {(b: string) => string} [opts.messages.createRace]  Used when `swallowCreateRace`.
 * @param {(b: string, ref: string, stderr: string) => string} opts.messages.createError
 * @param {(b: string, stderr: string) => string} [opts.messages.fetchError]
 *   When provided, a non-zero `fetch` exit throws with this message; when
 *   omitted, the fetch exit status is not inspected.
 */
export function seedStoryBranchRef({
  storyBranch,
  baseRef,
  swallowCreateRace = false,
  spawn,
  existsLocally,
  existsRemotely,
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

  // action === 'create'
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
 * Ensure an Epic branch exists and is published to `origin`. Handles all
 * four states of the (local, remote) matrix.
 *
 * @param {string} epicBranch
 * @param {string} baseBranch
 * @param {string} cwd
 * @param {{ progress?: (phase: string, message: string) => void }} [opts]
 */
export async function ensureEpicBranch(epicBranch, baseBranch, cwd, opts = {}) {
  assertBranchSafe(epicBranch, baseBranch);
  const progress = opts.progress ?? (() => {});

  // Short-circuit: if we're already on the epic branch, just sync with remote.
  // This avoids redundant checkout calls and prevents the edge case where
  // branchExistsLocally returns false while we're on the branch (detached HEAD,
  // worktree race), which would route into the create path and fail on -b.
  const onBranch = currentBranch(cwd);
  if (onBranch === epicBranch) {
    const remote = branchExistsRemotely(epicBranch, cwd);
    if (remote) {
      progress('GIT', `Already on ${epicBranch}. Syncing with remote.`);
      await gitPullWithRetry(cwd, 'origin', epicBranch);
    } else {
      progress('GIT', `Already on ${epicBranch}. Publishing to remote.`);
      gitSync(cwd, 'push', '--no-verify', '-u', 'origin', epicBranch);
    }
    return;
  }

  const local = branchExistsLocally(epicBranch, cwd);
  const remote = branchExistsRemotely(epicBranch, cwd);

  if (!local && !remote) {
    progress('GIT', `Creating Epic branch: ${epicBranch} (from ${baseBranch})`);
    gitSync(cwd, 'checkout', baseBranch);
    await gitPullWithRetry(cwd, 'origin', baseBranch);
    gitSync(cwd, 'checkout', '-b', epicBranch);
    gitSync(cwd, 'push', '--no-verify', '-u', 'origin', epicBranch);
    _assertOnBranch(cwd, epicBranch);
    return;
  }

  if (local && !remote) {
    progress(
      'GIT',
      `Epic branch exists locally only: ${epicBranch}. Publishing.`,
    );
    gitSync(cwd, 'checkout', epicBranch);
    gitSync(cwd, 'push', '--no-verify', '-u', 'origin', epicBranch);
    _assertOnBranch(cwd, epicBranch);
    return;
  }

  if (!local && remote) {
    progress('GIT', `Tracking remote Epic branch: ${epicBranch}`);
    gitSync(cwd, 'checkout', '-b', epicBranch, `origin/${epicBranch}`);
    await gitPullWithRetry(cwd, 'origin', epicBranch);
    _assertOnBranch(cwd, epicBranch);
    return;
  }

  progress('GIT', `Epic branch exists. Syncing: ${epicBranch}`);
  gitSync(cwd, 'checkout', epicBranch);
  await gitPullWithRetry(cwd, 'origin', epicBranch);
  _assertOnBranch(cwd, epicBranch);
}

/**
 * Post-operation assertion: verify HEAD is on the expected branch.
 * Guards against TOCTOU races where a parallel agent switches branches
 * between our checkout and pull.
 */
function _assertOnBranch(cwd, expected) {
  const actual = currentBranch(cwd);
  if (actual !== expected) {
    throw new Error(
      `[git-branch-lifecycle] Branch assertion failed after checkout. ` +
        `Expected HEAD on '${expected}', found '${actual}'. ` +
        `A concurrent process may have switched branches.`,
    );
  }
}

/**
 * Check out a Story branch, creating it from `epicBranch` if neither local
 * nor remote exists. Non-destructive: if the branch already exists, this
 * plain-`checkout`s it rather than `-B`-resetting.
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

  // Short-circuit: already on the story branch — just sync.
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
 * Ensure an Epic branch ref exists locally and is published to `origin`,
 * **without moving HEAD**. Designed for the worktree bootstrap path where
 * the main checkout must not switch branches (a parallel agent may be
 * working there, or the tree may be dirty).
 *
 * Uses `git branch` (not `checkout -b`) to create refs, and `git push` to
 * publish. Callers that need HEAD on the epic branch should use
 * `ensureEpicBranch()` instead.
 *
 * @param {string} epicBranch
 * @param {string} baseBranch
 * @param {string} cwd
 * @param {{ progress?: (phase: string, message: string) => void }} [opts]
 */
/**
 * Pure: choose the action to take for `ensureEpicBranchRef` given whether
 * the branch exists locally and/or remotely. One of:
 *   - `'noop'` — both refs exist; nothing to do.
 *   - `'fetch'` — only remote exists; fetch into local.
 *   - `'publish-existing'` — only local exists; push it.
 *   - `'create-and-publish'` — neither exists; create from base then push.
 *
 * @param {boolean} local
 * @param {boolean} remote
 * @returns {'noop' | 'fetch' | 'publish-existing' | 'create-and-publish'}
 */
export function planEnsureEpicBranchRefAction(local, remote) {
  if (local) return remote ? 'noop' : 'publish-existing';
  return remote ? 'fetch' : 'create-and-publish';
}

export function ensureEpicBranchRef(epicBranch, baseBranch, cwd, opts = {}) {
  assertBranchSafe(epicBranch, baseBranch);
  const progress = opts.progress ?? (() => {});

  // `ensureEpicBranchRef` is always called after a `git fetch origin` (via
  // `cachedGitFetch` / `fetchMainRefs` in `bootstrapWorktree`). The
  // remote-tracking refs are therefore authoritative, so we check
  // `refs/remotes/origin/<branch>` locally rather than issuing a second
  // network `ls-remote` call.
  const action = planEnsureEpicBranchRefAction(
    branchExistsLocally(epicBranch, cwd),
    branchExistsViaTrackingRef(epicBranch, cwd),
  );

  if (action === 'noop') {
    progress('GIT', `Epic branch ref exists (local+remote): ${epicBranch}`);
    return;
  }

  if (action === 'fetch') {
    progress('GIT', `Fetching remote Epic branch ref: ${epicBranch}`);
    const res = gitSpawn(cwd, 'fetch', 'origin', `${epicBranch}:${epicBranch}`);
    if (res.status !== 0) {
      throw new Error(
        `ensureEpicBranchRef: failed to fetch ${epicBranch}: ${res.stderr}`,
      );
    }
    return;
  }

  if (action === 'create-and-publish') {
    progress(
      'GIT',
      `Creating Epic branch ref: ${epicBranch} (from ${baseBranch})`,
    );
    gitSync(cwd, 'branch', epicBranch, baseBranch);
  }

  progress('GIT', `Publishing Epic branch: ${epicBranch}`);
  gitSync(cwd, 'push', '--no-verify', '-u', 'origin', epicBranch);
}

/**
 * Ensure an arbitrary branch exists locally, creating from `baseBranch` if
 * missing. Used by the dispatcher's task-dispatch path where the expected
 * side-effect is "branch ref exists"; the caller does not want HEAD to
 * move. After creation, HEAD is restored to `baseBranch`.
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
