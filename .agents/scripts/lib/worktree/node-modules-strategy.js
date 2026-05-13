/**
 * worktree/node-modules-strategy.js
 *
 * Strategies for populating `node_modules` inside a freshly created worktree:
 *
 *   - `per-worktree`  — run the project's package-manager install inside the
 *                       worktree (lock-file aware).
 *   - `symlink`       — symlink (or junction on Windows) the worktree's
 *                       `node_modules` to a donor worktree's copy. Refuses on
 *                       Windows unless `allowSymlinkOnWindows=true`.
 *   - `pnpm-store`    — run `pnpm install --frozen-lockfile` against the
 *                       shared content-addressable store.
 *
 * The context passed to each helper carries the minimum state the strategy
 * needs: config, platform, logger, and repoRoot (for `symlink`).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

/**
 * Apply the configured `nodeModulesStrategy` after a fresh worktree is added.
 * Called only during creation.
 *
 * @param {{ config: object, platform: NodeJS.Platform, logger: object, repoRoot: string }} ctx
 * @param {string} wtPath Absolute worktree path.
 */
export function applyNodeModulesStrategy(ctx, wtPath) {
  const strategy = ctx.config.nodeModulesStrategy ?? 'per-worktree';

  switch (strategy) {
    case 'per-worktree':
    case 'pnpm-store':
      return;

    case 'symlink': {
      const primeFromPath = ctx.config.primeFromPath;
      if (!primeFromPath) {
        throw new Error(
          "WorktreeManager: nodeModulesStrategy='symlink' requires orchestration.worktreeIsolation.primeFromPath.",
        );
      }
      if (ctx.platform === 'win32' && !ctx.config.allowSymlinkOnWindows) {
        throw new Error(
          "WorktreeManager: nodeModulesStrategy='symlink' refuses on Windows. " +
            'Symlink semantics vary by Windows version and may require admin rights. ' +
            'Set orchestration.worktreeIsolation.allowSymlinkOnWindows=true to opt in.',
        );
      }

      const resolvedPrime = path.resolve(ctx.repoRoot, primeFromPath);
      const primeNodeModules = path.join(resolvedPrime, 'node_modules');
      if (!fs.existsSync(primeNodeModules)) {
        throw new Error(
          `WorktreeManager: primeFromPath '${primeFromPath}' has no node_modules directory. ` +
            'Prime the donor worktree (run install there) before using the symlink strategy.',
        );
      }

      const target = path.join(wtPath, 'node_modules');
      try {
        // On Windows, `junction` works without Administrator privileges
        // (unlike `dir`/`file` symlinks) and is adequate for same-volume
        // node_modules priming. Key off the real host OS — `ctx.platform` is a
        // test-injection hook and does not change what the filesystem accepts.
        const linkType = process.platform === 'win32' ? 'junction' : 'dir';
        fs.symlinkSync(primeNodeModules, target, linkType);
      } catch (err) {
        throw new Error(
          `WorktreeManager: failed to symlink node_modules for ${wtPath}: ${err.message}`,
        );
      }
      ctx.logger.info(
        `worktree.node_modules strategy=symlink target=${target} source=${primeNodeModules}`,
      );
      return;
    }

    default:
      throw new Error(
        `WorktreeManager: unknown nodeModulesStrategy '${strategy}'. ` +
          'Expected per-worktree | symlink | pnpm-store.',
      );
  }
}

/**
 * Pure: pick the package-manager command + args for a given strategy and
 * worktree path. Returns `null` when the strategy is `symlink` (handled
 * elsewhere) or the worktree has no `package.json`.
 *
 * @param {string} strategy One of `per-worktree | pnpm-store | symlink`.
 * @param {string} wtPath Absolute worktree path.
 * @param {{ existsSync: (p: string) => boolean }} [fsLike] Injectable for tests.
 * @returns {{ cmd: string, args: string[] } | null}
 */
export function selectInstallCommand(strategy, wtPath, fsLike = fs) {
  if (strategy === 'symlink') return null;
  if (!fsLike.existsSync(path.join(wtPath, 'package.json'))) return null;

  if (strategy === 'pnpm-store') {
    return { cmd: 'pnpm', args: ['install', '--frozen-lockfile'] };
  }
  if (fsLike.existsSync(path.join(wtPath, 'pnpm-lock.yaml'))) {
    return { cmd: 'pnpm', args: ['install', '--frozen-lockfile'] };
  }
  if (fsLike.existsSync(path.join(wtPath, 'yarn.lock'))) {
    return { cmd: 'yarn', args: ['install', '--frozen-lockfile'] };
  }
  return { cmd: 'npm', args: ['ci'] };
}

/** Pure: retry policy keyed off the chosen command. pnpm gets 3× + 5min. */
export function installRetryPolicy(cmd) {
  const isPnpm = cmd === 'pnpm';
  return {
    maxAttempts: isPnpm ? 3 : 1,
    timeoutMs: isPnpm ? 300_000 : 120_000,
    backoffMs: [0, 2_000, 5_000],
  };
}

