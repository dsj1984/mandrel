// bench/driver/sandbox.js
/**
 * Ephemeral sandbox-repo lifecycle for the Mandrel self-benchmark harness.
 *
 * The harness must never mutate the live `mandrel` repo (Epic #4211 Non-Goal:
 * "Running against the live `mandrel` repo"). Every benchmark run executes in a
 * throwaway clone of a dedicated sandbox GitHub repo, created under the OS temp
 * directory and torn down when the run finishes.
 *
 * Two operations:
 *   - `provisionSandbox(opts)` — `git clone` the configured sandbox repo into a
 *     fresh `mkdtemp` workspace and return a handle describing it. For the
 *     control arm the materialized `.agents/` bundle is stripped so the bare
 *     model receives no Mandrel scaffolding (Tech Spec #4213: "The control arm
 *     clone has **no** `.agents/` scaffolding").
 *   - `teardownSandbox(handle)` — recursively remove the workspace, with the
 *     removal path asserted to live strictly inside the configured ephemeral
 *     root before a single byte is deleted.
 *
 * SECURITY (security-baseline + Story #4216 binding contract): teardown is
 * scoped strictly to the ephemeral workspace path. `assertInsideRoot` rejects
 * any path that is not a proper descendant of the ephemeral root, so a
 * malformed or adversarial handle can never escalate into an `rm -rf` of a real
 * repository, the home directory, or `/`. The git binary is invoked via
 * `execFileSync` with an argument array — never a shell string — so a
 * repo-URL or path value can never be interpreted as a shell command.
 *
 * All external effects (`git`, `mkdtemp`, `rm`, `existsSync`) are injectable so
 * the unit tests exercise the full provision/teardown contract — including the
 * path-containment guard — without cloning a real repository or deleting real
 * files.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Canonical prefix for every ephemeral sandbox workspace directory. Exported so
 * tests and teardown share one constant rather than a magic string.
 */
export const SANDBOX_DIR_PREFIX = 'mandrel-bench-sandbox-';

/**
 * Default ephemeral root under which all sandbox workspaces are created. Kept
 * as a function (not a const) so each call re-reads `tmpdir()` — the value is
 * environment-dependent and tests override it explicitly.
 *
 * @returns {string}
 */
export function defaultEphemeralRoot() {
  return tmpdir();
}

/**
 * Assert that `target` is a path strictly *inside* `root` (a proper
 * descendant, never `root` itself and never an escape via `..` or an absolute
 * re-root). Returns the resolved absolute target on success.
 *
 * This is the load-bearing safety check for teardown: it runs before any
 * filesystem removal and converts a bad path into a thrown Error rather than a
 * destructive delete. Mirrors `.agents/scripts/lib/path-security.js` but is
 * inlined so the bench tree carries no dependency on the distributed bundle.
 *
 * @param {string} root    Absolute path of the containing ephemeral root.
 * @param {string} target  Path to validate (resolved against `root`).
 * @param {string} label   Human-readable identifier for the error message.
 * @returns {string} The resolved absolute `target`.
 * @throws {Error} when `target` is not strictly inside `root`.
 */
export function assertInsideRoot(root, target, label = 'path') {
  if (typeof root !== 'string' || root.length === 0) {
    throw new TypeError('assertInsideRoot requires a non-empty root');
  }
  if (typeof target !== 'string' || target.length === 0) {
    throw new TypeError('assertInsideRoot requires a non-empty target');
  }
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, target);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  const escapes = rel === '' || rel.startsWith('..') || path.isAbsolute(rel);
  if (escapes) {
    throw new Error(
      `${label} resolves outside the ephemeral sandbox root ${resolvedRoot}: ${resolvedTarget}`,
    );
  }
  return resolvedTarget;
}

/**
 * @typedef {object} SandboxHandle
 * @property {string} workspacePath  Absolute path to the ephemeral clone root.
 * @property {string} ephemeralRoot  Absolute path of the temp root the clone lives under.
 * @property {string} repoUrl        The sandbox repo URL that was cloned.
 * @property {'mandrel'|'control'} arm  Which benchmark arm this workspace serves.
 * @property {string|null} ref       The branch/ref checked out, or null for default.
 * @property {boolean} agentsStripped Whether `.agents/` was removed (true for the control arm).
 */

