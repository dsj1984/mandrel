/**
 * close-validation/process.js — Child-process lifecycle plumbing for gates.
 *
 * Owns the default async gate runner (spawn + line-prefixed stdio piping)
 * and the AbortSignal / exit-code helpers it composes.
 */

import { spawn } from 'node:child_process';

/**
 * Pipe a child stream's output line-by-line through `emit`, prepending
 * `prefix` to each line. Tail bytes without a trailing newline flush on
 * `end` so the operator never loses the last line of a gate's output.
 */
function pipePrefixed(stream, prefix, emit) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    while (true) {
      const nl = buf.indexOf('\n');
      if (nl === -1) break;
      emit(prefix + buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  });
  stream.on('end', () => {
    if (buf.length > 0) emit(prefix + buf);
  });
}

/** Wire the AbortSignal so an abort kills the child. Returns the cleanup fn. */
export function attachGateAbortHandler(child, signal) {
  if (!signal) return () => {};
  const killChild = () => {
    try {
      child.kill('SIGTERM');
    } catch {
      /* race: already exited */
    }
  };
  if (signal.aborted) {
    killChild();
    return () => {};
  }
  signal.addEventListener('abort', killChild, { once: true });
  return () => signal.removeEventListener('abort', killChild);
}

/** SIGTERM (no exit code) on abort → non-zero so the gate counts as failed. */
export function gateExitCode(code, sig) {
  if (typeof code === 'number') return code;
  return sig ? 143 : 1;
}

/**
 * Default async gate runner — used by `runCloseValidation` when no `runner`
 * is injected. Spawns the gate via `child_process.spawn`, prefixes every
 * stdout/stderr line with `[gate-name] ` (so concurrent gates don't bleed
 * into each other in the operator's terminal), and resolves only when the
 * child exits.
 *
 * Honours `opts.signal`: a TERM is delivered to the child the moment the
 * signal fires, so a sibling gate's failure aborts the rest of the wave
 * promptly. The promise still resolves (rather than rejecting) on abort —
 * `runCloseValidation` sees a non-zero status and folds it into the
 * already-recorded first-failure.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string, signal?: AbortSignal, gateName?: string, log?: (m: string) => void, env?: Record<string, string> }} opts
 * @returns {Promise<{ status: number }>}
 */
export function defaultGateRunner(cmd, args, opts = {}) {
  const { cwd, signal, gateName, log, env } = opts;
  const child = spawn(cmd, args, {
    cwd,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    // Per-gate env overlay (Story #3890): merged over the inherited
    // environment so a gate-scoped `BASELINE_REF` reaches the spawned
    // `check-baselines` child without mutating the parent process env.
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  const prefix = gateName ? `[${gateName}] ` : '';
  const emit =
    typeof log === 'function' ? log : (m) => process.stdout.write(`${m}\n`);
  pipePrefixed(child.stdout, prefix, emit);
  pipePrefixed(child.stderr, prefix, emit);
  const detach = attachGateAbortHandler(child, signal);
  return new Promise((resolve) => {
    child.on('exit', (code, sig) => {
      detach();
      resolve({ status: gateExitCode(code, sig) });
    });
    child.on('error', () => {
      detach();
      resolve({ status: 1 });
    });
  });
}
