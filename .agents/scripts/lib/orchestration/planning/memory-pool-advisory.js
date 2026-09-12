/**
 * memory-pool-advisory.js — the `/mandrel-plan` Phase 0 memory-hygiene advisory.
 *
 * Replaces the retired memory-freshness pre-flight (Story #2557 / #4414) in
 * the same slot, fixing both of that design's defects:
 *
 *   1. **Correct pool resolution.** The retired `resolveMemoryDir` built
 *      `~/.claude/projects/<github.repo>/memory/`, but harness project
 *      directories are **cwd-slugs** — the absolute cwd with every `/` and `.`
 *      replaced by `-` — so the old path never resolved in any consumer and
 *      the scan was a silent no-op everywhere.
 *   2. **A named consumer.** The retired scanner emitted a per-entry staleness
 *      verdict nothing read. This emits one advisory the `/mandrel-plan` spine
 *      surfaces at Gate #1, recommending `/memory-consolidate`.
 *
 * It renders **no per-entry verdict at all**. A memory citing a closed issue
 * is a delivery retrospective whose subject is that issue — not a stale entry
 * — and only the attended `/memory-consolidate` pass, reading content, can
 * tell the difference. This module measures one thing; it never judges an
 * entry.
 *
 * **One arm: the index byte ceiling (Story #5285, sole survivor after Story
 * #5312).** The harness reads `MEMORY.md` into every session under a hard
 * byte cap and **truncates** past it, so an index over that cap loses its
 * tail entries silently — the pointers are on disk, indexed, and unreachable.
 * That is a loss in progress, not a hygiene forecast, and it is the only
 * signal that measures the artifact a session actually loads. The stamp-age
 * and growth-delta arms that used to sit beside it measured the *pool*, fired
 * on every plan once a pool was mature, and were learned-ignored by exactly
 * the operators they nagged; Story #5312 deleted them with their
 * `planning.memoryPool.{staleAfterDays, growthDelta}` knobs. A pass that
 * rewrites long index lines short clears this arm without pruning a single
 * entry.
 *
 * Detection is filesystem-only — no child processes, no `gh` probes, no
 * network. Every failure path fails soft to "no pool, no recommendation": the
 * advisory can degrade the nudge, never a plan.
 *
 * Test seams: `cwd`, `env`, `fsImpl` (node:fs-compatible `statSync` /
 * `readdirSync`), and the `indexByteCeiling` threshold.
 *
 * `buildMemoryPoolAdvisory` is the **only** export: the helpers below have no
 * caller outside this module, and exporting one solely for a test would add a
 * row to the `dead-exports-production` ratchet. Tests reach every branch
 * through the seams above — do not "fix" the missing exports.
 */

import * as defaultFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Recommend a pass once `MEMORY.md` exceeds this many bytes.
 *
 * 24576 (24 KiB) is the harness's own index cap — the point past which it
 * truncates the file it loads into a session, making every entry after the
 * cut unreachable. The default is the cap itself rather than a margin under
 * it: the arm reports a loss that has already started, not one approaching.
 */
const INDEX_BYTE_CEILING = 24_576;

/** The index file is not itself a memory entry. */
const INDEX_FILENAME = 'MEMORY.md';

/**
 * Slugify an absolute path the way the harness names its per-project
 * directories: every `/` and `.` becomes `-`. Verified against real
 * directories in `~/.claude/projects/` — a plain checkout and a worktree both
 * round-trip exactly.
 *
 * @param {string} absPath
 * @returns {string}
 */
function slugifyProjectPath(absPath) {
  return String(absPath ?? '').replace(/[/.]/g, '-');
}

/**
 * Resolve the memory pool directory for a working directory.
 *
 * `MANDREL_MEMORY_DIR` wins outright (operator override and test seam);
 * otherwise `~/.claude/projects/<cwd-slug>/memory/`.
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
 * Every read here is fail-soft by design — the advisory may degrade its nudge
 * but never a plan — so every probe has the same try/catch shape wrapped
 * around one expression. One helper states the rule once.
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
 * The index file's size in bytes.
 *
 * `null` when it cannot be stat'd — an absent or unreadable `MEMORY.md`
 * leaves the arm silent rather than guessing a size, on the same fail-soft
 * rule every other probe here follows. Stat'd rather than read: the arm needs
 * the length, never the content, and this module deliberately never reads a
 * memory's text.
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
 * Count memory entries — `.md` files other than the index.
 *
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
 * The advisory's field set, defaulted to the fail-soft "no usable pool"
 * reading. Every return path spreads its own findings over this, so the
 * envelope's shape is declared once — a new field cannot reach some callers
 * and not others, which is the failure mode a per-branch object literal has.
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
 * Build the `memoryPoolAdvisory` envelope field.
 *
 * Advisory only — it carries **no routing authority**. The `/mandrel-plan`
 * spine surfaces `recommend` at Gate #1 on one advisory line; nothing
 * auto-runs, and nothing here mutates the operator's memory store.
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
 * The index byte arm's verdict. `indexBytes === null` is an unreadable index,
 * not a small one, so it stays quiet and says why.
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