/** Pure: classify a failed `spawnSync` result for the warn-line. */
export function describeAttemptFailure(result, timeoutMs) {
  if (result.signal === 'SIGTERM') return `timeout after ${timeoutMs / 1000}s`;
  return `exit ${result.status}`;
}

/**
 * Run the package-manager install with the configured retry policy. Pure
 * w.r.t. `spawnFn` + `sleepFn` — the CLI wires real ones; tests inject stubs.
 *
 * @returns {{ ok: boolean, attempts: number, lastResult: object }}
 */
export function runInstallWithRetry({
  cmd,
  args,
  cwd,
  shell,
  policy,
  spawnFn,
  sleepFn,
  logger,
  strategy,
}) {
  let lastResult;
  let attempt = 0;
  for (attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    if (attempt > 1) {
      const delay = policy.backoffMs[attempt - 1] ?? 5_000;
      logger.info(
        `worktree.install retry ${attempt}/${policy.maxAttempts} after ${delay}ms...`,
      );
      sleepFn(delay);
    }
    logger.info(
      `worktree.install strategy=${strategy} cmd=${cmd} attempt=${attempt}/${policy.maxAttempts} path=${cwd}`,
    );
    lastResult = spawnFn(cmd, args, {
      cwd,
      stdio: 'pipe',
      encoding: 'utf-8',
      shell,
      timeout: policy.timeoutMs,
    });
    if (lastResult.status === 0) {
      return { ok: true, attempts: attempt, lastResult };
    }
    const reason = describeAttemptFailure(lastResult, policy.timeoutMs);
    logger.warn(
      `worktree.install attempt ${attempt} failed (${reason}) stderr=${(lastResult.stderr ?? '').slice(0, 500)}`,
    );
  }
  return { ok: false, attempts: attempt - 1, lastResult };
}

/**
 * Run the appropriate package-manager install inside a freshly created
 * worktree. Non-fatal: logs a warning on failure so the agent can retry.
 *
 * Return shape:
 *   - `{ status: 'installed' }`        — per-worktree install succeeded.
 *   - `{ status: 'failed', reason }`   — per-worktree install attempted and
 *                                        failed (or finished 0 but produced
 *                                        no `node_modules/`).
 *   - `{ status: 'skipped', reason }`  — strategy intentionally skips a
 *                                        per-worktree install. Covers
 *                                        `symlink` (donor `node_modules` is
 *                                        re-pointed), `pnpm-store` (relies
 *                                        on the shared content-addressable
 *                                        store), and the no-`package.json`
 *                                        case.
 *
 * @param {{ config: object, platform: NodeJS.Platform, logger: object }} ctx
 * @param {string} wtPath Absolute worktree path.
 * @returns {{ status: 'installed' | 'failed' | 'skipped', reason?: string }}
 */
function verifyInstallOutcome(ctx, wtPath, selection, run, policy) {
  if (!run.ok) {
    ctx.logger.warn(
      `worktree.install FAILED after ${policy.maxAttempts} attempt(s). ` +
        'Agent will need to run install manually in the worktree.',
    );
    return { status: 'failed', reason: 'install-command-nonzero' };
  }
  const nmPath = path.join(wtPath, 'node_modules');
  if (!fs.existsSync(nmPath)) {
    ctx.logger.warn(
      `worktree.install cmd=${selection.cmd} exited 0 but node_modules missing at ${nmPath}`,
    );
    return { status: 'failed', reason: 'node-modules-missing' };
  }
  ctx.logger.info(
    `worktree.install succeeded cmd=${selection.cmd} path=${wtPath}`,
  );
  return null;
}

export function installDependencies(ctx, wtPath) {
  const strategy = ctx.config.nodeModulesStrategy ?? 'per-worktree';
  // `symlink` re-points node_modules at a donor — no install command runs.
  if (strategy === 'symlink') {
    return { status: 'skipped', reason: 'symlink-strategy' };
  }
  const selection = selectInstallCommand(strategy, wtPath);
  if (selection === null) {
    return { status: 'skipped', reason: 'no-package-json' };
  }
  const policy = installRetryPolicy(selection.cmd);
  const run = runInstallWithRetry({
    cmd: selection.cmd,
    args: selection.args,
    cwd: wtPath,
    shell: ctx.platform === 'win32',
    policy,
    spawnFn: spawnSync,
    sleepFn: sleepSync,
    logger: ctx.logger,
    strategy,
  });
  const verdict = verifyInstallOutcome(ctx, wtPath, selection, run, policy);
  if (verdict) return verdict;
  // `pnpm-store` runs `pnpm install --frozen-lockfile`, but the resulting
  // node_modules is backed by a shared content-addressable store rather
  // than a self-contained tree. Report `skipped` so the workflow treats
  // dependency state as N/A and trusts the strategy.
  if (strategy === 'pnpm-store') {
    return { status: 'skipped', reason: 'pnpm-store-strategy' };
  }
  return { status: 'installed' };
}

export { sleepSync };
