/**
 * full-suite-queue.js — how a full-suite lock waiter waits (Story #5377):
 * in arrival order, and out loud.
 *
 * The lockfile alone is first-come-first-*polled*: whichever waiter happens to
 * retry in the instant after the holder releases wins, so a waiter that has
 * queued for four minutes can lose to one that arrived a second ago. Each
 * waiter therefore drops a ticket named by its arrival time into a directory
 * beside the lockfile, and only attempts the lock when no live ticket is
 * older than its own.
 *
 * **Best-effort, like the lock it orders.** A ticket counts only while it is
 * well-formed, its pid is alive, and its mtime is fresher than the stale
 * threshold — every waiter refreshes its own ticket on each poll. So a
 * corrupt entry is ignored at once, a crashed waiter's entry as soon as its
 * pid is gone, and nothing can block acquisition for longer than the stale
 * threshold. Any I/O failure resolves to "first in line": the queue may make
 * a waiter wait its turn, it may never make one wait forever.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  isHolderAlive,
  readLockHolderPid,
} from './single-story-sweep/sweep-lock.js';

const LOCK_TAG = '[full-suite-lock]';

/**
 * `<arrival ms>-<in-process sequence>-<pid>-<nonce>`, fixed-width where it
 * matters, so lexical order is arrival order — including two waiters of one
 * process that arrive within the same millisecond.
 */
const TICKET_RE = /^\d{15}-\d{6}-(\d+)-[0-9a-f]+$/;

let sequence = 0;

/**
 * @typedef {{ dir: string, name: string, file: string, detach: () => void }} Ticket
 */

/**
 * Take a ticket at the back of the queue for `lockPath`. Returns `null` when
 * the ticket cannot be written, which makes this waiter unordered rather
 * than unable to acquire.
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
  const ticket = { dir, name, file, detach: () => {} };
  // A waiter that exits mid-wait must not leave its ticket ahead of others.
  const onExit = () => dequeueWaiter(ticket, { fsImpl });
  if (typeof processImpl.once === 'function') {
    processImpl.once('exit', onExit);
    ticket.detach = () => processImpl.off?.('exit', onExit);
  }
  return ticket;
}

/**
 * Stamp a ticket as still-waiting so no other waiter reads it as stale.
 *
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
 * Leave the queue. Idempotent and never throws.
 *
 * @param {Ticket|null} ticket
 * @param {{ fsImpl?: object }} [opts]
 */
function dequeueWaiter(ticket, { fsImpl = fs } = {}) {
  if (!ticket) return;
  ticket.detach();
  try {
    fsImpl.unlinkSync(ticket.file);
  } catch {
    // Already gone.
  }
}

/**
 * Does a queue entry still hold a place in line?
 *
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
 * Is it this waiter's turn? True when no live ticket is older than `ticket`
 * — or, for a caller holding no ticket (the uncontended first attempt), when
 * nobody is queued at all.
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
 * Read the outcome a finished wait announced, from one of its log lines —
 * the one channel that reaches close from a capture running in a child
 * process as well as from a gate running in close's own.
 *
 * @param {string} line
 * @returns {{ waitedSeconds: number, expired: boolean }|null} `null` for any
 *   line that is not a wait's final line.
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
 * Wait, in arrival order, for the lock at `lockPath`. Announces the wait when
 * it starts, every `reportMs` while it lasts, and how it ended — the lines
 * {@link parseLockWaitOutcome} reads back.
 *
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

/**
 * The poll loop: attempt the lock only when first in line, until it is held,
 * a hard error ends the wait, or the deadline passes (`null`).
 */
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
