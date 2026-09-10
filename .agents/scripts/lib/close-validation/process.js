/**
 * close-validation/process.js — Child-process lifecycle plumbing for gates.
 *
 * Owns the default async gate runner (spawn + line-prefixed stdio piping)
 * and the AbortSignal / exit-code helpers it composes.
 */

import { spawn } from 'node:child_process';

import { withFullSuiteLockAsync } from '../full-suite-lock.js';

/**
 * Pipe a child stream's output line-by-line through `emit`, prepending
 * `prefix` to each line. Tail bytes without a trailing newline flush on
 * `end` so the operator never loses the last line of a gate's output.
 *
 * ## The drain must stay cheap (Story #4766)
 *
 * This handler runs on the reader side of the child's stdout/stderr pipe.
 * Every microsecond spent here is a microsecond the pipe is not being read,
 * and once the OS pipe buffer fills, the child's own write blocks — or, on a
 * non-blocking pipe, fails outright with `EAGAIN`. A gate child is not
 * obliged to survive that: Biome's `biome_console` `.unwrap()`s the error and
 * aborts the process with exit 101, so a green lint verdict presents as a
 * failed close. Two consequences bind everything on this path:
 *
 *   1. Splitting is O(chunk), not O(chunk × lines) — the scan advances a
 *      `start` index instead of re-slicing the buffer once per line, so a
 *      64KB chunk carrying 500 lines does not copy 16MB.
 *   2. **`emit` MUST NOT block.** A synchronous per-line file write is
 *      exactly the stall this path cannot afford; the close path's capture
 *      sink (`single-story-close/gate-log.js`) buffers to an async stream for
 *      that reason.
 */
function pipePrefixed(stream, prefix, emit) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let start = 0;
    let nl = buf.indexOf('\n', start);
    while (nl !== -1) {
      emit(prefix + buf.slice(start, nl));
      start = nl + 1;
      nl = buf.indexOf('\n', start);
    }
    if (start > 0) buf = buf.slice(start);
  });
  stream.on('end', () => {
    if (buf.length > 0) {
      emit(prefix + buf);
      buf = '';
    }
  });
  // A pipe-level error (EIO on a vanished child) must not become an
  // unhandled 'error' event that takes the whole close down.
  stream.on('error', () => {});
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
 * How many trailing gate lines the "No files were processed" probe retains.
 *
 * The marker only ever appears when biome processed nothing, and in that case
 * its whole output is a handful of lines — so a bounded tail always contains
 * it when it is there at all. Retaining a tail rather than the full transcript
 * keeps the drain path's per-line work O(1) in the volume of gate output
 * (Story #4766): the previous `captured += line` grew a string without limit,
 * on the one gate (biome/format) whose output is the loudest.
 */
const MARKER_PROBE_TAIL_LINES = 32;

/**
 * Whether biome's combined gate output carries the "No files were processed"
 * marker. Pure function — no I/O. Exported for unit coverage (Story #4292).
 *
 * @param {string} output - Combined stdout/stderr captured from the gate child.
 * @returns {boolean}
 */
function isBiomeNoFilesProcessed(output) {
  return (
    typeof output === 'string' && output.includes(BIOME_NO_FILES_PROCESSED)
  );
}

/**
 * Default async gate runner — used by `runCloseValidation` when no `runner`
 * is injected. Spawns the gate via `child_process.spawn`, prefixes every
 * stdout/stderr line with `[gate-name] ` (so concurrent gates don't bleed
 * into each other in the operator's terminal), and resolves only once the
 * child has exited and both stdio pipes are drained.
 *
 * `opts.log` is the drain sink and **must not block** — see `pipePrefixed`
 * above for what a synchronous per-line write costs the child (Story #4766).
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
 * When `opts.fullSuiteLock` is set — the standalone `test` gate, the one gate
 * here that runs a whole suite (Story #5173) — the spawn is serialized behind
 * the host-level advisory lock so two concurrent closes on one checkout do not
 * run two suites against the same cores. Best-effort: a wait that expires
 * spawns anyway. The async wrapper is used rather than the synchronous one
 * precisely because this runner drives sibling gates on the same event loop,
 * which a blocking wait would stall.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string, signal?: AbortSignal, gateName?: string, log?: (m: string) => void, env?: Record<string, string>, tolerateNoFilesProcessed?: boolean, fullSuiteLock?: boolean, skipIfSatisfied?: () => {status: number}|undefined }} opts
 * @returns {Promise<{ status: number }>}
 */
export function defaultGateRunner(cmd, args, opts = {}) {
  if (!opts.fullSuiteLock) return spawnGate(cmd, args, opts);
  // `log` is passed through as-is: `withFullSuiteLockAsync` supplies its own
  // no-op default, so a second fallback here would be an untestable branch.
  // `skipIfSatisfied` (Story #5278) is the caller's post-wait re-probe: after
  // queueing behind another full suite, the gate re-asks whether its evidence
  // has since been deposited and returns that verdict instead of spawning.
  return withFullSuiteLockAsync(
    { cwd: opts.cwd, log: opts.log, skipIfSatisfied: opts.skipIfSatisfied },
    () => spawnGate(cmd, args, opts),
  );
}

/**
 * The bare gate spawn — child process, prefixed drain, abort wiring, exit-code
 * normalisation. Split from {@link defaultGateRunner} so the full-suite lock
 * composes over one named unit.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {Parameters<typeof defaultGateRunner>[2]} opts
 * @returns {Promise<{ status: number }>}
 */
function spawnGate(cmd, args, opts) {
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
  // Retain a bounded tail only when we may need to inspect it for the biome
  // "No files were processed" marker — otherwise the stream is purely piped
  // through to the operator (no retained buffer).
  const recent = [];
  const tap = tolerateNoFilesProcessed
    ? (line) => {
        recent.push(line);
        if (recent.length > MARKER_PROBE_TAIL_LINES) recent.shift();
        emit(line);
      }
    : emit;
  pipePrefixed(child.stdout, prefix, tap);
  pipePrefixed(child.stderr, prefix, tap);
  const detach = attachGateAbortHandler(child, signal);
  return new Promise((resolve) => {
    // 'close', not 'exit' (Story #4766): 'close' fires only once the child has
    // exited AND both stdio pipes have been fully drained and closed, so no
    // gate ever reports its status while lines are still in flight. Resolving
    // on 'exit' raced the tail of a high-volume gate's output.
    child.on('close', (code, sig) => {
      detach();
      const status = gateExitCode(code, sig);
      if (
        status !== 0 &&
        tolerateNoFilesProcessed &&
        isBiomeNoFilesProcessed(recent.join('\n'))
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
