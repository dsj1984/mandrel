/**
 * One signal per story-handoff run: a `retry` naming the stopping step and
 * cause, or a `trace` for a ready run. Best-effort — a failed read or write
 * never changes the handoff's outcome. Details carry no file path.
 *
 * @module lib/observability/handoff-telemetry
 */

import crypto from 'node:crypto';

import { EVENT_KINDS } from '../signals/schema.js';
import { appendSignal, forEachLine } from '../signals/write.js';

export const HANDOFF_PHASE = 'handoff';
export const HANDOFF_TOOL = 'story-handoff';

export const HANDOFF_CAUSES = Object.freeze(
  new Set([
    'precheck',
    'merge-driver-unregistered',
    'base-branch-unconfirmed',
    'base-merge-conflict',
    'base-merge-failed',
    'preflight-unresolved',
    'lint',
    'format',
    'quality-preview',
    'ratchet',
    'lock-wait-expired',
    'host-admission',
    'suite-timeout',
    'red-suite',
    'capture-over-budget',
    'no-credit-signal',
    'seat-refused',
    'seat-commit-failed',
    'post-capture',
    'remote-unreachable',
    'push-rejected',
    'push-unconfirmed',
    'ref-behind',
    'push-hook',
    'review-critical',
    'other',
  ]),
);

/** @param {unknown} cause @returns {string} a closed-set cause, else `other`. */
export function handoffCause(cause) {
  return HANDOFF_CAUSES.has(cause) ? cause : 'other';
}

/** @param {unknown} record */
export function isHandoffRecord(record) {
  return (
    record?.phase === HANDOFF_PHASE && record?.emitter?.tool === HANDOFF_TOOL
  );
}

/** @param {Array<{ name: string, durationMs?: number|null }>} steps */
function stepDurations(steps) {
  const out = {};
  for (const step of steps ?? []) {
    if (Number.isInteger(step.durationMs)) out[step.name] = step.durationMs;
  }
  return out;
}

const pick = (obj, keys) =>
  obj ? Object.fromEntries(keys.map((k) => [k, obj[k] ?? null])) : null;

/** @param {object} envelope @returns {object} the record's kind-specific details. */
function recordDetails(envelope) {
  const common = {
    attempt: envelope.attempt,
    stepDurationsMs: stepDurations(envelope.steps),
    depositor: envelope.depositor ?? null,
    headSha: envelope.headSha ?? null,
  };
  if (envelope.status === 'ready') {
    return {
      status: 'ready',
      ...common,
      suiteTimings: pick(envelope.suiteTimings, [
        'lockWaitMs',
        'hostWaitMs',
        'testRunMs',
      ]),
      lockWait: pick(envelope.lockWait, ['waitedSeconds', 'expired']),
      reviewMs: envelope.reviewMs ?? null,
    };
  }
  const stop = envelope.steps?.findLast((s) => s.name === envelope.failedStep);
  return {
    status: envelope.status,
    failedStep: envelope.failedStep ?? null,
    cause: handoffCause(envelope.cause),
    ...(stop?.check ? { check: stop.check } : {}),
    ...(stop?.gate ? { gate: stop.gate } : {}),
    ...common,
  };
}

/**
 * @param {{ storyId: number, envelope: object, ts?: string }} args
 * @returns {object} a schema-valid signal.
 */
export function buildHandoffRecord({ storyId, envelope, ts }) {
  return {
    kind: envelope.status === 'ready' ? EVENT_KINDS.TRACE : EVENT_KINDS.RETRY,
    eventId: crypto.randomUUID(),
    ts: ts ?? new Date().toISOString(),
    epicId: null,
    storyId,
    taskId: null,
    phase: HANDOFF_PHASE,
    emitter: { tool: HANDOFF_TOOL },
    details: recordDetails(envelope),
  };
}

/**
 * Prior handoff records in the Story's stream, plus one; `null` on a failed read.
 *
 * @param {{ storyId: number, config?: object, readFn?: typeof forEachLine }} args
 * @returns {Promise<number|null>}
 */
export async function nextHandoffAttempt({
  storyId,
  config,
  readFn = forEachLine,
}) {
  let prior = 0;
  try {
    await readFn(
      null,
      storyId,
      (record) => {
        if (isHandoffRecord(record)) prior += 1;
      },
      config,
    );
  } catch {
    return null;
  }
  return prior + 1;
}

/**
 * @param {{ storyId: number, envelope: object, config?: object,
 *   writeFn?: typeof appendSignal, warn?: (msg: string) => void }} args
 * @returns {Promise<boolean>} true when the record was appended.
 */
export async function emitHandoffRecord({
  storyId,
  envelope,
  config,
  writeFn = appendSignal,
  warn = () => {},
}) {
  try {
    const signal = buildHandoffRecord({ storyId, envelope });
    const ok = await writeFn({ epicId: null, storyId, signal, config });
    if (!ok) warn('handoff signal not appended');
    return ok === true;
  } catch (err) {
    warn(`handoff signal not appended: ${err?.message ?? err}`);
    return false;
  }
}
