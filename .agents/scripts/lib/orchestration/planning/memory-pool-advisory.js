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
 * It also drops the semantic that made the old scanner unfixable: it renders
 * **no per-entry verdict at all**. A memory citing a closed issue is a
 * delivery retrospective whose subject is that issue — not a stale entry — and
 * only the attended `/memory-consolidate` pass, reading content, can tell the
 * difference. This module counts and stats; it never judges an entry.
 *
 * **Growth, never size (Story #5182).** The second arm used to be an absolute
 * ceiling of a hundred entries. A consolidation pass prefers `correct` over
 * `dead` by design, so a pool that crosses a fixed ceiling stays over it
 * forever: the nudge then fired on every plan however fresh the stamp, and a
 * permanent recommendation is one the operator learns to ignore. The arm now
 * measures **entries written since the last pass** — the one quantity a pass
 * actually resets, because Step 6 records the post-rewrite entry count in the
 * stamp as the next run's growth baseline.
 *
 * A stamp carrying a date but no usable `entryCount` (every stamp written
 * before that Story) leaves growth **unmeasured**. That is not
 * "never consolidated" — an operator did review the pool — so the growth arm
 * simply stays silent and only the age arm can speak, until the next pass
 * writes a baseline.
 *
 * **The index byte arm (Story #5285).** Age and growth both measure the
 * *pool*; neither measures the one artifact a session actually loads. The
 * harness reads `MEMORY.md` into every session under a hard byte cap and
 * **truncates** past it, so an index over that cap loses its tail entries
 * silently — the pointers are on disk, indexed, and unreachable. That is a
 * loss in progress, not a hygiene forecast, so this arm is independent of the
 * other two: it fires on a fresh, zero-growth pool whose index has simply
 * outgrown the cap. It measures the index file's size, never the pool's, and
 * a pass that rewrites long index lines short clears it without pruning a
 * single entry.
 *
 * **A future-dated stamp is no stamp.** `lastConsolidatedAt` ahead of `now`
 * cannot describe a pass that happened — it is a clock skew, a hand-edit, or
 * a timezone bug. Scored as-is it yields a negative age that silences the age
 * arm *forever*, which is the loudest possible failure for an advisory whose
 * only job is to speak up. It reads as unstamped instead, so the
 * never-consolidated reason fires and the next real pass overwrites it.
 *
 * Detection is filesystem-only — no child processes, no `gh` probes, no
 * network. Every failure path fails soft to "no pool, no recommendation": the
 * advisory can degrade the nudge, never a plan.
 *
 * Test seams: `cwd`, `env`, `fsImpl` (node:fs-compatible `statSync` /
 * `readdirSync` / `readFileSync`), `now`, and the three thresholds
 * (`staleAfterDays`, `growthDelta`, `indexByteCeiling`).
 *
 * `buildMemoryPoolAdvisory` is the **only** export: the helpers below have no
 * caller outside this module, and exporting one solely for a test would add a
 * row to the `dead-exports-production` ratchet (the `buildUiSurfaceSignal`
 * precedent). Tests reach every branch through the seams above — do not
 * "fix" the missing exports.
 */

import * as defaultFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Recommend a consolidation pass once the stamp is this old. */
const STALE_AFTER_DAYS = 30;

/** Recommend a pass once this many entries were written since the last one. */
const GROWTH_DELTA = 25;

/**
 * Recommend a pass once `MEMORY.md` exceeds this many bytes.
 *
 * 24576 (24 KiB) is the harness's own index cap — the point past which it
 * truncates the file it loads into a session, making every entry after the
 * cut unreachable. The default is the cap itself rather than a margin under
 * it: the arm reports a loss that has already started, not one approaching.
 */
const INDEX_BYTE_CEILING = 24_576;

/** Stamp file written by `/memory-consolidate` after its operator gate. */
const STAMP_FILENAME = '.consolidation-stamp.json';

/** The index file is not itself a memory entry. */
const INDEX_FILENAME = 'MEMORY.md';

const MS_PER_DAY = 86_400_000;

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
 * but never a plan — so all four probes had the same try/catch shape wrapped
 * around one expression. One helper states the rule once; a new probe cannot
 * forget it, and a `catch` that ever needs to do more than fall back would
 * have to be written out, which is the signal it deserves.
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
 * The growth baseline a stamp records: its entry count, or `null` when it
 * records none. `null` is *unmeasured*, never zero — a zero baseline would
 * score every entry in the pool as newly written.
 *
 * @param {unknown} count
 * @returns {number|null}
 */
function readBaseline(count) {
  return Number.isInteger(count) && count >= 0 ? count : null;
}

/**
 * Read the consolidation stamp.
 *
 * `at` is the ISO timestamp of the last pass, or `null` when there was none:
 * a missing, unreadable, unparseable, date-less or **future-dated** stamp is
 * indistinguishable from "never consolidated" — all five mean the same thing
 * to the advisory. A future date is the one that has to be caught here rather
 * than downstream: it is arithmetically valid, so the age arm would score it
 * as a negative age and stay silent for as long as the clock stays behind it.
 * A stamp whose date is unusable carries no baseline either, so `baseline`
 * follows it to `null` rather than describing a pass that cannot be dated.
 *
 * `baseline` is the entry count that pass left behind — the growth arm's
 * reference point. It is `null` on a stamp that predates Story #5182 (date
 * only) and on a malformed count, which reads as *unmeasured growth*, never
 * as zero growth: a `0` baseline would score the whole pool as new.
 *
 * @param {{ poolDir: string, fsImpl: object, now: Date|string|number }} args
 * @returns {{ at: string|null, baseline: number|null }}
 */
function readStamp({ poolDir, fsImpl, now }) {
  const parsed = probe(() =>
    JSON.parse(fsImpl.readFileSync(path.join(poolDir, STAMP_FILENAME), 'utf8')),
  );
  const at = parsed?.lastConsolidatedAt;
  // `Date.parse` rejects the empty string as NaN, so one test covers both an
  // absent date and an unusable one; `> now` covers the future-dated stamp.
  // Equality is not the future, so a stamp written this instant still counts.
  const at_ms = typeof at === 'string' ? Date.parse(at) : Number.NaN;
  if (Number.isNaN(at_ms) || at_ms > new Date(now).getTime()) {
    return { at: null, baseline: null };
  }
  return { at, baseline: readBaseline(parsed.entryCount) };
}

/**
 * The index file's size in bytes.
 *
 * `null` when it cannot be stat'd — an absent or unreadable `MEMORY.md`
 * leaves the byte arm silent rather than guessing a size, on the same
 * fail-soft rule every other probe here follows. Stat'd rather than read:
 * the arm needs the length, never the content, and this module deliberately
 * never reads a memory's text.
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
 *            lastConsolidatedAt: string|null,
 *            entriesSinceConsolidation: number|null, recommend: boolean,
 *            reasons: string[] }}
 */
function envelope(fields) {
  return {
    present: false,
    entryCount: 0,
    indexBytes: null,
    lastConsolidatedAt: null,
    entriesSinceConsolidation: null,
    recommend: false,
    reasons: [],
    ...fields,
  };
}

/**
 * Collect the reasons a pool wants a consolidation pass. An empty array is
 * the quiet verdict; the caller turns it into `recommend` and supplies the
 * standing-down sentence, so every arm lives in one place.
 *
 * The three arms are independent and every one that fires is reported.
 *
 * @param {{ stamp: { at: string|null, baseline: number|null },
 *           growth: number|null, indexBytes: number|null,
 *           now: Date|string|number, staleAfterDays: number,
 *           growthDelta: number, indexByteCeiling: number }} args
 * @returns {string[]}
 */
function collectReasons({
  stamp,
  growth,
  indexBytes,
  now,
  staleAfterDays,
  growthDelta,
  indexByteCeiling,
}) {
  const reasons = [];

  if (stamp.at === null) {
    reasons.push(
      'no consolidation stamp — this pool has never been consolidated',
    );
  } else {
    const ageDays =
      (new Date(now).getTime() - Date.parse(stamp.at)) / MS_PER_DAY;
    if (ageDays > staleAfterDays) {
      reasons.push(
        `last consolidated ${Math.floor(ageDays)} days ago (over the ${staleAfterDays}-day threshold)`,
      );
    }
  }

  // `growth === null` is unmeasured, not zero — a pre-#5182 stamp carries no
  // baseline, and guessing one would re-invent the ceiling this arm replaced.
  if (growth !== null && growth >= growthDelta) {
    reasons.push(
      `${growth} entries written since the last consolidation (at or over the ${growthDelta}-entry growth delta)`,
    );
  }

  // `indexBytes === null` is an unreadable index, not a small one.
  if (indexBytes !== null && indexBytes > indexByteCeiling) {
    reasons.push(
      `${INDEX_FILENAME} is ${indexBytes} bytes, ${indexBytes - indexByteCeiling} over the ${indexByteCeiling}-byte index ceiling — the index is truncated at the cap, so every entry listed after the cut is invisible to every session`,
    );
  }

  return reasons;
}

/**
 * The sentence a quiet pool explains itself with — one per reason it is quiet,
 * so "nothing to do" never reads the same as "nothing measurable".
 *
 * @param {{ growth: number|null, growthDelta: number }} args
 * @returns {string}
 */
function quietReason({ growth, growthDelta }) {
  if (growth === null) {
    return 'memory pool is within the freshness and index-size thresholds; growth is unmeasured until the next /memory-consolidate stamps an entry count';
  }
  return `memory pool is within every threshold — ${growth} entries written since the last consolidation (under the ${growthDelta}-entry growth delta)`;
}

/**
 * Build the `memoryPoolAdvisory` envelope field.
 *
 * Advisory only — it carries **no routing authority**, mirroring
 * `deliverLightSuggestion`. The `/mandrel-plan` spine surfaces `recommend` at Gate #1;
 * nothing auto-runs, and nothing here mutates the operator's memory store.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd] — defaults to `process.cwd()`
 * @param {Record<string,string|undefined>} [opts.env]
 * @param {object} [opts.fsImpl] — node:fs-compatible seam
 * @param {string} [opts.homedir]
 * @param {Date|string|number} [opts.now]
 * @param {number} [opts.staleAfterDays]
 * @param {number} [opts.growthDelta]
 * @param {number} [opts.indexByteCeiling]
 * @returns {{ present: boolean, entryCount: number, indexBytes: number|null,
 *            lastConsolidatedAt: string|null,
 *            entriesSinceConsolidation: number|null, recommend: boolean,
 *            reasons: string[] }}
 */
export function buildMemoryPoolAdvisory({
  cwd = process.cwd(),
  env = process.env,
  fsImpl = defaultFs,
  homedir,
  now = new Date(),
  staleAfterDays = STALE_AFTER_DAYS,
  growthDelta = GROWTH_DELTA,
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

  const stamp = readStamp({ poolDir, fsImpl, now });
  // Reported raw: a pruning pass can leave this negative, and saying the pool
  // shrank by 7 is more use to the operator than clamping it to zero.
  const growth = stamp.baseline === null ? null : entryCount - stamp.baseline;
  const indexBytes = readIndexBytes({ poolDir, fsImpl });

  const found = {
    present: true,
    entryCount,
    indexBytes,
    lastConsolidatedAt: stamp.at,
    entriesSinceConsolidation: growth,
  };

  // An empty pool has nothing to consolidate, whatever the stamp says.
  if (entryCount === 0) {
    return envelope({
      ...found,
      reasons: ['memory pool is empty — nothing to consolidate'],
    });
  }

  const reasons = collectReasons({
    stamp,
    growth,
    indexBytes,
    now,
    staleAfterDays,
    growthDelta,
    indexByteCeiling,
  });

  return envelope({
    ...found,
    recommend: reasons.length > 0,
    reasons:
      reasons.length > 0 ? reasons : [quietReason({ growth, growthDelta })],
  });
}
