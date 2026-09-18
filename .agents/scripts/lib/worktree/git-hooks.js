/**
 * Materialize the git hooks directory into a linked worktree. Git resolves a
 * relative `core.hooksPath` per working tree, and husky's gitignored `.husky/_`
 * exists only in the main checkout, so without this no hook runs in a
 * worktree. Nothing-to-do cases skip; every other outcome materializes or
 * throws, never a silent skip.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as defaultGit from '../git-utils.js';
import { assertPathContainment } from '../path-security.js';

// Skip reasons are printed contract strings, so deliberately not exported.
// same-checkout: copying the source onto itself would destroy the only copy.
const SKIP_UNSET = 'hooks-path-unset';
const SKIP_ABSOLUTE = 'hooks-path-absolute';
const SKIP_SOURCE_ABSENT = 'source-absent';
const SKIP_SAME_CHECKOUT = 'same-checkout';

/**
 * `core.hooksPath`, or `null` when unset or empty.
 *
 * @param {string} repoRoot
 * @param {{ gitSpawn: Function }} gitImpl
 * @returns {string|null}
 */
function readHooksPath(repoRoot, gitImpl) {
  const res = gitImpl.gitSpawn(repoRoot, 'config', '--get', 'core.hooksPath');
  if (res.status !== 0) return null;
  const value = (res.stdout ?? '').trim();
  return value.length > 0 ? value : null;
}

/**
 * Realpath for identity comparison (macOS `/var` → `/private/var`).
 *
 * @param {string} dir
 * @param {typeof fs} fsImpl
 * @returns {string}
 */
function canonical(dir, fsImpl) {
  const resolved = path.resolve(dir);
  try {
    return fsImpl.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * @param {string} dir
 * @param {typeof fs} fsImpl
 * @returns {string[]}
 */
function hookFileNames(dir, fsImpl) {
  return fsImpl
    .readdirSync(dir, { withFileTypes: true })
    .filter((ent) => ent.isFile())
    .map((ent) => ent.name)
    .sort();
}

/**
 * Idempotent; replaces an existing target so no stale shim survives.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} opts.worktree
 * @param {{ gitSpawn: Function }} [opts.gitImpl]
 * @param {typeof fs} [opts.fsImpl]
 * @returns {{ action: 'materialized' | 'skipped', reason?: string,
 *   hooksPath: string|null, source: string|null, target: string|null,
 *   hooks: string[] }}
 * @throws {Error} when the source exists but the hooks could not be placed.
 */
export function materializeGitHooks({
  repoRoot,
  worktree,
  gitImpl = defaultGit,
  fsImpl = fs,
} = {}) {
  if (!repoRoot || typeof repoRoot !== 'string') {
    throw new Error('worktree.hooks: repoRoot is required');
  }
  if (!worktree || typeof worktree !== 'string') {
    throw new Error('worktree.hooks: worktree is required');
  }

  const skip = (reason, hooksPath = null) => ({
    action: 'skipped',
    reason,
    hooksPath,
    source: null,
    target: null,
    hooks: [],
  });

  const hooksPath = readHooksPath(repoRoot, gitImpl);
  if (hooksPath === null) return skip(SKIP_UNSET);
  if (path.isAbsolute(hooksPath)) return skip(SKIP_ABSOLUTE, hooksPath);

  if (canonical(repoRoot, fsImpl) === canonical(worktree, fsImpl)) {
    return skip(SKIP_SAME_CHECKOUT, hooksPath);
  }

  const source = path.resolve(repoRoot, hooksPath);
  if (!fsImpl.existsSync(source)) return skip(SKIP_SOURCE_ABSENT, hooksPath);

  const target = path.resolve(worktree, hooksPath);
  // The value reaches a recursive remove; `../..` must not escape the worktree.
  assertPathContainment(
    path.resolve(worktree),
    target,
    'worktree.hooks: core.hooksPath',
    { allowEmpty: false },
  );

  try {
    fsImpl.rmSync(target, { recursive: true, force: true });
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    fsImpl.cpSync(source, target, { recursive: true });
  } catch (err) {
    throw new Error(
      `worktree.hooks: failed to materialize ${source} into ${target}: ${err.message}`,
    );
  }

  // Verify: missing hooks fail silently in git.
  const expected = hookFileNames(source, fsImpl);
  const actual = new Set(
    fsImpl.existsSync(target) ? hookFileNames(target, fsImpl) : [],
  );
  const missing = expected.filter((name) => !actual.has(name));
  if (missing.length > 0) {
    throw new Error(
      `worktree.hooks: materialized ${target} is missing ${missing.length} hook(s): ${missing.join(', ')}`,
    );
  }

  return { action: 'materialized', hooksPath, source, target, hooks: expected };
}

/**
 * The main checkout: parent of `--git-common-dir`, from any working tree.
 *
 * @param {string} cwd
 * @param {{ execFileSyncImpl?: typeof execFileSync }} [deps]
 * @returns {string}
 */
export function resolveCommonCheckout(
  cwd,
  { execFileSyncImpl = execFileSync } = {},
) {
  const out = execFileSyncImpl('git', ['rev-parse', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
  }).trim();
  return path.dirname(path.resolve(cwd, out));
}
