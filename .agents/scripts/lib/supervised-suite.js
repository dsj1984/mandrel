/**
 * A full suite supervised as a process group. The suite may write
 * `$MANDREL_SUITE_READY_FILE` when its tests start; the kill timer then
 * re-arms a fresh `timeoutMs`, so a pre-test wait (bounded by `timeoutMs`
 * too) never spends the test budget. Close parses the timing line back.
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

/** @typedef {{ lockWaitMs: number, hostWaitMs: number|null, testRunMs: number }} SuiteTimings */

export const SUITE_READY_FILE_ENV = 'MANDREL_SUITE_READY_FILE';

const DEFAULT_READY_POLL_MS = 250;

const NO_HOST_WAIT = 'n/a';

/** @param {{ dir?: string }} [opts] */
export function suiteReadyHandshake({ dir = os.tmpdir() } = {}) {
  const name = `mandrel-suite-ready-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const file = path.join(dir, name);
  return { file, env: { [SUITE_READY_FILE_ENV]: file } };
}

/** @param {SuiteTimings} timings */
export function formatSuiteTimings({ lockWaitMs, hostWaitMs, testRunMs }) {
  const host = hostWaitMs === null ? NO_HOST_WAIT : Math.round(hostWaitMs);
  return `⏲ suite timings: lockWaitMs=${Math.round(lockWaitMs)} hostWaitMs=${host} testRunMs=${Math.round(testRunMs)}`;
}

/**
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
    // A leftover marker is harmless.
  }
}

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
    this.checkReady();
    clearInterval(this.poller);
    clearTimeout(this.timer);
    removeQuietly(this.fsImpl, this.readyFile);
  }

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
 * `hostWaitMs` is spawn → ready (null without a signal); `testRunMs` ends at
 * exit. `readyTimeoutMs` (pre-ready bound) is a test seam over `timeoutMs`.
 *
 * @param {{ pid?: number, kill?: Function }} child
 * @param {{ readyFile: string, timeoutMs?: number, readyTimeoutMs?: number, readyPollMs?: number, abortSignal?: AbortSignal, signalOnParentSignal?: string, fsImpl?: object, nowFn?: () => number }} opts
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
 * A bare suite gets SIGKILL on a parent signal; a gate with its own cleanup
 * (a capture holding the lock) SIGTERM. A full-suite gate also gets the
 * handshake and emits its timing line on release.
 *
 * @param {{ fullSuiteLock?: boolean, timeoutMs?: number, signal?: AbortSignal, env?: Record<string, string> }} opts
 * @param {{ lockWaitMs?: number }} [lock]
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
 * @param {(timings: object) => void} report
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
 * Resolves the exit code, or `124` when the supervisor killed the suite.
 *
 * @param {{ cmd: string, args: string[], cwd: string, env?: Record<string, string>, timeoutMs?: number, readyTimeoutMs?: number, readyPollMs?: number, lockWaitMs?: number, spawnImpl?: typeof spawn, onTimings?: (timings: SuiteTimings) => void, onTimeout?: () => void }} opts
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
