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
 * Biome's marker for "you handed me a path set, but every one of them is
 * excluded by my own config (`files.includes` allowlist / `files.ignore` /
 * `overrides`), so I processed nothing" — biome exits 1 in that case.
 *
 * The format gate scopes biome to the changed-file subset (Story #3410). When
 * that subset is non-empty by extension but every path is biome-config-ignored,
 * the scoped invocation reports this message and exits 1 even though
 * `biome format .` over the whole tree is clean — a false negative for the
 * gate (Story #4292). Detecting the marker lets the runner treat that exit as
 * a clean skip rather than a formatting failure.
 */
const BIOME_NO_FILES_PROCESSED =
  'No files were processed in the specified paths';

/**
 * Whether biome's combined gate output carries the "No files were processed"
 * marker. Pure function — no I/O. Exported for unit coverage (Story #4292).
 *
 * @param {string} output - Combined stdout/stderr captured from the gate child.
 * @returns {boolean}
 */
export function isBiomeNoFilesProcessed(output) {
  return (
    typeof output === 'string' && output.includes(BIOME_NO_FILES_PROCESSED)
  );
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
 * When `opts.tolerateNoFilesProcessed` is set (the biome-scoped format gate —
 * Story #4292), a non-zero exit whose combined output carries biome's
 * "No files were processed" marker is downgraded to a clean `status: 0`,
 * because that exit means every config-included path was already excluded,
 * not that formatting drifted.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string, signal?: AbortSignal, gateName?: string, log?: (m: string) => void, env?: Record<string, string>, tolerateNoFilesProcessed?: boolean }} opts
 * @returns {Promise<{ status: number }>}
 */
export function defaultGateRunner(cmd, args, opts = {}) {
  const { cwd, signal, gateName, log, env, tolerateNoFilesProcessed } = opts;
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
  // Capture the combined output only when we may need to inspect it for the
  // biome "No files were processed" marker — otherwise the stream is purely
  // piped through to the operator (no retained buffer).
  let captured = '';
  const tap = tolerateNoFilesProcessed
    ? (line) => {
        captured += `${line}\n`;
        emit(line);
      }
    : emit;
  pipePrefixed(child.stdout, prefix, tap);
  pipePrefixed(child.stderr, prefix, tap);
  const detach = attachGateAbortHandler(child, signal);
  return new Promise((resolve) => {
    child.on('exit', (code, sig) => {
      detach();
      const status = gateExitCode(code, sig);
      if (
        status !== 0 &&
        tolerateNoFilesProcessed &&
        isBiomeNoFilesProcessed(captured)
      ) {
        emit(
          `${prefix}↳ biome processed zero files (all changed paths are config-ignored); treating as a clean skip`,
        );
        resolve({ status: 0 });
        return;
      }
      resolve({ status });
    });
    child.on('error', () => {
      detach();
      resolve({ status: 1 });
    });
  });
}
