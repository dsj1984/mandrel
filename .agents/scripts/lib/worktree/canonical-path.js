/**
 * worktree/canonical-path.js — the on-disk identity of a path, for every
 * worktree identity and containment comparison.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * `realpathSync.native` resolves symlinks (macOS `/var` ↔ `/private/var`) and
 * expands Windows 8.3 short names (`RUNNER~1` ↔ `runneradmin`) — `git
 * worktree list` reports the long form while `os.tmpdir()` / `process.cwd()`
 * may carry the short one. A path that no longer exists canonicalises its
 * nearest existing ancestor and re-appends the rest.
 *
 * @param {string} p
 * @param {{ realpath?: (p: string) => string }} [deps]
 * @returns {string}
 */
export function canonicalPath(p, { realpath = fs.realpathSync.native } = {}) {
  const resolved = path.resolve(p);
  const tail = [];
  let current = resolved;
  for (;;) {
    try {
      return path.join(realpath(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}
