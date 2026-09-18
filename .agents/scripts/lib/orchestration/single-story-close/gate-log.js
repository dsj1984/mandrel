/**
 * single-story-close/gate-log.js — captures close gate output to an artifact;
 * success emits a digest line, failure replays the tail inline. Never throws.
 *
 * Writes are async, never `fs.writeSync`: this runs in the gate child's
 * `'data'` handler, and a blocking write fills the pipe until the child dies
 * on `EAGAIN`. Await {@link GateLogSink#flush} before reading the artifact.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

import { orchestrationLogDir } from '../../config/temp-paths.js';
import { Logger, resolveLevel } from '../../Logger.js';

/** Trailing lines replayed on failure; a failed gate's evidence sits at the end. */
export const REPLAY_TAIL_LINES = 200;

/**
 * `closeGateLogPath` (temp-paths.js) spells the same name for the reader; it
 * is not imported because that helper resolves tempRoot (a git spawn). The
 * two spellings are pinned equal by test.
 */
function logNameFor(storyId) {
  return `close-gates-${storyId ?? 'unknown'}.log`;
}

/** Built only by {@link createGateLogSink}, which owns the degradation decision. */
class GateLogSink {
  /**
   * @param {{ logPath: string|null, streamInline: boolean, write: (line: string) => void, flush?: () => Promise<void>, emit: (line: string) => void }} args
   */
  constructor({ logPath, streamInline, write, flush, emit }) {
    /** `null` when capture is unavailable. */
    this.logPath = logPath;
    this.streamInline = streamInline;
    this.lineCount = 0;
    this._write = write;
    this._flush = flush ?? (() => Promise.resolve());
    this._emit = emit;
    this._tail = [];
  }

  /**
   * Bound, because it is passed by reference into the gate machinery.
   *
   * @type {(message: string) => void}
   */
  get log() {
    return (message) => {
      const line = String(message ?? '');
      this.lineCount += 1;
      this._tail.push(line);
      if (this._tail.length > REPLAY_TAIL_LINES) this._tail.shift();
      this._write(line);
      if (this.streamInline) this._emit(line);
    };
  }

  /**
   * Wait for every buffered line to reach disk. Idempotent, never throws.
   *
   * @returns {Promise<void>}
   */
  flush() {
    return this._flush();
  }

  /**
   * @returns {string}
   */
  digest() {
    const where = this.logPath
      ? `full gate output → ${this.logPath}`
      : 'full gate output was streamed inline (no artifact could be written)';
    return `${this.lineCount} line(s) of gate output captured; ${where}`;
  }

  /**
   * Replay the captured tail inline; a no-op when already streamed inline.
   *
   * @returns {number} Lines replayed.
   */
  replay() {
    if (this.streamInline || this._tail.length === 0) return 0;
    const dropped = this.lineCount - this._tail.length;
    if (dropped > 0) {
      this._emit(
        `[close-validation] … ${dropped} earlier line(s) omitted; full output → ${this.logPath}`,
      );
    }
    for (const line of this._tail) this._emit(line);
    return this._tail.length;
  }
}

/**
 * Non-blocking line writer over an open fd. Stream errors are absorbed, so
 * nothing here can abort a close.
 *
 * @param {typeof nodeFs} fs
 * @param {string} logPath
 * @param {number} handle
 * @returns {{ write: (line: string) => void, flush: () => Promise<void> }}
 */
function createArtifactWriter(fs, logPath, handle) {
  const stream = fs.createWriteStream(logPath, { fd: handle, autoClose: true });
  stream.on('error', () => {
    /* best-effort: a mid-run write failure must not abort the close */
  });
  let ending = null;
  return {
    write: (line) => {
      if (ending) return;
      try {
        stream.write(`${line}\n`);
      } catch {
        /* best-effort: see above */
      }
    },
    flush: () => {
      ending ??= new Promise((resolve) => {
        const settle = () => resolve();
        stream.once('error', settle);
        try {
          stream.end(settle);
        } catch {
          settle();
        }
      });
      return ending;
    },
  };
}

/**
 * @param {{
 *   storyId: number|null,
 *   logDir?: string,
 *   fs?: typeof nodeFs,
 *   logger?: { info: (m: string) => void },
 *   level?: string,
 *   config?: object,
 * }} [args] `logDir` defaults to `<tempRoot>/orchestration`.
 * @returns {GateLogSink}
 */
export function createGateLogSink({
  storyId = null,
  logDir,
  fs = nodeFs,
  logger = Logger,
  level,
  config,
} = {}) {
  const emit = (line) => logger.info?.(line);
  const verbose = (level ?? resolveLevel()) === 'verbose';
  const dir = logDir ?? orchestrationLogDir(config);

  let writer = null;
  let logPath = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    logPath = path.join(dir, logNameFor(storyId));
    // Truncate so a re-run never interleaves two runs' gates.
    writer = createArtifactWriter(fs, logPath, fs.openSync(logPath, 'w'));
  } catch {
    // No artifact: stream inline rather than drop the gate output.
    return new GateLogSink({
      logPath: null,
      streamInline: true,
      write: () => {},
      emit,
    });
  }

  return new GateLogSink({
    logPath,
    streamInline: verbose,
    write: writer.write,
    flush: writer.flush,
    emit,
  });
}
