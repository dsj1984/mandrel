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
import { forkAndCommitEpicSnapshot as defaultForkAndCommitEpicSnapshot } from '../baseline-snapshot.js';
import { resolveWorkingPath } from '../config-resolver.js';
import { cachedGitFetch } from '../git/cached-fetch.js';
import {
  branchExistsLocally,
  branchExistsRemotely,
  checkoutStoryBranch,
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
 * @returns {'none'|'fetch'|'create'}
 */
export function planStoryBranchSeed({ localHas, remoteHas }) {
  if (localHas) return 'none';
  if (remoteHas) return 'fetch';
  return 'create';
}

function ensureStoryBranchSeed({ storyBranch, epicBranch, mainCwd, progress }) {
  const action = planStoryBranchSeed({
    localHas: branchExistsLocally(storyBranch, mainCwd),
    remoteHas: branchExistsRemotely(storyBranch, mainCwd),
  });
  if (action === 'fetch') {
    progress('GIT', `Fetching remote story branch: ${storyBranch}`);
    gitSpawn(mainCwd, 'fetch', 'origin', `${storyBranch}:${storyBranch}`);
  } else if (action === 'create') {
    progress(
      'GIT',
      `Creating story branch ref: ${storyBranch} from ${epicBranch}`,
    );
    gitSpawn(mainCwd, 'branch', storyBranch, epicBranch);
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

export function reportSnapshotFork(snapshot, epicBranch, progress) {
  if (snapshot?.commit?.committed) {
    progress(
      'GIT',
      `🧊 Forked main baselines → ${epicBranch} (commit ${snapshot.commit.sha?.slice(0, 7)}).`,
    );
    return;
  }
  progress(
    'GIT',
    `🧊 Snapshot fork skipped: ${snapshot?.commit?.reason ?? 'no-files'}.`,
  );
}

export function maybeForkSnapshot({
  epicId,
  epicBranch,
  mainCwd,
  forkAndCommitEpicSnapshot,
  progress,
}) {
  // Story #1585 (Epic #1471): defer the baseline-snapshot fork from
  // /epic-plan to first-story-init so plan-time stays git-state-free and
  // the snapshot reflects the current main rather than stale main at plan
  // time. Idempotent + non-fatal on missing source baselines.
  if (epicId === undefined || epicId === null) return;
  try {
    const snapshot = forkAndCommitEpicSnapshot({ epicId, cwd: mainCwd });
    reportSnapshotFork(snapshot, epicBranch, progress);
  } catch (err) {
    progress(
      'GIT',
      `⚠️ snapshot fork failed (non-fatal): ${err?.message ?? err}`,
    );
  }
}

export async function bootstrapWorktree({
  epicBranch,
  epicId,
  storyBranch,
  storyId,
  baseBranch,
  mainCwd,
  wtConfig,
  progress = defaultProgress(),
  fs = nodeFs,
  path = nodePath,
  onPhase,
  forkAndCommitEpicSnapshot = defaultForkAndCommitEpicSnapshot,
}) {
  await fetchMainRefs({ mainCwd, progress });
  ensureEpicBranchRef(epicBranch, baseBranch, mainCwd, { progress });
  maybeForkSnapshot({
    epicId,
    epicBranch,
    mainCwd,
    forkAndCommitEpicSnapshot,
    progress,
  });
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
 * @param {number} [deps.input.epicId]
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
    epicId,
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
      epicId,
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
