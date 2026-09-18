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
export function isFirstInLine({
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
    return true;
  }
  for (const name of names) {
    if (name === ticket?.name) return true;
    if (isLiveEntry({ dir, name, staleMs, nowFn, fsImpl, killFn })) {
      return false;
    }
  }
  return true;
}

/**
 * Log lines are the one channel that reaches close from a child capture.
 *
 * @param {string} line
 * @returns {{ waitedSeconds: number, expired: boolean }|null}
 */
export function parseLockWaitOutcome(line) {
  const match = /\[full-suite-lock\] (✅|⌛) [^\n]*\(waited (\d+)s[,)]/u.exec(
    String(line ?? ''),
  );
  if (!match) return null;
  return { waitedSeconds: Number(match[2]), expired: match[1] === '⌛' };
}

function holderLabel(lockPath, fsImpl) {
  return `holding pid ${readLockHolderPid(lockPath, fsImpl) ?? 'unknown'}`;
}

/**
 * @param {{
 *   lockPath: string, waitMs: number, pollMs: number, staleMs: number,
 *   reportMs: number, fsImpl: object, nowFn: () => number,
 *   sleepFn: (ms: number) => Promise<void>, acquireOnceFn: Function,
 *   log: (m: string) => void, expiryNote: string,
 * }} opts
 * @returns {Promise<{ held: object|null, expired: boolean, waited: true }>}
 */
export async function waitInLine(opts) {
  const { lockPath, waitMs, fsImpl, nowFn, log } = opts;
  const startedAt = nowFn();
  const clock = {
    deadline: startedAt + Math.max(0, waitMs),
    nextReport: startedAt + opts.reportMs,
    waited: () => Math.round((nowFn() - startedAt) / 1000),
  };
  log(
    `${LOCK_TAG} ⏳ another full suite is already running on this host (${holderLabel(lockPath, fsImpl)}) — waiting up to ${Math.round(waitMs / 1000)}s for it to finish before spawning.`,
  );
  const ticket = enqueueWaiter({ lockPath, nowFn, fsImpl });
  try {
    const outcome = await pollForTurn(opts, ticket, clock);
    if (outcome) return { ...outcome, waited: true };
  } finally {
    dequeueWaiter(ticket, { fsImpl });
  }
  log(
    `${LOCK_TAG} ⌛ gave up waiting for the full-suite lock (waited ${clock.waited()}s, ${holderLabel(lockPath, fsImpl)}) — ${opts.expiryNote}.`,
  );
  return { held: null, expired: true, waited: true };
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
      return { held: attempt, expired: false };
    }
    // A hard I/O error will not resolve by waiting; it is not an expiry.
    if (attempt.reason === 'error') return { held: null, expired: false };
    reportStillWaiting(opts, clock);
  }
  return null;
}

function reportStillWaiting({ lockPath, fsImpl, nowFn, log, reportMs }, clock) {
  if (nowFn() < clock.nextReport) return;
  log(
    `${LOCK_TAG} ⏳ still waiting for the full-suite lock (${holderLabel(lockPath, fsImpl)}, waited ${clock.waited()}s).`,
  );
  clock.nextReport += reportMs;
}