/**
 * @typedef {object} ProvisionDeps
 * @property {(cmd: string, args: string[], opts: object) => unknown} [execFileFn]
 *   Injected `execFileSync`. Defaults to the real one. Tests stub this so no
 *   real `git clone` runs.
 * @property {(prefix: string) => string} [mkdtempFn]
 *   Injected directory factory. Receives the full `<root>/<prefix>` argument
 *   and returns the created absolute path. Defaults to `mkdtempSync`.
 * @property {(p: string) => boolean} [existsFn]  Injected `existsSync`.
 * @property {(p: string, opts: object) => void} [rmFn]  Injected `rmSync`.
 * @property {{ info?: Function, warn?: Function }} [logger]
 */

/**
 * Provision a fresh ephemeral clone of the configured sandbox repo.
 *
 * @param {object} opts
 * @param {string} opts.repoUrl  Sandbox repo URL or local path to clone.
 * @param {'mandrel'|'control'} [opts.arm='mandrel']  Benchmark arm.
 * @param {string|null} [opts.ref=null]  Branch / ref to check out (default branch when null).
 * @param {string} [opts.ephemeralRoot]  Temp root to clone under. Defaults to `tmpdir()`.
 * @param {number} [opts.depth=1]  `git clone --depth` value (shallow by default).
 * @param {ProvisionDeps} [deps]
 * @returns {SandboxHandle}
 */
export function provisionSandbox(opts = {}, deps = {}) {
  const {
    repoUrl,
    arm = 'mandrel',
    ref = null,
    ephemeralRoot = defaultEphemeralRoot(),
    depth = 1,
  } = opts;

  if (typeof repoUrl !== 'string' || repoUrl.length === 0) {
    throw new TypeError('provisionSandbox requires a non-empty repoUrl');
  }
  if (arm !== 'mandrel' && arm !== 'control') {
    throw new TypeError(
      `provisionSandbox arm must be "mandrel" or "control", got: ${String(arm)}`,
    );
  }

  const execFileFn = deps.execFileFn ?? execFileSync;
  const mkdtempFn = deps.mkdtempFn ?? mkdtempSync;
  const existsFn = deps.existsFn ?? existsSync;
  const rmFn = deps.rmFn ?? rmSync;
  const logger = deps.logger;

  const resolvedRoot = path.resolve(ephemeralRoot);
  // mkdtemp appends random chars to the prefix; we pass the full root+prefix.
  const workspacePath = path.resolve(
    mkdtempFn(path.join(resolvedRoot, SANDBOX_DIR_PREFIX)),
  );
  // Defense in depth: the freshly minted workspace must itself sit inside root.
  assertInsideRoot(resolvedRoot, workspacePath, 'sandbox workspace');

  logger?.info?.(
    `[sandbox] Cloning ${repoUrl} → ${workspacePath} (arm=${arm}, depth=${depth})`,
  );

  const cloneArgs = ['clone', '--depth', String(depth)];
  if (ref) {
    cloneArgs.push('--branch', ref);
  }
  cloneArgs.push('--', repoUrl, workspacePath);

  try {
    execFileFn('git', cloneArgs, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5 * 60 * 1000,
    });
  } catch (err) {
    // Clone failed — best-effort clean up the (possibly partial) workspace so a
    // failed provision never leaks a temp directory, then rethrow.
    try {
      const safe = assertInsideRoot(
        resolvedRoot,
        workspacePath,
        'sandbox workspace (failed-clone cleanup)',
      );
      if (existsFn(safe)) {
        rmFn(safe, { recursive: true, force: true });
      }
    } catch {
      // Swallow cleanup errors — the original clone error is what matters.
    }
    throw new Error(
      `[sandbox] git clone failed for ${repoUrl}: ${err?.message ?? err}`,
    );
  }

  let agentsStripped = false;
  if (arm === 'control') {
    // The control arm is the bare-model baseline: it must carry NO Mandrel
    // scaffolding so the overhead ratio is apples-to-apples by construction.
    const agentsPath = assertInsideRoot(
      workspacePath,
      path.join(workspacePath, '.agents'),
      'control-arm .agents bundle',
    );
    if (existsFn(agentsPath)) {
      rmFn(agentsPath, { recursive: true, force: true });
      agentsStripped = true;
      logger?.info?.(
        `[sandbox] Stripped .agents/ for control arm: ${agentsPath}`,
      );
    }
  }

  return {
    workspacePath,
    ephemeralRoot: resolvedRoot,
    repoUrl,
    arm,
    ref,
    agentsStripped,
  };
}

