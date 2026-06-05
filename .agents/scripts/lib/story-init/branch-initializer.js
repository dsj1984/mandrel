/* node:coverage ignore file -- worktree provisioning over live git + filesystem; testing requires standing up real worktrees (integration) or asserting only the mock structure */

/**
 * branch-initializer.js — Stage 5 of the story-init pipeline.
 *
 * Materialises the Story branch either in the main checkout (single-tree
 * mode) or behind a dedicated git worktree (isolated mode). Both paths
 * leave the agent with a working directory on the `story-<id>` branch and a
 * clean index.
 *
 * The legacy `bootstrapBranch` and `bootstrapWorktree` helpers are preserved
 * verbatim and exported alongside the canonical `initializeBranch` stage
 * entry point so existing callers / tests can reach them directly.
 * Surviving callers (Epic #990 Story #1006 triage):
 *   - tests/lib/story-init/branch-initializer-pure.test.js
 *   - tests/story-off-branch-e2e.test.js
 */

import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { resolveWorkingPath } from '../config-resolver.js';
import { cachedGitFetch } from '../git/cached-fetch.js';
import {
  branchExistsLocally,
  branchExistsViaTrackingRef,
  checkoutStoryBranch,
  classifyBranchSeed,
  ensureEpicBranch,
  ensureEpicBranchRef,
} from '../git-branch-lifecycle.js';
import { gitSpawn } from '../git-utils.js';
import { Logger } from '../Logger.js';
import {
  resolveWorkspaceFiles,
  verify as verifyWorkspace,
} from '../workspace-provisioner.js';
import { WorktreeManager } from '../worktree-manager.js';
import { ensureDonorPrimed } from './donor-precheck.js';

function defaultProgress() {
  return () => {};
}

/**
 * Idempotently apply `core.longpaths=true` at the repo level on Windows.
 *
 * On the worktree-off branch the agent works directly in the main checkout,
 * so the per-worktree `git config --local core.longpaths` set in
 * `WorktreeManager.ensure` is never reached. Without this, deep
 * `node_modules/.../<long-name>` paths under the main checkout fail on
 * Windows with `Filename too long`.
 *
 * Skipped on every non-Windows platform (Linux web runtime included).
 * Skipped when the repo-local config is already `true` so the function is a
 * single read after the first invocation.
 *
 * Exported for testing.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {NodeJS.Platform} [opts.platform]
 * @param {(level: string, msg: string) => void} [opts.progress]
 * @returns {{ applied: boolean, reason: string }}
 */
export function ensureRepoCoreLongpathsOnWindows({
  cwd,
  platform = process.platform,
  progress = defaultProgress(),
  git = { gitSpawn },
} = {}) {
  if (platform !== 'win32') {
    return { applied: false, reason: 'not-windows' };
  }
  const current = git.gitSpawn(
    cwd,
    'config',
    '--local',
    '--get',
    'core.longpaths',
  );
  // Exit 0 means the value was found; stdout holds it. Exit 1 means unset.
  if (current.status === 0 && (current.stdout ?? '').trim() === 'true') {
    return { applied: false, reason: 'already-set' };
  }
  const set = git.gitSpawn(cwd, 'config', '--local', 'core.longpaths', 'true');
  if (set.status !== 0) {
    progress(
      'GIT',
      `⚠️ Failed to set core.longpaths on ${cwd}: ${set.stderr || 'unknown'} (continuing)`,
    );
    return { applied: false, reason: 'set-failed' };
  }
  progress('GIT', '✅ Applied core.longpaths=true (repo-level, Windows)');
  return { applied: true, reason: 'set' };
}

function assertWorkingTreeClean(cwd) {
  const status = gitSpawn(cwd, 'status', '--porcelain');
  if (status.status !== 0) {
    throw new Error(
      `Failed to read git status: ${status.stderr || '(no stderr)'}`,
    );
  }
  if (status.stdout.length > 0) {
    throw new Error(
      `Working tree is dirty. Refusing to switch branches — uncommitted/untracked files may belong to another agent.\nRun \`git status\` and resolve before retrying.\n--- dirty entries ---\n${status.stdout}`,
    );
  }
}

export async function bootstrapBranch({
  epicBranch,
  storyBranch,
  baseBranch,
  cwd,
  progress = defaultProgress(),
}) {
  // First-use Windows guard: ensure deep paths under node_modules/ etc. don't
  // blow up the main checkout when worktree isolation is off. Skipped on Linux
  // (web runtime) and when already set.
  ensureRepoCoreLongpathsOnWindows({ cwd, progress });

  progress('GIT', 'Fetching remote refs...');
  const fetchResult = await cachedGitFetch(cwd, 'origin');
  if (fetchResult.cached) {
    progress('GIT', 'Fetch served from (cwd, ref) cache — skipped network.');
  } else if (fetchResult.attempts > 1) {
    progress(
      'GIT',
      `Fetch completed after ${fetchResult.attempts} attempt(s) — packed-refs contention.`,
    );
  }

  assertWorkingTreeClean(cwd);

  await ensureEpicBranch(epicBranch, baseBranch, cwd, { progress });
  await checkoutStoryBranch(storyBranch, epicBranch, cwd, { progress });

  const currentBranch = gitSpawn(cwd, 'branch', '--show-current');
  if (currentBranch.stdout !== storyBranch) {
    throw new Error(
      `Branch verification failed. Expected: ${storyBranch}, Got: ${currentBranch.stdout}.`,
    );
  }
  progress('GIT', `✅ On branch: ${currentBranch.stdout}`);
}

