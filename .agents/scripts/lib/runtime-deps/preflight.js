/**
 * runtime-deps/preflight — pure messaging helpers for the dependency check.
 * Builtins only: it runs before any third-party package is imported.
 */

import fs from 'node:fs';
import { detectPackageManager as detectPm } from '../detect-package-manager.js';

/**
 * Lockfile-based, so the message names the right install command.
 *
 * @param {string} root
 * @param {(p: string) => boolean} [exists=fs.existsSync]
 * @returns {'pnpm'|'yarn'|'npm'}
 */
export function detectPackageManager(root, exists = fs.existsSync) {
  return detectPm(root, exists) ?? 'npm';
}

function installCommand(packageManager) {
  if (packageManager === 'pnpm') return 'pnpm install';
  if (packageManager === 'yarn') return 'yarn install';
  return 'npm install';
}

/**
 * Replaces the opaque `ERR_MODULE_NOT_FOUND` stack with an actionable message.
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
