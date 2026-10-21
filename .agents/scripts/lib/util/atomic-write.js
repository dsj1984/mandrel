import fs from 'node:fs';
import path from 'node:path';

/**
 * Tmp-then-rename via a pid-scoped sibling; reaps the tmp and rethrows on
 * failure. A string is written as UTF-8; a Buffer is written byte-for-byte.
 *
 * @param {string} target
 * @param {string | Buffer} contents
 * @param {{ fsImpl?: typeof fs }} [opts]
 */
export function writeFileAtomic(target, contents, { fsImpl = fs } = {}) {
  replaceAtomic(target, fsImpl, (tmp) =>
    fsImpl.writeFileSync(tmp, contents, 'utf8'),
  );
}

/** {@link writeFileAtomic} for a copy; keeps `source`'s mode bits. */
export function copyFileAtomic(source, target, { fsImpl = fs } = {}) {
  replaceAtomic(target, fsImpl, (tmp) => fsImpl.copyFileSync(source, tmp));
}

function replaceAtomic(target, fsImpl, fill) {
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    fill(tmp);
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
