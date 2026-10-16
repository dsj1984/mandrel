/**
 * Health of one measuring instrument: unconfigured, missing, stub, stale, or
 * dead `ignoreGlobs` — each of which reads green from the gate's exit code.
 *
 * @module lib/audit-baselines/surface-entry
 */

import picomatch from 'picomatch';
import { IGNORED_DIRS } from '../maintainability-utils.js';
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
 * Directory names each gate's own scanner never descends into. CRAP and
 * maintainability share the `scanDirectory` walk; duplication runs jscpd with
 * `gitignore: false` over its `targetDirs`, so it skips nothing. A kind absent
 * here declares no `ignoreGlobs` and skips nothing.
 *
 * @type {Readonly<Record<string, ReadonlySet<string>>>}
 */
const SCANNER_SKIP_DIRS = Object.freeze({
  crap: IGNORED_DIRS,
  maintainability: IGNORED_DIRS,
});

const NO_SKIP = new Set();

/**
 * @param {string} kind
 * @returns {ReadonlySet<string>}
 */
export function scannerSkipDirsFor(kind) {
  return SCANNER_SKIP_DIRS[kind] ?? NO_SKIP;
}

/**
 * Generated or installed trees: absent from a fresh checkout, present after an
 * install or build. A glob aimed at one is load-bearing whenever the gate's
 * scanner would descend there, whatever is on disk today.
 */
const GENERATED_TREE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
]);

const GLOB_META = /[*?[\]{}()!+@]/;

/**
 * A glob is latent when one of its literal segments names a generated tree the
 * scanner would walk into, so an empty match today is not evidence of death.
 *
 * @param {string} glob
 * @param {ReadonlySet<string>} scannerSkipDirs
 * @returns {boolean}
 */
function isLatentGlob(glob, scannerSkipDirs) {
  return glob
    .split('/')
    .some(
      (segment) =>
        !GLOB_META.test(segment) &&
        GENERATED_TREE_DIRS.has(segment) &&
        !scannerSkipDirs.has(segment),
    );
}

/**
 * @param {unknown} glob
 * @param {ReadonlySet<string>} scannerSkipDirs
 * @returns {boolean} a non-empty, non-latent glob string
 */
function isJudgeableGlob(glob, scannerSkipDirs) {
  return (
    typeof glob === 'string' &&
    glob.length > 0 &&
    !isLatentGlob(glob, scannerSkipDirs)
  );
}

/**
 * @param {string} glob
 * @param {string[]} files
 * @returns {boolean}
 */
function matchesNothing(glob, files) {
  const isMatch = picomatch(glob, { dot: true });
  return !files.some((f) => isMatch(f));
}

/**
 * @param {string[]} ignoreGlobs
 * @param {string[]} files repo-relative posix paths the gate's scanner walks
 * @param {ReadonlySet<string>} scannerSkipDirs
 * @returns {string[]} non-latent globs matching zero files
 */
function findDeadIgnoreGlobs(ignoreGlobs, files, scannerSkipDirs) {
  return (ignoreGlobs ?? []).filter(
    (glob) =>
      isJudgeableGlob(glob, scannerSkipDirs) && matchesNothing(glob, files),
  );
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
    deadIgnoreGlobs: findDeadIgnoreGlobs(
      gateBlock?.ignoreGlobs,
      files,
      scannerSkipDirsFor(kind),
    ),
    parseError,
  };
}
