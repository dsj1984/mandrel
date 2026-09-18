/**
 * Walks both halves of the baseline surface (gates and ratchets).
 *
 * @module lib/audit-baselines/gate-surface
 */

import path from 'node:path';
import { ALL_KINDS, baselinePathFor, GATE_KINDS } from './kinds.js';
import { listFilesUnder, readJsonFile } from './read.js';
import { surfaceEntryFor } from './surface-entry.js';

/**
 * The file universe `ignoreGlobs` are checked against.
 *
 * @param {object | null | undefined} quality
 * @returns {string[]}
 */
function declaredTargetDirs(quality) {
  const dirs = new Set();
  for (const kind of GATE_KINDS) {
    for (const dir of quality?.gates?.[kind]?.targetDirs ?? []) {
      if (typeof dir === 'string' && dir.length > 0) dirs.add(dir);
    }
  }
  return [...dirs].sort();
}

/**
 * @param {{ cwd: string, quality: object, now?: Date, run?: Function }} args
 * @returns {{ entries: object[], baselines: Map<string, object|null> }}
 *   `baselines` is carried forward so later sections never re-read from disk.
 */
export function buildGateSurface({ cwd, quality, now = new Date(), run }) {
  const files = declaredTargetDirs(quality).flatMap((dir) =>
    listFilesUnder(cwd, dir),
  );
  const io = { cwd, run };
  const entries = [];
  const baselines = new Map();
  for (const kind of ALL_KINDS) {
    const relPath = baselinePathFor(kind, quality);
    const read = readJsonFile(path.resolve(cwd, relPath));
    entries.push(
      surfaceEntryFor({ kind, quality, read, relPath, files, now, io }),
    );
    baselines.set(kind, read.parsed);
  }
  return { entries, baselines };
}
