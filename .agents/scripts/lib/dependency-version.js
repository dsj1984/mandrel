/**
 * dependency-version.js — read an installed package's version from its
 * manifest without evaluating the package (`require(pkg).version` pays the
 * whole module init; for `typescript` that is tens of ms and MB per gate).
 * Unlike `crap-utils.js#resolveEscomplexVersion`, this resolves from this
 * module's location, not a scanned `cwd`.
 *
 * @module lib/dependency-version
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Tries `<pkg>/package.json` first; when `exports` withholds it, resolves the
 * main entry and walks up — still evaluation-free.
 *
 * @param {string} name
 * @param {NodeJS.Require} requireFn
 * @returns {string | null}
 */
function resolveManifestPath(name, requireFn) {
  try {
    return requireFn.resolve(`${name}/package.json`);
  } catch {
    // fall through to the main-entry walk
  }
  let dir;
  try {
    dir = path.dirname(requireFn.resolve(name));
  } catch {
    return null;
  }
  const { root } = path.parse(dir);
  while (true) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * `null` — never a guess or a throw — when unresolvable or versionless.
 *
 * @param {string} name
 * @param {NodeJS.Require} requireFn
 * @returns {string | null}
 */
export function resolveDependencyVersion(name, requireFn) {
  const manifest = resolveManifestPath(name, requireFn);
  if (!manifest) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf-8'));
    if (parsed && typeof parsed.version === 'string' && parsed.version) {
      return parsed.version;
    }
  } catch {
    // unreadable / unparseable manifest
  }
  return null;
}
