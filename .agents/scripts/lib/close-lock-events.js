/**
 * Lock-wait, suite-timing and live lock-progress events, as NDJSON in a
 * per-run file (never gate output, which tests can forge). A child claims
 * the env var before spawning, so no suite process can write to it.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLOSE_LOCK_EVENTS_FILE_ENV = 'MANDREL_CLOSE_LOCK_EVENTS_FILE';

const EVENT_KINDS = new Set(['lock-wait', 'suite-timings', 'lock-progress']);

function appendEvent(file, event, fsImpl) {
  try {
    fsImpl.appendFileSync(file, `${JSON.stringify(event)}\n`);
  } catch {}
}

function parseEventLine(line) {
  try {
    const event = JSON.parse(line);
    return EVENT_KINDS.has(event?.kind) ? event : null;
  } catch {
    return null;
  }
}

/** @param {{ dir?: string, fsImpl?: object }} [opts] */
export function createLockEventChannel({
  dir = os.tmpdir(),
  fsImpl = fs,
} = {}) {
  const name = `mandrel-lock-events-${process.pid}-${crypto.randomBytes(6).toString('hex')}.ndjson`;
  const file = path.join(dir, name);
  return {
    file,
    env: { [CLOSE_LOCK_EVENTS_FILE_ENV]: file },
    emit: (event) => appendEvent(file, event, fsImpl),
    read: () => readEvents(file, fsImpl),
    drain: createDrain(file, fsImpl),
    dispose() {
      try {
        fsImpl.rmSync(file, { force: true });
      } catch {}
    },
  };
}

function readText(file, fsImpl) {
  try {
    return fsImpl.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function parseEvents(text) {
  return text.split('\n').filter(Boolean).map(parseEventLine).filter(Boolean);
}

function readEvents(file, fsImpl) {
  return parseEvents(readText(file, fsImpl));
}

/** Each call returns only complete lines appended since the last one. */
function createDrain(file, fsImpl) {
  let consumed = 0;
  return () => {
    const text = readText(file, fsImpl);
    const end = Math.max(consumed, text.lastIndexOf('\n') + 1);
    const fresh = text.slice(consumed, end);
    consumed = end;
    return parseEvents(fresh);
  };
}

/**
 * Remove the channel from `env` and return its emitter (a no-op without one).
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {{ fsImpl?: object }} [opts]
 * @returns {(event: object) => void}
 */
export function claimLockEventSink(env = process.env, { fsImpl = fs } = {}) {
  const file = env[CLOSE_LOCK_EVENTS_FILE_ENV];
  delete env[CLOSE_LOCK_EVENTS_FILE_ENV];
  if (!file) return () => {};
  return (event) => appendEvent(file, event, fsImpl);
}

/**
 * Waits sum, an expiry sticks, the last holder wins; timings are the last.
 *
 * @param {object[]} events
 * @returns {{ lockWait: object|null, suiteTimings: object|null }}
 */
export function summarizeLockEvents(events) {
  let lockWait = null;
  let suiteTimings = null;
  for (const event of events) {
    if (event.kind === 'lock-wait') lockWait = mergeLockWait(lockWait, event);
    else if (event.kind === 'suite-timings') suiteTimings = timingsOf(event);
  }
  return { lockWait, suiteTimings };
}

function mergeLockWait(tally, event) {
  const holder = event.holder ?? tally?.holder;
  return {
    waitedSeconds: (tally?.waitedSeconds ?? 0) + Number(event.waitedSeconds),
    expired: Boolean(tally?.expired) || event.expired === true,
    ...(holder ? { holder } : {}),
  };
}

function timingsOf({ lockWaitMs, hostWaitMs, testRunMs }) {
  return { lockWaitMs, hostWaitMs: hostWaitMs ?? null, testRunMs };
}

/** @param {(event: object) => void} emit */
export function lockEventHooks(emit) {
  return {
    onLockOutcome: (outcome) => emit({ kind: 'lock-wait', ...outcome }),
    onLockProgress: (progress) => emit({ kind: 'lock-progress', ...progress }),
    onTimings: (timings) => emit({ kind: 'suite-timings', ...timings }),
  };
}
