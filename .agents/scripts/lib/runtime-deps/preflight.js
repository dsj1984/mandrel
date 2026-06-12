/**
 * runtime-deps/preflight — pure helpers for the dependency-presence check.
 *
 * These functions hold no side effects so they are unit-testable in
 * isolation: `checkRuntimeDeps` takes an injected `resolve` seam,
 * `detectPackageManager` takes an injected `exists` seam, and
 * `formatMissingDepsMessage` is a pure string builder. The side-effecting
 * guard that wires them to the real process lives in `ensure-installed.js`.
 *
 * Builtins only — this module runs *before* any third-party package is
 * imported, so importing a third-party here would defeat its own purpose.
 */

import fs from 'node:fs';
import { detectPackageManager as detectPm } from '../detect-package-manager.js';

/**
 * Resolve each required package via the injected `resolve` seam and collect
 * the ones that fail. `resolve` is typically `require.resolve` bound to the
 * framework module location; it throws `MODULE_NOT_FOUND` when a package is
 * absent from the resolvable `node_modules`.
 *
 * @param {{ required: string[], resolve: (specifier: string) => string }} opts
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function checkRuntimeDeps({ required, resolve }) {
  const missing = [];
  for (const dep of required) {
    try {
      resolve(dep);
    } catch {
      missing.push(dep);
    }
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Detect the consumer's package manager from lockfile presence so the
 * remediation message names the right install command. Defaults to `npm`.
 *
 * Delegates to the shared `detectPackageManager` helper
 * (Story #4048 B3 — one implementation per concept). The `exists` seam
 * is forwarded directly; `null` (no manifest) coerces to `'npm'`.
 *
 * @param {string} root
 * @param {(p: string) => boolean} [exists=fs.existsSync]
 * @returns {'pnpm'|'yarn'|'npm'}
 */
export function detectPackageManager(root, exists = fs.existsSync) {
  return detectPm(root, exists) ?? 'npm';
}

/** Map a detected package manager to its install command. */
function installCommand(packageManager) {
  if (packageManager === 'pnpm') return 'pnpm install';
  if (packageManager === 'yarn') return 'yarn install';
  return 'npm install';
}

/**
 * Build the actionable remediation message naming the missing packages and
 * the consumer's install command. This is what replaces the opaque raw
 * `ERR_MODULE_NOT_FOUND` stack trace.
 *
 * @param {string[]} missing
 * @param {{ root: string, packageManager: 'pnpm'|'yarn'|'npm' }} opts
 * @returns {string}
 */
export function formatMissingDepsMessage(missing, { root, packageManager }) {
  return [
    'Framework runtime dependencies are not installed.',
    `Missing from node_modules/: ${missing.join(', ')}.`,
    `The .agents/ framework scripts require these packages (declared in ` +
      `.agents/runtime-deps.json) to be installed in this repository.`,
    `Run \`${installCommand(packageManager)}\` in ${root}, then re-run this command.`,
  ].join('\n');
}
