/**
 * Shared filesystem-path helpers.
 *
 * @module lib/util/paths
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Native separators to `/`. Splits on `path.sep` only, so a literal `\` in a
 * POSIX filename survives while every win32 separator is converted.
 *
 * @param {string} p
 * @returns {string}
 */
export function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
export function dirExists(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Non-directory entries under `dir` passing `filter`, pruning `skipDirs`
 * before descent. A missing root is `[]`; any other readdir error throws,
 * or, given `onError(err, dir)`, is reported and that directory skipped.
 *
 * @param {string} dir
 * @param {{ skipDirs?: Iterable<string> | ((name: string) => boolean), filter?: (absPath: string, dirent: fs.Dirent) => boolean, onError?: (err: Error, dir: string) => void, fsImpl?: typeof fs }} [opts]
 * @returns {string[]}
 */
export function walkFiles(
  dir,
  { skipDirs = [], filter, onError, fsImpl = fs } = {},
) {
  const skip = toSkipPredicate(skipDirs);
  const out = [];
  const visit = (current) => {
    for (const dirent of readEntries(
      fsImpl,
      current,
      current === dir,
      onError,
    )) {
      const abs = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        if (!skip(dirent.name)) visit(abs);
      } else if (!filter || filter(abs, dirent)) {
        out.push(abs);
      }
    }
  };
  visit(dir);
  return out;
}

function toSkipPredicate(skipDirs) {
  if (typeof skipDirs === 'function') return skipDirs;
  const names = new Set(skipDirs);
  return (name) => names.has(name);
}

function readEntries(fsImpl, dir, isRoot, onError) {
  try {
    return fsImpl.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (isRoot && err?.code === 'ENOENT') return [];
    if (!onError) throw err;
    onError(err, dir);
    return [];
  }
}
