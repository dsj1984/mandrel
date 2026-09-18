/**
 * full-suite-lock.js — serialize the framework's full-suite spawns across
 * concurrent processes on one host (Story #5173).
 *
 * A full `npm test` / `npm run test:coverage` is the most expensive thing this
 * framework causes, and a multi-Story delivery runs several of them from
 * sibling worktrees of the same checkout. Two suites racing on one host do not
 * merely take twice as long — they contend for the same cores, and the
 * coverage artifact they both write is a single shared path per worktree, so
 * the loser's run is wasted work. This module makes the second spawn wait for
 * the first instead.
 *
 * **It reuses the shipped advisory-lock primitive**
 * (`single-story-sweep/sweep-lock.js`) rather than authoring a second
 * lockfile: pid+mtime identity, stale takeover, heartbeat and owner-checked
 * release are all already solved there, and a second implementation would be a
 * second set of those bugs. `phases/post-land.js` is the other consumer.
 *
 * **Posture: best-effort, never load-bearing.** Failing to acquire — a
 * contended wait that expires, an I/O error, an unresolvable lock home —
 * falls through to spawning the suite anyway. The lock is a collision damper,
 * not mutual exclusion; turning it load-bearing would let a stale lockfile
 * fail a delivery, which is strictly worse than the contention it prevents.
 * The one exception is close (Story #5377): it opts in to *defer* on an
 * expired wait — spawn nothing and report {@link LOCK_WAIT_EXPIRED_EXIT_CODE}
 * — so it can end `pending` rather than run a second suite beside the first.
 * Every other caller (pre-push, a direct capture) keeps spawning anyway.
 *
 * **Waits are asynchronous, ordered and visible (Story #5377).** The holder's
 * event loop keeps turning for the whole spawn, so its heartbeat and its
 * release-on-signal handler both work while the suite runs. Waiters acquire in
 * arrival order (`full-suite-queue.js`), and a wait announces itself when it
 * starts, every {@link DEFAULT_REPORT_MS} while it lasts, and when it ends.
 *
 * **It covers only the spawn.** Callers acquire immediately around the child
 * process, never around the freshness/digest checks that precede it, so a
 * capture that is already credited never waits.
 */
import fs from 'node:fs';
import path from 'node:path';

import { mainCheckoutRoot } from './config/temp-paths.js';
import { isFirstInLine, waitInLine } from './full-suite-queue.js';
import { acquireSweepLock } from './single-story-sweep/sweep-lock.js';

/** Environment escape hatch: set to `0`/`false`/`off`/`no` to disable. */
export const FULL_SUITE_LOCK_ENV = 'MANDREL_FULL_SUITE_LOCK';

/**
 * Environment opt-in for the close-only expiry posture (Story #5377). Close
 * sets it to `defer` on its gate children, and nothing else sets it, so a
 * capture spawned by close reports an expired wait as
 * {@link LOCK_WAIT_EXPIRED_EXIT_CODE} while pre-push and a direct run keep
 * spawning anyway.
 */
export const FULL_SUITE_LOCK_EXPIRY_ENV = 'MANDREL_FULL_SUITE_LOCK_ON_EXPIRY';

/**
 * Exit code for "the lock wait expired and the caller chose not to spawn" —
 * `EX_TEMPFAIL` from `sysexits.h`: try again later, nothing is broken.
 */
export const LOCK_WAIT_EXPIRED_EXIT_CODE = 75;

/**
 * Lockfile name, resolved under the **git common dir's parent** so every
 * linked worktree of one checkout contends on one file — the whole point of a
 * host-level lock is that `.worktrees/story-A` and `.worktrees/story-B` must
 * not each get their own.
 */
const FULL_SUITE_LOCK_FILENAME = 'mandrel-full-suite.lock';

/**
 * Total bounded wait. Well under the ten-minute foreground ceiling close runs
 * under, so a close that waits the whole budget still has time to report.
 */
const DEFAULT_WAIT_MS = 300_000;

/**
 * Stale-holder threshold — never above the wait budget. A live holder keeps
 * its mtime current through the primitive's heartbeat (a third of this), a
 * dead-pid holder is reclaimed at once, and a hung suite is killed by its own
 * timeout; none of them is this threshold's job.
 */
const DEFAULT_STALE_MS = 240_000;

/** Poll interval while waiting. */
const DEFAULT_POLL_MS = 2_000;

/**
 * Still-waiting cadence. Below 30 s by more than one poll, so polling jitter
 * can never stretch the gap between two lines past thirty seconds.
 */
const DEFAULT_REPORT_MS = 25_000;

const FALSEY = /^(0|false|off|no)$/i;

const LOCK_TAG = '[full-suite-lock]';

/** Every {@link withFullSuiteLockAsync} option that has a default. */
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
 * Is the full-suite lock enabled for this process?
 *
 * The environment wins over config so an operator can disable it for one
 * invocation without editing `.agentrc.json`. Both hatches are one-way: they
 * only ever turn the lock **off**, because an operator disabling a
 * best-effort damper is always safe while forcing it on is not.
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
 * Resolve the one lockfile path shared by a checkout and all of its linked
 * worktrees, or `null` when the checkout root cannot be resolved (not a git
 * repo, git unavailable). A `null` disables the lock for that call rather
 * than inventing a cwd-local path that would never actually collide with the
 * sibling it is meant to serialize against.
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
 * Decide whether to lock at all and take the uncontended fast path. A
 * caller with waiters already queued ahead of it does not try the fast path
 * — that is exactly the overtaking the queue exists to stop.
 *
 * @returns {{ lock: object|null, lockPath: string|null }} `lock` is a held
 *   lock when the fast path won, `null` when the caller must wait (or when
 *   locking is off, in which case `lockPath` is `null` too).
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

