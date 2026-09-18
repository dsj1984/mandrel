/**
 * Append-only writer and readers for per-Story `signals.ndjson`. Best-effort:
 * failures are logged, never thrown. No buffering — emitters run in
 * sub-agents that may exit abruptly.
 */

import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import {
  resolvedTempRoot,
  SIGNALS_BASENAME,
  STANDALONE_DIRNAME,
  STORIES_DIRNAME,
  signalsFile,
} from '../config/temp-paths.js';
import { Logger } from '../Logger.js';
import { validateSignal } from './signal-validator.js';
import { classifySignalSource } from './source-classifier.js';

/**
 * `source` means only framework/consumer (the tool lives in `emitter`); a
 * caller-set canonical value is kept, anything else overwritten.
 *
 * @param {unknown} signal
 * @returns {unknown}
 */
function tagSignalSource(signal) {
  if (signal === null || typeof signal !== 'object' || Array.isArray(signal)) {
    return signal;
  }
  const record = /** @type {Record<string, unknown>} */ (signal);
  if (record.source === 'framework' || record.source === 'consumer') {
    return record;
  }
  try {
    return { ...record, source: classifySignalSource(record) };
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
 * @param {unknown} record
 * @param {string} label
 * @returns {boolean} true when the record is valid (safe to append).
 */
function validateOrDrop(record, label) {
  const { valid, violatingField, message } = validateSignal(record);
  if (valid) return true;
  Logger.warn(
    `signals-writer: dropping schema-invalid ${label} record — violating field '${violatingField}' (${message}).`,
  );
  return false;
}

/**
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
  const tagged = tagSignalSource(signal);
  if (!validateOrDrop(tagged, 'signal')) return false;
  return appendOne(target, tagged);
}

/**
 * Shared reader spine; malformed lines and callback throws are skipped.
 *
 * @param {string} target
 * @param {(parsed: unknown, lineNumber: number) => unknown | Promise<unknown>} cb
 * @param {string} label
 * @returns {Promise<{ linesRead: number, linesParsed: number, missing: boolean }>}
 */
async function forEachLineIn(target, cb, label) {
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
          `signals-writer: ${label} cb threw at ${target}:${linesRead}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  } catch (err) {
    Logger.warn(
      `signals-writer: ${label} read failed for ${target}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return { linesRead, linesParsed, missing: false };
}

/**
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

  return forEachLineIn(target, cb, 'forEachLine');
}

const RUN_DIR_RE = /^run-\d+$/;

const STORY_DIR_RE = /^story-(\d+)$/;

/**
 * @param {string} dir
 * @returns {Promise<import('node:fs').Dirent[]>}
 */
async function readDirEntries(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Every surviving stream (both layouts) — the recurrence window. Sorted so
 * composed proposals are deterministic.
 *
 * @param {object} [config]
 * @returns {Promise<Array<{ storyId: number, file: string }>>}
 */
async function listStorySignalStreams(config) {
  let root;
  try {
    root = resolvedTempRoot(config);
  } catch (err) {
    Logger.warn(
      `signals-writer: cannot resolve tempRoot for stream discovery: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }

  const storiesDirs = [];
  for (const entry of await readDirEntries(root)) {
    if (!entry.isDirectory()) continue;
    if (entry.name !== STANDALONE_DIRNAME && !RUN_DIR_RE.test(entry.name)) {
      continue;
    }
    storiesDirs.push(path.join(root, entry.name, STORIES_DIRNAME));
  }

  const streams = [];
  for (const storiesDir of storiesDirs) {
    for (const entry of await readDirEntries(storiesDir)) {
      if (!entry.isDirectory()) continue;
      const match = STORY_DIR_RE.exec(entry.name);
      if (match === null) continue;
      streams.push({
        storyId: Number(match[1]),
        file: path.join(storiesDir, entry.name, SIGNALS_BASENAME),
      });
    }
  }
  return streams.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * `context.storyId` is the stream owner (a fallback only); `file` +
 * `lineNumber` de-duplicate legacy rows without `eventId`.
 *
 * @param {(parsed: unknown, context: { storyId: number, file: string, lineNumber: number }) => unknown | Promise<unknown>} cb
 * @param {object} [config]
 * @returns {Promise<{ streams: number, linesParsed: number }>}
 */
export async function forEachSignalStreamLine(cb, config) {
  if (typeof cb !== 'function') {
    Logger.warn(
      'signals-writer: forEachSignalStreamLine called without a callback',
    );
    return { streams: 0, linesParsed: 0 };
  }
  const streams = await listStorySignalStreams(config);
  let linesParsed = 0;
  for (const { storyId, file } of streams) {
    const result = await forEachLineIn(
      file,
      (parsed, lineNumber) => cb(parsed, { storyId, file, lineNumber }),
      'forEachSignalStreamLine',
    );
    linesParsed += result.linesParsed;
  }
  return { streams: streams.length, linesParsed };
}
