/**
 * Streaming signals reader (Epic #1181 / Story #1438 / Task #1459).
 *
 * Provides one async-iterator entry point — `read({ epic, story?, kind?,
 * config? })` — that consumers use instead of opening the NDJSON file
 * themselves. The reader streams line-by-line so callers never load the
 * full file into memory (50MB+ traces stay under file size in RSS).
 *
 * On-disk layout (resolved via `lib/config/temp-paths.js`):
 *
 *   <tempRoot>/epic-<epic>/story-<story>/signals.ndjson
 *
 * When `story` is omitted, the reader fans out across every
 * `story-<id>/signals.ndjson` under `<tempRoot>/epic-<epic>/`. When the
 * Epic directory is missing, the iterator yields nothing (consumers
 * treat absence as "no signals yet").
 *
 * ## Filter semantics
 *
 *   - `kind` — when provided, only events whose `kind` matches the
 *     argument are yielded. Filtering happens after the per-line JSON
 *     parse + envelope guard (see `lib/signals/schema.js`).
 *   - `story` — narrows to a single Story's stream; otherwise we walk
 *     every Story directory under the Epic.
 *
 * ## Warn-once policy (AC #3)
 *
 *   Malformed JSON lines are common during a partial write race; we
 *   warn **once per process** (module-level latch) rather than per line
 *   so a corrupted tail doesn't drown the operator log. The latch
 *   carries the first offending path/line and a count for follow-up.
 *
 * ## Robustness
 *
 *   The reader never throws on a missing file, a permission error, or
 *   malformed JSON — every failure path resolves to "no more events"
 *   so the analyzer can keep walking. Errors from the supplied
 *   `tempRoot` resolver propagate (those are programmer errors, not
 *   I/O conditions).
 *
 * @module lib/signals/read
 */

import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  epicArtifactPath,
  epicTempDir,
  signalsFile,
  storyTempDir,
} from '../config/temp-paths.js';
import { parseStoryBranch } from '../git-utils.js';
import { Logger } from '../Logger.js';

import { isPositiveInt } from './detectors/common.js';
import { EVENT_KIND_VALUES, hasCommonEnvelope } from './schema.js';

// Module-level latch. Carries `{ path, lineNumber, totalCount }` for the
// first malformed line we see in this process; subsequent malformed
// lines bump `totalCount` without emitting. Reset is intentionally
// not exposed — the warn-once contract is process-wide.
const _malformedLatch = { fired: false, totalCount: 0 };

/**
 * Test-only helper to reset the warn-once latch. Not part of the public
 * surface — exported so the unit test can exercise per-test isolation
 * without spawning a new Node process.
 *
 * @returns {void}
 */
export function __resetMalformedLatchForTests() {
  _malformedLatch.fired = false;
  _malformedLatch.totalCount = 0;
}

/**
 * Snapshot of the current warn-once state. Test-only — surfaces the
 * count of malformed lines observed so the unit suite can assert that
 * "10 bad lines → 1 warn but count=10".
 *
 * @returns {{ fired: boolean, totalCount: number }}
 */
export function __getMalformedLatchForTests() {
  return { ..._malformedLatch };
}

function warnOnceMalformed(targetPath, lineNumber, parseErr) {
  _malformedLatch.totalCount += 1;
  if (_malformedLatch.fired) return;
  _malformedLatch.fired = true;
  Logger.warn(
    `signals/read: malformed JSON encountered (first at ${targetPath}:${lineNumber}: ${
      parseErr instanceof Error ? parseErr.message : String(parseErr)
    }); further malformed lines suppressed for this process.`,
  );
}

/**
 * Stream one signals.ndjson file as an async iterable of parsed records.
 * Internal helper; consumers go through `read()`.
 *
 * @param {string} target — absolute on-disk path
 * @param {string | null} kindFilter — kind to filter on (null = no filter)
 * @returns {AsyncGenerator<object>}
 */
