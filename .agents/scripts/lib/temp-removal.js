/**
 * Filesystem primitives for the temp-retention engine: sizing a tree and
 * deleting one while sparing the never-purged basenames at any depth.
 */

import path from 'node:path';

/**
 * Never deleted, re-checked at the deletion site: `signals.ndjson` is read
 * long after merge and its loss is silent and unrecoverable.
 */
export const KEEP_BASENAMES = Object.freeze(['signals.ndjson']);

/**
 * `readdir` yielding `[]` for an absent or unreadable directory.
 *
 * @param {typeof import('node:fs/promises')} fsp
 * @param {string} dir
 * @returns {Promise<import('node:fs').Dirent[]>}
 */
export async function safeReaddir(fsp, dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Recursive byte total; a vanished child is skipped.
 *
 * @param {typeof import('node:fs/promises')} fsp
 * @param {string} target
 * @returns {Promise<number>}
 */
export async function sizeOf(fsp, target) {
  let total = 0;
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop();
    let stats;
    try {
      stats = await fsp.stat(current);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) {
      total += stats.size;
      continue;
    }
    for (const child of await safeReaddir(fsp, current)) {
      stack.push(path.join(current, child.name));
    }
  }
  return total;
}

/**
 * Paths of every never-purged basename at any depth under `target`.
 *
 * @param {typeof import('node:fs/promises')} fsp
 * @param {string} target
 * @returns {Promise<string[]>}
 */
async function findKeptDescendants(fsp, target) {
  const kept = [];
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const child of await safeReaddir(fsp, current)) {
      const childPath = path.join(current, child.name);
      if (child.isDirectory()) stack.push(childPath);
      else if (KEEP_BASENAMES.includes(child.name)) kept.push(childPath);
    }
  }
  return kept;
}

/**
 * Delete `target` while sparing every never-purged basename beneath it: a
 * tree holding none goes in one `rm`; otherwise its children are removed
 * one by one and the kept files (with their parent dirs) stay.
 *
 * @param {typeof import('node:fs/promises')} fsp
 * @param {string} target
 * @param {number} [knownBytes] Pre-computed size, spared a second walk.
 * @returns {Promise<{ bytes: number, kept: string[] }>}
 */
export async function removeSparingKept(fsp, target, knownBytes) {
  const stats = await fsp.stat(target);
  if (!stats.isDirectory()) {
    if (KEEP_BASENAMES.includes(path.basename(target))) {
      return { bytes: 0, kept: [target] };
    }
    await fsp.rm(target, { force: true });
    return { bytes: stats.size, kept: [] };
  }
  const kept = await findKeptDescendants(fsp, target);
  if (kept.length === 0) {
    const bytes = knownBytes ?? (await sizeOf(fsp, target));
    await fsp.rm(target, { recursive: true, force: true });
    return { bytes, kept };
  }
  let bytes = 0;
  for (const child of await safeReaddir(fsp, target)) {
    bytes += (await removeSparingKept(fsp, path.join(target, child.name)))
      .bytes;
  }
  return { bytes, kept };
}
