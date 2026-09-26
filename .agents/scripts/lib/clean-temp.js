/**
 * `/clean-temp` engine: sorts every top-level entry under the project's
 * tempRoot into one bucket and, on `--execute`, deletes the confirmed
 * buckets through the temp-retention engine — there is no second walker.
 *
 * Buckets: `framework` (a class entry the auto-purge would take),
 * `closed-issue` (an unrecognized entry naming exactly one closed issue),
 * `aged` (an unrecognized id-less entry past `staleDays`), and `kept`.
 */

import { realpathSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { mainCheckoutRoot, tempRootFrom } from './config/temp-paths.js';
import { removeSparingKept, safeReaddir } from './temp-removal.js';
import {
  collectTempEntries,
  formatBytes,
  isReservedTopLevel,
  resolveTempRetention,
  sweepTempRetention,
} from './temp-retention.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Deletable buckets, in execution order. `aged` is never deleted under `--yes`. */
const DELETABLE_BUCKETS = Object.freeze(['framework', 'closed-issue', 'aged']);
const UNATTENDED_BUCKETS = Object.freeze(['framework', 'closed-issue']);

/**
 * A standalone run of 1–7 digits, no leading zero, not glued to a letter or
 * digit — so a hash fragment, a timestamp or a version suffix is not an id.
 */
const ID_TOKEN = /(?<![A-Za-z0-9])[1-9]\d{0,6}(?![A-Za-z0-9])/g;

const silent = Object.freeze({ info: () => {} });

/**
 * Distinct issue-id candidates in a basename (extension stripped). More than
 * one means the entry cannot be attributed to any of them.
 *
 * @param {string} name
 * @returns {number[]}
 */
function idCandidates(name) {
  const stem = name.replace(/\.[^.]*$/, '');
  return [...new Set(stem.match(ID_TOKEN) ?? [])].map(Number);
}

/**
 * @param {string[]} argv
 * @returns {{ execute: boolean, yes: boolean, json: boolean, cwd: string|undefined }}
 */
function parseCleanTempArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      execute: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      cwd: { type: 'string' },
    },
    strict: true,
  });
  return values;
}

