/**
 * full-suite-lock.js — serialize full-suite spawns across one host's
 * worktrees (they contend for cores and a shared coverage artifact), over
 * the `sweep-lock.js` primitive.
 *
 * It queues, never overlaps: an expired wait behind a live holder spawns
 * nothing ({@link LOCK_WAIT_EXPIRED_EXIT_CODE}). A dead holder is taken over
 * and a lockfile I/O error proceeds unserialized. Waits are async (the
 * holder's heartbeat keeps working) and FIFO via `full-suite-queue.js`; the
 * lock covers only the spawn.
 */
import fs from 'node:fs';
import path from 'node:path';

import { getQuality } from './config/quality.js';
import { mainCheckoutRoot } from './config/temp-paths.js';
import { isFirstInLine, waitInLine } from './full-suite-queue.js';
import { acquireSweepLock } from './single-story-sweep/sweep-lock.js';

/** Environment escape hatch: set to `0`/`false`/`off`/`no` to disable. */
export const FULL_SUITE_LOCK_ENV = 'MANDREL_FULL_SUITE_LOCK';

/** `EX_TEMPFAIL`. */
export const LOCK_WAIT_EXPIRED_EXIT_CODE = 75;

/** Under the main checkout's `.git`, so every worktree shares one file. */
const FULL_SUITE_LOCK_FILENAME = 'mandrel-full-suite.lock';

/** The wait floor, and the budget when no kill bound is known. */
const MIN_WAIT_MS = 300_000;

const DEFAULT_POLL_MS = 2_000;

/** More than one poll under 30 s, so jitter never stretches a gap past 30 s. */
const DEFAULT_REPORT_MS = 25_000;

const FALSEY = /^(0|false|off|no)$/i;

const LOCK_TAG = '[full-suite-lock]';

const LOCK_DEFAULTS = Object.freeze({
  enabled: true,
  log: () => {},
  ...resolveFullSuiteLockBudget(),
  pollMs: DEFAULT_POLL_MS,
  reportMs: DEFAULT_REPORT_MS,
  fsImpl: fs,
  nowFn: Date.now,
  sleepFn: (ms) => defaultSleep(ms),
  acquireOnceFn: (opts) => acquireSweepLock(opts),
  onWaitExpired: () => LOCK_WAIT_EXPIRED_EXIT_CODE,
  rerunCommand: 'the same command',
});

/**
 * The one wait budget every full-suite lock taker uses. A holder's suite is
 * killed at its supervisor's `killBoundMs` (the coverage gate's `timeoutMs`),
 * so waiting that long always observes a release or a death. The stale
 * threshold is four fifths of the wait: never above the budget, and a live
 * holder (heartbeating at a third of its own threshold) is never read stale.
 *
 * @param {number} [killBoundMs]
 * @returns {{ waitMs: number, staleMs: number }}
 */
export function resolveFullSuiteLockBudget(killBoundMs) {
  const waitMs = Math.max(MIN_WAIT_MS, Number(killBoundMs) || 0);
  return { waitMs, staleMs: waitMs - waitMs / 5 };
}

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
 *   onWaitExpired?: (holder: import('./full-suite-queue.js').LockHolder) => T,
 *   rerunCommand?: string,
 * }} opts A non-`undefined` `skipIfSatisfied` return stands in for the spawn.
 * @param {(timing: { lockWaitMs: number }) => Promise<T>} spawn
 * @returns {Promise<T>}
 */
export async function withFullSuiteLockAsync(options, spawn) {
  const opts = withDefaults(options);
  const { lock, lockPath } = beginLock(opts);
  const wait =
    lock === null && lockPath !== null
      ? await waitInLine({ ...opts, lockPath })
      : { held: lock, expired: false, waited: false, waitedMs: 0 };
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

async function spawnOrStandIn(opts, wait, spawn) {
  const probe = consult(opts.skipIfSatisfied, wait.waited);
  if (probe.satisfied) {
    opts.log(
      `${LOCK_TAG} ⏭ the run we waited for already covered this tree — skipping the spawn.`,
    );
    return probe.value;
  }
  if (wait.expired) return opts.onWaitExpired(wait.holder);
  return await spawn({ lockWaitMs: wait.waitedMs ?? 0 });
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
 * @param {object} [config]
 * @param {Record<string, string|undefined>} [env]
 */
export function fullSuiteLockPolicy(config, env = process.env) {
  return {
    ...resolveFullSuiteLockBudget(getQuality(config).coverage?.timeoutMs),
    enabled: isFullSuiteLockEnabled({ config, env }),
    onWaitExpired: () => LOCK_WAIT_EXPIRED_EXIT_CODE,
  };
}

/**
 * Serialize a capture runner's spawn. Wrapped at the one call site below
 * every skip/freshness decision, so a credited capture never waits.
 *
 * @param {Function} runCaptureFn
 * @param {object} [config]
 * @param {Record<string, string|undefined>} [env]
 * @param {object} [lockOptions]
 * @returns {(opts?: object) => Promise<number>}
 */
export function lockedCapture(
  runCaptureFn,
  config,
  env = process.env,
  lockOptions = {},
) {
  const policy = { ...fullSuiteLockPolicy(config, env), ...lockOptions };
  return (captureOpts = {}) =>
    withFullSuiteLockAsync(
      {
        ...policy,
        cwd: captureOpts.cwd,
        log: captureOpts.log,
        skipIfSatisfied: freshnessProbe(captureOpts),
      },
      ({ lockWaitMs }) => runCaptureFn({ ...captureOpts, lockWaitMs }),
    );
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
