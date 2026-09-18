/**
 * detect-package-manager — the single lockfile probe. `null` means no Node
 * manifest at all; callers needing a default coerce (`?? 'npm'`). Builtins
 * only: it runs before third-party packages are guaranteed present.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Precedence: pnpm > yarn > bun > package-lock > bare `package.json` (npm).
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
 * `workspaceRoot` is true only for pnpm with `pnpm-workspace.yaml` — then
 * `pnpm add` needs `-w`.
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
