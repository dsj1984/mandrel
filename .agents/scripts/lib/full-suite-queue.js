/**
 * full-suite-queue.js — FIFO for full-suite lock waiters (the lockfile alone
 * is first-come-first-polled). A ticket counts only while well-formed, its
 * pid alive and its mtime fresh; any I/O failure means "first in line", so
 * no waiter can wait forever.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  isHolderAlive,
  readLockHolderPid,
} from './single-story-sweep/sweep-lock.js';

const LOCK_TAG = '[full-suite-lock]';

/** Fixed-width, so lexical order is arrival order. */
const TICKET_RE = /^\d{15}-\d{6}-(\d+)-[0-9a-f]+$/;

let sequence = 0;

/**
 * @typedef {{ dir: string, name: string, file: string }} Ticket
 */

/**
 * `null` when unwritable: unordered, not blocked.
 *
 * @param {{ lockPath: string, nowFn?: () => number, fsImpl?: object, processImpl?: object }} opts
 * @returns {Ticket|null}
 */
function enqueueWaiter({
  lockPath,
  nowFn = Date.now,
  fsImpl = fs,
  processImpl = process,
}) {
  const dir = `${lockPath}.queue`;
  const arrival = String(Math.max(0, Math.floor(nowFn()))).padStart(15, '0');
  sequence = (sequence + 1) % 1_000_000;
  const seq = String(sequence).padStart(6, '0');
  const name = `${arrival}-${seq}-${processImpl.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const file = path.join(dir, name);
  try {
    fsImpl.mkdirSync(dir, { recursive: true });
    fsImpl.writeFileSync(file, '');
  } catch {
    return null;
  }
  // No exit hook needed: a dead pid never holds a place in line.
  return { dir, name, file };
}

/**
 * @param {Ticket|null} ticket
 * @param {{ nowFn?: () => number, fsImpl?: object }} [opts]
 */
function refreshTicket(ticket, { nowFn = Date.now, fsImpl = fs } = {}) {
  if (!ticket) return;
  try {
    const stamp = new Date(nowFn());
    fsImpl.utimesSync(ticket.file, stamp, stamp);
  } catch {
    // A vanished ticket just stops ordering this waiter.
  }
}

/**
 * @param {Ticket|null} ticket
 * @param {{ fsImpl?: object }} [opts]
 */
function dequeueWaiter(ticket, { fsImpl = fs } = {}) {
  if (!ticket) return;
  try {
    fsImpl.unlinkSync(ticket.file);
  } catch {
    // Already gone.
  }
}

/**
 * @param {{ dir: string, name: string, staleMs: number, nowFn: () => number, fsImpl: object, killFn?: Function }} args
 * @returns {boolean}
 */
function isLiveEntry({ dir, name, staleMs, nowFn, fsImpl, killFn }) {
  const match = TICKET_RE.exec(name);
  if (!match) return false;
  if (isHolderAlive(Number(match[1]), killFn) === false) return false;
  try {
    return nowFn() - fsImpl.statSync(path.join(dir, name)).mtimeMs <= staleMs;
  } catch {
    return false;
  }
}

/** Live waiters ahead of `ticket`; `null` when the queue is unreadable. */
function countAhead({
  lockPath,
  ticket,
  staleMs,
  nowFn = Date.now,
  fsImpl = fs,
  killFn,
}) {
  const dir = `${lockPath}.queue`;
  let names;
  try {
    names = fsImpl.readdirSync(dir).map(String).sort();
  } catch {
    return null;
  }
  const own = ticket ? names.indexOf(ticket.name) : -1;
  return names
    .slice(0, own === -1 ? names.length : own)
    .filter((name) =>
      isLiveEntry({ dir, name, staleMs, nowFn, fsImpl, killFn }),
    ).length;
}

/**
 * With no ticket, true only when nobody is queued.
 *
 * @param {{
 *   lockPath: string,
 *   ticket: Ticket|null,
 *   staleMs: number,
 *   nowFn?: () => number,
 *   fsImpl?: object,
 *   killFn?: Function,
 * }} opts
 * @returns {boolean}
 */
export function isFirstInLine(opts) {
  return (countAhead(opts) ?? 0) === 0;
}

/**
 * @typedef {{ ownerId: string|null, pid: number|null, ageSeconds: number|null }} LockHolder
 */

/**
 * Lockfile lines: owner id, creation stamp, pid. Unreadable parts are null.
 *
 * @param {string} lockPath
 * @param {{ fsImpl?: object, nowFn?: () => number }} [opts]
 * @returns {LockHolder}
 */
export function readLockHolder(
  lockPath,
  { fsImpl = fs, nowFn = Date.now } = {},
) {
  let lines = [];
  try {
    lines = String(fsImpl.readFileSync(lockPath, 'utf8')).split('\n');
  } catch {
    // No lockfile.
  }
  const created = Date.parse(lines[1] ?? '');
  return {
    ownerId: lines[0] ? lines[0] : null,
    pid: readLockHolderPid(lockPath, fsImpl),
    ageSeconds: Number.isFinite(created)
      ? Math.max(0, Math.round((nowFn() - created) / 1000))
      : null,
  };
}

/** @param {LockHolder} holder */
function describeHolder({ ownerId, pid, ageSeconds }) {
  return `holder ${ownerId ?? 'unknown'}, pid ${pid ?? 'unknown'}, lock age ${ageSeconds ?? 'unknown'}s`;
}

function holderLabel(lockPath, fsImpl) {
  return `holding pid ${readLockHolderPid(lockPath, fsImpl) ?? 'unknown'}`;
}

/**
 * @typedef {{
 *   phase: 'waiting'|'still-waiting'|'acquired'|'expired',
 *   waitedSeconds: number, waitBudgetSeconds: number,
 *   holder?: LockHolder, queueAhead?: number,
 * }} LockProgress
 */

/**
 * @param {{
 *   lockPath: string, waitMs: number, pollMs: number, staleMs: number,
 *   reportMs: number, fsImpl: object, nowFn: () => number,
 *   sleepFn: (ms: number) => Promise<void>, acquireOnceFn: Function,
 *   log: (m: string) => void, rerunCommand: string,
 *   onLockProgress?: (progress: LockProgress) => void,
 * }} opts A throwing `onLockProgress` is swallowed.
 * @returns {Promise<{ held: object|null, expired: boolean, waited: true, waitedMs: number, holder?: LockHolder }>}
 */
export async function waitInLine(opts) {
  const { lockPath, fsImpl, nowFn } = opts;
  const clock = waitClock(opts);
  announceWait(opts);
  reportProgress(opts, clock, 'waiting', null);
  const ticket = enqueueWaiter({ lockPath, nowFn, fsImpl });
  try {
    const outcome = await pollForTurn(opts, ticket, clock);
    if (outcome)
      return { ...outcome, waited: true, waitedMs: clock.waitedMs() };
  } finally {
    dequeueWaiter(ticket, { fsImpl });
  }
  return giveUp(opts, clock);
}

function waitClock({ waitMs, reportMs, nowFn }) {
  const startedAt = nowFn();
  return {
    deadline: startedAt + Math.max(0, waitMs),
    nextReport: startedAt + reportMs,
    waitedMs: () => Math.max(0, nowFn() - startedAt),
    waited: () => Math.round((nowFn() - startedAt) / 1000),
  };
}

function reportProgress(opts, clock, phase, ticket, knownHolder) {
  try {
    opts.onLockProgress?.({
      phase,
      waitedSeconds: clock.waited(),
      waitBudgetSeconds: Math.round(Math.max(0, opts.waitMs) / 1000),
      ...(phase === 'acquired' ? {} : waitContext(opts, ticket, knownHolder)),
    });
  } catch {}
}

/** Holder and queue position, each only when readable. */
function waitContext({ lockPath, staleMs, fsImpl, nowFn }, ticket, known) {
  const holder = known ?? readLockHolder(lockPath, { fsImpl, nowFn });
  const queueAhead = countAhead({ lockPath, ticket, staleMs, nowFn, fsImpl });
  return {
    ...(holder.ownerId === null && holder.pid === null ? {} : { holder }),
    ...(queueAhead === null ? {} : { queueAhead }),
  };
}

function announceWait({ lockPath, waitMs, fsImpl, log }) {
  log(
    `${LOCK_TAG} ⏳ another full suite is already running on this host (${holderLabel(lockPath, fsImpl)}) — waiting up to ${Math.round(waitMs / 1000)}s for it to finish before spawning.`,
  );
}

function giveUp(opts, clock) {
  const { lockPath, fsImpl, nowFn, log, rerunCommand } = opts;
  const holder = readLockHolder(lockPath, { fsImpl, nowFn });
  log(
    `${LOCK_TAG} ⌛ gave up waiting for the full-suite lock (waited ${clock.waited()}s, ${describeHolder(holder)}) — not spawning, so two full suites never overlap. Re-run once it finishes: ${rerunCommand}`,
  );
  reportProgress(opts, clock, 'expired', null, holder);
  return {
    held: null,
    expired: true,
    waited: true,
    waitedMs: clock.waitedMs(),
    holder,
  };
}

/** `null` means the deadline passed. */
async function pollForTurn(opts, ticket, clock) {
  const { lockPath, staleMs, fsImpl, nowFn, log } = opts;
  while (nowFn() < clock.deadline) {
    await opts.sleepFn(Math.max(0, opts.pollMs));
    refreshTicket(ticket, { nowFn, fsImpl });
    const attempt = isFirstInLine({ lockPath, ticket, staleMs, nowFn, fsImpl })
      ? opts.acquireOnceFn({ lockPath, timeoutMs: staleMs, fsImpl })
      : { acquired: false };
    if (attempt.acquired) {
      log(
        `${LOCK_TAG} ✅ acquired the full-suite lock (waited ${clock.waited()}s).`,
      );
      reportProgress(opts, clock, 'acquired', ticket);
      return { held: attempt, expired: false };
    }
    // A hard I/O error will not resolve by waiting; it is not an expiry.
    if (attempt.reason === 'error') return { held: null, expired: false };
    reportStillWaiting(opts, clock, ticket);
  }
  return null;
}

function reportStillWaiting(opts, clock, ticket) {
  const { lockPath, fsImpl, nowFn, log, reportMs } = opts;
  if (nowFn() < clock.nextReport) return;
  log(
    `${LOCK_TAG} ⏳ still waiting for the full-suite lock (${holderLabel(lockPath, fsImpl)}, waited ${clock.waited()}s).`,
  );
  reportProgress(opts, clock, 'still-waiting', ticket);
  clock.nextReport += reportMs;
}
