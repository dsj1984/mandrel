/**
 * full-suite-lock.js — admit suite spawns across one repository's worktrees
 * (they contend for cores and shared artifacts), over the `sweep-lock.js`
 * primitive. An undeclared spawn runs exclusively; a declared one is admitted
 * against a capacity budget by `suite-admission.js`.
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
import {
  ADMISSION_REFUSED_EXIT_CODE,
  completedProgress,
  createAttempt,
  describeRefusal,
  FULL_SUITE_STALE_MS,
  resolveAdmission,
  resolveSuiteCapacity,
} from './suite-admission.js';
import { defaultSleep } from './util/sleep.js';

export { ADMISSION_REFUSED_EXIT_CODE };

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

/** The argv coverage capture spawns — its workload identity. */
const COVERAGE_CAPTURE_ARGV = Object.freeze(['npm', 'run', 'test:coverage']);

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
  onAdmissionRefused: () => ADMISSION_REFUSED_EXIT_CODE,
  workload: Object.freeze({ kind: 'exclusive' }),
  capacity: resolveSuiteCapacity(),
  onLockOutcome: () => {},
  onLockProgress: () => {},
  rerunCommand: 'the same command',
});

/**
 * The one wait budget every lock taker uses: a holder's suite is killed at
 * its supervisor's `killBoundMs` (the coverage gate's `timeoutMs`). Staleness
 * is fixed, never derived from the waiter's budget — a waiter with a shorter
 * budget than the holder's timeout must not read a live holder stale.
 *
 * @param {number} [killBoundMs]
 * @returns {{ waitMs: number, staleMs: number }}
 */
export function resolveFullSuiteLockBudget(killBoundMs) {
  const waitMs = Math.max(MIN_WAIT_MS, Number(killBoundMs) || 0);
  return { waitMs, staleMs: FULL_SUITE_STALE_MS };
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
 * @returns {{ attempt: object|null, lock: object|null, lockPath: string|null,
 *   blocking?: object }} null `lock` with a `lockPath` means wait; a null
 *   `lockPath` means no lock.
 */
function beginLock(opts) {
  const lockPath = lockHome(opts);
  if (lockPath === null) return NO_LOCK;
  const attempt = createAttempt({ ...opts, lockPath });
  return { attempt, lockPath, ...firstTry(opts, attempt, lockPath) };
}

const NO_LOCK = Object.freeze({ attempt: null, lock: null, lockPath: null });

const QUEUED = Object.freeze({ reason: 'queue' });

function firstTry({ staleMs, fsImpl }, attempt, lockPath) {
  if (!isFirstInLine({ lockPath, ticket: null, staleMs, fsImpl })) {
    return { lock: null, blocking: QUEUED };
  }
  return afterFirst(attempt.tryOnce());
}

/** A hard I/O error will not resolve by waiting — proceed unserialized. */
function afterFirst(first) {
  if (first.acquired) return { lock: first };
  if (first.reason === 'error') return { lock: null, lockPath: null };
  return { lock: null, blocking: first.blocking };
}

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
 *   onLockOutcome?: (outcome: object) => void,
 *   onLockProgress?: (progress: import('./full-suite-queue.js').LockProgress) => void,
 *   rerunCommand?: string,
 * }} opts A non-`undefined` `skipIfSatisfied` return stands in for the spawn.
 * @param {(timing: { lockWaitMs: number }) => Promise<T>} spawn
 * @returns {Promise<T>}
 */
export async function withFullSuiteLockAsync(options, spawn) {
  const opts = withDefaults(options);
  if (isRefused(opts)) return refuse(opts);
  const begun = beginLock(opts);
  try {
    const wait = await awaitTurn(opts, begun);
    reportOutcome(opts.onLockOutcome, wait);
    return await spawnOrStandIn(opts, wait, spawn);
  } finally {
    begun.attempt?.release();
  }
}

function isRefused({ enabled, workload }) {
  return enabled && workload?.kind === 'refused';
}

function refuse(opts) {
  opts.log(describeRefusal(opts.workload));
  return opts.onAdmissionRefused(opts.workload);
}

function awaitTurn(opts, { attempt, lock, lockPath, blocking }) {
  if (lock !== null || lockPath === null) {
    return { held: lock, expired: false, waited: false, waitedMs: 0 };
  }
  return waitInLine({ ...opts, lockPath, attempt, blocking });
}

/** An I/O-error wait is no outcome; a throwing callback never costs the spawn. */
function reportOutcome(onLockOutcome, wait) {
  if (!isFinishedWait(wait)) return;
  try {
    onLockOutcome(lockOutcome(wait));
  } catch {}
}

function isFinishedWait(wait) {
  return wait.waited && (wait.expired || Boolean(wait.held?.acquired));
}

function lockOutcome({ waitedMs, expired, holder }) {
  const outcome = { waitedSeconds: Math.round(waitedMs / 1000), expired };
  return expired && holder ? { ...outcome, holder } : outcome;
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
  return wait.expired
    ? opts.onWaitExpired(wait.holder)
    : await timedSpawn(opts, wait, spawn);
}

/** Wait and execution reach progress as separate figures. */
async function timedSpawn(opts, wait, spawn) {
  const startedAt = opts.nowFn();
  const result = await spawn({ lockWaitMs: wait.waitedMs ?? 0 });
  if (wait.waited) reportCompleted(opts, wait, opts.nowFn() - startedAt);
  return result;
}

function reportCompleted(opts, wait, ranMs) {
  try {
    opts.onLockProgress(completedProgress(wait.waitedMs, opts.waitMs, ranMs));
  } catch {}
}

/**
 * The one admission policy every caller resolves: enablement, budget,
 * capacity, and the workload `argv` classifies to.
 *
 * @param {object} [config]
 * @param {Record<string, string|undefined>} [env]
 * @param {string[]} [argv]
 */
export function fullSuiteLockPolicy(config, env = process.env, argv) {
  return {
    ...resolveFullSuiteLockBudget(getQuality(config).coverage?.timeoutMs),
    enabled: isFullSuiteLockEnabled({ config, env }),
    onWaitExpired: () => LOCK_WAIT_EXPIRED_EXIT_CODE,
    ...resolveAdmission(config, argv),
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
  const policy = {
    ...fullSuiteLockPolicy(config, env, COVERAGE_CAPTURE_ARGV),
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
