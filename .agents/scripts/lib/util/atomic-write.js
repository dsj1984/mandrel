import fs from 'node:fs';
import path from 'node:path';

/**
 * Tmp-then-rename via a pid-scoped sibling; reaps the tmp and rethrows on
 * failure.
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

function reapTmp(fsImpl, tmp) {
  try {
    if (typeof fsImpl.rmSync === 'function')
      fsImpl.rmSync(tmp, { force: true });
    else fsImpl.unlinkSync(tmp);
  } catch {}
}
