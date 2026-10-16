/**
 * Walks both halves of the baseline surface (gates and ratchets).
 *
 * @module lib/audit-baselines/gate-surface
 */

import path from 'node:path';
import { ALL_KINDS, baselinePathFor } from './kinds.js';
import { listFilesUnder, readJsonFile } from './read.js';
import { scannerSkipDirsFor, surfaceEntryFor } from './surface-entry.js';

/**
 * One gate's declared `targetDirs`, deduplicated.
 *
 * @param {object | null | undefined} quality
 * @param {string} kind
 * @returns {string[]}
 */
function targetDirsOf(quality, kind) {
  const dirs = new Set();
  for (const dir of quality?.gates?.[kind]?.targetDirs ?? []) {
    if (typeof dir === 'string' && dir.length > 0) dirs.add(dir);
  }
  return [...dirs].sort();
}

/**
 * The files one gate's scanner could visit: its own `targetDirs`, walked with
 * its own skip set.
 *
 * @param {string} cwd
 * @param {object | null | undefined} quality
 * @param {string} kind
 * @returns {string[]}
 */
function candidateFilesFor(cwd, quality, kind) {
  const skip = scannerSkipDirsFor(kind);
  return targetDirsOf(quality, kind).flatMap((dir) =>
    listFilesUnder(cwd, dir, skip),
  );
}

/**
 * @param {{ cwd: string, quality: object, now?: Date, run?: Function }} args
 * @returns {{ entries: object[], baselines: Map<string, object|null> }}
 *   `baselines` is carried forward so later sections never re-read from disk.
 */
export function buildGateSurface({ cwd, quality, now = new Date(), run }) {
  const io = { cwd, run };
  const entries = [];
  const baselines = new Map();
  for (const kind of ALL_KINDS) {
    const relPath = baselinePathFor(kind, quality);
    const read = readJsonFile(path.resolve(cwd, relPath));
    const files = candidateFilesFor(cwd, quality, kind);
    entries.push(
      surfaceEntryFor({ kind, quality, read, relPath, files, now, io }),
    );
    baselines.set(kind, read.parsed);
  }
  return { entries, baselines };
}