/**
 * Pure: classify whether a story branch needs to be fetched from origin or
 * created from the epic branch. Returns the action keyword. Exported so the
 * decision is testable without git side-effects.
 *
 * Delegates the (local, remote) decision to the shared `classifyBranchSeed`
 * classifier (Story #3513) so this Epic-attached path and the standalone
 * `single-story-init.js#decideStoryBranchSeed` share one decision tree. The
 * shared classifier returns `'local'` for the local-present case; this path
 * names that outcome `'none'` (no re-seed).
 *
 * @returns {'none'|'fetch'|'create'}
 */
export function planStoryBranchSeed({ localHas, remoteHas }) {
  const action = classifyBranchSeed({ localHas, remoteHas });
  return action === 'local' ? 'none' : action;
}

/**
 * Ensure the `story-<id>` ref exists locally, seeding it from the Epic branch
 * (or fetching it from origin) only when it does not already exist. A
 * pre-existing ref — local or created concurrently between the probe and the
 * `git branch` call — is treated as **reuse**, never an error (Story #3482).
 *
 * Exported with injectable git seams so the reuse / race-swallow behaviour is
 * unit-testable without standing up a real repo.
 *
 * @param {object} args
 * @param {string} args.storyBranch
 * @param {string} args.epicBranch
 * @param {string} args.mainCwd
 * @param {(level: string, msg: string) => void} [args.progress]
 * @param {object} [args.git]   Injected `{ spawn, existsLocally, existsRemotely }`.
 */
export function ensureStoryBranchSeed({
  storyBranch,
  epicBranch,
  mainCwd,
  progress = defaultProgress(),
  git,
}) {
  const spawn = git?.spawn ?? ((...args) => gitSpawn(mainCwd, ...args));
  const existsLocally =
    git?.existsLocally ?? ((b) => branchExistsLocally(b, mainCwd));
  // `ensureStoryBranchSeed` is always called after `fetchMainRefs` in
  // `bootstrapWorktree`, so remote-tracking refs are authoritative. Use a
  // local tracking-ref check rather than a network `ls-remote` round-trip.
  const existsRemotely =
    git?.existsRemotely ?? ((b) => branchExistsViaTrackingRef(b, mainCwd));

  const action = planStoryBranchSeed({
    localHas: existsLocally(storyBranch),
    remoteHas: existsRemotely(storyBranch),
  });
  if (action === 'none') {
    // Story #3482 — a pre-existing `story-<id>` ref is reuse, not an error.
    // The worktree bootstrap below seeds onto whatever the ref already points
    // at (resuming a partially-implemented Story), so seeding is a no-op here.
    progress(
      'GIT',
      `Reusing existing story branch ref: ${storyBranch} (no re-seed)`,
    );
    return;
  }
  if (action === 'fetch') {
    progress('GIT', `Fetching remote story branch: ${storyBranch}`);
    spawn('fetch', 'origin', `${storyBranch}:${storyBranch}`);
    return;
  }
  progress(
    'GIT',
    `Creating story branch ref: ${storyBranch} from ${epicBranch}`,
  );
  const res = spawn('branch', storyBranch, epicBranch);
  // Story #3482 — close the probe→create race: another concurrent
  // dispatch (or a prior interrupted run) may have created the ref between
  // our existence probe above and this `git branch` call. `git branch`
  // exits non-zero with "already exists" in that window. Treat it as reuse
  // rather than letting story-init abort — the ref exists, which is exactly
  // the post-condition this function guarantees.
  if (res.status !== 0) {
    const stderr = res.stderr || res.stdout || '';
    if (/already exists/i.test(stderr)) {
      progress(
        'GIT',
        `Story branch ref ${storyBranch} already exists (created concurrently) — reusing.`,
      );
      return;
    }
    throw new Error(
      `ensureStoryBranchSeed: failed to create ${storyBranch} from ${epicBranch}: ${stderr}`,
    );
  }
}

function verifyWorkspaceSafe({
  ensured,
  mainCwd,
  wtConfig,
  fs,
  path,
  progress,
}) {
  try {
    const workspaceFiles = resolveWorkspaceFiles(wtConfig);
    const presentAtSource = workspaceFiles.filter((rel) =>
      fs.existsSync(path.join(mainCwd, rel)),
    );
    if (presentAtSource.length > 0) {
      verifyWorkspace({
        worktree: ensured.path,
        files: presentAtSource,
        sourceRoot: mainCwd,
      });
    }
  } catch (err) {
    progress('WORKTREE', `⚠️ ${err.message}`);
    throw err;
  }
}

