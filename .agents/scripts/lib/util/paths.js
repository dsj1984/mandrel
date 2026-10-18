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
 * before descent. A missing root is `[]`; other readdir errors throw.
 *
 * @param {string} dir
 * @param {{ skipDirs?: Iterable<string> | ((name: string) => boolean), filter?: (absPath: string, dirent: fs.Dirent) => boolean, fsImpl?: typeof fs }} [opts]
 * @returns {string[]}
 */
export function walkFiles(dir, { skipDirs = [], filter, fsImpl = fs } = {}) {
  const skipSet = typeof skipDirs === 'function' ? null : new Set(skipDirs);
  const skip = skipSet ? (name) => skipSet.has(name) : skipDirs;
  const out = [];
  const visit = (current, entries) => {
    for (const dirent of entries) {
      const abs = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        if (!skip(dirent.name)) visit(abs, readEntries(fsImpl, abs));
      } else if (!filter || filter(abs, dirent)) {
        out.push(abs);
      }
    }
  };
  let rootEntries;
  try {
    rootEntries = readEntries(fsImpl, dir);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  visit(dir, rootEntries);
  return out;
}

function readEntries(fsImpl, dir) {
  return fsImpl.readdirSync(dir, { withFileTypes: true });
}
