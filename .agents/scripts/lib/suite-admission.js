/**
 * suite-admission.js — capacity admission for the suite spawns the
 * full-suite lock guards.
 *
 * A spawn is classified by its exact argv against
 * `delivery.execution.workloads[]`. A declared workload holds a
 * weight-carrying reservation under the main checkout's `.git`, admitted while
 * live weights fit `capacity` and no live reservation shares a resource. An
 * undeclared spawn is exclusive: it takes the legacy lockfile (so older
 * Mandrel versions still queue behind it) and drains every reservation first.
 * Check-then-reserve runs under a short admission mutex, so two processes can
 * never both take the last slot — and an exclusive run's drain check runs
 * under the same mutex, so it can never pass between a declared run's
 * legacy-holder check and its reservation.
 */
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import {
  acquireSweepLock,
  isHolderAlive,
  readLockHolderPid,
} from './single-story-sweep/sweep-lock.js';

/** `EX_CONFIG`: a declared weight the capacity can never admit. */
export const ADMISSION_REFUSED_EXIT_CODE = 78;

/**
 * Staleness for every holder, reservation and ticket — fixed, so no waiter's
 * own wait budget can read a live holder stale. A dead pid is stale at once.
 */
export const FULL_SUITE_STALE_MS = 1_800_000;

/** Holders refresh well inside every stale threshold, old or new. */
const HOLDER_HEARTBEAT_MS = 20_000;

const MUTEX_STALE_MS = 30_000;

const RESERVATION_RE = /^w(\d+)~([a-z0-9+-]*)~[^~]+\.lock$/;

/**
 * @typedef {{ kind: 'exclusive' }
 *   | { kind: 'declared', command: string, weight: number, resources: string[] }
 *   | { kind: 'refused', command: string, weight: number, capacity: number }} SuiteWorkload
 */

/** @param {string|string[]} argv */
function normalizeCommand(argv) {
  const text = Array.isArray(argv) ? argv.join(' ') : String(argv ?? '');
  return text.split(/\s+/).filter(Boolean).join(' ');
}

/**
 * @param {object} [config]
 * @param {{ availableParallelism?: () => number }} [osImpl]
 * @returns {number}
 */
export function resolveSuiteCapacity(config, osImpl = os) {
  const configured = config?.delivery?.execution?.capacity;
  if (Number.isInteger(configured) && configured >= 1) return configured;
  return Math.max(1, Number(osImpl.availableParallelism?.()) || 1);
}

/**
 * Exact argv equality only — never a prefix, flag or diff-size inference.
 *
 * @param {{ config?: object, argv?: string|string[], capacity?: number }} opts
 * @returns {SuiteWorkload}
 */
function classifySuiteWorkload({ config, argv, capacity }) {
  const workloads = config?.delivery?.execution?.workloads;
  if (!Array.isArray(workloads) || argv === undefined) {
    return { kind: 'exclusive' };
  }
  const command = normalizeCommand(argv);
  const entry = workloads.find(
    (w) => normalizeCommand(w?.command) === command && command !== '',
  );
  if (!entry) return { kind: 'exclusive' };
  const limit = capacity ?? resolveSuiteCapacity(config);
  if (entry.weight > limit) {
    return { kind: 'refused', command, weight: entry.weight, capacity: limit };
  }
  return {
    kind: 'declared',
    command,
    weight: entry.weight,
    resources: [...(entry.resources ?? [])],
  };
}

/**
 * @param {object} [config]
 * @param {string[]} [argv]
 * @returns {{ capacity: number, workload: SuiteWorkload }}
 */
export function resolveAdmission(config, argv) {
  const capacity = resolveSuiteCapacity(config);
  return {
    capacity,
    workload: classifySuiteWorkload({ config, argv, capacity }),
  };
}

/** @param {{ workload?: SuiteWorkload }} opts */
export function createAttempt(opts) {
  return opts.workload?.kind === 'declared'
    ? createDeclaredAttempt(opts)
    : createExclusiveAttempt(opts);
}

/** The `completed` progress event: wait and execution kept apart. */
export function completedProgress(waitMs, budgetMs, executionMs) {
  return {
    phase: 'completed',
    waitedSeconds: Math.round(waitMs / 1000),
    waitBudgetSeconds: Math.round(Math.max(0, budgetMs) / 1000),
    waitMs,
    executionMs: Math.max(0, executionMs),
  };
}

/** @param {SuiteWorkload} workload */
export function describeRefusal({ command, weight, capacity }) {
  return `[full-suite-lock] ✖ \`${command}\` declares weight ${weight}, above delivery.execution.capacity ${capacity} — it can never be admitted, so nothing ran and no credit was recorded. Lower its weight or raise capacity. Exiting ${ADMISSION_REFUSED_EXIT_CODE}.`;
}

