/**
 * memory-pool-advisory.js — the `/mandrel-plan` memory-hygiene advisory.
 *
 * Recommends `/memory-consolidate` when `MEMORY.md` exceeds the harness's
 * index cap (past it, later entries are truncated away). Never judges an
 * entry; filesystem-only and fail-soft.
 */

import * as defaultFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The harness's own index cap (24 KiB): past it, the loss has already started. */
const INDEX_BYTE_CEILING = 24_576;

/** The index file is not itself a memory entry. */
const INDEX_FILENAME = 'MEMORY.md';

/**
 * Harness per-project dir naming: every `/` and `.` becomes `-`.
 *
 * @param {string} absPath
 * @returns {string}
 */
function slugifyProjectPath(absPath) {
  return String(absPath ?? '').replace(/[/.]/g, '-');
}

/**
 * `MANDREL_MEMORY_DIR` wins; else `~/.claude/projects/<cwd-slug>/memory/`.
 *
 * @param {{ cwd?: string, env?: Record<string,string|undefined>, homedir?: string }} [opts]
 * @returns {string|null} absolute pool path, or `null` when unresolvable
 */
function resolveMemoryPoolDir({ cwd, env = process.env, homedir } = {}) {
  const override = env?.MANDREL_MEMORY_DIR;
  if (typeof override === 'string' && override.length > 0) return override;

  const base = typeof cwd === 'string' && cwd.length > 0 ? cwd : null;
  if (!base) return null;

  const home =
    typeof homedir === 'string' && homedir.length > 0 ? homedir : os.homedir();
  if (!home) return null;

  return path.join(
    home,
    '.claude',
    'projects',
    slugifyProjectPath(base),
    'memory',
  );
}

/**
 * Run one filesystem probe, falling back on any failure.
 *
 * @template T
 * @param {() => T} read
 * @param {T|null} [fallback]
 * @returns {T|null}
 */
function probe(read, fallback = null) {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/**
 * Stat'd, never read: this module never reads a memory's text.
 *
 * @returns {number|null}
 */
function readIndexBytes({ poolDir, fsImpl }) {
  const size = probe(
    () => fsImpl.statSync(path.join(poolDir, INDEX_FILENAME)).size,
  );
  return Number.isFinite(size) ? size : null;
}

/**
 * @returns {number|null} `null` when the directory cannot be listed
 */
function countEntries({ poolDir, fsImpl }) {
  return probe(
    () =>
      fsImpl
        .readdirSync(poolDir)
        .filter((name) => name.endsWith('.md') && name !== INDEX_FILENAME)
        .length,
  );
}

/**
 * The envelope shape, declared once and defaulted to "no usable pool".
 *
 * @param {object} fields
 * @returns {{ present: boolean, entryCount: number, indexBytes: number|null,
 *            recommend: boolean, reasons: string[] }}
 */
function envelope(fields) {
  return {
    present: false,
    entryCount: 0,
    indexBytes: null,
    recommend: false,
    reasons: [],
    ...fields,
  };
}

/**
 * Advisory only: no routing authority, and nothing here mutates the store.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd] — defaults to `process.cwd()`
 * @param {Record<string,string|undefined>} [opts.env]
 * @param {object} [opts.fsImpl] — node:fs-compatible seam
 * @param {string} [opts.homedir]
 * @param {number} [opts.indexByteCeiling]
 * @returns {{ present: boolean, entryCount: number, indexBytes: number|null,
 *            recommend: boolean, reasons: string[] }}
 */
export function buildMemoryPoolAdvisory({
  cwd = process.cwd(),
  env = process.env,
  fsImpl = defaultFs,
  homedir,
  indexByteCeiling = INDEX_BYTE_CEILING,
} = {}) {
  const absent = (reason) => envelope({ reasons: [reason] });

  const poolDir = resolveMemoryPoolDir({ cwd, env, homedir });
  if (!poolDir) {
    return absent(
      'no memory pool could be resolved for this working directory',
    );
  }

  const isDir = probe(() => fsImpl.statSync(poolDir).isDirectory(), false);
  if (!isDir) {
    return absent(`no memory pool at ${poolDir} — nothing to consolidate`);
  }

  const entryCount = countEntries({ poolDir, fsImpl });
  if (entryCount === null) {
    return absent(`memory pool at ${poolDir} could not be listed`);
  }

  const indexBytes = readIndexBytes({ poolDir, fsImpl });
  const found = { present: true, entryCount, indexBytes };

  // An empty pool has nothing to consolidate, whatever the index says.
  if (entryCount === 0) {
    return envelope({
      ...found,
      reasons: ['memory pool is empty — nothing to consolidate'],
    });
  }

  const { recommend, reason } = judgeIndex(indexBytes, indexByteCeiling);
  return envelope({ ...found, recommend, reasons: [reason] });
}

/**
 * `null` is an unreadable index, not a small one: stay quiet and say why.
 *
 * @param {number|null} indexBytes
 * @param {number} indexByteCeiling
 * @returns {{ recommend: boolean, reason: string }}
 */
function judgeIndex(indexBytes, indexByteCeiling) {
  if (indexBytes === null) {
    return {
      recommend: false,
      reason: `memory pool present but ${INDEX_FILENAME} could not be measured — the index ceiling is the only arm and it is unmeasured`,
    };
  }
  if (indexBytes > indexByteCeiling) {
    return {
      recommend: true,
      reason: `${INDEX_FILENAME} is ${indexBytes} bytes, ${indexBytes - indexByteCeiling} over the ${indexByteCeiling}-byte index ceiling — the index is truncated at the cap, so every entry listed after the cut is invisible to every session`,
    };
  }
  return {
    recommend: false,
    reason: `${INDEX_FILENAME} is ${indexBytes} bytes, within the ${indexByteCeiling}-byte index ceiling`,
  };
}
