/**
 * Hotspot detector — pure module (Epic #1721 / Story #1769 / Task #1776).
 *
 * Walks every Story directory under `temp/epic-<eid>/`, aggregates edit
 * counts per `details.targetHash` for file-mutating tools across Stories,
 * and emits one `kind: 'hotspot'` SignalEvent per hash whose total edit
 * count exceeds `p95 * multiplier`. Pure: takes config-shaped args in,
 * returns events out. Caller persists via `appendEpicSignal` (the signal
 * is Epic-scope; there is no single owning Story).
 *
 * ## Counting rule
 *
 * Only file-mutating tools are counted:
 *   - `Edit`
 *   - `Write`
 *   - `MultiEdit`
 *   - `NotebookEdit`
 *
 * Every other tool (Read, Bash, Grep, Glob, …) is ignored. Trace records
 * without a `details.targetHash` are also skipped — without a stable key
 * we cannot group repeats.
 *
 * ## Cross-Story-only percentile pool
 *
 * Hashes that appear in **fewer than 2 Stories** are excluded from the
 * p95 calculation. This prevents a single large Story from manufacturing
 * its own hotspot when no other Story touches the same file. The pool
 * for the percentile is therefore the set of `totalEdits` values for
 * hashes seen in ≥ 2 Stories. Hashes outside that pool also do not
 * emit a signal — by construction they are not cross-Story.
 *
 * ## p95 algorithm
 *
 * Nearest-rank method (no interpolation): for a sorted array of length
 * `n`, the p95 index is `ceil(0.95 * n) - 1` (0-based). For
 * `[1,2,3,4,5,6,7,8,9,10]` the index is `ceil(9.5) - 1 = 9` → value `10`.
 * For a single-element array `[10]` the index is `ceil(0.95) - 1 = 0` →
 * value `10`. Nearest-rank keeps fixture-driven tests deterministic
 * across Node versions and avoids the floating-point ambiguity of
 * linear-interpolation variants.
 *
 * ## Privacy contract
 *
 * Trace records key off `details.targetHash` (a sha256 of the file path,
 * see `lib/observability/tool-trace-hook.js`). The detector groups by
 * the hash, never the raw path, so the privacy boundary established by
 * the hook is preserved end-to-end.
 *
 * ## Threshold semantics
 *
 * `totalEdits > p95 * multiplier` (strictly greater than). A hash with
 * exactly `p95 * multiplier` edits does NOT emit; only counts past the
 * threshold trip the detector. The multiplier comes from
 * `delivery.signals.hotspot.p95Multiplier` (default 1.25) — pass it in
 * via `args.multiplier`. The detector itself does not import the config
 * resolver.
 *
 * ## Robustness
 *
 *   - Missing `temp/epic-<eid>/` → returns `[]`. Never throws.
 *   - Story directories with no `traces.ndjson` → contribute zero edits.
 *   - Malformed JSON lines → silently skipped (consistent with
 *     `lib/signals/read.js` and `detectors/rework.js`).
 *   - Non-trace records → ignored (the file may legitimately interleave
 *     other kinds in future).
 *
 * @module lib/signals/detectors/hotspot
 */

import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { epicTempDir } from '../../config/temp-paths.js';
import { parseStoryBranch } from '../../git-utils.js';
import { extractTool, validateDetectorArgs } from './common.js';

/**
 * Tools that mutate files. Only these contribute to the per-target edit
 * count. Anything outside this set is ignored.
 *
 * @type {ReadonlySet<string>}
 */
const FILE_MUTATING_TOOLS = Object.freeze(
  new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']),
);

function isPositiveNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * Stream a single `traces.ndjson` line-by-line and emit per-targetHash
 * edit counts as a `Map<targetHash, count>`. Missing file → empty map.
 *
 * @param {string} tracesPath
 * @returns {Promise<Map<string, number>>}
 */
async function tallyEditsByTarget(tracesPath) {
  const counts = new Map();

  // Existence check before opening the stream — `createReadStream`
  // defers ENOENT until the first read, which leaves the iterator in a
  // bad state on some Node versions.
  try {
    await fs.access(tracesPath);
  } catch {
    return counts;
  }

  const stream = createReadStream(tracesPath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const rawLine of rl) {
      if (rawLine.length === 0) continue;
      let parsed;
      try {
        parsed = JSON.parse(rawLine);
      } catch {
        continue;
      }
      if (parsed == null || typeof parsed !== 'object') continue;
      if (parsed.kind !== 'trace') continue;

      const tool = extractTool(parsed);
      if (tool == null || !FILE_MUTATING_TOOLS.has(tool)) continue;

      const hash = parsed.details?.targetHash;
      if (typeof hash !== 'string' || hash.length === 0) continue;

      counts.set(hash, (counts.get(hash) ?? 0) + 1);
    }
  } finally {
    rl.close();
    if (!stream.destroyed) stream.destroy();
  }

  return counts;
}

/**
 * Enumerate `story-<id>` subdirectories of `epicDir`. Returns an empty
 * array when `epicDir` does not exist. The ordering is by Story ID
 * ascending so `storiesAffected` and any future audit output are stable.
 *
 * @param {string} epicDir
 * @returns {Promise<string[]>} absolute paths to each story directory
 */
