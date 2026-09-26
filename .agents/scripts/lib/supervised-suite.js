/**
 * supervised-suite.js — one full-suite spawn, supervised as a process group
 * with the suite-ready handshake, and the one timing line every full-suite
 * taker prints: lock wait, host wait and test run as three separate figures.
 *
 * Suite-ready handshake: the supervisor passes a fresh path to the suite as
 * {@link SUITE_READY_FILE_ENV}. A suite that waits before its tests start (a
 * consumer's host-load gate) writes that file when they do; the supervisor
 * then records `hostWaitMs` and re-arms a fresh `timeoutMs` for the test
 * phase. The pre-ready phase is bounded by the same `timeoutMs`, so a suite
 * that never signals is killed exactly as before (exit 124) and the
 * worst-case wall is 2 × `timeoutMs` after the lock is held.
 *
 * The timing line is also how close learns a child capture's figures — it is
 * parsed back out of the gate log by {@link parseSuiteTimings}.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  groupSpawnOptions,
  killProcessGroup,
  superviseGroup,
  TIMEOUT_EXIT_CODE,
} from './process-group.js';

/**
 * @typedef {{ lockWaitMs: number, hostWaitMs: number|null, testRunMs: number }} SuiteTimings
 */

/** Absolute path the suite writes when its tests start. */
export const SUITE_READY_FILE_ENV = 'MANDREL_SUITE_READY_FILE';

const DEFAULT_READY_POLL_MS = 250;

const NO_HOST_WAIT = 'n/a';

/**
 * A fresh, not-yet-existing ready-file path and the child env naming it.
 *
 * @param {{ dir?: string }} [opts]
 * @returns {{ file: string, env: Record<string, string> }}
 */
