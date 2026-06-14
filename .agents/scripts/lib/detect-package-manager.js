/**
 * detect-package-manager — shared lockfile-probe helper (Story #4048 B3).
 *
 * Several independent copies of this lockfile probe existed across the
 * codebase before this consolidation:
 *   - `lib/cli/update.js#detectPackageManager`
 *   - `lib/bootstrap/project-bootstrap.js#detectPackageManager`
 *   - `lib/runtime-deps/preflight.js#detectPackageManager`
 *   - `lib/worktree/node-modules-strategy.js#selectInstallCommand` (inline)
 *
 * This module is the single authoritative implementation. It uses the
 * strictest semantics from the prior copies: detects `bun` in addition to
 * pnpm/yarn/npm, returns `null` when the directory has no Node manifest at
 * all (not even `package.json`), and optionally reports `workspaceRoot` for
 * pnpm (the `update.js` caller's unique requirement).
 *
 * All callers must handle `null` explicitly — it means the directory carries
 * no recognizable Node toolchain, so callers that need a concrete fallback
 * should coerce: `detectPm(root) ?? 'npm'`.
 *
 * Injectable seams: the `exists` parameter replaces `fs.existsSync` so
 * callers can drive the function with an in-memory fixture in unit tests.
 *
 * Builtins only — this module runs before third-party packages are
 * guaranteed to be present and is also imported from the worktree and
 * runtime-deps preflight guards.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Detect the package manager from lockfile and manifest presence.
 *
 * Precedence: `pnpm-lock.yaml` > `yarn.lock` > `bun.lockb` >
 * `package-lock.json` > `package.json` (npm without a lockfile yet) > `null`.
 *
 * @param {string} root - Absolute directory to probe (consumer project root).
 * @param {(p: string) => boolean} [exists=fs.existsSync] - Path existence probe.
 * @returns {'pnpm'|'yarn'|'bun'|'npm'|null}
 */
export function detectPackageManager(root, exists = fs.existsSync) {
  if (exists(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (exists(path.join(root, 'yarn.lock'))) return 'yarn';
  if (exists(path.join(root, 'bun.lockb'))) return 'bun';
  if (exists(path.join(root, 'package-lock.json'))) return 'npm';
  if (exists(path.join(root, 'package.json'))) return 'npm';
  return null;
}

/**
 * Detect the package manager and whether the directory is a pnpm workspace
 * root. The `workspaceRoot` flag is `true` only for pnpm when
 * `pnpm-workspace.yaml` is present alongside the lockfile — the signal that
 * `pnpm add` must carry `-w` to target the workspace-root manifest.
 *
 * Used by `lib/cli/update.js` which needs both pieces of information to
 * construct the correct install command.
 *
 * @param {string} root - Absolute directory to probe.
 * @param {(p: string) => boolean} [exists=fs.existsSync] - Path existence probe.
 * @returns {{ packageManager: 'pnpm'|'yarn'|'bun'|'npm', workspaceRoot: boolean }}
 */
export function detectPackageManagerWithWorkspace(
  root,
  exists = fs.existsSync,
) {
  const pm = detectPackageManager(root, exists) ?? 'npm';
  const workspaceRoot =
    pm === 'pnpm' && exists(path.join(root, 'pnpm-workspace.yaml'));
  return { packageManager: pm, workspaceRoot };
}