function reportEnsureWarnings(ensured, progress) {
  if (ensured.installStatus?.status === 'failed') {
    progress(
      'WORKTREE',
      `⚠️ Dependency install failed (${ensured.installStatus.reason}). Agent must run package-manager install in the worktree before proceeding.`,
    );
  }
  if (ensured.windowsPathWarning) {
    const { path: p, length, threshold } = ensured.windowsPathWarning;
    progress(
      'WORKTREE',
      `⚠️ Windows long-path: ${p} (${length} >= ${threshold}). Consider relocating orchestration.worktreeIsolation.root.`,
    );
  }
}

async function fetchMainRefs({ mainCwd, progress }) {
  progress('GIT', 'Fetching remote refs (main checkout)...');
  const fetchResult = await cachedGitFetch(mainCwd, 'origin');
  if (fetchResult.cached) {
    progress('GIT', 'Fetch served from (cwd, ref) cache — skipped network.');
    return;
  }
  if (fetchResult.attempts > 1) {
    progress(
      'GIT',
      `Fetch completed after ${fetchResult.attempts} attempt(s) — packed-refs contention.`,
    );
  }
}

export async function bootstrapWorktree({
  epicBranch,
  storyBranch,
  storyId,
  baseBranch,
  mainCwd,
  wtConfig,
  progress = defaultProgress(),
  fs = nodeFs,
  path = nodePath,
  onPhase,
}) {
  await fetchMainRefs({ mainCwd, progress });
  ensureEpicBranchRef(epicBranch, baseBranch, mainCwd, { progress });
  ensureStoryBranchSeed({ storyBranch, epicBranch, mainCwd, progress });

  // Symlink-strategy fast path: verify the donor has node_modules before
  // creating the worktree. A missing donor would otherwise produce a
  // dangling junction/symlink. Idempotent across concurrent wave
  // dispatches via a filesystem lock at the donor path.
  ensureDonorPrimed({
    strategy: wtConfig?.nodeModulesStrategy,
    primeFromPath: wtConfig?.primeFromPath,
    repoRoot: mainCwd,
    logger: { progress },
  });

  const wm = new WorktreeManager({
    repoRoot: mainCwd,
    config: wtConfig,
    logger: {
      info: (m) => progress('WORKTREE', m),
      warn: (m) => progress('WORKTREE', `⚠️ ${m}`),
      error: (m) => Logger.error(`[story-init] ${m}`),
    },
    onPhase,
  });

  const ensured = await wm.ensure(storyId, storyBranch);
  progress(
    'WORKTREE',
    `${ensured.created ? '✨ Created' : '♻️  Reusing'} worktree: ${ensured.path}`,
  );

  verifyWorkspaceSafe({ ensured, mainCwd, wtConfig, fs, path, progress });
  reportEnsureWarnings(ensured, progress);

  return {
    worktreePath: ensured.path,
    created: ensured.created,
    installStatus: ensured.installStatus ?? {
      status: 'skipped',
      reason: 'unknown',
    },
  };
}

/**
 * Canonical stage entry point. Routes to worktree-isolated or single-tree
 * bootstrap based on `input.worktreeEnabled`.
 *
 * @param {object} deps
 * @param {object} [deps.logger]
 * @param {object} [deps.fs]
 * @param {object} deps.input
 * @param {number} deps.input.storyId
 * @param {string} deps.input.epicBranch
 * @param {string} deps.input.storyBranch
 * @param {string} deps.input.baseBranch
 * @param {string} deps.input.cwd
 * @param {boolean} deps.input.worktreeEnabled
 * @param {object|undefined} deps.input.wtConfig
 * @returns {Promise<{
 *   workCwd: string,
 *   worktreeCreated: boolean,
 *   installStatus: { status: 'installed' | 'failed' | 'skipped', reason?: string },
 * }>}
 */
export async function initializeBranch({ logger, fs = nodeFs, input }) {
  const {
    storyId,
    epicBranch,
    storyBranch,
    baseBranch,
    cwd,
    worktreeEnabled,
    wtConfig,
    onPhase,
  } = input;
  const progress = logger?.progress ?? defaultProgress();

  if (worktreeEnabled) {
    const wtResult = await bootstrapWorktree({
      epicBranch,
      storyBranch,
      storyId,
      baseBranch,
      mainCwd: cwd,
      wtConfig,
      progress,
      fs,
      onPhase,
    });
    return {
      workCwd: wtResult.worktreePath,
      worktreeCreated: wtResult.created,
      installStatus: wtResult.installStatus,
    };
  }

  await bootstrapBranch({
    epicBranch,
    storyBranch,
    baseBranch,
    cwd,
    progress,
  });
  return {
    workCwd: resolveWorkingPath({ worktreeEnabled: false, repoRoot: cwd }),
    worktreeCreated: false,
    installStatus: { status: 'skipped', reason: 'single-tree-mode' },
  };
}