/**
 * @typedef {object} TeardownDeps
 * @property {(p: string) => boolean} [existsFn]  Injected `existsSync`.
 * @property {(p: string) => { isDirectory: () => boolean }} [statFn]  Injected `statSync`.
 * @property {(p: string, opts: object) => void} [rmFn]  Injected `rmSync`.
 * @property {{ info?: Function, warn?: Function }} [logger]
 */

/**
 * Tear down an ephemeral sandbox workspace. The removal target is asserted to
 * live strictly inside the handle's `ephemeralRoot` *before* any deletion — a
 * handle whose `workspacePath` is not a descendant of its `ephemeralRoot`
 * throws and removes nothing. This is the strict-scoping guarantee in the
 * Story #4216 binding contract: teardown can only ever delete the throwaway
 * workspace, never a real repo.
 *
 * Idempotent: tearing down an already-removed workspace is a no-op.
 *
 * @param {SandboxHandle} handle
 * @param {TeardownDeps} [deps]
 * @returns {{ removed: boolean, workspacePath: string }}
 */
export function teardownSandbox(handle, deps = {}) {
  if (!handle || typeof handle !== 'object') {
    throw new TypeError('teardownSandbox requires a sandbox handle');
  }
  const { workspacePath, ephemeralRoot } = handle;
  if (typeof workspacePath !== 'string' || workspacePath.length === 0) {
    throw new TypeError('teardownSandbox handle requires workspacePath');
  }
  if (typeof ephemeralRoot !== 'string' || ephemeralRoot.length === 0) {
    throw new TypeError('teardownSandbox handle requires ephemeralRoot');
  }

  const existsFn = deps.existsFn ?? existsSync;
  const statFn = deps.statFn ?? statSync;
  const rmFn = deps.rmFn ?? rmSync;
  const logger = deps.logger;

  // The single safety gate: assert containment before touching the filesystem.
  const safeTarget = assertInsideRoot(
    ephemeralRoot,
    workspacePath,
    'sandbox teardown target',
  );

  if (!existsFn(safeTarget)) {
    logger?.info?.(`[sandbox] Teardown no-op (already gone): ${safeTarget}`);
    return { removed: false, workspacePath: safeTarget };
  }

  // Guard against pointing teardown at a file or a symlink masquerading as the
  // workspace — only ever recursively remove an actual directory.
  const stat = statFn(safeTarget);
  if (!stat.isDirectory()) {
    throw new Error(
      `[sandbox] teardown target is not a directory, refusing to remove: ${safeTarget}`,
    );
  }

  logger?.info?.(`[sandbox] Removing ephemeral workspace: ${safeTarget}`);
  rmFn(safeTarget, { recursive: true, force: true });
  return { removed: true, workspacePath: safeTarget };
}

/**
 * Convenience wrapper: provision a sandbox, run `fn(handle)`, and guarantee
 * teardown even when `fn` throws. The harness uses this so a crashed run can
 * never leak a workspace (Epic AC: "tears down each workspace").
 *
 * @template T
 * @param {object} provisionOpts  Forwarded to `provisionSandbox`.
 * @param {(handle: SandboxHandle) => Promise<T> | T} fn
 * @param {{ provision?: ProvisionDeps, teardown?: TeardownDeps }} [deps]
 * @returns {Promise<T>}
 */
export async function withSandbox(provisionOpts, fn, deps = {}) {
  const handle = provisionSandbox(provisionOpts, deps.provision);
  try {
    return await fn(handle);
  } finally {
    teardownSandbox(handle, deps.teardown);
  }
}
