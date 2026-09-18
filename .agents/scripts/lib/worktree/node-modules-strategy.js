/* node:coverage ignore file -- node_modules placement strategies (symlink/copy/install); pure filesystem I/O, integration-shaped */

/**
 * Strategies for populating a new worktree's `node_modules`: `per-worktree`
 * (PM install), `clone` (copy-on-write clone of the donor, falling back to
 * install), `symlink` (to a donor; opt-in on Windows) and `pnpm-store`.
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { detectPackageManager } from '../detect-package-manager.js';

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

/**
 * Clone donor: `primeFromPath` when pinned, else the (host-installed) repo root.
 *
 * @param {{ config: object, repoRoot: string }} ctx
 * @returns {string}
 */
function resolveCloneDonor(ctx) {
  const primeFromPath = ctx.config?.primeFromPath;
  return primeFromPath
    ? path.resolve(ctx.repoRoot, primeFromPath)
    : path.resolve(ctx.repoRoot);
}

/**
 * Apply `nodeModulesStrategy` to a freshly created worktree.
 *
 * @param {{ config: object, platform: NodeJS.Platform, logger: object, repoRoot: string }} ctx
 * @param {string} wtPath
 */
export function applyNodeModulesStrategy(ctx, wtPath) {
  const strategy = ctx.config.nodeModulesStrategy ?? 'per-worktree';

  switch (strategy) {
    case 'per-worktree':
    case 'pnpm-store':
      return;

    case 'clone': {
      cloneNodeModules(ctx, wtPath);
      return;
    }

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
        // A junction needs no admin rights on Windows. Keyed off the real host
        // OS: `ctx.platform` is a test hook the filesystem ignores.
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
          'Expected per-worktree | clone | symlink | pnpm-store.',
      );
  }
}

/**
 * Copy-on-write clone the donor's `node_modules` into the worktree. A fast
 * path only: every failure returns `cloned: false` (never throws) and the
 * regular install runs instead.
 *
 * @param {{ config: object, platform: NodeJS.Platform, logger: object, repoRoot: string }} ctx
 * @param {string} wtPath
 * @param {{ spawnFn?: typeof spawnSync, fsLike?: typeof fs }} [io]
 * @returns {{ cloned: boolean, reason?: string }}
 */
