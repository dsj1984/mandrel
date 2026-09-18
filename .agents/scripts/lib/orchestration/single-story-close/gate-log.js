/**
 * single-story-close/gate-log.js — bounded gate output for the close path
 * (Story #4736).
 *
 * ## Why
 *
 * `runCloseValidation` streams every child gate's stdout/stderr line through
 * an injected `log`, and the close phase used to hand it `Logger.info` — whose
 * default sink is `console.log`. A single successful close therefore wrote the
 * whole of `npm test`, the linter, and the baseline checks onto the invoking
 * agent's stdout: ~50KB, over the host's inline tool-result ceiling. The caller
 * got a truncated preview, had to open the persisted file anyway, and re-ran
 * close for a clean envelope — burning the run's most expensive stretch to
 * re-derive output it already had.
 *
 * Story #4708 set the contract this restores compliance with (see
 * `docs/contributing/orchestration-error-handling.md` § Output Contract): compact digest
 * plus an on-disk artifact path, ≤ ~2KB on the **default success path**.
 *
 * ## The shape
 *
 * A sink captures every gate line to a log under the gitignored temp tree and
 * emits nothing inline. What happens next depends on the outcome, because the
 * two outcomes want opposite things:
 *
 *   - **success** — the caller wants the verdict, not the evidence.
 *     {@link GateLogSink#digest} is one line: the pass count and the log path.
 *   - **failure** — the evidence IS the point, and making the caller open a
 *     file to see why a gate went red just moves the cost.
 *     {@link GateLogSink#replay} puts the captured tail back inline.
 *
 * `AGENT_LOG_LEVEL=verbose` opts back into live inline streaming (the
 * "existing log-level control"): the capture still happens, so the artifact is
 * written either way.
 *
 * The sink never throws. A log directory that cannot be written degrades to
 * inline streaming — losing the size bound is strictly better than losing the
 * gate output that says why a close failed.
 *
 * ## Why the artifact is written asynchronously (Story #4766)
 *
 * This sink is the `log` callable that `close-validation/process.js` invokes
 * from inside the gate child's stdout/stderr `'data'` handler — once per line.
 * The first cut wrote each line with `fs.writeSync`, which blocks the event
 * loop while the child keeps writing: the OS pipe buffer fills, the child's
 * write fails with `EAGAIN`, and a child that does not tolerate that dies. On
 * a clean `main` `biome ci .` already emits ~625 lines, and it aborts with
 * exit 101 (a `biome_console` panic, not a lint violation) when it happens —
 * so the first gate of any close could die on plumbing while its verdict was
 * green.
 *
 * So the write path buffers into an async stream instead: per-line work is
 * O(1) and never touches a syscall on the drain path. The cost is that the
 * artifact is not on disk the instant a line is logged, which is why the sink
 * exposes {@link GateLogSink#flush} — callers await it before reading,
 * replaying, or naming the artifact as final.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

import { orchestrationLogDir } from '../../config/temp-paths.js';
import { Logger, resolveLevel } from '../../Logger.js';

/**
 * How many trailing captured lines {@link GateLogSink#replay} puts back
 * inline. A failed gate's actionable evidence — the assertion, the stack, the
 * summary counts — sits at the end of its output; the head is startup noise.
 * The full text is always in the artifact regardless.
 */
export const REPLAY_TAIL_LINES = 200;

/**
 * Basename of the per-Story gate log inside the temp directory.
 *
 * `closeGateLogPath` in `lib/config/temp-paths.js` spells the same name for the
 * READER — `deliver-recover.js` uses this file's freshness to tell a live close
 * from a dead one. Deliberately not shared through an import: this sink needs
 * the basename alone (it honours a `logDir` override the path helper knows
 * nothing about), and calling that helper for it would drag tempRoot
 * resolution — a git spawn and scratch-dir creation — into a filename lookup.
 * The two spellings are pinned equal by test instead.
 */
function logNameFor(storyId) {
  return `close-gates-${storyId ?? 'unknown'}.log`;
}

/**
 * A capturing sink for close-validation gate output.
 *
 * Not exported as a constructor — {@link createGateLogSink} owns the
 * degradation decision, so every instance in the wild has already resolved
 * whether it has a writable artifact.
 */
class GateLogSink {
  /**
   * @param {{ logPath: string|null, streamInline: boolean, write: (line: string) => void, flush?: () => Promise<void>, emit: (line: string) => void }} args
   */
  constructor({ logPath, streamInline, write, flush, emit }) {
    /** Absolute path of the artifact, or `null` when capture is unavailable. */
    this.logPath = logPath;
    /** Whether lines are ALSO echoed inline as they arrive. */
    this.streamInline = streamInline;
    /** Number of lines captured so far. */
    this.lineCount = 0;
    this._write = write;
    this._flush = flush ?? (() => Promise.resolve());
    this._emit = emit;
    this._tail = [];
  }

  /**
   * The `log` callable handed to `runCloseValidation` / `buildDefaultGates`.
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
   * Settle the artifact: wait for every buffered line to reach disk and close
   * the file. Idempotent, never throws, and a no-op on the degraded (no
   * artifact) path. Await it before reading {@link GateLogSink#logPath} or
   * handing the path to anyone — the write path is async precisely so it never
   * stalls a gate child's pipe.
   *
   * @returns {Promise<void>}
   */
  flush() {
    return this._flush();
  }

  /**
   * The success-path digest: one line, no gate output. Names the artifact so
   * the caller can open it on demand rather than carrying it all session.
   *
   * @returns {string}
   */
  digest() {
    const where = this.logPath
      ? `full gate output → ${this.logPath}`
      : 'full gate output was streamed inline (no artifact could be written)';
    return `${this.lineCount} line(s) of gate output captured; ${where}`;
  }

  /**
   * Put the captured tail back inline — the failure path, where the evidence
   * is what the caller came for. A no-op when the lines were already streamed
   * inline (verbose, or degraded capture), so nothing is ever printed twice.
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
 * Wrap an already-open artifact fd in a non-blocking line writer.
 *
 * `write` hands the line to a `fs.WriteStream` — O(1), no syscall on the
 * caller's stack — and `flush` ends the stream, resolving once every buffered
 * line has reached disk (or the stream has errored; a half-written artifact is
 * still better than a dead close). Both are best-effort by construction: the
 * stream's `'error'` is absorbed, so nothing here can abort a close.
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
 * Build the gate-output sink for one close run.
 *
 * @param {{
 *   storyId: number|null,
 *   logDir?: string,
 *   fs?: typeof nodeFs,
 *   logger?: { info: (m: string) => void },
 *   level?: string,
 *   config?: object,
 * }} [args] `logDir` defaults to the configured `<tempRoot>/orchestration`
 *   (Story #4794 — was a hardcoded `<cwd>/temp/orchestration`, which ignored
 *   `project.paths.tempRoot` and hid the artifact from the retention purge);
 *   `level` defaults to the live Logger level so `AGENT_LOG_LEVEL=verbose`
 *   restores streaming.
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
    // Truncate: each close run owns its artifact outright, so a re-run never
    // hands the reader a file interleaving two runs' gates.
    writer = createArtifactWriter(fs, logPath, fs.openSync(logPath, 'w'));
  } catch {
    // No artifact — fall back to inline streaming rather than dropping the
    // gate output on the floor.
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