export function suiteReadyHandshake({ dir = os.tmpdir() } = {}) {
  const name = `mandrel-suite-ready-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const file = path.join(dir, name);
  return { file, env: { [SUITE_READY_FILE_ENV]: file } };
}

/**
 * @param {SuiteTimings} timings
 * @returns {string} e.g. `⏲ suite timings: lockWaitMs=0 hostWaitMs=n/a testRunMs=51234`
 */
export function formatSuiteTimings({ lockWaitMs, hostWaitMs, testRunMs }) {
  const host = hostWaitMs === null ? NO_HOST_WAIT : Math.round(hostWaitMs);
  return `⏲ suite timings: lockWaitMs=${Math.round(lockWaitMs)} hostWaitMs=${host} testRunMs=${Math.round(testRunMs)}`;
}

/**
 * Inverse of {@link formatSuiteTimings}, tolerant of any line prefix.
 *
 * @param {string} line
 * @returns {SuiteTimings|null}
 */
export function parseSuiteTimings(line) {
  const match =
    /suite timings: lockWaitMs=(\d+) hostWaitMs=(\d+|n\/a) testRunMs=(\d+)/u.exec(
      String(line ?? ''),
    );
  if (!match) return null;
  return {
    lockWaitMs: Number(match[1]),
    hostWaitMs: match[2] === NO_HOST_WAIT ? null : Number(match[2]),
    testRunMs: Number(match[3]),
  };
}

function fileExists(fsImpl, file) {
  try {
    return fsImpl.existsSync(file);
  } catch {
    return false;
  }
}

function removeQuietly(fsImpl, file) {
  try {
    fsImpl.rmSync(file, { force: true });
  } catch {
    // Best-effort: a leftover marker in the tmp dir is harmless.
  }
}

/**
 * The kill timer: armed at spawn with the pre-ready bound, re-armed once with
 * a fresh `timeoutMs` when the ready file appears.
 */
class SuiteClock {
  constructor({ kill, timeoutMs, readyTimeoutMs, readyFile, fsImpl, nowFn }) {
    Object.assign(this, { kill, timeoutMs, readyFile, fsImpl, nowFn });
    this.timedOut = false;
    this.startedAt = nowFn();
    this.readyAt = null;
    this.endedAt = null;
    this.timer = null;
    this.poller = null;
    this.arm(readyTimeoutMs ?? timeoutMs);
  }

  arm(boundMs) {
    clearTimeout(this.timer);
    if (!(Number.isFinite(boundMs) && boundMs > 0)) return;
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.kill();
    }, boundMs);
  }

  watch(pollMs) {
    this.poller = setInterval(() => this.checkReady(), pollMs);
    this.poller.unref?.();
  }

  checkReady() {
    if (this.readyAt !== null || this.timedOut) return;
    if (!fileExists(this.fsImpl, this.readyFile)) return;
    this.readyAt = this.nowFn();
    clearInterval(this.poller);
    this.arm(this.timeoutMs);
  }

  stop() {
    this.endedAt ??= this.nowFn();
    // Last look: a suite that signalled and exited inside one poll.
    this.checkReady();
    clearInterval(this.poller);
    clearTimeout(this.timer);
    removeQuietly(this.fsImpl, this.readyFile);
  }

  /** @returns {{ hostWaitMs: number|null, testRunMs: number }} */
  timings() {
    const end = this.endedAt ?? this.nowFn();
    const testStart = this.readyAt ?? this.startedAt;
    return {
      hostWaitMs: this.readyAt === null ? null : this.readyAt - this.startedAt,
      testRunMs: Math.max(0, end - testStart),
    };
  }
}

/**
 * {@link superviseGroup} (abort and parent-signal forwarding) plus the
 * suite clock: `hostWaitMs` is spawn → ready (`null` when the suite never
 * signalled) and `testRunMs` runs from ready — or spawn — to exit.
 *
 * @param {{ pid?: number, kill?: Function }} child
 * @param {{
 *   readyFile: string,
 *   timeoutMs?: number,
 *   readyTimeoutMs?: number,
 *   readyPollMs?: number,
 *   abortSignal?: AbortSignal,
 *   signalOnParentSignal?: string,
 *   fsImpl?: object,
 *   nowFn?: () => number,
 * }} opts `readyTimeoutMs` bounds the pre-ready phase and defaults to
 *   `timeoutMs` — every production caller leaves it there.
 * @returns {{ readonly timedOut: boolean, readonly timings: { hostWaitMs: number|null, testRunMs: number }, release: () => void }}
 */
export function superviseSuite(child, opts) {
  const { readyPollMs = DEFAULT_READY_POLL_MS, fsImpl = fs } = opts;
  const group = superviseGroup(child, {
    abortSignal: opts.abortSignal,
    signalOnParentSignal: opts.signalOnParentSignal,
  });
  const clock = new SuiteClock({
    ...opts,
    fsImpl,
    nowFn: opts.nowFn ?? Date.now,
    kill: () => killProcessGroup(child, 'SIGKILL'),
  });
  clock.watch(readyPollMs);
  return {
    get timedOut() {
      return clock.timedOut;
    },
    get timings() {
      return clock.timings();
    },
    release() {
      clock.stop();
      group.release();
    },
  };
}

/**
 * How a close gate child is supervised: its process group is killed on
 * timeout, abort or parent signal — SIGKILL for a bare suite, SIGTERM for a
 * gate with its own cleanup (a capture holding the lock). A `fullSuiteLock`
 * gate also gets the handshake env and the suite clock, and its release
 * emits the timing line through the gate's `output`.
 *
 * @param {{ fullSuiteLock?: boolean, timeoutMs?: number, signal?: AbortSignal, env?: Record<string, string> }} opts
 * @param {{ lockWaitMs?: number }} [lock] The full-suite lock's measured wait.
 * @returns {{ env: Record<string, string>|undefined, supervise: (child: object, output: { prefix: string, emit: (line: string) => void }) => { readonly timedOut: boolean, release: () => void } }}
 */
export function gateSupervision(opts, lock = {}) {
  const base = {
    timeoutMs: opts.timeoutMs,
    abortSignal: opts.signal,
    signalOnParentSignal: opts.fullSuiteLock ? 'SIGKILL' : 'SIGTERM',
  };
  if (!opts.fullSuiteLock) {
    return { env: opts.env, supervise: (child) => superviseGroup(child, base) };
  }
  const handshake = suiteReadyHandshake();
  return {
    env: { ...opts.env, ...handshake.env },
    supervise: (child, output) =>
      reportOnRelease(
        superviseSuite(child, { ...base, readyFile: handshake.file }),
        (timings) =>
          output.emit(
            output.prefix +
              formatSuiteTimings({
                lockWaitMs: lock.lockWaitMs ?? 0,
                ...timings,
              }),
          ),
      ),
  };
}

/**
 * @param {ReturnType<typeof superviseSuite>} supervisor
 * @param {(timings: { hostWaitMs: number|null, testRunMs: number }) => void} report
 */
function reportOnRelease(supervisor, report) {
  return {
    get timedOut() {
      return supervisor.timedOut;
    },
    release() {
      supervisor.release();
      report(supervisor.timings);
    },
  };
}

/**
 * Spawn `cmd args` as its own process group with inherited stdio, bounded by
 * `timeoutMs` from spawn (never from before the lock was held) and re-armed
 * once the suite signals the ready file. Resolves the exit code — `124` when
 * the supervisor killed it — and reports the timings through `onTimings`.
 *
 * @param {{
 *   cmd: string,
 *   args: string[],
 *   cwd: string,
 *   env?: Record<string, string>,
 *   timeoutMs?: number,
 *   readyTimeoutMs?: number,
 *   readyPollMs?: number,
 *   lockWaitMs?: number,
 *   spawnImpl?: typeof spawn,
 *   onTimings?: (timings: SuiteTimings) => void,
 *   onTimeout?: () => void,
 * }} opts `readyTimeoutMs` / `readyPollMs` are test seams.
 * @returns {Promise<number>}
 */
export function runSupervisedSuite(opts) {
  const { cmd, args, cwd, env = {}, spawnImpl = spawn } = opts;
  const handshake = suiteReadyHandshake();
  return new Promise((resolve) => {
    const child = spawnImpl(cmd, args, {
      cwd,
      env: { ...process.env, ...env, ...handshake.env },
      stdio: 'inherit',
      shell: process.platform === 'win32',
      ...groupSpawnOptions(),
    });
    const supervisor = superviseSuite(child, {
      ...opts,
      readyFile: handshake.file,
    });
    let settled = false;
    const settle = (code) => {
      if (settled) return;
      settled = true;
      supervisor.release();
      opts.onTimings?.({
        lockWaitMs: opts.lockWaitMs ?? 0,
        ...supervisor.timings,
      });
      if (supervisor.timedOut) opts.onTimeout?.();
      resolve(supervisor.timedOut ? TIMEOUT_EXIT_CODE : code);
    };
    child.on('error', () => settle(1));
    child.on('exit', (code) => settle(code ?? 1));
  });
}
