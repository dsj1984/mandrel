/**
 * close-validation/process.js — Child-process lifecycle plumbing for gates.
 *
 * Owns the default async gate runner (spawn + line-prefixed stdio piping)
 * and the AbortSignal / exit-code helpers it composes.
 */

import { spawn } from 'node:child_process';

import {
  LOCK_WAIT_EXPIRED_EXIT_CODE,
  withFullSuiteLockAsync,
} from '../full-suite-lock.js';
import {
  groupSpawnOptions,
  superviseGroup,
  TIMEOUT_EXIT_CODE,
} from '../process-group.js';

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
 * run two suites against the same cores. The async wrapper is used rather than
 * a blocking one precisely because this runner drives sibling gates on the
 * same event loop, which a blocking wait would stall. A wait that expires
 * spawns anyway, unless `opts.deferOnLockExpiry` is set (close only, Story
 * #5377): then nothing is spawned and the gate reports
 * `LOCK_WAIT_EXPIRED_EXIT_CODE` so close can end `pending` instead.
 *
 * Every gate child leads its own process group (Story #5377): `timeoutMs`,
 * an abort, and a SIGINT/SIGTERM to this process all kill the whole group, so
 * a suite's worker processes never outlive the gate that spawned them.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string, signal?: AbortSignal, gateName?: string, log?: (m: string) => void, env?: Record<string, string>, tolerateNoFilesProcessed?: boolean, fullSuiteLock?: boolean, deferOnLockExpiry?: boolean, timeoutMs?: number, lockOptions?: object, skipIfSatisfied?: () => {status: number}|undefined }} opts
 * @returns {Promise<{ status: number }>}
 */
export function defaultGateRunner(cmd, args, opts = {}) {
  if (!opts.fullSuiteLock) return spawnGate(cmd, args, opts);
  // `log` is passed through as-is: `withFullSuiteLockAsync` supplies its own
  // no-op default, so a second fallback here would be an untestable branch.
  // `skipIfSatisfied` (Story #5278) is the caller's post-wait re-probe: after
  // queueing behind another full suite, the gate re-asks whether its evidence
  // has since been deposited and returns that verdict instead of spawning.
  return withFullSuiteLockAsync(gateLockOptions(opts), () =>
    spawnGate(cmd, args, opts),
  );
}

/** The full-suite lock options a `fullSuiteLock` gate runs under. */
function gateLockOptions(opts) {
  return {
    cwd: opts.cwd,
    log: opts.log,
    skipIfSatisfied: opts.skipIfSatisfied,
    onWaitExpired: opts.deferOnLockExpiry ? deferredGateStatus : undefined,
    // Test seam only (lock path, wait budget); production never passes it.
    ...opts.lockOptions,
  };
}

/** The gate verdict an expired, deferred lock wait stands in for a spawn. */
function deferredGateStatus() {
  return { status: LOCK_WAIT_EXPIRED_EXIT_CODE };
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
  const child = spawnGateChild(cmd, args, opts);
  const output = gateOutput(opts);
  pipePrefixed(child.stdout, output.prefix, output.tap);
  pipePrefixed(child.stderr, output.prefix, output.tap);
  // A bare suite has nothing to clean up, so a signal to close SIGKILLs its
  // group; any other gate child (a capture holding the lock) gets SIGTERM so
  // its own handler can release what it holds and kill its own suite.
  const supervisor = superviseGroup(child, {
    timeoutMs: opts.timeoutMs,
    abortSignal: opts.signal,
    signalOnParentSignal: opts.fullSuiteLock ? 'SIGKILL' : 'SIGTERM',
  });
  return new Promise((resolve) => {
    // 'close', not 'exit' (Story #4766): 'close' fires only once the child has
    // exited AND both stdio pipes have been fully drained and closed, so no
    // gate ever reports its status while lines are still in flight. Resolving
    // on 'exit' raced the tail of a high-volume gate's output.
    child.on('close', (code, sig) => {
      supervisor.release();
      resolve({
        status: settledGateStatus({ code, sig, supervisor, opts, output }),
      });
    });
    child.on('error', () => {
      supervisor.release();
      resolve({ status: 1 });
    });
  });
}

/**
 * Spawn one gate child as the leader of its own process group.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string, env?: Record<string, string> }} opts
 */
function spawnGateChild(cmd, args, { cwd, env }) {
  return spawn(cmd, args, {
    cwd,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...groupSpawnOptions(),
    // Per-gate env overlay (Story #3890): merged over the inherited
    // environment so a gate-scoped `BASELINE_REF` reaches the spawned
    // `check-baselines` child without mutating the parent process env.
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
}

/**
 * The gate's output sink: its line prefix, the drain callback, and — only
 * when the biome marker may need inspecting — a bounded tail of recent lines.
 * Otherwise the stream is purely piped through (no retained buffer).
 *
 * @param {{ gateName?: string, log?: (m: string) => void, tolerateNoFilesProcessed?: boolean }} opts
 */
function gateOutput({ gateName, log, tolerateNoFilesProcessed }) {
  const prefix = gateName ? `[${gateName}] ` : '';
  const emit =
    typeof log === 'function' ? log : (m) => process.stdout.write(`${m}\n`);
  const recent = [];
  const tap = tolerateNoFilesProcessed ? retainTail(recent, emit) : emit;
  return { prefix, emit, tap, recent };
}

/** A drain that also keeps the last `MARKER_PROBE_TAIL_LINES` lines. */
function retainTail(recent, emit) {
  return (line) => {
    recent.push(line);
    if (recent.length > MARKER_PROBE_TAIL_LINES) recent.shift();
    emit(line);
  };
}

/**
 * The status a closed gate child reports: 124 when its wall-clock budget
 * killed it (Story #5377), a clean 0 for biome's "processed zero files" exit
 * under `tolerateNoFilesProcessed` (Story #4292), else its own exit code.
 */
function settledGateStatus(settled) {
  return settled.supervisor.timedOut
    ? timedOutStatus(settled)
    : exitedStatus(settled);
}

/** Report the watchdog kill and return the `timeout(1)` exit code. */
function timedOutStatus({ opts, output }) {
  output.emit(
    `${output.prefix}⏱ exceeded ${opts.timeoutMs}ms — killed the gate's process group. Returning exit ${TIMEOUT_EXIT_CODE}.`,
  );
  return TIMEOUT_EXIT_CODE;
}

/** The child's own exit status, with biome's zero-files exit forgiven. */
function exitedStatus({ code, sig, opts, output }) {
  const status = gateExitCode(code, sig);
  if (status === 0 || !opts.tolerateNoFilesProcessed) return status;
  if (!isBiomeNoFilesProcessed(output.recent.join('\n'))) return status;
  output.emit(
    `${output.prefix}↳ biome processed zero files (all changed paths are config-ignored); treating as a clean skip`,
  );
  return 0;
}
