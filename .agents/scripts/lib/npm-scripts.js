/**
 * npm-scripts.js — shared `package.json` scripts probe (Story #4473).
 *
 * A single, dependency-free reader used wherever the framework must decide
 * whether a consumer actually ships a given npm script before spawning
 * `npm run <name>`. Two call sites depend on it:
 *   - `close-validation/gates.js` — only registers the coverage-capture gate
 *     when a `test:coverage` script exists (otherwise a consumer without it
 *     turns the gate into a guaranteed first-try close failure).
 *   - `coverage-capture.js` — fails fast with a one-line, fix-naming
 *     diagnostic instead of surfacing npm's opaque "Missing script" exit when
 *     invoked without the script.
 *
 * The reader is deliberately forgiving: any failure (missing file,
 * unreadable, unparseable, or no `scripts` object) resolves to an empty map
 * so callers treat "cannot prove the script exists" as "absent" without
 * throwing.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Read the `scripts` map from the `package.json` at `cwd`.
 *
 * @param {string|undefined|null} cwd - Directory containing `package.json`.
 *   Defaults to `process.cwd()`.
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
 * Does the consumer define a runnable npm script by this name? A script is
 * "runnable" when it is a present, non-empty string.
 *
 * @param {Record<string, string>} scripts - A scripts map (from
 *   `readPackageScripts`).
 * @param {string} name - The script name to check (e.g. `test:coverage`).
 * @returns {boolean}
 */
export function hasNpmScript(scripts, name) {
  const s = scripts?.[name];
  return typeof s === 'string' && s.trim().length > 0;
}
