/**
 * fs-walk.js — the one recursive file walker the lint scripts share.
 *
 * `check-lifecycle-lint.js` and `lint-label-vocabulary.js` each carried a
 * private copy of this generator, differing only in the extension they
 * matched — the second one's comment said so outright ("mirrors the walker
 * shape in check-lifecycle-lint.js"). Story #5024 extracted it: shrinking
 * check-lifecycle-lint.js pushed its duplication percentage up on an unchanged
 * clone count, which is the ratchet correctly pointing at boilerplate that
 * should not have been copied twice.
 *
 * A missing directory yields nothing rather than throwing. That is
 * load-bearing, not lenient: the lint surfaces are directories a deletion can
 * legitimately remove (Story #5024 deleted `lifecycle/listeners/`), and a scan
 * of an absent path is vacuously clean, not an error. Every other `readdir`
 * failure — a permission error, a file where a directory was expected —
 * propagates, so a genuinely broken scan cannot read as clean.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Walk a directory tree synchronously, yielding absolute paths of every file
 * whose name ends with `extension`.
 *
 * @param {string} dir Absolute directory to walk.
 * @param {string} extension Extension to match, leading dot included (`.js`).
 * @param {{ readDir?: typeof readdirSync }} [ports] Injectable for tests.
 * @returns {Generator<string, void, void>}
 */
export function* walkFilesByExtension(
  dir,
  extension,
  { readDir = readdirSync } = {},
) {
  let entries;
  try {
    entries = readDir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFilesByExtension(p, extension, { readDir });
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      yield p;
    }
  }
}