async function listStoryDirs(epicDir) {
  let entries;
  try {
    entries = await fs.readdir(epicDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const stories = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const id = parseStoryBranch(ent.name);
    if (id == null) continue;
    stories.push({ id, dir: path.join(epicDir, ent.name) });
  }
  stories.sort((a, b) => a.id - b.id);
  return stories.map((s) => s.dir);
}

/**
 * Nearest-rank p95 of a numeric array. Returns `0` for an empty input.
 *
 * The pool is sorted ascending in-place on a defensive copy and the
 * value at index `ceil(0.95 * n) - 1` (0-based) is returned. No
 * interpolation — keeps fixture tests deterministic.
 *
 * @param {readonly number[]} values
 * @returns {number}
 */
export function nearestRankP95(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

/**
 * Detect Epic-scope hotspots. Returns one `kind: 'hotspot'` SignalEvent
 * per `targetHash` whose cross-Story `totalEdits` strictly exceeds
 * `p95(pool) * multiplier`, where `pool` is the set of `totalEdits`
 * values for hashes appearing in ≥ 2 Stories.
 *
 * Pure — emission to disk is the caller's responsibility (use
 * `appendEpicSignal` since the signal is Epic-scope).
 *
 * @param {object} args
 * @param {number} args.epicId — positive integer Epic ID.
 * @param {number} args.multiplier — positive number; p95 multiplier.
 * @param {string} [args.tempRoot] — override `temp/` root (mostly for
 *   tests that point at a synthetic fixture tree).
 * @param {() => string} [args.nowFn] — optional clock seam returning the
 *   ISO-8601 `ts` stamped onto every emitted SignalEvent. Defaults to
 *   `() => new Date().toISOString()`. Inject a fixed-return function in
 *   tests to make the emitted `ts` deterministic. MUST, when provided, be
 *   a function.
 * @returns {Promise<object[]>} array of hotspot SignalEvents conforming
 *   to `.agents/schemas/signal-event.schema.json`'s envelope. Emitted
 *   `details` payload: `{ targetHash, totalEdits, storiesAffected,
 *   p95Threshold, multiplier }`.
 */
export async function detectHotspot(args) {
  // Hotspot shares only the args-shape, nowFn, and epicId guards with the
  // Story-scoped detectors — it has no tracesPath/storyId/taskId/threshold.
  // Gate those three off and validate multiplier/tempRoot (hotspot-specific)
  // inline below.
  const { epicId, nowFn } = validateDetectorArgs(args, {
    fnName: 'detectHotspot',
    requireTracesPath: false,
    requireStoryId: false,
    requireThreshold: false,
  });
  const { multiplier, tempRoot } = args;

  if (!isPositiveNumber(multiplier)) {
    throw new RangeError(
      `detectHotspot: multiplier must be a positive number (got ${multiplier})`,
    );
  }
  if (
    tempRoot != null &&
    (typeof tempRoot !== 'string' || tempRoot.length === 0)
  ) {
    throw new TypeError(
      `detectHotspot: tempRoot, when provided, must be a non-empty string (got ${tempRoot})`,
    );
  }

  // Resolve the Epic temp dir. When the caller supplies an explicit
  // `tempRoot`, splice it into the `{ project: { paths: { tempRoot } } }`
  // shape that `epicTempDir` understands without forcing a config load.
  const epicDir = tempRoot
    ? epicTempDir(epicId, { project: { paths: { tempRoot } } })
    : epicTempDir(epicId);

  const storyDirs = await listStoryDirs(epicDir);
  if (storyDirs.length === 0) return [];

  // Per-Story edit-count maps, then aggregate per-hash totals plus the
  // count of distinct Stories each hash was seen in.
  const totals = new Map(); // hash -> totalEdits across Stories
  const storyHits = new Map(); // hash -> count of distinct Stories

  for (const storyDir of storyDirs) {
    const tracesPath = path.join(storyDir, 'traces.ndjson');
    const perStory = await tallyEditsByTarget(tracesPath);
    for (const [hash, count] of perStory) {
      totals.set(hash, (totals.get(hash) ?? 0) + count);
      storyHits.set(hash, (storyHits.get(hash) ?? 0) + 1);
    }
  }

  // Cross-Story-only pool: keep hashes seen in ≥ 2 Stories. Single-Story
  // hashes never qualify as hotspots regardless of their absolute count.
  const crossStoryHashes = [];
  for (const [hash, hits] of storyHits) {
    if (hits >= 2) crossStoryHashes.push(hash);
  }

  if (crossStoryHashes.length === 0) return [];

  const pool = crossStoryHashes.map((h) => totals.get(h));
  const p95 = nearestRankP95(pool);
  const threshold = p95 * multiplier;

  // Sort offenders by hash ascending for stable emission order.
  const offenders = crossStoryHashes
    .filter((h) => totals.get(h) > threshold)
    .sort();

  const ts = nowFn();
  return offenders.map((targetHash) => ({
    ts,
    kind: 'hotspot',
    source: { tool: 'hotspot-detector' },
    epicId,
    details: {
      targetHash,
      totalEdits: totals.get(targetHash),
      storiesAffected: storyHits.get(targetHash),
      p95Threshold: threshold,
      multiplier,
    },
  }));
}
