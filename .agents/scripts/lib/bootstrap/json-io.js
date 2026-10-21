/**
 * The bootstrap installers' JSON read/write pair.
 *
 * @module bootstrap/json-io
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * `null` when absent; parse errors propagate so a corrupt config fails loudly.
 *
 * @param {string} file
 * @param {typeof fs} [fsImpl]
 * @returns {any}
 */
export function readJsonIfExists(file, fsImpl = fs) {
  if (!fsImpl.existsSync(file)) return null;
  return JSON.parse(fsImpl.readFileSync(file, 'utf8'));
}

/**
 * Pretty-printed with a trailing newline; creates the parent directory.
 *
 * @param {string} file
 * @param {unknown} data
 * @param {typeof fs} [fsImpl]
 */
export function writeJson(file, data, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}
