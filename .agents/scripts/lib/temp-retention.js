/**
 * temp-retention.js — allowlisted auto-purge of spent temp artifacts (Story #4794).
 *
 * The workspace temp tree grew without bound: every landed Story left its
 * close-gate transcript (~1.4MB each), its terse-result detail dumps, and its
 * validation-evidence envelope behind forever, because no code path had ever
 * removed them. This module is the single engine that reclaims them.
 *
 * ## Allowlist, never a blocklist
 *
 * The safety property that matters is not "delete the right things" but
 * "never delete the wrong thing". So classification is positive: an artifact
 * is a purge candidate only when a declared class claims it. Everything else —
 * an operator's scratch directory, a hand-parked file, a family a future
 * Story adds without teaching this module about it — is **unrecognized**, is
 * never touched, and is reported with its byte size so a human decides. A
 * blocklist would have the opposite failure mode: anything the framework
 * forgot to exclude gets deleted.
 *
 * ## Two eligibility signals, deliberately different in strength
 *
 * - **Story-keyed.** An artifact whose name carries a Story id is purged when
 *   that Story's merge has been *confirmed* by the caller — the post-land tail
 *   or a boot sweep that read live state. This is the primary path and the one
 *   the operator asked for: spent the moment the work lands.
 * - **Age-floored.** Artifacts no Story id can be recovered from (audit
 *   reports, abandoned `plan-<slug>/` dirs) fall back to a `staleDays` floor.
 *   Only the sweep opts into this; the per-Story purge never does, so a
 *   post-land tail can never reap a sibling's in-flight artifact.
 *
 * ## Keep-class
 *
 * `signals.ndjson` is the artifact whose value *starts* when the run ends —
 * `acceptance-eval` and the loop-health check both read it
 * long after the Story merged. It is excluded twice over: it is not in the
 * evidence basename allowlist, and {@link KEEP_BASENAMES} is re-checked at
 * the deletion site. Defence in depth is warranted for the one file whose
 * loss is silent and unrecoverable.
 *
 * ## Best-effort, never load-bearing
 *
 * Every entry point resolves rather than throws. This is hygiene: a purge
 * that fails must never fail a land, a boot, or a persist that already did
 * its real work. Failures are collected into `errors[]` and reported.
 */

import fsPromises from 'node:fs/promises';
import path from 'node:path';

import {
  anchorTempRoot,
  ORCHESTRATION_DIRNAME,
  tempRootFrom,
} from './config/temp-paths.js';
import { Logger } from './Logger.js';

/**
 * Shipped defaults for `delivery.tempRetention`. `enabled` defaults to `true`:
 * the operator asked for auto-purge to be the behaviour, with the knob there
 * to turn it off rather than to turn it on. `staleDays` is a fixed constant
 * since Story #5382 folded the never-set `tempRetention.staleDays` key; the
 * master switch and the per-class opt-outs stay configurable because each
 * one turns a deletion off.
 */
export const TEMP_RETENTION_DEFAULTS = Object.freeze({
  enabled: true,
  staleDays: 7,
  classes: Object.freeze({
    orchestrationLogs: true,
    validationEvidence: true,
    auditResults: true,
    planDirs: true,
  }),
});

/** Every declared purge class, in classification order. */
export const PURGE_CLASS_NAMES = Object.freeze(
  Object.keys(TEMP_RETENTION_DEFAULTS.classes),
);

/**
 * Basenames no path may ever delete, re-checked at the deletion site even
 * though classification already excludes them. See the module header.
 */
export const KEEP_BASENAMES = Object.freeze(['signals.ndjson']);

/**
 * The per-Story artifact basenames `validationEvidence` claims. An explicit
 * allowlist rather than a "delete everything but signals" rule: a file this
 * module has not been taught about is kept, not guessed at.
 */
const STORY_EVIDENCE_BASENAMES = Object.freeze([
  'validation-evidence.json',
  'lifecycle.ndjson',
  'manifest.md',
]);

