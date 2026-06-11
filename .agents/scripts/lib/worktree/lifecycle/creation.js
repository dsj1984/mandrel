/**
 * worktree/lifecycle/creation.js
 *
 * `ensure` — idempotently provision `.worktrees/story-<id>/` on `branch`.
 * Threads the `ctx` bag built by `WorktreeManager`; cross-cutting work
 * (workspace bootstrap, Windows long-path warning) is supplied via callbacks
 * on `ctx` so this submodule never reaches into `WorktreeManager` instance
 * state directly.
 */

import fs from 'node:fs';
import {
  applyNodeModulesStrategy,
  installDependencies,
  probeReusedInstall,
} from '../node-modules-strategy.js';
import {
  findByPath,
  invalidateWorktreeCache,
  pathFor,
} from './registry-sync.js';
import { validateBranch, validateStoryId } from './shared.js';

export async function ensure(ctx, storyId, branch) {
  const id = validateStoryId(storyId);
  const br = validateBranch(branch);
  if (br !== `story-${id}`) {
    throw new Error(
      `WorktreeManager: branch ${br} does not match storyId ${id}`,
    );
  }

  const wtPath = pathFor(ctx, id);
  const existing = findByPath(ctx, wtPath);

  // Phase-boundary callback — invoked even on reuse so story-init's
  // phase timer records non-null `worktree-create`/`bootstrap`/`install`
  // entries regardless of whether provisioning actually ran. The timer
  // reports the elapsed wall-clock between marks, so reuse paths yield
  // near-zero rows, which is the correct observability signal.
  const phase = (name) => {
    if (typeof ctx.onPhase === 'function') ctx.onPhase(name);
  };

  // Reuse must not blindly skip the install: when the prior run's install
  // failed (or was interrupted), `skipped/worktree-reused` defeats the
  // retry exactly when it matters — `deriveInstallAction('skipped')` skips.
  // Probe for a completed install; on a failed probe, retry the install
  // here and surface its real outcome.
  const reuseInstallStatus = () => {
    const strategy = ctx.config?.nodeModulesStrategy ?? 'per-worktree';
    const probe = probeReusedInstall(strategy, wtPath);
    if (probe.status !== 'failed') return probe;
    ctx.logger.warn(
      `worktree.reuse install probe failed (${probe.reason}) — retrying install in ${wtPath}`,
    );
    // `ctx.installDependencies` is a test-injection seam; production ctx
    // bags leave it unset and get the real installer.
    return (ctx.installDependencies ?? installDependencies)(ctx, wtPath);
  };

  if (existing) {
    if (existing.branch && existing.branch !== br) {
      throw new Error(
        `WorktreeManager: worktree at ${wtPath} is on branch ${existing.branch}, expected ${br}`,
      );
    }
    phase('worktree-create');
    phase('bootstrap');
    phase('install');
    return {
      path: wtPath,
      created: false,
      installStatus: reuseInstallStatus(),
    };
  }

  fs.mkdirSync(ctx.worktreeRoot, { recursive: true });

  const windowsPathWarning = ctx.maybeWarnWindowsPath(wtPath);

  const branchExists =
    ctx.git.gitSpawn(
      ctx.repoRoot,
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${br}`,
    ).status === 0;

  const addArgs = branchExists
    ? ['worktree', 'add', wtPath, br]
    : ['worktree', 'add', '-b', br, wtPath];

  phase('worktree-create');
  const res = ctx.git.gitSpawn(ctx.repoRoot, ...addArgs);
  if (res.status !== 0) {
    const stderr = res.stderr || res.stdout || '';
    if (/already (exists|checked out)/.test(stderr)) {
      const raceExisting = findByPath(ctx, wtPath);
      if (raceExisting) {
        ctx.logger.info(
          `worktree.ensure race: worktree appeared concurrently for story-${id}, reusing`,
        );
        return {
          path: wtPath,
          created: false,
          installStatus: reuseInstallStatus(),
        };
      }
    }
    throw new Error(
      `WorktreeManager: git worktree add failed for story-${id}: ${stderr}`,
    );
  }

  invalidateWorktreeCache(ctx);

  if (ctx.platform === 'win32') {
    ctx.git.gitSpawn(wtPath, 'config', '--local', 'core.longpaths', 'true');
  }

  applyNodeModulesStrategy(ctx, wtPath);
  phase('bootstrap');
  ctx.copyBootstrapFiles(wtPath);
  phase('install');
  const installStatus = installDependencies(ctx, wtPath);

  ctx.logger.info(`worktree.created storyId=${id} path=${wtPath}`);
  return {
    path: wtPath,
    created: true,
    installStatus,
    ...(windowsPathWarning ? { windowsPathWarning } : {}),
  };
}
