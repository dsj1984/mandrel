/**
 * single-story-sweep/sweep-lock.js
 *
 * Best-effort cross-process lockfile (atomic `wx` create) for the merged-branch
 * sweep. Never load-bearing: a contended caller skips or proceeds. A live
 * holder is never mistaken for a crashed one: it heartbeats its mtime, a
 * stale-breaker removes only the exact file it observed (dev/ino/mtime), and
 * release unlinks only a lockfile still stamped with its owner.
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 60_000;

const MIN_HEARTBEAT_MS = 1_000;

// Three refreshes per staleness window: two missed refreshes (stalled loop,
// slow disk) still do not make a live holder look dead.
const HEARTBEAT_DIVISOR = 3;

// One critical section reached from single-story-init and boot-sweep, so one
// lockfile; both MUST resolve it through resolveSweepLockPath.
const MERGED_BRANCH_SWEEP_LOCK_FILENAME = 'merged-branch-sweep.lock';

/**
 * @param {{ cwd: string, tempRoot?: string }} args
 * @returns {string} absolute path to the shared lockfile.
 */
export function resolveSweepLockPath({ cwd, tempRoot = 'temp' } = {}) {
  return path.resolve(cwd, tempRoot, MERGED_BRANCH_SWEEP_LOCK_FILENAME);
}

/**
 * @param {number} timeoutMs
 * @returns {number} an interval strictly below `timeoutMs`.
 */
function heartbeatIntervalFor(timeoutMs) {
  const derived = Math.floor(
    (Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS) /
      HEARTBEAT_DIVISOR,
  );
  return Math.max(MIN_HEARTBEAT_MS, derived);
}

// Node runs no 'exit' handler for an unhandled fatal signal, so the holder
// must drop its lockfile on these itself.
const RELEASE_ON_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM']);

/**
 * `kill(pid, 0)`: returns → alive; `EPERM` → alive (exists, not ours);
 * `ESRCH` → dead. Also used by the full-suite waiter queue.
 *
 * @param {number|null} pid
 * @param {(pid: number, signal: number) => void} [killFn]
 * @returns {boolean|null} `null` when the pid is unknown.
 */
export function isHolderAlive(pid, killFn = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    killFn(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'ESRCH' ? false : true;
  }
}

/**
 * `dev`+`ino` change on re-create and `mtimeMs` on every heartbeat, so a
 * steal that re-checks all three cannot remove a lock created or refreshed in
 * the interim.
 *
 * @param {string} lockPath
 * @param {object} [fsImpl]
 * @returns {{ mtimeMs: number, ino: number|null, dev: number|null }|null}
 */
function readLockIdentity(lockPath, fsImpl = fs) {
  try {
    const stat = fsImpl.statSync(lockPath);
    return {
      mtimeMs: stat.mtimeMs,
      ino: stat.ino ?? null,
      dev: stat.dev ?? null,
    };
  } catch {
    return null;
  }
}

/** Lockfile mtime, or `null` when absent (no holder). */
export function readLockMtime(lockPath, fsImpl = fs) {
  return readLockIdentity(lockPath, fsImpl)?.mtimeMs ?? null;
}

/**
 * @param {string} lockPath
 * @param {object} [fsImpl]
 * @returns {string|null}
 */
