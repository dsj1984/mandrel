/**
 * full-suite-lock.js — serialize full-suite spawns across one host's
 * worktrees (they contend for cores and a shared coverage artifact), over
 * the `sweep-lock.js` primitive.
 *
 * Best-effort: any failure to acquire spawns anyway — a stale lockfile must
 * never fail a delivery. Only close opts in to defer on an expired wait
 * ({@link LOCK_WAIT_EXPIRED_EXIT_CODE}). Waits are async so the holder's
 * heartbeat and signal release keep working, and FIFO via
 * `full-suite-queue.js`. The lock covers only the spawn, never the
 * freshness checks before it.
 */
import fs from 'node:fs';
import path from 'node:path';

import { mainCheckoutRoot } from './config/temp-paths.js';
import { isFirstInLine, waitInLine } from './full-suite-queue.js';
import { acquireSweepLock } from './single-story-sweep/sweep-lock.js';

/** Environment escape hatch: set to `0`/`false`/`off`/`no` to disable. */
export const FULL_SUITE_LOCK_ENV = 'MANDREL_FULL_SUITE_LOCK';

/** Close sets it to `defer` on its gate children; nothing else does. */
export const FULL_SUITE_LOCK_EXPIRY_ENV = 'MANDREL_FULL_SUITE_LOCK_ON_EXPIRY';

/** `EX_TEMPFAIL`. */
export const LOCK_WAIT_EXPIRED_EXIT_CODE = 75;

/** Under the main checkout's `.git`, so every worktree shares one file. */
const FULL_SUITE_LOCK_FILENAME = 'mandrel-full-suite.lock';

/** Well under close's ten-minute foreground ceiling. */
const DEFAULT_WAIT_MS = 300_000;

/** Never above the wait budget. */
const DEFAULT_STALE_MS = 240_000;

const DEFAULT_POLL_MS = 2_000;

/** More than one poll under 30 s, so jitter never stretches a gap past 30 s. */
const DEFAULT_REPORT_MS = 25_000;

const FALSEY = /^(0|false|off|no)$/i;

const LOCK_TAG = '[full-suite-lock]';

const LOCK_DEFAULTS = Object.freeze({
  enabled: true,
  log: () => {},
  waitMs: DEFAULT_WAIT_MS,
  pollMs: DEFAULT_POLL_MS,
  staleMs: DEFAULT_STALE_MS,
  reportMs: DEFAULT_REPORT_MS,
  fsImpl: fs,
  nowFn: Date.now,
  sleepFn: (ms) => defaultSleep(ms),
  acquireOnceFn: (opts) => acquireSweepLock(opts),
});

/**
 * Both hatches (env, then config) can only turn the lock off.
 *
 * @param {{ config?: object, env?: Record<string, string|undefined> }} [opts]
 * @returns {boolean}
 */
export function isFullSuiteLockEnabled({ config, env = process.env } = {}) {
  const raw = env?.[FULL_SUITE_LOCK_ENV];
  if (typeof raw === 'string' && FALSEY.test(raw.trim())) return false;
  return config?.delivery?.execution?.fullSuiteLock !== false;
}

/**
 * `null` (no lock) when the root is unresolvable — a cwd-local path would
 * never collide with its sibling.
 *
 * @param {{ cwd: string, mainCheckoutRootFn?: typeof mainCheckoutRoot }} opts
 * @returns {string|null}
 */
export function resolveFullSuiteLockPath({
  cwd,
  mainCheckoutRootFn = mainCheckoutRoot,
}) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  const root = mainCheckoutRootFn(cwd);
  if (typeof root !== 'string' || root.length === 0) return null;
  return path.join(root, '.git', FULL_SUITE_LOCK_FILENAME);
}

/**
 * Uncontended fast path, skipped when waiters are queued (no overtaking).
 *
 * @returns {{ lock: object|null, lockPath: string|null }} null `lock` with a
 *   `lockPath` means wait; both null means no lock.
 */
function beginLock({ staleMs, fsImpl, acquireOnceFn, ...where }) {
  const resolved = lockHome(where);
  if (resolved === null) return NO_LOCK;
  if (!isFirstInLine({ lockPath: resolved, ticket: null, staleMs, fsImpl })) {
    return { lock: null, lockPath: resolved };
  }
  const first = acquireOnceFn({
    lockPath: resolved,
    timeoutMs: staleMs,
    fsImpl,
  });
  if (first.acquired) return { lock: first, lockPath: resolved };
  // A hard I/O error will not resolve by waiting — proceed unserialized.
  return first.reason === 'error'
    ? NO_LOCK
    : { lock: null, lockPath: resolved };
}