export function cloneNodeModules(ctx, wtPath, io = {}) {
  const spawnFn = io.spawnFn ?? spawnSync;
  const fsLike = io.fsLike ?? fs;
  // Real host OS, not `ctx.platform`: Windows has no clone `cp` here.
  if (process.platform === 'win32') {
    ctx.logger.info(
      'worktree.node_modules strategy=clone fallback=per-worktree reason=windows-unsupported',
    );
    return { cloned: false, reason: 'windows-unsupported' };
  }

  const donor = resolveCloneDonor(ctx);
  const donorNodeModules = path.join(donor, 'node_modules');
  if (!fsLike.existsSync(donorNodeModules)) {
    ctx.logger.info(
      `worktree.node_modules strategy=clone fallback=per-worktree reason=donor-node-modules-missing donor=${donorNodeModules}`,
    );
    return { cloned: false, reason: 'donor-node-modules-missing' };
  }

  const target = path.join(wtPath, 'node_modules');
  if (fsLike.existsSync(target)) {
    // cp would nest into an existing dir; let the install-skip probe decide.
    ctx.logger.info(
      `worktree.node_modules strategy=clone skip reason=target-exists target=${target}`,
    );
    return { cloned: false, reason: 'target-exists' };
  }

  // `--reflink=always` (not `auto`) so a slow full copy never masquerades as
  // a free clone.
  const cloneArgs =
    process.platform === 'darwin'
      ? ['-c', '-R', donorNodeModules, target]
      : ['--reflink=always', '-R', donorNodeModules, target];
  const result = spawnFn('cp', cloneArgs, {
    cwd: wtPath,
    stdio: 'pipe',
    encoding: 'utf-8',
    timeout: 120_000,
  });
  if (result.status !== 0) {
    // Remove a partial copy so the fallback install starts empty.
    try {
      fsLike.rmSync(target, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    ctx.logger.warn(
      `worktree.node_modules strategy=clone fallback=per-worktree reason=clone-command-failed ` +
        `(${describeAttemptFailure(result, 120_000)}) stderr=${(result.stderr ?? '').slice(0, 300)}`,
    );
    return { cloned: false, reason: 'clone-command-failed' };
  }

  ctx.logger.info(
    `worktree.node_modules strategy=clone target=${target} source=${donorNodeModules}`,
  );
  return { cloned: true };
}

/**
 * Install command for a strategy, or `null` for `symlink` / no `package.json`.
 *
 * @param {string} strategy
 * @param {string} wtPath
 * @param {{ existsSync: (p: string) => boolean }} [fsLike]
 * @returns {{ cmd: string, args: string[] } | null}
 */
export function selectInstallCommand(strategy, wtPath, fsLike = fs) {
  if (strategy === 'symlink') return null;
  if (!fsLike.existsSync(path.join(wtPath, 'package.json'))) return null;

  if (strategy === 'pnpm-store') {
    return { cmd: 'pnpm', args: ['install', '--frozen-lockfile'] };
  }
  const pm = detectPackageManager(wtPath, (p) => fsLike.existsSync(p)) ?? 'npm';
  if (pm === 'pnpm') {
    return { cmd: 'pnpm', args: ['install', '--frozen-lockfile'] };
  }
  if (pm === 'yarn') {
    return { cmd: 'yarn', args: ['install', '--frozen-lockfile'] };
  }
  return { cmd: 'npm', args: ['ci'] };
}

/** Markers a PM writes only once an install completes. */
const INSTALL_MARKERS = [
  '.package-lock.json', // npm ci / npm install
  '.modules.yaml', // pnpm
  '.yarn-state.yml', // yarn berry (node-modules linker)
  '.yarn-integrity', // yarn classic
];

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];

/**
 * SHA-256 of the first lockfile in `dir`, or `null`. The freshness key is a
 * content hash, never mtime, which clones and checkouts do not preserve.
 *
 * @param {string} dir
 * @param {{ existsSync: Function, readFileSync: Function }} [fsLike]
 * @returns {string | null}
 */
export function lockfileHash(dir, fsLike = fs) {
  const lockfile = LOCKFILES.map((l) => path.join(dir, l)).find((p) =>
    fsLike.existsSync(p),
  );
  if (!lockfile) return null;
  try {
    const bytes = fsLike.readFileSync(lockfile);
    return crypto.createHash('sha256').update(bytes).digest('hex');
  } catch {
    return null;
  }
}

/**
 * The install is skippable iff a completed-install marker exists and the
 * worktree lockfile hash matches the donor's (vacuous with no donor).
 *
 * @param {object} opts
 * @param {string} opts.wtPath
 * @param {string} [opts.donorPath]
 * @param {{ existsSync: Function, readFileSync: Function }} [opts.fsLike]
 * @returns {{ skippable: boolean, reason: string }}
 */
export function isInstallSkippable({ wtPath, donorPath, fsLike = fs }) {
  const nmPath = path.join(wtPath, 'node_modules');
  if (!fsLike.existsSync(nmPath)) {
    return { skippable: false, reason: 'node-modules-missing' };
  }
  const marker = INSTALL_MARKERS.map((m) => path.join(nmPath, m)).find((p) =>
    fsLike.existsSync(p),
  );
  if (!marker) {
    return { skippable: false, reason: 'install-incomplete' };
  }
  const wtHash = lockfileHash(wtPath, fsLike);
  if (wtHash === null) {
    return { skippable: true, reason: 'marker-present-no-lockfile' };
  }
  if (donorPath) {
    const donorHash = lockfileHash(donorPath, fsLike);
    if (donorHash !== null && donorHash !== wtHash) {
      return { skippable: false, reason: 'lockfile-mismatch' };
    }
  }
  return { skippable: true, reason: 'lockfile-match' };
}

/**
 * Whether a reused worktree has a completed install. Reports `failed` rather
 * than a blind `skipped` so a prior failed install is retried.
 *
 * @param {string} strategy
 * @param {string} wtPath
 * @param {{ existsSync: Function, readFileSync: Function }} [fsLike]
 * @returns {{ status: 'skipped' | 'failed', reason: string }}
 */
export function probeReusedInstall(strategy, wtPath, fsLike = fs) {
  if (strategy === 'symlink') {
    return { status: 'skipped', reason: 'worktree-reused' };
  }
  if (!fsLike.existsSync(path.join(wtPath, 'package.json'))) {
    return { status: 'skipped', reason: 'no-package-json' };
  }
  const probe = isInstallSkippable({ wtPath, fsLike });
  if (probe.skippable) {
    return { status: 'skipped', reason: 'worktree-reused' };
  }
  return {
    status: 'failed',
    reason:
      probe.reason === 'node-modules-missing'
        ? 'reuse-node-modules-missing'
        : 'reuse-install-incomplete',
  };
}

/** Retry policy per command; this is the only install retry. */
export function installRetryPolicy(cmd) {
  const isPnpm = cmd === 'pnpm';
  return {
    maxAttempts: isPnpm ? 3 : 2,
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
const PNPM_STORE_PRIME_SENTINEL = path.join('temp', '.pnpm-store-primed');

/**
 * Prime the shared pnpm store once per machine (sentinel under `temp/`): on a
 * cold store, concurrent worktree installs can exhaust their retries racing
 * each other.
 *
 * @returns {{ primed: 'primed' | 'cached' | 'failed' | 'skipped', reason?: string }}
 */
function primePnpmStore({
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
 * Run the install under the retry policy.
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
 * Failure verdict for an install run (non-zero exit, or exit 0 without
 * `node_modules`), or `null` on success.
 *
 * @param {{ config: object, platform: NodeJS.Platform, logger: object }} ctx
 * @param {string} wtPath
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
  if (strategy === 'symlink') {
    return { status: 'skipped', reason: 'symlink-strategy' };
  }
  const selection = selectInstallCommand(strategy, wtPath);
  if (selection === null) {
    return { status: 'skipped', reason: 'no-package-json' };
  }
  if (strategy === 'clone') {
    const donor = resolveCloneDonor(ctx);
    const probe = isInstallSkippable({ wtPath, donorPath: donor });
    if (probe.skippable) {
      ctx.logger.info(
        `worktree.install strategy=clone skip reason=${probe.reason} path=${wtPath}`,
      );
      return { status: 'skipped', reason: `clone-${probe.reason}` };
    }
    ctx.logger.info(
      `worktree.install strategy=clone install reason=${probe.reason} path=${wtPath}`,
    );
  }
  // A failed prime only warns; the install keeps its full retry budget.
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
  // Store-backed, not self-contained: report `skipped` (dependency state N/A).
  if (strategy === 'pnpm-store') {
    return { status: 'skipped', reason: 'pnpm-store-strategy' };
  }
  return { status: 'installed' };
}

export { sleepSync };