function readLockOwner(lockPath, fsImpl = fs) {
  try {
    const raw = fsImpl.readFileSync(lockPath, 'utf8');
    const first = String(raw).split('\n', 1)[0];
    return first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

/**
 * The holder pid (third line), so a waiter can name who it waits on.
 * Advisory: `null` just means the wait line says less.
 *
 * @param {string} lockPath
 * @param {object} [fsImpl]
 * @returns {number|null}
 */
export function readLockHolderPid(lockPath, fsImpl = fs) {
  try {
    const lines = String(fsImpl.readFileSync(lockPath, 'utf8')).split('\n');
    const pid = Number.parseInt(lines[2] ?? '', 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * A `null` on either side is never "the same".
 *
 * @param {ReturnType<typeof readLockIdentity>} a
 * @param {ReturnType<typeof readLockIdentity>} b
 * @returns {boolean}
 */
function sameLockIdentity(a, b) {
  if (!a || !b) return false;
  return a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev;
}

/** A `null` mtime (no file) is never stale. */
export function isLockStale(mtime, nowMs, timeoutMs) {
  if (mtime === null) return false;
  return nowMs - mtime > timeoutMs;
}

/**
 * `wx` = O_CREAT|O_EXCL: `false` on EEXIST, any other error throws.
 */
function tryCreateLock(lockPath, ownerId, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(lockPath), { recursive: true });
  let fd;
  try {
    fd = fsImpl.openSync(lockPath, 'wx');
  } catch (err) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  }
  try {
    fsImpl.writeSync(
      fd,
      `${ownerId}\n${new Date().toISOString()}\n${process.pid}\n`,
    );
  } finally {
    fsImpl.closeSync(fd);
  }
  return true;
}

/**
 * Single attempt, with one stale-takeover retry.
 *
 * @param {object} opts
 * @param {string} opts.lockPath
 * @param {number} [opts.timeoutMs=60000]  Stale-lock threshold.
 * @param {string} [opts.ownerId]          Persisted for postmortem.
 * @param {object} [opts.nowFn]
 * @param {object} [opts.fsImpl]
 * @param {number} [opts.heartbeatMs]      Defaults to `timeoutMs / 3`; `0` disables.
 * @param {Function} [opts.setIntervalFn]
 * @param {Function} [opts.clearIntervalFn]
 * @param {Function} [opts.killFn]        Holder liveness probe seam.
 * @param {object} [opts.processImpl]     Seam for release-on-signal.
 * @returns {{ acquired: true, release: () => void, ownerId: string }
 *          | { acquired: false, reason: 'contended' | 'error', detail?: string }}
 */
export function acquireSweepLock({
  lockPath,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ownerId,
  nowFn = Date.now,
  fsImpl = fs,
  heartbeatMs,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  killFn,
  processImpl = process,
} = {}) {
  if (typeof lockPath !== 'string' || lockPath.length === 0) {
    return {
      acquired: false,
      reason: 'error',
      detail: 'lockPath is required',
    };
  }
  const id = ownerId ?? `pid-${process.pid}-${nowFn()}`;
  const holder = {
    lockPath,
    ownerId: id,
    fsImpl,
    nowFn,
    heartbeatMs: heartbeatMs ?? heartbeatIntervalFor(timeoutMs),
    setIntervalFn,
    clearIntervalFn,
    killFn,
    processImpl,
  };
  try {
    if (
      tryCreateLock(lockPath, id, fsImpl) ||
      tryStaleTakeover(holder, timeoutMs)
    ) {
      return buildAcquired(holder);
    }
    return { acquired: false, reason: 'contended' };
  } catch (err) {
    return {
      acquired: false,
      reason: 'error',
      detail: err?.message ?? String(err),
    };
  }
}

/**
 * `true` only when this call removed the exact stale file it observed and won
 * the re-create, so concurrent breakers yield one acquisition.
 *
 * @param {{ lockPath: string, ownerId: string, fsImpl: object, nowFn: () => number }} holder
 * @param {number} timeoutMs
 * @returns {boolean}
 */
function tryStaleTakeover(
  { lockPath, ownerId, fsImpl, nowFn, killFn },
  timeoutMs,
) {
  const observed = readLockIdentity(lockPath, fsImpl);
  if (observed === null) return false;
  if (
    !isHolderStale({ lockPath, fsImpl, nowFn, killFn, observed, timeoutMs })
  ) {
    return false;
  }
  return (
    breakStaleLock(lockPath, observed, fsImpl) &&
    tryCreateLock(lockPath, ownerId, fsImpl)
  );
}

/**
 * A dead pid makes the holder stale immediately; otherwise mtime decides.
 * One-directional on purpose: a live pid never vetoes the mtime rule, or a
 * hung holder would be immortal.
 *
 * @param {{ lockPath: string, fsImpl: object, nowFn: () => number, killFn?: Function, observed: {mtimeMs: number}, timeoutMs: number }} args
 * @returns {boolean}
 */
function isHolderStale({
  lockPath,
  fsImpl,
  nowFn,
  killFn,
  observed,
  timeoutMs,
}) {
  if (isHolderAlive(readLockHolderPid(lockPath, fsImpl), killFn) === false) {
    return true;
  }
  return isLockStale(observed.mtimeMs, nowFn(), timeoutMs);
}

/**
 * Unlink only if the file is still the observed instance; `false` means
 * someone else owns it now.
 *
 * @param {string} lockPath
 * @param {ReturnType<typeof readLockIdentity>} observed
 * @param {object} fsImpl
 * @returns {boolean}
 */
function breakStaleLock(lockPath, observed, fsImpl) {
  if (!sameLockIdentity(observed, readLockIdentity(lockPath, fsImpl))) {
    return false;
  }
  try {
    fsImpl.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuses a lockfile no longer ours, or we would keep a thief's lock alive.
 *
 * @param {{ lockPath: string, ownerId: string, fsImpl?: object, nowFn?: () => number }} holder
 * @returns {boolean} `true` when the refresh landed; `false` when the lock is
 *   no longer ours (the caller stops heartbeating).
 */
function refreshLockSync({ lockPath, ownerId, fsImpl = fs, nowFn = Date.now }) {
  if (readLockOwner(lockPath, fsImpl) !== ownerId) return false;
  try {
    const stamp = new Date(nowFn());
    fsImpl.utimesSync(lockPath, stamp, stamp);
    return true;
  } catch {
    return false;
  }
}

/** Unref'd so a forgotten release never holds the process open. */
function startHeartbeat(holder) {
  const { heartbeatMs, setIntervalFn, clearIntervalFn } = holder;
  if (!(heartbeatMs > 0) || typeof setIntervalFn !== 'function') {
    return () => {};
  }
  let timer = null;
  const stop = () => {
    if (timer === null) return;
    const handle = timer;
    timer = null;
    try {
      clearIntervalFn(handle);
    } catch {
      // A fake timer seam may not implement clear.
    }
  };
  timer = setIntervalFn(() => {
    if (!refreshLockSync(holder)) stop();
  }, heartbeatMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return stop;
}

/**
 * @param {string} lockPath
 * @param {string} ownerId
 * @param {object} fsImpl
 */
function unlinkIfOwned(lockPath, ownerId, fsImpl) {
  if (readLockOwner(lockPath, fsImpl) !== ownerId) return;
  try {
    fsImpl.unlinkSync(lockPath);
  } catch {
    // Already gone.
  }
}

function buildAcquired(holder) {
  const { lockPath, ownerId, fsImpl, processImpl = process } = holder;
  const stopHeartbeat = startHeartbeat(holder);
  let released = false;
  let detachSignals = () => {};
  const release = () => {
    if (released) return;
    released = true;
    stopHeartbeat();
    detachSignals();
    unlinkIfOwned(lockPath, ownerId, fsImpl);
  };
  const exitCleanup = () => release();
  if (typeof processImpl?.once === 'function') {
    processImpl.once('exit', exitCleanup);
  }
  detachSignals = attachSignalRelease(processImpl, release);
  return {
    acquired: true,
    release,
    ownerId,
  };
}

/**
 * Drop the lock on SIGINT/SIGTERM, then re-raise: only cleanup changes, the
 * process still dies under the default disposition (exit 128 + signum).
 *
 * @param {object} processImpl
 * @param {() => void} release
 * @returns {() => void} detach
 */
function attachSignalRelease(processImpl, release) {
  if (
    typeof processImpl?.once !== 'function' ||
    typeof processImpl?.off !== 'function' ||
    typeof processImpl?.kill !== 'function'
  ) {
    return () => {};
  }
  const handlers = RELEASE_ON_SIGNALS.map((signal) => {
    const handler = () => {
      // release() already detached us, so the re-raise cannot loop back.
      release();
      try {
        processImpl.kill(processImpl.pid, signal);
      } catch {
        // A process that cannot signal itself is already on its way out.
      }
    };
    processImpl.once(signal, handler);
    return [signal, handler];
  });
  return () => {
    for (const [signal, handler] of handlers) {
      try {
        processImpl.off(signal, handler);
      } catch {
        // A seam may not implement removal.
      }
    }
  };
}

const DEFAULT_WAIT_MS = 8_000;
const DEFAULT_POLL_MS = 150;

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Polls {@link acquireSweepLock} up to `waitMs` — a collision damper for the
 * post-land tail, not mutual exclusion: on exhaustion the caller proceeds
 * anyway. A hard I/O error returns immediately.
 *
 * @param {object} opts
 * @param {string} opts.lockPath
 * @param {number} [opts.waitMs]
 * @param {number} [opts.pollMs]
 * @param {number} [opts.timeoutMs]  Stale-lock expiry.
 * @param {string} [opts.ownerId]
 * @param {() => number} [opts.nowFn]
 * @param {(ms: number) => Promise<void>} [opts.sleepFn]
 * @param {object} [opts.fsImpl]
 * @param {number} [opts.heartbeatMs]
 * @param {Function} [opts.setIntervalFn]
 * @param {Function} [opts.clearIntervalFn]
 * @returns {Promise<{ acquired: true, release: () => void, ownerId: string }
 *          | { acquired: false, reason: 'contended-after-wait' | 'error', detail?: string }>}
 */
export async function acquireLockWithWait({
  lockPath,
  waitMs = DEFAULT_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ownerId,
  nowFn = Date.now,
  sleepFn = defaultSleep,
  fsImpl = fs,
  heartbeatMs,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  killFn,
  processImpl,
} = {}) {
  const deadline = nowFn() + Math.max(0, waitMs);
  for (;;) {
    const res = acquireSweepLock({
      lockPath,
      timeoutMs,
      ownerId,
      nowFn,
      fsImpl,
      heartbeatMs,
      setIntervalFn,
      clearIntervalFn,
      killFn,
      processImpl,
    });
    if (res.acquired) return res;
    if (res.reason === 'error') return res;
    if (nowFn() >= deadline) {
      return { acquired: false, reason: 'contended-after-wait' };
    }
    await sleepFn(Math.max(0, pollMs));
  }
}
