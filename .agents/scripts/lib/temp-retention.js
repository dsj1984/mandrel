/**
 * Allowlisted auto-purge of spent temp artifacts: only a declared class's
 * entries are candidates; the rest are reported, never touched. Never throws
 * — a failed purge must not fail a land, boot, or persist.
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
 * Defaults for `delivery.tempRetention`; purge is on unless turned off.
 * `staleDays` is not configurable — only switches that turn a deletion off are.
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

export const PURGE_CLASS_NAMES = Object.freeze(
  Object.keys(TEMP_RETENTION_DEFAULTS.classes),
);

/**
 * Never deleted, re-checked at the deletion site: `signals.ndjson` is read
 * long after merge and its loss is silent and unrecoverable.
 */
export const KEEP_BASENAMES = Object.freeze(['signals.ndjson']);

/** Explicit allowlist: an untaught file in a Story dir is kept. */
const STORY_EVIDENCE_BASENAMES = Object.freeze([
  'validation-evidence.json',
  'lifecycle.ndjson',
  'manifest.md',
]);

/** Framework-owned, never purged (`*.lock` files are also skipped). */
const RESERVED_TOP_LEVEL = Object.freeze(['qa', 'cache']);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const STORY_DIR_PATTERN = /^story-(\d+)$/;
const TRAILING_ID_PATTERN = /-(\d+)$/;
const AUDIT_STORY_PATTERN = /^audit-story-(\d+)-/;
/** Per-run temp tree holding `stories/story-<id>/` children. */
const RUN_DIR_PATTERN = /^run-\d+$/;

/**
 * Effective retention policy, defaults filled in.
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
 * `readdir` yielding `[]` for an absent or unreadable directory.
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
 * Recursive byte total; a vanished child is skipped.
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
 * One classified entry. `mtimeMs` is the entry's own mtime, not the newest
 * beneath it; widening it would change when an abandoned dir becomes eligible.
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

/** `.json` covers the persisted terminal envelope beside each gate log. */
const ORCHESTRATION_EXTENSIONS = Object.freeze(['.log', '.json']);

/**
 * Story id from an `orchestration/` basename; every writer there ends the
 * name with `-<id>`.
 *
 * @param {string} name
 * @returns {number|null}
 */
function storyIdFromLogName(name) {
  const match = TRAILING_ID_PATTERN.exec(name.replace(/\.(log|json)$/, ''));
  return match ? Number(match[1]) : null;
}

/** `<tempRoot>/orchestration/*.{log,json}`; an id-less name is age-floored. */
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

/** Directories holding `story-<id>/` children: standalone and per-run. */
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
 * `<…>/stories/story-<id>/*`; non-allowlisted files are emitted `keep: true`
 * so the envelope shows what survived.
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

/** `<tempRoot>/audits/*`; `audit-story-<id>-*` is Story-keyed, rest age-floored. */
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

/** `<tempRoot>/plan-<slug>/`: predates its Stories, so age is the only signal. */
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

const SCANNERS = Object.freeze({
  orchestrationLogs: scanOrchestrationLogs,
  validationEvidence: scanValidationEvidence,
  auditResults: scanAuditResults,
  planDirs: scanPlanDirs,
});

/**
 * Keep in lockstep with the scanners: an entry no class walks must surface
 * as unrecognized.
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
 * Unclaimed, non-reserved top-level entries: reported with sizes, never deleted.
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
 * Classify a temp tree without deleting anything.
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
 * Purge core; module-private because each exported entry point encodes the
 * Story-keyed vs. age-floored policy a direct caller could get wrong.
 *
 * @param {object} [args]
 * @param {object} [args.config]
 * @param {number[]} [args.storyIds] Stories whose merge the caller CONFIRMED.
 * @param {boolean} [args.sweepStale] Opt into the age floor for un-keyed entries.
 * @param {string[]|null} [args.only]
 * @param {string[]} [args.excludePaths]
 * @param {number} [args.now]
 * @param {string} [args.tempRoot]
 * @param {typeof fsPromises} [args.fsp]
 * @param {{ info: Function }} [args.logger]
 * @param {string} [args.label]
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
 * Purge one confirmed-merged Story's artifacts; never applies the age floor.
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
 * Catch-up sweep: confirmed-merged Stories plus age-floored entries past
 * `staleDays`.
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
