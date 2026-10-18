/**
 * The one tmp-then-rename write: a reader never sees a partial file.
 *
 * @module lib/util/atomic-write
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Write `contents` to `target` through a pid-scoped tmp sibling (same
 * directory, so the rename is atomic and two processes never share a tmp).
 * Creates the parent directory. On any failure the tmp is reaped and the
 * error rethrown — a best-effort caller keeps its own `try/catch`.
 *
 * @param {string} target
 * @param {string} contents
 * @param {{ fsImpl?: typeof fs }} [opts]
 */
export function writeFileAtomic(target, contents, { fsImpl = fs } = {}) {
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    fsImpl.writeFileSync(tmp, contents, 'utf8');
    fsImpl.renameSync(tmp, target);
  } catch (err) {
    reapTmp(fsImpl, tmp);
    throw err;
  }
}

/** Best-effort removal; an injected fs may carry `rmSync` or `unlinkSync`. */
function reapTmp(fsImpl, tmp) {
  try {
    if (typeof fsImpl.rmSync === 'function')
      fsImpl.rmSync(tmp, { force: true });
    else fsImpl.unlinkSync(tmp);
  } catch {
    // Never written, or already gone.
  }
}
