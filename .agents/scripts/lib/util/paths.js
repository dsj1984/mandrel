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
