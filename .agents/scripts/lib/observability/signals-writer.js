/**
 * Append-only signals/trace writer (Epic #1030 Story #1041).
 *
 * Centralizes the per-(epic, story) NDJSON streams under
 * `temp/epic-<eid>/stories/story-<sid>/signals.ndjson` (and a sibling
 * `traces.ndjson` for trace-shaped records). Detector modules and the
 * runtime trace hook all funnel through this writer so the on-disk
 * shape stays under one schema and one set of robustness guarantees.
 *
 * Robustness contract (Tech Spec #1032 §observability):
 *   - **Best-effort.** Every entry point swallows fs / JSON failures
 *     after logging via `Logger.warn`. Observability MUST NOT take down
 *     the runner — a failed write is a missing signal, not a halted
 *     wave.
 *   - **No buffering.** Each `appendSignal` / `appendTrace` opens the
 *     target file, writes one newline-terminated JSON line, and closes.
 *     The Tech Spec explicitly forbids in-process buffering: detectors
 *     fire from inside per-Story sub-agents that may exit abruptly, and
 *     a buffered tail would silently disappear on `process.exit`.
 *   - **Lazy directory creation.** The first write to a fresh Story
 *     creates `temp/epic-<eid>/stories/story-<sid>/` via `fs.mkdir(..., { recursive: true })`.
 *     `epicId` / `storyId` are required positive integers — the
 *     `temp-paths.js` helpers assert this before we touch the disk.
 *
 * Reader contract:
 *   - `forEachLine(epicId, storyId, cb)` streams `signals.ndjson` line
 *     by line, parses each line as JSON, and invokes `cb(parsed, lineNumber)`.
 *     Malformed lines are skipped with a `Logger.warn`; a missing file
 *     returns `{ linesRead: 0, linesParsed: 0, missing: true }` rather
 *     than throwing. This matches how the analyzer wants to consume
 *     partial streams from in-flight Stories.
 */

import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import {
  epicArtifactPath,
  signalsFile,
  storyTempDir,
} from '../config/temp-paths.js';
import { Logger } from '../Logger.js';
import { classifyPathSource } from './source-classifier.js';

const TRACES_BASENAME = 'traces.ndjson';
const EPIC_SIGNALS_BASENAME = 'signals.ndjson';

/**
 * Async traces-file path (kept private — consumers thread through
 * `appendTrace`). Mirrors `signalsFile` but with the `traces.ndjson`
 * sibling so the analyzer can scan signals and traces independently.
 */
function tracesFile(eid, sid, config) {
  return path.join(storyTempDir(eid, sid, config), TRACES_BASENAME);
}

/**
 * Best-effort decoration of a signal record with a `source` field
 * (`"framework"` or `"consumer"`) produced by `classifyPathSource`.
 *
 * Rules (Epic #2547 / Story #2553 / Tech Spec #2550):
 *   - If the record is not a plain object (string, number, null,
 *     undefined), return it unchanged — the writer's existing
 *     serialisation guard will reject or pass it through as before.
 *   - If the caller pre-set `signal.source`, preserve it verbatim. Some
 *     detectors classify upstream (e.g. wave-lifecycle signals always
 *     belong to the framework) and we MUST NOT overwrite their
 *     intentional tag.
 *   - Otherwise, invoke `classifyPathSource` against the record's
 *     `failingPath` / `path` and `command` fields, and inject the result
 *     as a new `source` key. The classifier itself never throws, but we
 *     belt-and-braces a try/catch so an unexpected fault degrades to a
 *     `Logger.warn` and a passthrough of the original signal — never a
 *     dropped write.
 *
 * @param {unknown} signal
 * @returns {unknown}
 */
function tagSignalSource(signal) {
  if (signal === null || typeof signal !== 'object' || Array.isArray(signal)) {
    return signal;
  }
  // Caller-supplied source wins, even when undefined-typed but present as
  // an own property — only inject when the key is absent entirely so we
  // never overwrite an explicit decision.
  if (Object.hasOwn(signal, 'source')) {
    return signal;
  }
  try {
    const record = /** @type {Record<string, unknown>} */ (signal);
    const failingPath = record.failingPath ?? record.path;
    const command = record.command;
    const source = classifyPathSource(failingPath, command);
    return { ...record, source };
  } catch (err) {
    Logger.warn(
      `signals-writer: source classifier failed (${
        err instanceof Error ? err.message : String(err)
      }); falling back to original signal without source tag`,
    );
    return signal;
  }
}

/**
 * Best-effort append of a single record as one newline-terminated JSON
 * line. Caller-supplied record must be JSON-serialisable; circular refs
 * or BigInt fields are reported via `Logger.warn` and dropped.
 *
 * @param {string} targetPath
 * @param {unknown} record
 * @returns {Promise<boolean>} true on success, false on any swallowed failure.
 */