async function* streamFile(target, kindFilter) {
  // Existence check before opening the stream — `createReadStream`
  // defers ENOENT until the first `read()`, which leaves the async
  // iterator with an uncatchable error mid-flight on some Node
  // versions. `fs.access` is cheap and gives us a clean early return.
  try {
    await fs.access(target);
  } catch {
    return;
  }

  const stream = createReadStream(target, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let lineNumber = 0;
  try {
    for await (const rawLine of rl) {
      lineNumber += 1;
      if (rawLine.length === 0) continue;
      let parsed;
      try {
        parsed = JSON.parse(rawLine);
      } catch (err) {
        warnOnceMalformed(target, lineNumber, err);
        continue;
      }
      if (!hasCommonEnvelope(parsed)) continue;
      if (kindFilter != null && parsed.kind !== kindFilter) continue;
      yield parsed;
    }
  } finally {
    rl.close();
    // `stream.destroy()` is idempotent — `rl.close()` already pulls
    // the underlying stream down on its own, but we drop it explicitly
    // here to satisfy the Windows file-handle leak check.
    if (!stream.destroyed) stream.destroy();
  }
}

/**
 * List every `stories/story-<id>/signals.ndjson` path under the Epic's
 * `<tempRoot>/epic-<epic>/` directory. Returns an empty array when the
 * Epic directory is missing.
 *
 * The returned paths are sorted by Story ID ascending so the iterator's
 * output is stable across runs.
 *
 * Story #2940 nested per-Story directories under a `stories/` segment.
 * Epic-level signals continue to live at the Epic root.
 *
 * @param {number} epic
 * @param {object | undefined} config
 * @returns {Promise<string[]>}
 */
async function listEpicStorySignalsFiles(epic, config) {
  const epicDir = epicTempDir(epic, config);
  let epicEntries;
  try {
    epicEntries = await fs.readdir(epicDir, { withFileTypes: true });
  } catch {
    return [];
  }
  let hasEpicLevelSignals = false;
  let hasStoriesDir = false;
  for (const ent of epicEntries) {
    if (ent.isDirectory() && ent.name === 'stories') {
      hasStoriesDir = true;
    } else if (ent.isFile() && ent.name === 'signals.ndjson') {
      // Story #1430 — wave-runner lifecycle signals land here.
      hasEpicLevelSignals = true;
    }
  }
  const storyIds = [];
  if (hasStoriesDir) {
    let storyEntries;
    try {
      storyEntries = await fs.readdir(path.join(epicDir, 'stories'), {
        withFileTypes: true,
      });
    } catch {
      storyEntries = [];
    }
    for (const ent of storyEntries) {
      if (!ent.isDirectory()) continue;
      const sid = parseStoryBranch(ent.name);
      if (sid === null || !isPositiveInt(sid)) continue;
      storyIds.push(sid);
    }
  }
  storyIds.sort((a, b) => a - b);
  // Yield epic-level signals first (wave-start precedes per-Story friction),
  // then walk the per-Story streams in ascending ID order.
  const targets = hasEpicLevelSignals
    ? [epicArtifactPath(epic, 'signals.ndjson', config)]
    : [];
  for (const sid of storyIds) {
    targets.push(path.join(storyTempDir(epic, sid, config), 'signals.ndjson'));
  }
  return targets;
}

/**
 * Stream every event matching `{ epic, story?, kind? }` from the
 * configured `tempRoot`'s `epic-<epic>/[story-<story>/]signals.ndjson`
 * file(s).
 *
 * Returns an async iterable so callers can `for await` over it without
 * buffering. The reader is **streaming** — peak memory stays below the
 * file size for any input.
 *
 * @param {{ epic: number, story?: number, kind?: string, config?: object }} args
 * @returns {AsyncGenerator<object>}
 *
 * @example
 *   for await (const evt of read({ epic: 1181 })) { ... }
 *   for await (const evt of read({ epic: 1181, story: 1438, kind: 'friction' })) { ... }
 */
export async function* read(args) {
  if (args == null || typeof args !== 'object') {
    throw new TypeError(
      `signals/read: args must be an object with at minimum { epic }; got ${args}`,
    );
  }
  const { epic, story, kind, config } = args;
  if (!isPositiveInt(epic)) {
    throw new RangeError(
      `signals/read: epic must be a positive integer (got ${epic})`,
    );
  }
  if (story !== undefined && !isPositiveInt(story)) {
    throw new RangeError(
      `signals/read: story must be a positive integer when provided (got ${story})`,
    );
  }
  if (kind !== undefined && kind !== null) {
    if (typeof kind !== 'string' || kind.length === 0) {
      throw new TypeError(
        `signals/read: kind must be a non-empty string when provided (got ${kind})`,
      );
    }
    if (!EVENT_KIND_VALUES.has(kind)) {
      // Unknown kinds are not technically invalid — a future detector
      // might emit a new kind that we don't yet know about. We warn
      // (best effort) but still let the iterator run so the consumer
      // can adopt the new kind without code change here.
      Logger.warn(
        `signals/read: kind '${kind}' is not in the current EVENT_KINDS enumeration; iterating anyway.`,
      );
    }
  }

  const kindFilter = kind ?? null;
  const targets =
    story !== undefined
      ? [signalsFile(epic, story, config)]
      : await listEpicStorySignalsFiles(epic, config);

  for (const target of targets) {
    yield* streamFile(target, kindFilter);
  }
}