/**
 * Top-level temp entries that belong to the framework but are never purge
 * candidates: `qa/` holds resumable operator-owned session ledgers, `cache/`
 * has its own invalidation, and `*.lock` files are live coordination state.
 */
const RESERVED_TOP_LEVEL = Object.freeze(['qa', 'cache']);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `story-4794` → `4794`. */
const STORY_DIR_PATTERN = /^story-(\d+)$/;
/** `close-gates-4794`, `sync-result-story-4794` → `4794`. */
const TRAILING_ID_PATTERN = /-(\d+)$/;
/** `audit-story-4794-audit-clean-code.md` → `4794`. */
const AUDIT_STORY_PATTERN = /^audit-story-(\d+)-/;
/** `run-1030` — a per-run temp tree holding `stories/story-<id>/` children. */
const RUN_DIR_PATTERN = /^run-\d+$/;

/**
 * Resolve the effective retention policy, filling every field from
 * {@link TEMP_RETENTION_DEFAULTS}. An unset block yields the defaults, so a
 * consumer that never heard of this feature gets the purge.
 *
 * @param {object} [config] Resolved config bag.
 * @returns {{ enabled: boolean, staleDays: number, classes: Record<string, boolean> }}
 */
export function resolveTempRetention(config) {
  const raw = config?.delivery?.tempRetention ?? {};
  const classes = {};
  for (const name of PURGE_CLASS_NAMES) {
    classes[name] =
      raw.classes?.[name] ?? TEMP_RETENTION_DEFAULTS.classes[name];
  }
  return {
    enabled: raw.enabled ?? TEMP_RETENTION_DEFAULTS.enabled,
    staleDays: TEMP_RETENTION_DEFAULTS.staleDays,
    classes,
  };
}

/**
 * `readdir` that yields `[]` for a directory that does not exist or cannot be
 * read. Every scan below walks optional trees, so an absent one is the normal
 * case, not an error.
 *
 * @param {typeof fsPromises} fsp
 * @param {string} dir
 * @returns {Promise<import('node:fs').Dirent[]>}
 */
