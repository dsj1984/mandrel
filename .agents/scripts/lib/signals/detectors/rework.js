/**
 * Rework detector — pure module (Epic #1721 / Story #1771 / Task #1774).
 *
 * Scans a `traces.ndjson` file for repeated edits against the same target
 * (keyed by hashed `details.targetHash`) and emits one `kind: 'rework'`
 * SignalEvent per offending target whose edit count strictly exceeds the
 * configured threshold. Pure: takes a file path in, returns events out.
 * Emission to disk is the caller's job.
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
 * ## Privacy contract
 *
 * Trace records key off `details.targetHash` (a sha256 of the file path,
 * see `lib/observability/tool-trace-hook.js`). The detector groups by
 * the hash, never the raw path, so the privacy boundary established by
 * the hook is preserved end-to-end. A future analyzer that wants to
 * surface the offending path must resolve the hash through a separate
 * mapping — the detector itself never touches plaintext.
 *
 * ## Threshold semantics
 *
 * `editCount > threshold` (strictly greater than). A target with exactly
 * `threshold` edits does NOT emit; only the first edit *past* the
 * threshold trips the detector. This matches the
 * `delivery.signals.rework.editsPerFile` config surface (Epic #1720) —
 * the configured value is the maximum tolerated count, not the trigger
 * count.
 *
 * ## Robustness
 *
 *   - Missing `tracesPath` file → returns `[]`. Never throws.
 *   - Malformed JSON lines → silently skipped (consistent with the
 *     `lib/signals/read.js` reader).
 *   - Non-trace records → ignored (the file may legitimately contain
 *     other kinds in future).
 *
 * @module lib/signals/detectors/rework
 */

import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createInterface } from 'node:readline';

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

/**
 * Stream `tracesPath` line-by-line and accumulate per-targetHash edit
 * counts. Returns a `Map<targetHash, count>`. Missing file → empty map.
 *
 * @param {string} tracesPath
 * @returns {Promise<Map<string, number>>}
 */
async function tallyEditsByTarget(tracesPath) {
  const counts = new Map();

  // Existence check before opening the stream — `createReadStream`
  // defers ENOENT until the first read, which leaves the iterator in a
  // bad state on some Node versions. `fs.access` short-circuits cleanly.
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
        // Mirrors lib/signals/read.js — malformed lines are common
        // during a partial-write race; skip silently.
        continue;
      }
      if (parsed == null || typeof parsed !== 'object') continue;
      // We only care about trace records; the file is named
      // traces.ndjson but a future writer may interleave other kinds.
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
 * Detect rework against `tracesPath`. Returns a `kind: 'rework'`
 * SignalEvent for every targetHash whose edit count strictly exceeds
 * `threshold`. Pure — emission to disk is the caller's responsibility.
 *
 * @param {object} args
 * @param {string} args.tracesPath — absolute path to a `traces.ndjson`.
 * @param {number} args.epicId — positive integer Epic ID.
 * @param {number} args.storyId — positive integer Story ID.
 * @param {number|null} [args.taskId] — positive integer Task ID, or null.
 * @param {number} args.threshold — the maximum tolerated edit count;
 *   targets with `editCount > threshold` emit. MUST be a non-negative
 *   integer.
 * @param {() => string} [args.nowFn] — optional clock seam returning the
 *   ISO-8601 `ts` stamped onto every emitted SignalEvent. Defaults to
 *   `() => new Date().toISOString()`. Inject a fixed-return function in
 *   tests to make the emitted `ts` deterministic. MUST, when provided, be
 *   a function.
 * @returns {Promise<object[]>} array of SignalEvent objects
 *   conforming to `.agents/schemas/signal-event.schema.json`.
 */
export async function detectRework(args) {
  const { tracesPath, epicId, storyId, taskId, threshold, nowFn } =
    validateDetectorArgs(args, { fnName: 'detectRework' });

  const counts = await tallyEditsByTarget(tracesPath);

  // Stable order: sort by targetHash ascending so the same input always
  // yields the same emission sequence (eases snapshot testing and
  // downstream deduping).
  const offenders = [];
  for (const [hash, count] of counts) {
    if (count > threshold) offenders.push([hash, count]);
  }
  offenders.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const ts = nowFn();
  return offenders.map(([targetHash, editCount]) => ({
    ts,
    kind: 'rework',
    emitter: { tool: 'rework-detector' },
    epicId,
    storyId,
    taskId,
    details: { targetHash, editCount, threshold },
  }));
}
