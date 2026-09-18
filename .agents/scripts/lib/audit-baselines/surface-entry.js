/**
 * Health of one measuring instrument: unconfigured, missing, stub, stale, or
 * dead `ignoreGlobs` — each of which reads green from the gate's exit code.
 *
 * @module lib/audit-baselines/surface-entry
 */

import picomatch from 'picomatch';
import { GATE_KINDS, KIND_SPECS, measuredTotalOf, rollupOf } from './kinds.js';
import { stalenessOf } from './staleness.js';

/**
 * A rollup with no numeric leaves is not all-zero.
 *
 * @param {object | null} rollup
 * @returns {boolean}
 */
function isAllZeroRollup(rollup) {
  if (!rollup || typeof rollup !== 'object') return false;
  const numbers = Object.values(rollup).filter((v) => typeof v === 'number');
  return numbers.length > 0 && numbers.every((v) => v === 0);
}

/**
 * Zero rows AND an all-zero rollup, so a clean ratchet (no rollup) is never
 * called a stub.
 *
 * @param {{ rowCount: number, rollup: object | null }} args
 * @returns {boolean}
 */
function isStubInstrument({ rowCount, rollup }) {
  return rowCount === 0 && isAllZeroRollup(rollup);
}

/**
 * @param {string[]} ignoreGlobs
 * @param {string[]} files repo-relative posix paths
 * @returns {string[]} globs matching zero files
 */
function findDeadIgnoreGlobs(ignoreGlobs, files) {
  const dead = [];
  for (const glob of ignoreGlobs ?? []) {
    if (typeof glob !== 'string' || glob.length === 0) continue;
    const isMatch = picomatch(glob, { dot: true });
    if (!files.some((f) => isMatch(f))) dead.push(glob);
  }
  return dead;
}

/**
 * `rowCount` (per-file) and `measured` (own unit) legitimately differ.
 *
 * @param {{
 *   kind: string, quality: object, read: object, relPath: string,
 *   files: string[], now: Date, io: { cwd: string, run?: Function },
 * }} args
 * @returns {object}
 */
export function surfaceEntryFor({
  kind,
  quality,
  read,
  relPath,
  files,
  now,
  io,
}) {
  const gateBlock = quality?.gates?.[kind] ?? null;
  const { exists, parsed: baseline, parseError } = read;
  const rows = baseline ? KIND_SPECS[kind].rows(baseline) : [];
  const rollup = rollupOf(kind, baseline);
  return {
    kind,
    surface: GATE_KINDS.includes(kind) ? 'gate' : 'ratchet',
    baselinePath: relPath,
    configured: gateBlock !== null && typeof gateBlock === 'object',
    baselineExists: exists,
    stub: isStubInstrument({ rowCount: rows.length, rollup }),
    rowCount: rows.length,
    measured: measuredTotalOf(kind, baseline),
    ...stalenessOf({ kind, gateBlock, rows, relPath, baseline, now, io }),
    deadIgnoreGlobs: findDeadIgnoreGlobs(gateBlock?.ignoreGlobs, files),
    parseError,
  };
}
