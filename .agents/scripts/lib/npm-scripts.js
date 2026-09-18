/**
 * npm-scripts.js — does the consumer ship an npm script, checked before
 * spawning `npm run <name>`. Any read failure means "absent", never a throw.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * @param {string|undefined|null} cwd - Directory containing `package.json`.
 * @returns {Record<string, string>} The scripts map, or `{}` on any failure.
 */
export function readPackageScripts(cwd) {
  try {
    const pkgPath = path.join(cwd || process.cwd(), 'package.json');
    if (!existsSync(pkgPath)) return {};
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return parsed && typeof parsed.scripts === 'object' && parsed.scripts
      ? parsed.scripts
      : {};
  } catch {
    return {};
  }
}

/**
 * Runnable means a present, non-empty string.
 *
 * @param {Record<string, string>} scripts - A scripts map.
 * @param {string} name - The script name to check (e.g. `test:coverage`).
 * @returns {boolean}
 */
export function hasNpmScript(scripts, name) {
  const s = scripts?.[name];
  return typeof s === 'string' && s.trim().length > 0;
}