function reservationsDir(lockPath) {
  return `${lockPath}.reservations`;
}

function ageOf(file, fsImpl, nowFn) {
  try {
    return nowFn() - fsImpl.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Dead pid → stale now; otherwise a heartbeat older than `staleMs`.
 *
 * @returns {{ live: boolean, exists: boolean, pid: number|null, ageMs: number|null }}
 */
function holderState(file, { fsImpl, nowFn, staleMs, killFn }) {
  const ageMs = ageOf(file, fsImpl, nowFn);
  if (ageMs === null) return { live: false, exists: false, pid: null, ageMs };
  const pid = readLockHolderPid(file, fsImpl);
  const dead = isHolderAlive(pid, killFn) === false;
  return { live: !dead && ageMs <= staleMs, exists: true, pid, ageMs };
}

function holderOf(file, state) {
  return {
    ownerId: path.basename(file),
    pid: state.pid,
    ageSeconds: Math.max(0, Math.round(state.ageMs / 1000)),
  };
}

/**
 * Live reservations; a dead-pid entry is unlinked (callers hold the mutex).
 *
 * @returns {Array<{ weight: number, resources: string[], holder: object }>|null}
 *   `null` when the directory is absent.
 */
function readLiveReservations({ lockPath, ...probe }) {
  const dir = reservationsDir(lockPath);
  let names;
  try {
    names = probe.fsImpl.readdirSync(dir).map(String).sort();
  } catch {
    return null;
  }
  return names.flatMap((name) => liveReservation(dir, name, probe));
}

function liveReservation(dir, name, probe) {
  const match = RESERVATION_RE.exec(name);
  if (!match) return [];
  const file = path.join(dir, name);
  const state = holderState(file, probe);
  if (!state.live) {
    if (state.exists && isHolderAlive(state.pid, probe.killFn) === false) {
      unlinkQuietly(file, probe.fsImpl);
    }
    return [];
  }
  return [
    {
      weight: Number(match[1]),
      resources: match[2] ? match[2].split('+') : [],
      holder: holderOf(file, state),
    },
  ];
}

function unlinkQuietly(file, fsImpl) {
  try {
    fsImpl.unlinkSync(file);
  } catch {}
}

/** @returns {object|null} the live legacy holder, if any. */
function liveLegacyHolder({ lockPath, ...probe }) {
  const state = holderState(lockPath, probe);
  return state.live ? holderOf(lockPath, state) : null;
}

/**
 * Runs `fn` under the admission mutex. `busy` retries next poll; `error`
 * fails open, as every lockfile I/O error does.
 */
function underAdmissionMutex({ lockPath, fsImpl }, fn) {
  const mutex = acquireSweepLock({
    lockPath: `${lockPath}.admission`,
    timeoutMs: MUTEX_STALE_MS,
    heartbeatMs: 0,
    fsImpl,
    processImpl: null,
  });
  if (!mutex.acquired) {
    return mutex.reason === 'error'
      ? { acquired: false, reason: 'error' }
      : { acquired: false, blocking: { reason: 'admission' } };
  }
  try {
    return fn();
  } finally {
    mutex.release();
  }
}

function blocked(blocking) {
  return { acquired: false, blocking };
}

function sharedResource(live, resources) {
  for (const reservation of live) {
    const shared = reservation.resources.find((r) => resources.includes(r));
    if (shared) return { shared, holder: reservation.holder };
  }
  return null;
}

function reservationName({ weight, resources }) {
  const rand = crypto.randomBytes(4).toString('hex');
  return `w${weight}~${resources.join('+')}~${process.pid}-${rand}.lock`;
}

/**
 * A declared run: admitted when no exclusive holder is live, no live
 * reservation shares a resource, and the live weights plus its own fit.
 *
 * @param {{ lockPath: string, workload: SuiteWorkload, capacity: number,
 *   staleMs: number, fsImpl: object, nowFn: () => number, killFn?: Function,
 *   acquireReservationFn?: typeof acquireSweepLock }} opts
 */
function createDeclaredAttempt(opts) {
  const { workload, capacity } = opts;
  const acquire = opts.acquireReservationFn ?? acquireSweepLock;
  let held = null;
  const admit = () => {
    const legacy = liveLegacyHolder(opts);
    if (legacy) return blocked({ reason: 'exclusive', holder: legacy });
    const live = readLiveReservations(opts) ?? [];
    const clash = sharedResource(live, workload.resources);
    if (clash) {
      return blocked({
        reason: 'resource',
        resource: clash.shared,
        holder: clash.holder,
      });
    }
    const used = live.reduce((sum, r) => sum + r.weight, 0);
    if (used + workload.weight > capacity) {
      return blocked({
        reason: 'capacity',
        used,
        requested: workload.weight,
        capacity,
      });
    }
    return reserve();
  };
  const reserve = () => {
    const dir = reservationsDir(opts.lockPath);
    try {
      opts.fsImpl.mkdirSync(dir, { recursive: true });
    } catch {
      return { acquired: false, reason: 'error' };
    }
    const result = acquire({
      lockPath: path.join(dir, reservationName(workload)),
      timeoutMs: opts.staleMs,
      heartbeatMs: HOLDER_HEARTBEAT_MS,
      fsImpl: opts.fsImpl,
    });
    if (result.acquired) held = result;
    return result.acquired ? result : { acquired: false, reason: 'error' };
  };
  return {
    tryOnce: () => underAdmissionMutex(opts, admit),
    release: () => held?.release(),
  };
}

/**
 * An undeclared run: take the legacy lockfile, then wait (still holding it,
 * so nothing new is admitted) until every live reservation has drained. The
 * drain check always takes the admission mutex: a declared run mid-admission
 * has passed its legacy-holder check but not yet written its reservation, so
 * an unlocked "no reservations" read could admit both. A busy mutex blocks as
 * `admission` and retries next poll; a mutex I/O error fails open.
 *
 * @param {{ lockPath: string, capacity: number, staleMs: number,
 *   fsImpl: object, nowFn: () => number, killFn?: Function,
 *   acquireOnceFn: typeof acquireSweepLock }} opts
 */
function createExclusiveAttempt(opts) {
  let held = null;
  const drained = () => {
    const live = readLiveReservations(opts);
    if (live === null || live.length === 0) return held;
    return blocked({
      reason: 'capacity',
      used: live.reduce((sum, r) => sum + r.weight, 0),
      requested: opts.capacity,
      capacity: opts.capacity,
      holder: live[0].holder,
    });
  };
  const tryOnce = () => {
    if (!held) {
      const first = opts.acquireOnceFn({
        lockPath: opts.lockPath,
        timeoutMs: opts.staleMs,
        heartbeatMs: HOLDER_HEARTBEAT_MS,
        fsImpl: opts.fsImpl,
      });
      if (!first.acquired) return first;
      held = first;
    }
    const verdict = underAdmissionMutex(opts, drained);
    return verdict.reason === 'error' ? held : verdict;
  };
  return {
    tryOnce,
    release: () => held?.release(),
  };
}

const LOCK_TAG = '[full-suite-lock]';

/** The declared-run wait line; `null` leaves the exclusive wording. */
export function admissionWaitLine(workload, blocking, waitMs) {
  if (workload?.kind !== 'declared') return null;
  return `${LOCK_TAG} ⏳ waiting for admission of \`${workload.command}\` (weight ${workload.weight}; ${describeBlocking(blocking)}) — waiting up to ${Math.round(waitMs / 1000)}s before spawning.`;
}

/** The declared-run admitted line; `null` leaves the exclusive wording. */
export function admittedLine(workload, waited) {
  if (workload?.kind !== 'declared') return null;
  return `${LOCK_TAG} ✅ admitted \`${workload.command}\` (weight ${workload.weight}, waited ${waited}s).`;
}

/** A reason worth naming over the holder pid; `null` for a plain queue. */
export function blockingLabel(blocking) {
  return blocking && blocking.reason !== 'queue'
    ? describeBlocking(blocking)
    : null;
}

/** The progress-event `blocking` field, without the holder it duplicates. */
export function publicBlocking(blocking, queueAhead) {
  if (!blocking) return {};
  const { holder: _holder, ...rest } = blocking;
  return {
    blocking:
      rest.reason === 'queue' && Number.isInteger(queueAhead)
        ? { ...rest, queueAhead }
        : rest,
  };
}

/**
 * @param {{ reason: string, used?: number, requested?: number,
 *   capacity?: number, resource?: string, queueAhead?: number }} blocking
 * @returns {string}
 */
export function describeBlocking(blocking) {
  switch (blocking?.reason) {
    case 'capacity':
      return `capacity ${blocking.used}/${blocking.capacity} in use, ${blocking.requested} requested`;
    case 'resource':
      return `resource "${blocking.resource}" is held`;
    case 'exclusive':
      return 'an exclusive full suite holds the lock';
    case 'queue':
      return 'an earlier waiter is first in line';
    case 'admission':
      return 'another process is mid-admission';
    default:
      return 'blocked';
  }
}
