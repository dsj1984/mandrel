/**
 * Run one handoff child with its evidence log written live, so an operator
 * can tail a long suite. Streamed text is never inspected: the caller decides
 * credit from the settled status and retained output. A log that cannot be
 * written degrades to the completion-only write, never a failed step.
 */

import fs from 'node:fs';

export const HEARTBEAT_MS = 30_000;

const CANCEL_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM']);

/** Reported when a cancelled child raced to exit 0. */
const CANCELLED_EXIT_CODE = 130;

/** With our listener gone, an unhandled signal terminates as it would have. */
function defaultReraise(signal) {
  if (process.listenerCount(signal) > 0) return;
  try {
    process.kill(process.pid, signal);
  } catch {}
}

/** Append-only sink; on any fs failure `finish` rewrites from the tail. */
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
    } catch {}
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
      const head = output && tail ? `${output}\n` : output;
      try {
        fsImpl.writeFileSync(file, `${head}${tail}`, 'utf8');
      } catch {}
    },
  };
}

/** @param {number} ms */
const seconds = (ms) => Math.round(ms / 1000);

/** Report elapsed time on each tick that finds the child silent. */
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

/** Abort the child on SIGINT/SIGTERM until `detach()`. */
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
  } catch (err) {
    sink.finish('', []);
    throw err;
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