/** `realpath` when the path exists, else a plain resolve. */
function canonical(target) {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * The tempRoot a relative `project.paths.tempRoot` names, anchored at the
 * project root, and whether it lies strictly inside that root.
 *
 * @param {string} projectRoot
 * @param {object} config
 * @returns {{ tempRoot: string, inside: boolean }}
 */
function resolveScopedTempRoot(projectRoot, config) {
  const raw = tempRootFrom(config);
  const tempRoot = canonical(
    path.isAbsolute(raw) ? raw : path.join(projectRoot, raw),
  );
  const rel = path.relative(canonical(projectRoot), tempRoot);
  const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  return { tempRoot, inside };
}

/**
 * Issue states, read once per id. A failed read is `error`, which every
 * caller treats as "not closed" — reads fail safe.
 *
 * @param {object|null} provider
 * @param {Iterable<number>} ids
 * @returns {Promise<Map<number, 'closed'|'open'|'error'>>}
 */
async function readIssueStates(provider, ids) {
  const states = new Map();
  for (const id of ids) {
    try {
      const ticket = await provider.getTicket(id);
      const state = String(ticket?.state ?? '').toLowerCase();
      states.set(id, state === 'closed' ? 'closed' : 'open');
    } catch {
      states.set(id, 'error');
    }
  }
  return states;
}

/** Top-level name of `target` beneath `tempRoot`. */
function topLevelName(tempRoot, target) {
  return path.relative(tempRoot, target).split(path.sep)[0];
}

/** Every id the scan could need a state for. */
function idsToRead(scan) {
  const ids = new Set();
  for (const entry of scan.entries) {
    if (entry.storyId !== null) ids.add(entry.storyId);
  }
  for (const u of scan.unrecognized) {
    const candidates = idCandidates(path.basename(u.path));
    if (candidates.length === 1) ids.add(candidates[0]);
  }
  return ids;
}

/** Closed ids among `states`. */
function closedIds(states) {
  return [...states].filter(([, s]) => s === 'closed').map(([id]) => id);
}

/**
 * Bucket one unrecognized entry.
 *
 * @param {{ path: string, bytes: number, mtimeMs: number }} u
 * @param {Map<number, string>} states
 * @param {{ now: number, staleMs: number }} ctx
 * @returns {{ bucket: string, reason: string }}
 */
function classifyUnrecognized(u, states, ctx) {
  const ids = idCandidates(path.basename(u.path));
  if (ids.length === 1) {
    const state = states.get(ids[0]);
    if (state === 'closed') {
      return { bucket: 'closed-issue', reason: `issue #${ids[0]} closed` };
    }
    const why = state === 'open' ? 'open' : 'read failed';
    return { bucket: 'kept', reason: `issue #${ids[0]} ${why}` };
  }
  const label = ids.length === 0 ? 'no id' : `${ids.length} ids`;
  if (ctx.now - u.mtimeMs >= ctx.staleMs) {
    return { bucket: 'aged', reason: `${label}, past staleDays` };
  }
  return { bucket: 'kept', reason: `${label}, too recent` };
}

/**
 * One row per top-level entry under tempRoot.
 *
 * @param {object} args
 * @returns {Promise<object[]>}
 */
async function buildRows({ tempRoot, scan, preview, states, ctx, fsp }) {
  const spent = new Map();
  for (const p of preview.purged) {
    const name = topLevelName(tempRoot, p.path);
    const acc = spent.get(name) ?? { count: 0, bytes: 0 };
    spent.set(name, { count: acc.count + 1, bytes: acc.bytes + p.bytes });
  }
  const unrecognized = new Map(
    scan.unrecognized.map((u) => [path.basename(u.path), u]),
  );
  const rows = [];
  for (const dirent of await safeReaddir(fsp, tempRoot)) {
    const { name } = dirent;
    const row = { entry: name, path: path.join(tempRoot, name), bytes: 0 };
    const u = unrecognized.get(name);
    if (isReservedTopLevel(name)) {
      rows.push({ ...row, bucket: 'kept', reason: 'reserved' });
    } else if (u) {
      const ageDays = Math.floor((ctx.now - u.mtimeMs) / MS_PER_DAY);
      rows.push({
        ...row,
        bytes: u.bytes,
        ageDays,
        ...classifyUnrecognized(u, states, ctx),
      });
    } else if (spent.has(name)) {
      const { count, bytes } = spent.get(name);
      rows.push({
        ...row,
        bytes,
        bucket: 'framework',
        reason: `${count} spent artifact(s)`,
      });
    } else {
      rows.push({ ...row, bucket: 'kept', reason: 'framework: nothing spent' });
    }
  }
  return rows.sort((a, b) => a.entry.localeCompare(b.entry));
}

/**
 * @param {object[]} rows
 * @returns {Record<string, { count: number, bytes: number }>}
 */
function bucketTotals(rows) {
  const totals = {};
  for (const bucket of [...DELETABLE_BUCKETS, 'kept']) {
    const inBucket = rows.filter((r) => r.bucket === bucket);
    totals[bucket] = {
      count: inBucket.length,
      bytes: inBucket.reduce((sum, r) => sum + r.bytes, 0),
    };
  }
  return totals;
}

/**
 * @param {object[]} rows
 * @returns {string}
 */
function renderTable(rows) {
  const lines = [
    'bucket        entry                                    size      age   reason',
  ];
  for (const r of rows) {
    const age = r.ageDays === undefined ? '-' : `${r.ageDays}d`;
    lines.push(
      `${r.bucket.padEnd(13)} ${r.entry.padEnd(40)} ${formatBytes(r.bytes).padStart(8)} ${age.padStart(5)}   ${r.reason}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The operator-confirmed deletion of unrecognized entries: each path is
 * re-verified as still unrecognized by a fresh scan before it goes.
 *
 * @param {{ tempRoot: string, paths: string[], fsp: typeof fsPromises }} args
 * @returns {Promise<{ bytes: number, errors: string[] }>}
 */
async function purgeUnrecognizedEntries({ tempRoot, paths, fsp }) {
  const { unrecognized } = await collectTempEntries({ tempRoot, fsp });
  const allowed = new Set(unrecognized.map((u) => u.path));
  const out = { bytes: 0, errors: [] };
  for (const target of paths) {
    if (!allowed.has(target)) {
      out.errors.push(`${target}: no longer an unrecognized entry — kept`);
      continue;
    }
    try {
      out.bytes += (await removeSparingKept(fsp, target)).bytes;
    } catch (err) {
      out.errors.push(`${target}: ${String(err?.message ?? err)}`);
    }
  }
  return out;
}

/**
 * Delete one bucket through the engine.
 *
 * @returns {Promise<{ bytes: number, errors: string[] }>}
 */
async function executeBucket(bucket, rows, env) {
  if (bucket === 'framework') {
    const result = await sweepTempRetention({
      config: env.config,
      tempRoot: env.tempRoot,
      mergedStoryIds: env.closed,
      now: env.now,
      fsp: env.fsp,
      logger: silent,
      label: 'clean-temp',
    });
    return { bytes: result.bytesReclaimed, errors: result.errors };
  }
  return purgeUnrecognizedEntries({
    tempRoot: env.tempRoot,
    paths: rows.filter((r) => r.bucket === bucket).map((r) => r.path),
    fsp: env.fsp,
  });
}

/**
 * Decide whether a bucket may be deleted this run.
 *
 * @returns {Promise<{ run: boolean, note?: string }>}
 */
async function approveBucket(bucket, total, opts, confirm) {
  if (total.count === 0) return { run: false };
  if (opts.yes) {
    return UNATTENDED_BUCKETS.includes(bucket)
      ? { run: true }
      : { run: false, note: 'never deleted unattended — rerun without --yes' };
  }
  const ok = await confirm(
    `[clean-temp] Delete ${total.count} ${bucket} entr${total.count === 1 ? 'y' : 'ies'} (${formatBytes(total.bytes)})?`,
  );
  return ok ? { run: true } : { run: false, note: 'declined' };
}

/**
 * @returns {Promise<{ executed: object, bytesReclaimed: number, errors: string[] }>}
 */
async function executeBuckets(rows, totals, opts, env) {
  const executed = {};
  let bytesReclaimed = 0;
  const errors = [];
  for (const bucket of DELETABLE_BUCKETS) {
    const decision = await approveBucket(
      bucket,
      totals[bucket],
      opts,
      env.confirm,
    );
    if (!decision.run) {
      executed[bucket] = { deleted: false, note: decision.note ?? 'empty' };
      continue;
    }
    const result = await executeBucket(bucket, rows, env);
    executed[bucket] = { deleted: true, bytes: result.bytes };
    bytesReclaimed += result.bytes;
    errors.push(...result.errors);
  }
  return { executed, bytesReclaimed, errors };
}

/**
 * Run `/clean-temp`. Never calls `process.exit`; the CLI shell applies the
 * returned exit code.
 *
 * @param {object} args
 * @param {string[]} args.argv
 * @param {string} args.cwd Invocation dir; `--cwd` overrides it.
 * @param {(projectRoot: string) => object} args.loadConfig Resolved config bag.
 * @param {(cwd: string) => string} [args.resolveRoot] The project root the
 *   run is scoped to — the main checkout root, else `cwd` itself.
 * @param {(config: object) => object} args.getProvider Lazy; called only when
 *   an id needs a read.
 * @param {(question: string) => Promise<boolean>} args.confirm
 * @param {(text: string) => void} args.write stdout sink.
 * @param {(text: string) => void} args.writeErr stderr sink.
 * @param {number} [args.now]
 * @param {typeof fsPromises} [args.fsp]
 * @returns {Promise<{ exitCode: number, envelope: object }>}
 */
export async function runCleanTemp({
  argv,
  cwd,
  loadConfig,
  resolveRoot = (dir) => mainCheckoutRoot(dir) ?? dir,
  getProvider,
  confirm,
  write,
  writeErr,
  now = Date.now(),
  fsp = fsPromises,
}) {
  const opts = parseCleanTempArgs(argv);
  const projectRoot = resolveRoot(path.resolve(opts.cwd ?? cwd));
  const config = loadConfig(projectRoot);
  const { tempRoot, inside } = resolveScopedTempRoot(projectRoot, config);
  if (!inside) {
    writeErr(
      `[clean-temp] refusing: tempRoot ${tempRoot} is not inside the project root ${projectRoot}.\n`,
    );
    return {
      exitCode: 1,
      envelope: { kind: 'clean-temp', refused: true, tempRoot, projectRoot },
    };
  }

  const policy = resolveTempRetention(config);
  const ctx = { now, staleMs: policy.staleDays * MS_PER_DAY };
  const scan = await collectTempEntries({ config, tempRoot, fsp });
  const ids = idsToRead(scan);
  const states =
    ids.size > 0 ? await readIssueStates(getProvider(config), ids) : new Map();
  const closed = closedIds(states);
  const preview = await sweepTempRetention({
    config,
    tempRoot,
    mergedStoryIds: closed,
    now,
    fsp,
    dryRun: true,
    logger: silent,
  });
  const rows = await buildRows({ tempRoot, scan, preview, states, ctx, fsp });
  const totals = bucketTotals(rows);
  const envelope = {
    kind: 'clean-temp',
    tempRoot,
    dryRun: !opts.execute,
    staleDays: policy.staleDays,
    buckets: totals,
    entries: rows.map(({ path: _p, ...r }) => r),
    executed: null,
    bytesReclaimed: 0,
    errors: [],
  };

  if (!opts.json) write(renderTable(rows));
  if (opts.execute) {
    const env = { config, tempRoot, closed, now, fsp, confirm };
    Object.assign(envelope, await executeBuckets(rows, totals, opts, env));
  }
  if (opts.json) write(`${JSON.stringify(envelope)}\n`);
  else write(renderSummary(envelope));
  return { exitCode: envelope.errors.length > 0 ? 1 : 0, envelope };
}

/**
 * @param {object} envelope
 * @returns {string}
 */
function renderSummary(envelope) {
  const parts = Object.entries(envelope.buckets).map(
    ([bucket, t]) => `${bucket}=${t.count} (${formatBytes(t.bytes)})`,
  );
  const head = envelope.dryRun
    ? '[clean-temp] dry run — nothing deleted; pass --execute to delete.'
    : `[clean-temp] reclaimed ${formatBytes(envelope.bytesReclaimed)}.`;
  const errors = envelope.errors
    .map((e) => `[clean-temp] error: ${e}\n`)
    .join('');
  return `${head} ${parts.join(' · ')}\n${errors}`;
}