async function safeReaddir(fsp, dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Total bytes under a path — the file's own size, or the recursive sum for a
 * directory. Reporting-only: a vanished child is skipped rather than fatal.
 *
 * @param {typeof fsPromises} fsp
 * @param {string} target
 * @returns {Promise<number>}
 */
async function sizeOf(fsp, target) {
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
 * Build one classified entry. `mtimeMs` is the entry's **own** mtime, not the
 * newest mtime beneath it — that is the semantics the shipped stale-plan-dir
 * reap has always used, and widening it here would silently change when an
 * abandoned directory becomes eligible.
 *
 * @param {typeof fsPromises} fsp
 * @param {string} target
 * @param {string} className
 * @param {number|null} storyId
 * @param {boolean} keep
 * @returns {Promise<object|null>}
 */
async function makeEntry(fsp, target, className, storyId, keep = false) {
  let stats;
  try {
    stats = await fsp.stat(target);
  } catch {
    return null;
  }
  return {
    path: target,
    className,
    storyId,
    keep,
    mtimeMs: stats.mtimeMs,
    bytes: stats.isDirectory() ? await sizeOf(fsp, target) : stats.size,
  };
}

/**
 * Extensions this class owns inside `orchestration/`. Story #4816 added
 * `.json`: the persisted terminal envelope lands beside the gate log, and a
 * `.log`-only scan would have left one immortal file per delivered Story in a
 * directory the purge otherwise keeps clean.
 */
const ORCHESTRATION_EXTENSIONS = Object.freeze(['.log', '.json']);

/**
 * Recover the Story id a run-artifact basename carries. Every writer that
 * lands in `orchestration/` ends its name with the scope: `close-gates-4794.log`
 * from the gate sink, `sync-result-story-4794.log` from the terse-result dump,
 * `story-deliver-terminal-4794.json` from the terminal-envelope persist.
 *
 * @param {string} name
 * @returns {number|null}
 */
function storyIdFromLogName(name) {
  const match = TRAILING_ID_PATTERN.exec(name.replace(/\.(log|json)$/, ''));
  return match ? Number(match[1]) : null;
}

/**
 * `<tempRoot>/orchestration/*.{log,json}` — close gate transcripts,
 * terse-result detail dumps, and persisted terminal envelopes. An artifact
 * whose name carries no id (there are none today, but the class owns the
 * directory) is age-floored rather than dropped from the class.
 */
async function scanOrchestrationLogs(tempRoot, fsp) {
  const dir = path.join(tempRoot, ORCHESTRATION_DIRNAME);
  const entries = [];
  for (const dirent of await safeReaddir(fsp, dir)) {
    if (
      !dirent.isFile() ||
      !ORCHESTRATION_EXTENSIONS.some((ext) => dirent.name.endsWith(ext))
    ) {
      continue;
    }
    const entry = await makeEntry(
      fsp,
      path.join(dir, dirent.name),
      'orchestrationLogs',
      storyIdFromLogName(dirent.name),
    );
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Every directory that holds `story-<id>/` children: the standalone tree and
 * each per-run tree.
 */
async function storyParentDirs(tempRoot, fsp) {
  const parents = [path.join(tempRoot, 'standalone', 'stories')];
  for (const dirent of await safeReaddir(fsp, tempRoot)) {
    if (dirent.isDirectory() && RUN_DIR_PATTERN.test(dirent.name)) {
      parents.push(path.join(tempRoot, dirent.name, 'stories'));
    }
  }
  return parents;
}

/**
 * `<…>/stories/story-<id>/*` — the per-Story delivery artifacts.
 *
 * Every file in the directory is emitted, but only the declared evidence
 * basenames are purge candidates; `signals.ndjson` and anything unrecognized
 * are emitted with `keep: true` so the envelope can show what survived.
 */
async function scanValidationEvidence(tempRoot, fsp) {
  const entries = [];
  for (const parent of await storyParentDirs(tempRoot, fsp)) {
    for (const dirent of await safeReaddir(fsp, parent)) {
      const match = STORY_DIR_PATTERN.exec(dirent.name);
      if (!dirent.isDirectory() || !match) continue;
      const storyDir = path.join(parent, dirent.name);
      for (const file of await safeReaddir(fsp, storyDir)) {
        if (!file.isFile()) continue;
        const entry = await makeEntry(
          fsp,
          path.join(storyDir, file.name),
          'validationEvidence',
          Number(match[1]),
          !STORY_EVIDENCE_BASENAMES.includes(file.name),
        );
        if (entry) entries.push(entry);
      }
    }
  }
  return entries;
}

/**
 * `<tempRoot>/audits/*` — audit reports. `audit-story-<id>-<lens>.md` is
 * Story-keyed; the roster-level reports and profiling output are age-floored.
 */
async function scanAuditResults(tempRoot, fsp) {
  const dir = path.join(tempRoot, 'audits');
  const entries = [];
  for (const dirent of await safeReaddir(fsp, dir)) {
    const match = AUDIT_STORY_PATTERN.exec(dirent.name);
    const entry = await makeEntry(
      fsp,
      path.join(dir, dirent.name),
      'auditResults',
      match ? Number(match[1]) : null,
    );
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * `<tempRoot>/plan-<slug>/` — plan authoring dirs. Never Story-keyed: the
 * directory predates the Stories it creates, so age is the only safe signal.
 */
async function scanPlanDirs(tempRoot, fsp) {
  const entries = [];
  for (const dirent of await safeReaddir(fsp, tempRoot)) {
    if (!dirent.isDirectory() || !dirent.name.startsWith('plan-')) continue;
    const entry = await makeEntry(
      fsp,
      path.join(tempRoot, dirent.name),
      'planDirs',
      null,
    );
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Class name → scanner. Iteration order matches {@link PURGE_CLASS_NAMES}. */
const SCANNERS = Object.freeze({
  orchestrationLogs: scanOrchestrationLogs,
  validationEvidence: scanValidationEvidence,
  auditResults: scanAuditResults,
  planDirs: scanPlanDirs,
});

/**
 * Does a top-level temp entry belong to a declared class? Kept in lockstep
 * with the scanners above: an entry no class walks must show up as
 * unrecognized, never be silently ignored.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isClassOwnedTopLevel(name) {
  return (
    name === ORCHESTRATION_DIRNAME ||
    name === 'standalone' ||
    name === 'audits' ||
    name.startsWith('plan-') ||
    RUN_DIR_PATTERN.test(name)
  );
}

/**
 * Top-level entries that no class claims and that are not framework-reserved.
 * Reported with byte sizes, never deleted — this is what makes a 49MB scratch
 * directory visible to the operator instead of invisible to the tooling.
 *
 * @param {string} tempRoot
 * @param {typeof fsPromises} fsp
 * @returns {Promise<Array<{ path: string, bytes: number }>>}
 */
async function collectUnrecognized(tempRoot, fsp) {
  const found = [];
  for (const dirent of await safeReaddir(fsp, tempRoot)) {
    const { name } = dirent;
    if (isClassOwnedTopLevel(name)) continue;
    if (RESERVED_TOP_LEVEL.includes(name) || name.endsWith('.lock')) continue;
    const target = path.join(tempRoot, name);
    found.push({ path: target, bytes: await sizeOf(fsp, target) });
  }
  return found;
}

/**
 * Classify a whole temp tree without deleting anything. Exported so a caller
 * (or a test) can see exactly what the purge would consider.
 *
 * @param {{ config?: object, tempRoot?: string, fsp?: typeof fsPromises }} [args]
 * @returns {Promise<{ tempRoot: string, entries: object[], unrecognized: Array<{ path: string, bytes: number }> }>}
 */
export async function collectTempEntries({
  config,
  tempRoot,
  fsp = fsPromises,
} = {}) {
  const root = tempRoot ?? anchorTempRoot(tempRootFrom(config));
  const entries = [];
  for (const className of PURGE_CLASS_NAMES) {
    entries.push(...(await SCANNERS[className](root, fsp)));
  }
  return {
    tempRoot: root,
    entries,
    unrecognized: await collectUnrecognized(root, fsp),
  };
}

/**
 * Is this entry eligible for deletion under the current policy and signals?
 *
 * @param {object} entry
 * @param {object} ctx
 * @returns {boolean}
 */
function isPurgeable(entry, ctx) {
  if (entry.keep) return false;
  if (KEEP_BASENAMES.includes(path.basename(entry.path))) return false;
  if (!ctx.classes[entry.className]) return false;
  if (ctx.only && !ctx.only.includes(entry.className)) return false;
  if (ctx.excluded.has(path.resolve(entry.path))) return false;
  if (entry.storyId !== null && ctx.storyIds.has(entry.storyId)) return true;
  return ctx.sweepStale && ctx.now - entry.mtimeMs >= ctx.staleMs;
}

/**
 * The purge core. Deliberately **module-private**: the two exported entry
 * points below are the whole public surface, and each encodes a policy
 * decision (Story-keyed vs. age-floored) that a caller reaching this directly
 * could get wrong. Exporting it would also be a dead export — nothing outside
 * this file has a reason to call it.
 *
 * @param {object} [args]
 * @param {object} [args.config] Resolved config bag.
 * @param {number[]} [args.storyIds] Stories whose merge the caller CONFIRMED.
 * @param {boolean} [args.sweepStale] Opt into the age floor for un-keyed entries.
 * @param {string[]|null} [args.only] Restrict to these class names.
 * @param {string[]} [args.excludePaths] Absolute paths to leave alone.
 * @param {number} [args.now] Clock seam.
 * @param {string} [args.tempRoot] Temp root override (tests).
 * @param {typeof fsPromises} [args.fsp] Filesystem seam.
 * @param {{ info: Function }} [args.logger] Logger seam.
 * @param {string} [args.label] Prefix for the single summary line.
 * @returns {Promise<object>} Result envelope; never throws.
 */
async function purgeTempArtifacts({
  config,
  storyIds = [],
  sweepStale = false,
  only = null,
  excludePaths = [],
  now = Date.now(),
  tempRoot,
  fsp = fsPromises,
  logger = Logger,
  label = 'temp-retention',
} = {}) {
  const policy = resolveTempRetention(config);
  const base = {
    enabled: policy.enabled,
    tempRoot: tempRoot ?? anchorTempRoot(tempRootFrom(config)),
    purged: [],
    kept: [],
    unrecognized: [],
    bytesReclaimed: 0,
    errors: [],
  };
  if (!policy.enabled) return { ...base, skipped: 'disabled' };

  let scan;
  try {
    scan = await collectTempEntries({ config, tempRoot: base.tempRoot, fsp });
  } catch (err) {
    return { ...base, skipped: null, errors: [String(err?.message ?? err)] };
  }

  const ctx = {
    classes: policy.classes,
    only,
    storyIds: new Set(storyIds),
    sweepStale,
    staleMs: policy.staleDays * MS_PER_DAY,
    now,
    excluded: new Set(excludePaths.map((p) => path.resolve(p))),
  };
  const result = { ...base, skipped: null, unrecognized: scan.unrecognized };

  for (const entry of scan.entries) {
    if (!isPurgeable(entry, ctx)) {
      if (entry.keep) result.kept.push(entry.path);
      continue;
    }
    try {
      await fsp.rm(entry.path, { recursive: true, force: true });
      result.purged.push({ path: entry.path, bytes: entry.bytes });
      result.bytesReclaimed += entry.bytes;
    } catch (err) {
      // A racing writer or a permission error: leave it for the next run.
      result.errors.push(`${entry.path}: ${String(err?.message ?? err)}`);
    }
  }

  if (result.purged.length > 0) {
    logger?.info?.(
      `[${label}] purged ${result.purged.length} spent temp artifact(s), ` +
        `reclaimed ${formatBytes(result.bytesReclaimed)} under ${result.tempRoot}.`,
    );
  }
  return result;
}

/**
 * Human-readable byte count for the one summary line.
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)}${units[unit]}`;
}

/**
 * Purge one merged Story's spent artifacts. Called from the post-land tail,
 * where "merged" is already confirmed — so this never applies the age floor
 * and can never touch a sibling Story's in-flight artifacts.
 *
 * @param {{ storyId: number, config?: object, now?: number, tempRoot?: string,
 *   fsp?: typeof fsPromises, logger?: object }} args
 * @returns {Promise<object>} Result envelope; never throws.
 */
export async function purgeStoryTempArtifacts({ storyId, config, ...rest }) {
  return purgeTempArtifacts({
    config,
    storyIds: Number.isInteger(storyId) ? [storyId] : [],
    sweepStale: false,
    ...rest,
  });
}

/**
 * Catch-up sweep: purge the artifacts of every Story the caller confirmed
 * merged, plus every age-floored entry past `staleDays`. This is the path
 * that reclaims a backlog — Stories merged in an earlier run, merged through
 * the GitHub UI, or delivered before this feature existed.
 *
 * @param {{ config?: object, mergedStoryIds?: number[], now?: number,
 *   tempRoot?: string, fsp?: typeof fsPromises, logger?: object,
 *   only?: string[]|null, excludePaths?: string[], label?: string }} [args]
 * @returns {Promise<object>} Result envelope; never throws.
 */
export async function sweepTempRetention({
  mergedStoryIds = [],
  ...rest
} = {}) {
  return purgeTempArtifacts({
    storyIds: mergedStoryIds,
    sweepStale: true,
    ...rest,
  });
}