async function appendOne(targetPath, record) {
  let line;
  try {
    line = `${JSON.stringify(record)}\n`;
  } catch (err) {
    Logger.warn(
      `signals-writer: failed to serialise record for ${targetPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }

  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.appendFile(targetPath, line, 'utf8');
    return true;
  } catch (err) {
    Logger.warn(
      `signals-writer: append failed for ${targetPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/**
 * Append one signal record to `temp/epic-<eid>/stories/story-<sid>/signals.ndjson`.
 *
 * The `signal` is written verbatim — callers (detectors) own its shape
 * (kind, severity, message, etc.). The writer adds nothing. Errors are
 * logged via `Logger.warn` and never thrown.
 *
 * @param {{ epicId: number, storyId: number, signal: unknown, config?: object }} args
 * @returns {Promise<boolean>}
 */
export async function appendSignal(args) {
  const { epicId, storyId, signal, config } = args ?? {};
  let target;
  try {
    target = signalsFile(epicId, storyId, config);
  } catch (err) {
    Logger.warn(
      `signals-writer: invalid epicId/storyId for appendSignal: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
  return appendOne(target, tagSignalSource(signal));
}

/**
 * Append one signal record to the per-Epic stream at
 * `temp/epic-<eid>/signals.ndjson` — used for wave-lifecycle signals
 * (`wave-start`, `wave-tick`, `wave-complete`, `epic-complete`) that are
 * not scoped to an individual Story.
 *
 * @param {{ epicId: number, signal: unknown, config?: object }} args
 * @returns {Promise<boolean>}
 */
export async function appendEpicSignal(args) {
  const { epicId, signal, config } = args ?? {};
  let target;
  try {
    target = epicArtifactPath(epicId, EPIC_SIGNALS_BASENAME, config);
  } catch (err) {
    Logger.warn(
      `signals-writer: invalid epicId for appendEpicSignal: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
  return appendOne(target, tagSignalSource(signal));
}

/**
 * Append one trace record to `temp/epic-<eid>/stories/story-<sid>/traces.ndjson`.
 * Same robustness contract as `appendSignal` — never throws.
 *
 * @param {{ epicId: number, storyId: number, trace: unknown, config?: object }} args
 * @returns {Promise<boolean>}
 */
export async function appendTrace(args) {
  const { epicId, storyId, trace, config } = args ?? {};
  let target;
  try {
    target = tracesFile(epicId, storyId, config);
  } catch (err) {
    Logger.warn(
      `signals-writer: invalid epicId/storyId for appendTrace: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
  return appendOne(target, trace);
}

/**
 * Stream `signals.ndjson` line by line, invoking `cb(parsed, lineNumber)`
 * for each successfully parsed JSON line. `lineNumber` is 1-based to
 * match operator log expectations. Malformed lines are skipped with a
 * `Logger.warn`. A missing file resolves with `missing: true` rather
 * than throwing — the analyzer treats absence as "no signals yet" and
 * keeps walking.
 *
 * @param {number} epicId
 * @param {number} storyId
 * @param {(parsed: unknown, lineNumber: number) => unknown | Promise<unknown>} cb
 * @param {object} [config]
 * @returns {Promise<{ linesRead: number, linesParsed: number, missing: boolean }>}
 */
export async function forEachLine(epicId, storyId, cb, config) {
  if (typeof cb !== 'function') {
    Logger.warn('signals-writer: forEachLine called without a callback');
    return { linesRead: 0, linesParsed: 0, missing: false };
  }

  let target;
  try {
    target = signalsFile(epicId, storyId, config);
  } catch (err) {
    Logger.warn(
      `signals-writer: invalid epicId/storyId for forEachLine: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { linesRead: 0, linesParsed: 0, missing: false };
  }

  try {
    await fs.access(target);
  } catch {
    return { linesRead: 0, linesParsed: 0, missing: true };
  }

  let linesRead = 0;
  let linesParsed = 0;
  const stream = createReadStream(target, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const rawLine of rl) {
      linesRead += 1;
      // Skip empty lines (trailing newline at EOF, accidental blanks).
      if (rawLine.length === 0) continue;
      let parsed;
      try {
        parsed = JSON.parse(rawLine);
      } catch (err) {
        Logger.warn(
          `signals-writer: malformed JSON at ${target}:${linesRead} (${
            err instanceof Error ? err.message : String(err)
          })`,
        );
        continue;
      }
      linesParsed += 1;
      try {
        await cb(parsed, linesRead);
      } catch (err) {
        Logger.warn(
          `signals-writer: forEachLine cb threw at ${target}:${linesRead}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  } catch (err) {
    Logger.warn(
      `signals-writer: forEachLine read failed for ${target}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return { linesRead, linesParsed, missing: false };
}
