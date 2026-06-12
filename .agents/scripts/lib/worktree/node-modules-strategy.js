/* node:coverage ignore file -- node_modules placement strategies (symlink/copy/install); pure filesystem I/O, integration-shaped */

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
import { detectPackageManager } from '../detect-package-manager.js';

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
  // Shared lockfile probe (Story #4048 B3 — one implementation per concept).
  const pm = detectPackageManager(wtPath, (p) => fsLike.existsSync(p)) ?? 'npm';
  if (pm === 'pnpm') {
    return { cmd: 'pnpm', args: ['install', '--frozen-lockfile'] };
  }
  if (pm === 'yarn') {
    return { cmd: 'yarn', args: ['install', '--frozen-lockfile'] };
  }
  return { cmd: 'npm', args: ['ci'] };
}

/**
 * Per-package-manager "install completed" marker files written into
 * `node_modules/` by the install command itself. Their presence (and
 * freshness relative to the lockfile) is the cheapest reliable signal that a
 * prior install ran to completion — a failed/interrupted install leaves
 * `node_modules` partially populated without (or with a stale) marker.
 */
const INSTALL_MARKERS = [
  '.package-lock.json', // npm ci / npm install
  '.modules.yaml', // pnpm
  '.yarn-state.yml', // yarn berry (node-modules linker)
  '.yarn-integrity', // yarn classic
];

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];

function safeMtimeMs(fsLike, p) {
  try {
    return fsLike.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Pure: probe whether a **reused** worktree already carries a completed,
 * up-to-date install. Worktree reuse must not blindly report
 * `skipped/worktree-reused` — when the prior run's install *failed*, that
 * status defeats the install retry exactly when it matters
 * (`deriveInstallAction('skipped')` treats it as "nothing to do").
 *
 * Returns the same shape as `installDependencies`:
 *   - `{ status: 'skipped', reason: 'worktree-reused' }` — a completed
 *     install was detected (or the strategy never installs per-tree);
 *     safe to skip.
 *   - `{ status: 'failed', reason }` — missing/incomplete/stale install
 *     detected; callers should retry the install.
 *
 * @param {string} strategy One of `per-worktree | pnpm-store | symlink`.
 * @param {string} wtPath Absolute worktree path.
 * @param {{ existsSync: Function, statSync: Function }} [fsLike] Injectable for tests.
 * @returns {{ status: 'skipped' | 'failed', reason: string }}
 */
export function probeReusedInstall(strategy, wtPath, fsLike = fs) {
  // `symlink` re-points node_modules at a donor — no per-tree install to probe.
  if (strategy === 'symlink') {
    return { status: 'skipped', reason: 'worktree-reused' };
  }
  if (!fsLike.existsSync(path.join(wtPath, 'package.json'))) {
    return { status: 'skipped', reason: 'no-package-json' };
  }
  const nmPath = path.join(wtPath, 'node_modules');
  if (!fsLike.existsSync(nmPath)) {
    return { status: 'failed', reason: 'reuse-node-modules-missing' };
  }
  const marker = INSTALL_MARKERS.map((m) => path.join(nmPath, m)).find((p) =>
    fsLike.existsSync(p),
  );
  if (!marker) {
    return { status: 'failed', reason: 'reuse-install-incomplete' };
  }
  const markerMtime = safeMtimeMs(fsLike, marker);
  const lockfile = LOCKFILES.map((l) => path.join(wtPath, l)).find((p) =>
    fsLike.existsSync(p),
  );
  if (lockfile && markerMtime !== null) {
    const lockMtime = safeMtimeMs(fsLike, lockfile);
    if (lockMtime !== null && lockMtime > markerMtime) {
      return { status: 'failed', reason: 'reuse-node-modules-stale' };
    }
  }
  return { status: 'skipped', reason: 'worktree-reused' };
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

/** Relative path of the per-machine pnpm-store prime sentinel (under tempRoot). */
export const PNPM_STORE_PRIME_SENTINEL = path.join(
  'temp',
  '.pnpm-store-primed',
);

/**
 * Pure: one-time per-machine pnpm content-addressable-store prime.
 *
 * The `pnpm-store` strategy relies on a hydrated shared store. On a cold
 * machine the first `pnpm install --frozen-lockfile` inside a worktree races
 * other workers, and the per-tree retries can all hit the same un-populated
 * store and exhaust without any single attempt succeeding. Priming the store
 * once at `repoRoot` (where the lockfile lives) before any worktree install
 * eliminates that class of transient failure.
 *
 * The sentinel is a zero-byte file under `<repoRoot>/temp/`. The directory
 * lives outside Git (the project's standard scratch root) so the sentinel
 * persists across worktrees on the same machine but never ships to commits.
 *
 * No-op for strategies other than `pnpm-store`.
 *
 * @returns {{ primed: 'primed' | 'cached' | 'failed' | 'skipped', reason?: string }}
 */
export function primePnpmStore({
  strategy,
  repoRoot,
  logger,
  spawnFn = spawnSync,
  fsLike = fs,
  shell = process.platform === 'win32',
}) {
  if (strategy !== 'pnpm-store') {
    return { primed: 'skipped', reason: 'strategy-not-pnpm-store' };
  }
  const sentinelPath = path.join(repoRoot, PNPM_STORE_PRIME_SENTINEL);
  if (fsLike.existsSync(sentinelPath)) {
    logger.info(`worktree.install prime skipped (sentinel ${sentinelPath})`);
    return { primed: 'cached', reason: 'sentinel-present' };
  }
  logger.info(
    `worktree.install priming pnpm content-addressable store at ${repoRoot} (sentinel missing)`,
  );
  const result = spawnFn('pnpm', ['install', '--frozen-lockfile'], {
    cwd: repoRoot,
    stdio: 'pipe',
    encoding: 'utf-8',
    shell,
    timeout: 600_000,
  });
  if (result.status !== 0) {
    logger.warn(
      `worktree.install prime FAILED (${describeAttemptFailure(result, 600_000)}) stderr=${(result.stderr ?? '').slice(0, 500)}`,
    );
    return { primed: 'failed', reason: 'prime-command-nonzero' };
  }
  try {
    fsLike.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fsLike.writeFileSync(sentinelPath, '');
  } catch (err) {
    logger.warn(
      `worktree.install prime succeeded but sentinel write failed: ${err.message}`,
    );
    return { primed: 'failed', reason: 'sentinel-write-failed' };
  }
  logger.info(
    `worktree.install prime succeeded (sentinel written ${sentinelPath})`,
  );
  return { primed: 'primed' };
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
    const errFn = ctx.logger.error ?? ctx.logger.warn;
    errFn.call(
      ctx.logger,
      `worktree.install FAILED after ${policy.maxAttempts} attempt(s) of ` +
        `${selection.cmd} ${selection.args.join(' ')} in ${wtPath}. ` +
        `Recovery: cd "${wtPath}" ; npm ci  ` +
        '(falls back to the npm install path; resolve any underlying registry/network issue first).',
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
  // Prime the pnpm content-addressable store once per machine before the
  // worktree's own install runs. No-op for non-pnpm-store strategies. Prime
  // failures are surfaced as warnings but do not short-circuit the install —
  // the retry ladder below still gets its full budget of attempts.
  if (strategy === 'pnpm-store' && ctx.repoRoot) {
    primePnpmStore({
      strategy,
      repoRoot: ctx.repoRoot,
      logger: ctx.logger,
      shell: ctx.platform === 'win32',
    });
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
