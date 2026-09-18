/** Default async gate runner: spawn, line-prefixed stdio, abort and exit codes. */

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
 * Emit each line with `prefix`; the unterminated tail flushes on `end`.
 *
 * The drain must stay cheap: a slow reader fills the pipe and the child's
 * write fails with `EAGAIN` (Biome then aborts with exit 101, a false red).
 * So splitting advances an index (O(chunk)), and `emit` MUST NOT block.
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
 * Biome exits 1 with this when every path handed to it is config-ignored — a
 * false negative for the changed-file-scoped format gate, treated as a skip.
 */
const BIOME_NO_FILES_PROCESSED =
  'No files were processed in the specified paths';

/**
 * The marker only appears in a few-line output, so a bounded tail always
 * holds it and keeps per-line drain work O(1).
 */
const MARKER_PROBE_TAIL_LINES = 32;

/**
 * @param {string} output - Combined stdout/stderr.
 * @returns {boolean}
 */
function isBiomeNoFilesProcessed(output) {
  return (
    typeof output === 'string' && output.includes(BIOME_NO_FILES_PROCESSED)
  );
}

/**
 * Spawn a gate with `[gate-name] `-prefixed output; resolves (never rejects)
 * once the child exits and both pipes drain. `opts.log` must not block.
 * An abort signal TERMs the child so a sibling failure stops the wave.
 *
 * `fullSuiteLock` serializes the spawn behind the host lock (async, so
 * sibling gates on this event loop are not stalled). An expired wait spawns
 * anyway unless `deferOnLockExpiry`, which returns
 * `LOCK_WAIT_EXPIRED_EXIT_CODE` so close ends `pending`. Each child leads its
 * own process group so a timeout, abort or parent signal kills its workers too.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string, signal?: AbortSignal, gateName?: string, log?: (m: string) => void, env?: Record<string, string>, tolerateNoFilesProcessed?: boolean, fullSuiteLock?: boolean, deferOnLockExpiry?: boolean, timeoutMs?: number, lockOptions?: object, skipIfSatisfied?: () => {status: number}|undefined }} opts
 * @returns {Promise<{ status: number }>}
 */
export function defaultGateRunner(cmd, args, opts = {}) {
  if (!opts.fullSuiteLock) return spawnGate(cmd, args, opts);
  // `skipIfSatisfied` re-probes after the wait: evidence another suite
  // deposited meanwhile is returned instead of spawning.
  return withFullSuiteLockAsync(gateLockOptions(opts), () =>
    spawnGate(cmd, args, opts),
  );
}

function gateLockOptions(opts) {
  return {
    cwd: opts.cwd,
    log: opts.log,
    skipIfSatisfied: opts.skipIfSatisfied,
    onWaitExpired: opts.deferOnLockExpiry ? deferredGateStatus : undefined,
    ...opts.lockOptions, // test seam only
  };
}

function deferredGateStatus() {
  return { status: LOCK_WAIT_EXPIRED_EXIT_CODE };
}

/**
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
  // A bare suite has nothing to clean up, so it gets SIGKILL; other gates
  // (a capture holding the lock) get SIGTERM to release and kill their suite.
  const supervisor = superviseGroup(child, {
    timeoutMs: opts.timeoutMs,
    abortSignal: opts.signal,
    signalOnParentSignal: opts.fullSuiteLock ? 'SIGKILL' : 'SIGTERM',
  });
  return new Promise((resolve) => {
    // 'close', not 'exit': only 'close' waits for both pipes to drain.
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
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
}

/**
 * Retains a bounded tail only when the biome marker may need inspecting.
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

function retainTail(recent, emit) {
  return (line) => {
    recent.push(line);
    if (recent.length > MARKER_PROBE_TAIL_LINES) recent.shift();
    emit(line);
  };
}

function settledGateStatus(settled) {
  return settled.supervisor.timedOut
    ? timedOutStatus(settled)
    : exitedStatus(settled);
}

function timedOutStatus({ opts, output }) {
  output.emit(
    `${output.prefix}⏱ exceeded ${opts.timeoutMs}ms — killed the gate's process group. Returning exit ${TIMEOUT_EXIT_CODE}.`,
  );
  return TIMEOUT_EXIT_CODE;
}

function exitedStatus({ code, sig, opts, output }) {
  const status = gateExitCode(code, sig);
  if (status === 0 || !opts.tolerateNoFilesProcessed) return status;
  if (!isBiomeNoFilesProcessed(output.recent.join('\n'))) return status;
  output.emit(
    `${output.prefix}↳ biome processed zero files (all changed paths are config-ignored); treating as a clean skip`,
  );
  return 0;
}
