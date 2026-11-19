// lib/cli/ui/log-tail.js
/**
 * The last lines of a dispatched delivery's log, one readable line per
 * event. A log is read only when its recorded path resolves inside the
 * dispatch directory, and only its last 64 KiB.
 *
 * @module cli/ui/log-tail
 */

import fs from 'node:fs';
import path from 'node:path';

const TAIL_BYTES = 64 * 1024;
const TAIL_LINES = 50;
const TEXT_MAX = 200;
const ARG_MAX = 120;

const oneLine = (text, max) =>
  String(text).replace(/\s+/g, ' ').trim().slice(0, max);

function blockLine(block) {
  if (block?.type === 'text') return oneLine(block.text ?? '', TEXT_MAX);
  if (block?.type !== 'tool_use') return '';
  const input = block.input ?? {};
  const arg = input.command ?? input.file_path ?? input.path ?? '';
  return oneLine(`tool: ${block.name} ${oneLine(arg, ARG_MAX)}`, TEXT_MAX);
}

/**
 * The readable lines one log line becomes: assistant text and tool calls,
 * a result's subtype, a non-JSON line as it is; any other event is dropped.
 *
 * @param {string} line
 * @returns {string[]}
 */
function summarizeLine(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    const raw = line.slice(0, TEXT_MAX);
    return raw.trim() ? [raw] : [];
  }
  if (event?.type === 'result') return [`result: ${event.subtype}`];
  if (event?.type !== 'assistant') return [];
  const content = event.message?.content;
  return (Array.isArray(content) ? content : []).map(blockLine).filter(Boolean);
}

/** Whether `file` resolves inside `dir`. */
function isInside(dir, file) {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function readLastBytes(file, fsImpl) {
  const fd = fsImpl.openSync(file, 'r');
  try {
    const { size } = fsImpl.fstatSync(fd);
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fsImpl.readSync(fd, buffer, 0, length, size - length);
    return { text: buffer.toString('utf8'), partial: size > length };
  } finally {
    fsImpl.closeSync(fd);
  }
}

/**
 * At most 50 summarized lines from the end of `logPath`; `[]` when the path
 * is missing, outside `dir`, or unreadable.
 *
 * @param {string|null|undefined} logPath
 * @param {{ dir: string, fsImpl?: typeof fs }} opts
 * @returns {string[]}
 */
export function readLogTail(logPath, { dir, fsImpl = fs }) {
  if (typeof logPath !== 'string' || !isInside(dir, logPath)) return [];
  let tail;
  try {
    tail = readLastBytes(logPath, fsImpl);
  } catch {
    return [];
  }
  const lines = tail.text.split(/\r?\n/);
  // A cut-off first line is the end of an event, not one.
  if (tail.partial) lines.shift();
  return lines.flatMap(summarizeLine).slice(-TAIL_LINES);
}