/** Locking disabled, unresolvable, or broken: spawn unserialized. */
const NO_LOCK = Object.freeze({ lock: null, lockPath: null });

/**
 * The lockfile this call contends on, or `null` when locking is off or the
 * lock home cannot be resolved.
 *
 * @param {{ enabled: boolean, cwd: string, lockPath?: string }} where
 * @returns {string|null}
 */
function lockHome({ enabled, cwd, lockPath }) {
  if (!enabled) return null;
  return lockPath ?? resolveFullSuiteLockPath({ cwd });
}

/**
 * The post-wait re-probe (Story #5278).
 *
 * Waiting for the lock is waiting for *someone else's* full suite against
 * this same checkout. By the time it finishes, the thing this caller was
 * about to spawn the suite to establish may already be true — the holder
 * deposited the stamp, or a sibling recorded the evidence. Spawning anyway
 * pays for a whole suite to re-derive a fact that is already on disk, which
 * is exactly the cost the lock exists to avoid.
 *
 * Consulted **only after a real wait**: an uncontended caller's freshness
 * probe ran moments ago and nothing has happened since, so re-running it
 * would be pure overhead on the hot path. It stays scoped to the caller's
 * own tree: a sibling Story's suite measured a different one.
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
 * Run `spawn` with the full-suite lock held.
 *
 * Never throws on the lock's account and runs `spawn` at most once: every
 * lock outcome — disabled, acquired, contended past the wait budget, I/O
 * error — ends in the same call, so a lock defect can slow a suite down but
 * can never duplicate it. It skips the spawn only when the caller asked it
 * to: `skipIfSatisfied` after a wait, or `onWaitExpired` after an expired one.
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
 * }} opts `skipIfSatisfied` is the post-wait re-probe (Story #5278); a
 *   non-`undefined` return is returned in the spawn's place. `onWaitExpired`
 *   is the close-only defer (Story #5377): consulted only when the wait
 *   expired, and a non-`undefined` return likewise stands in for the spawn.
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

/** The caller's options over {@link LOCK_DEFAULTS}; `undefined` never wins. */
function withDefaults(options) {
  const opts = { ...LOCK_DEFAULTS };
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) opts[key] = value;
  }
  return opts;
}

/** What an expired wait's final line says the caller will do next. */
function expiryNote({ onWaitExpired }) {
  return typeof onWaitExpired === 'function'
    ? 'not spawning; the caller reports the wait instead'
    : 'spawning anyway';
}

/**
 * Spawn — unless the post-wait re-probe or the expiry defer supplies the
 * answer the spawn would have produced.
 */
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
 * Promise-based delay. Injectable so tests can drive the wait loop on a fake
 * clock without a real timer.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Decorate a capture runner so its spawn is serialized behind the host lock.
 *
 * The lock composes *over* `runCapture` rather than living inside it, for two
 * reasons. `runCapture` has no config in scope — it is reached from pre-push
 * and from unit tests as a pure spawn helper — and every decision that can
 * avoid the suite (the changed-file skip, the digest/mtime freshness probe)
 * happens in the capture paths *above* it. Wrapping the runner at the one
 * production call site therefore puts the lock exactly around the spawn: an
 * already-credited capture returns before the wrapper is ever invoked, so it
 * never waits (AC-9).
 *
 * @param {Function} runCaptureFn The runner to wrap (`runCapture`).
 * @param {object} [config] Resolved config; both escape hatches are read here.
 * @param {Record<string, string|undefined>} [env] Read for the enable hatch
 *   and for close's {@link FULL_SUITE_LOCK_EXPIRY_ENV} opt-in.
 * @param {object} [lockOptions] Test seam only (lock path, wait budget);
 *   production never passes it.
 * @returns {(opts?: object) => Promise<number>} A runner with the same
 *   `(opts) => exitCode` contract, asynchronous.
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
 * Close's opt-in (Story #5377): under {@link FULL_SUITE_LOCK_EXPIRY_ENV}
 * `defer`, an expired wait exits {@link LOCK_WAIT_EXPIRED_EXIT_CODE} instead
 * of spawning; anywhere else it spawns anyway.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {(() => number)|undefined}
 */
function deferredCaptureExit(env) {
  return env[FULL_SUITE_LOCK_EXPIRY_ENV] === 'defer'
    ? () => LOCK_WAIT_EXPIRED_EXIT_CODE
    : undefined;
}

/**
 * Story #5278 — the capture path supplies its own freshness re-probe per
 * call, because only it knows which scope ('full' / 'incremental') the stamp
 * has to satisfy. A `true` means the suite we queued behind already stamped
 * this tree, so this caller reports success (exit 0) without spawning a
 * second one.
 *
 * @param {{ recheckFresh?: () => boolean }} captureOpts
 * @returns {(() => number|undefined)|undefined}
 */
function freshnessProbe({ recheckFresh }) {
  return typeof recheckFresh === 'function'
    ? () => (recheckFresh() ? 0 : undefined)
    : undefined;
}