const NO_LOCK = Object.freeze({ lock: null, lockPath: null });

/**
 * @param {{ enabled: boolean, cwd: string, lockPath?: string }} where
 * @returns {string|null}
 */
function lockHome({ enabled, cwd, lockPath }) {
  if (!enabled) return null;
  return lockPath ?? resolveFullSuiteLockPath({ cwd });
}

/**
 * Consulted only after a real wait: the suite we waited behind may already
 * have established what we were about to spawn for.
 *
 * @template T
 * @param {(() => T|undefined)|undefined} probe
 * @param {boolean} applies
 * @returns {{ satisfied: boolean, value?: T }}
 */
function consult(probe, applies) {
  if (!(applies && typeof probe === 'function')) return { satisfied: false };
  const value = probe();
  return value === undefined
    ? { satisfied: false }
    : { satisfied: true, value };
}

/**
 * Never throws on the lock's account and spawns at most once — a lock defect
 * can slow a suite, never duplicate it.
 *
 * @template T
 * @param {{
 *   cwd: string,
 *   enabled?: boolean,
 *   log?: (m: string) => void,
 *   waitMs?: number,
 *   pollMs?: number,
 *   staleMs?: number,
 *   reportMs?: number,
 *   fsImpl?: object,
 *   nowFn?: () => number,
 *   sleepFn?: (ms: number) => Promise<void>,
 *   acquireOnceFn?: typeof acquireSweepLock,
 *   lockPath?: string,
 *   skipIfSatisfied?: () => T|undefined,
 *   onWaitExpired?: () => T|undefined,
 * }} opts A non-`undefined` return from either hook stands in for the spawn.
 * @param {() => Promise<T>} spawn
 * @returns {Promise<T>}
 */
export async function withFullSuiteLockAsync(options, spawn) {
  const opts = withDefaults(options);
  const { lock, lockPath } = beginLock(opts);
  const wait =
    lock === null && lockPath !== null
      ? await waitInLine({ ...opts, lockPath, expiryNote: expiryNote(opts) })
      : { held: lock, expired: false, waited: false };
  try {
    return await spawnOrStandIn(opts, wait, spawn);
  } finally {
    if (wait.held?.acquired) wait.held.release();
  }
}

function withDefaults(options) {
  const opts = { ...LOCK_DEFAULTS };
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) opts[key] = value;
  }
  return opts;
}

function expiryNote({ onWaitExpired }) {
  return typeof onWaitExpired === 'function'
    ? 'not spawning; the caller reports the wait instead'
    : 'spawning anyway';
}

async function spawnOrStandIn(opts, wait, spawn) {
  const probe = consult(opts.skipIfSatisfied, wait.waited);
  if (probe.satisfied) {
    opts.log(
      `${LOCK_TAG} ⏭ the run we waited for already covered this tree — skipping the spawn.`,
    );
    return probe.value;
  }
  const deferred = consult(opts.onWaitExpired, wait.expired);
  return deferred.satisfied ? deferred.value : await spawn();
}

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
 * Serialize a capture runner's spawn. Wrapped at the one call site below
 * every skip/freshness decision, so a credited capture never waits.
 *
 * @param {Function} runCaptureFn
 * @param {object} [config]
 * @param {Record<string, string|undefined>} [env]
 * @param {object} [lockOptions] Test seam only.
 * @returns {(opts?: object) => Promise<number>}
 */
export function lockedCapture(
  runCaptureFn,
  config,
  env = process.env,
  lockOptions = {},
) {
  const policy = {
    enabled: isFullSuiteLockEnabled({ config, env }),
    onWaitExpired: deferredCaptureExit(env),
    ...lockOptions,
  };
  return (captureOpts = {}) =>
    withFullSuiteLockAsync(
      {
        ...policy,
        cwd: captureOpts.cwd,
        log: captureOpts.log,
        skipIfSatisfied: freshnessProbe(captureOpts),
      },
      () => runCaptureFn(captureOpts),
    );
}

/**
 * @param {Record<string, string|undefined>} env
 * @returns {(() => number)|undefined}
 */
function deferredCaptureExit(env) {
  return env[FULL_SUITE_LOCK_EXPIRY_ENV] === 'defer'
    ? () => LOCK_WAIT_EXPIRED_EXIT_CODE
    : undefined;
}

/**
 * A fresh recheck means exit 0 without spawning.
 *
 * @param {{ recheckFresh?: () => boolean }} captureOpts
 * @returns {(() => number|undefined)|undefined}
 */
function freshnessProbe({ recheckFresh }) {
  return typeof recheckFresh === 'function'
    ? () => (recheckFresh() ? 0 : undefined)
    : undefined;
}
