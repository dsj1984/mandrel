/**
 * evidence-stream.js — run one handoff child with its evidence log written
 * live (Story #5694). The log is opened before the child spawns, its path is
 * announced on the progress channel, and every stdout/stderr chunk is
 * appended in arrival order, so an operator can tail a minutes-long suite.
 *
 * Authority is unchanged: the caller decides credit from the settled exit
 * status and the retained output only; streamed text is never inspected.
 * The heartbeat comes from a timer, never from child text. A log that cannot
 * be opened or written degrades to the completion-only write — the step is
 * never failed by its own evidence.
 */

import fs from 'node:fs';

export const HEARTBEAT_MS = 30_000;

const CANCEL_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM']);

/** The exit status a cancelled child reports when it raced to exit 0. */
const CANCELLED_EXIT_CODE = 130;

/**
 * With our listener gone, a signal nobody else handles terminates the
 * process the way it would have without the handoff in the way.
 *
 * @param {string} signal
 */
function defaultReraise(signal) {
  if (process.listenerCount(signal) > 0) return;
  try {
    process.kill(process.pid, signal);
  } catch {
    // A process that cannot signal itself is already on its way out.
  }
}

/**
 * An append-only sink over `file`. Any fs failure marks it broken and stops
 * writing; `finish` then rewrites the file whole from the retained output.
 *
 * @param {string} file
 * @param {typeof fs} fsImpl
 */
function openSink(file, fsImpl) {
  let fd = null;
  let wrote = false;
  try {
    fd = fsImpl.openSync(file, 'w');
  } catch {
    fd = null;
  }
  const close = () => {
    if (fd === null) return;
    try {
      fsImpl.closeSync(fd);
    } catch {
      // Closing a descriptor that already failed changes nothing.
    }
    fd = null;
  };
  let broken = fd === null;
  const write = (text) => {
    if (broken) return;
    try {
      fsImpl.writeSync(fd, text);
      wrote = true;
    } catch {
      broken = true;
      close();
    }
  };
  return {
    write,
    /**
     * @param {string} output the retained combined output.
     * @param {string[]} terminal lines the handoff itself appends.
     */
    finish(output, terminal) {
      const tail = terminal.map((line) => `${line}\n`).join('');
      if (!broken && wrote) {
        write(tail);
        if (!broken) {
          close();
          return;
        }
      }
      close();
      // Nothing streamed (a non-streaming runner) or the stream broke.
      const head = output && tail ? `${output}\n` : output;
      try {
        fsImpl.writeFileSync(file, `${head}${tail}`, 'utf8');
      } catch {
        // Evidence is best effort; the step's outcome stands.
      }
    },
  };
}

/** @param {number} ms */
const seconds = (ms) => Math.round(ms / 1000);

/**
 * Emit `running <elapsed>s, last output <n>s ago` on each tick that finds
 * the child silent for at least one interval.
 */
function startHeartbeat({ progress, tag, heartbeatMs, now, lastOutput }) {
  const startedAt = now();
  const timer = setInterval(() => {
    const at = now();
    const silent = at - lastOutput();
    if (silent < heartbeatMs) return;
    progress(
      tag,
      `running ${seconds(at - startedAt)}s, last output ${seconds(silent)}s ago`,
    );
  }, heartbeatMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Cancel the child on SIGINT/SIGTERM; `detach()` removes the listeners.
 *
 * @returns {{ controller: AbortController, cancelled: () => string|null, detach: () => void }}
 */
function trapCancellation(signalTarget) {
  const controller = new AbortController();
  let cancelled = null;
  const handlers = CANCEL_SIGNALS.map((signal) => {
    const handler = () => {
      cancelled ??= signal;
      controller.abort();
    };
    signalTarget.on(signal, handler);
    return [signal, handler];
  });
  return {
    controller,
    cancelled: () => cancelled,
    detach() {
      for (const [signal, handler] of handlers) {
        signalTarget.off(signal, handler);
      }
    },
  };
}

/** @param {number} ms */
function describeTimeout(ms) {
  return `[handoff] child timed out after ${Number((ms / 1000).toFixed(1))}s`;
}

/**
 * Run `cmd args` through `runCommand`, streaming its output to `file`.
 *
 * @param {{
 *   runCommand: Function, cmd: string, args: string[], opts: object,
 *   file: string, tag: string, progress: (tag: string, msg: string) => void,
 *   heartbeatMs?: number, timeoutMs?: number|null,
 *   signalTarget?: import('node:events').EventEmitter,
 *   reraise?: (signal: string) => void, now?: () => number,
 *   fsImpl?: typeof fs,
 * }} request
 * @returns {Promise<{ status: number, output: string, evidencePath: string }>}
 */
export async function runStreamed({
  runCommand,
  cmd,
  args,
  opts,
  file,
  tag,
  progress,
  heartbeatMs = HEARTBEAT_MS,
  timeoutMs = null,
  signalTarget = process,
  reraise = defaultReraise,
  now = Date.now,
  fsImpl = fs,
}) {
  const sink = openSink(file, fsImpl);
  progress(tag, `evidence ${file}`);
  let lastOutputAt = now();
  const trap = trapCancellation(signalTarget);
  const stopHeartbeat = startHeartbeat({
    progress,
    tag,
    heartbeatMs,
    now,
    lastOutput: () => lastOutputAt,
  });
  let res;
  try {
    res = await runCommand(cmd, args, {
      ...opts,
      signal: trap.controller.signal,
      ...(timeoutMs ? { timeoutMs } : {}),
      onChunk: (text) => {
        lastOutputAt = now();
        sink.write(text);
      },
    });
  } finally {
    stopHeartbeat();
    trap.detach();
  }
  const output = [res.stdout, res.stderr].filter(Boolean).join('\n');
  const cancelled = trap.cancelled();
  const terminal = [];
  if (res.timedOut) terminal.push(describeTimeout(timeoutMs ?? 0));
  if (cancelled) terminal.push('[handoff] cancelled');
  sink.finish(output, terminal);
  if (cancelled) reraise(cancelled);
  const status =
    cancelled && res.status === 0 ? CANCELLED_EXIT_CODE : res.status;
  return { status, output, evidencePath: file };
}
