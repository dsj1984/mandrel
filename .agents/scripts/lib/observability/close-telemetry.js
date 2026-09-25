/**
 * What a Story cost, as close observes it: retries by cause, review halts and
 * overrides by provider, acceptance rounds, worker tokens. Best-effort and
 * local only — a failed write is a missing metric, never a failed close.
 *
 * @module lib/observability/close-telemetry
 */

import crypto from 'node:crypto';

import { parseWorkerTokens } from '../cli-args.js';
import { Logger } from '../Logger.js';
import { EVENT_KINDS } from '../signals/schema.js';
import {
  emitRuntimeFriction,
  emitTerminalFriction,
  RUNTIME_FRICTION_CATEGORIES,
} from './runtime-friction.js';
import { appendSignal, forEachLine } from './signals-writer.js';

const RETRY_CAUSES = Object.freeze({
  CI_RED: 'ci-red',
  REVIEW_BLOCK: 'review-block',
  GATE_FAILED: 'gate-failed',
  MERGE_WAIT: 'merge-wait',
  OTHER: 'other',
});

const BLOCK_CLASS_CAUSES = Object.freeze({
  'checks-failed': RETRY_CAUSES.CI_RED,
  'advisory-gate-red': RETRY_CAUSES.CI_RED,
  'checks-pending-timeout': RETRY_CAUSES.MERGE_WAIT,
});

const FAILED_PHASE_CAUSES = Object.freeze({
  'code-review': RETRY_CAUSES.REVIEW_BLOCK,
  'close-validation': RETRY_CAUSES.GATE_FAILED,
  'confirm-merge': RETRY_CAUSES.MERGE_WAIT,
});

/**
 * @param {object|null|undefined} envelope
 * @returns {string|null} `null` for a landed or pending close.
 */
function retryCauseForTerminal(envelope) {
  const status = envelope?.status;
  if (status === 'blocked') {
    return (
      BLOCK_CLASS_CAUSES[envelope.blocked?.blockClass] ?? RETRY_CAUSES.OTHER
    );
  }
  if (status === 'failed') {
    return FAILED_PHASE_CAUSES[envelope.phase] ?? RETRY_CAUSES.OTHER;
  }
  return null;
}

/**
 * @param {{ envelope: object, config?: object }} args
 * @returns {Promise<boolean>}
 */
async function emitCloseRetrySignal({ envelope, config }) {
  const cause = retryCauseForTerminal(envelope);
  const storyId = Number(envelope?.storyId);
  if (cause === null || !Number.isInteger(storyId) || storyId <= 0) {
    return false;
  }
  const signal = {
    kind: EVENT_KINDS.RETRY,
    eventId: crypto.randomUUID(),
    ts: new Date().toISOString(),
    epicId: null,
    storyId,
    taskId: null,
    phase: 'close',
    emitter: { tool: 'single-story-close' },
    details: {
      cause,
      status: envelope.status,
      closePhase: envelope.phase ?? null,
      blockClass: envelope.blocked?.blockClass ?? null,
    },
  };
  return appendSignal({ epicId: null, storyId, signal, config });
}

/**
 * @param {{ envelope: object, config?: object }} args
 * @returns {Promise<void>}
 */
export async function emitCloseTerminalSignals({ envelope, config } = {}) {
  await emitCloseRetrySignal({ envelope, config });
  await emitTerminalFriction({ envelope, config });
}

/**
 * @param {{ storyId: number, prNumber?: number|null, criticalCount: number,
 *   criticalByProvider?: Record<string, number>, config?: object }} args
 * @returns {Promise<boolean>} true when a record was appended.
 */
export function emitReviewBlockedFriction({
  storyId,
  prNumber = null,
  criticalCount,
  criticalByProvider = {},
  config,
}) {
  return emitRuntimeFriction({
    storyId,
    category: RUNTIME_FRICTION_CATEGORIES.REVIEW_BLOCKED,
    tool: 'single-story-close',
    details: { prNumber, criticalCount, criticalByProvider },
    config,
  });
}

/**
 * @param {Record<string, number>} into
 * @param {Record<string, number>} from
 * @returns {Record<string, number>} `into`, mutated.
 */
function addCounts(into, from) {
  for (const [key, count] of Object.entries(from)) {
    into[key] = (into[key] ?? 0) + count;
  }
  return into;
}

function emptyTelemetryTally() {
  return {
    acceptanceRounds: 0,
    retries: { total: 0, byCause: {} },
    review: { haltsByProvider: {}, overridesByProvider: {} },
  };
}

/**
 * One incident per provider that raised a critical finding, not per finding.
 *
 * @param {object} details
 * @returns {Record<string, number>}
 */
function providerIncidents(details) {
  const out = {};
  const byProvider = details?.criticalByProvider;
  for (const [name, count] of Object.entries(byProvider ?? {})) {
    if (Number.isInteger(count) && count > 0) out[name] = 1;
  }
  return out;
}

const RECORD_TALLIERS = Object.freeze({
  [EVENT_KINDS.RETRY]: (tally, record) => {
    const cause =
      typeof record.details?.cause === 'string'
        ? record.details.cause
        : RETRY_CAUSES.OTHER;
    tally.retries.total += 1;
    addCounts(tally.retries.byCause, { [cause]: 1 });
  },
  [EVENT_KINDS.ACCEPTANCE_EVAL]: (tally, record) => {
    const round = Number(record.details?.round);
    const seen = Number.isInteger(round) && round > 0 ? round : 1;
    tally.acceptanceRounds = Math.max(tally.acceptanceRounds, seen);
  },
  [EVENT_KINDS.FRICTION]: (tally, record) => {
    if (record.details?.recovered === true) return;
    if (record.category === RUNTIME_FRICTION_CATEGORIES.REVIEW_BLOCKED) {
      addCounts(
        tally.review.haltsByProvider,
        providerIncidents(record.details),
      );
    } else if (
      record.category === RUNTIME_FRICTION_CATEGORIES.REVIEW_BLOCK_OVERRIDDEN
    ) {
      addCounts(
        tally.review.overridesByProvider,
        providerIncidents(record.details),
      );
    }
  },
});

/**
 * @param {Iterable<unknown>} records
 * @returns {ReturnType<typeof emptyTelemetryTally>}
 */
function tallyStoryTelemetry(records) {
  const tally = emptyTelemetryTally();
  for (const record of records ?? []) {
    if (!record || typeof record !== 'object') continue;
    RECORD_TALLIERS[record.kind]?.(tally, record);
  }
  return tally;
}

/**
 * @param {Array<ReturnType<typeof emptyTelemetryTally>>} tallies
 * @returns {ReturnType<typeof emptyTelemetryTally>}
 */
function mergeTelemetryTallies(tallies) {
  const total = emptyTelemetryTally();
  for (const t of tallies ?? []) {
    total.acceptanceRounds += t.acceptanceRounds;
    total.retries.total += t.retries.total;
    addCounts(total.retries.byCause, t.retries.byCause);
    addCounts(total.review.haltsByProvider, t.review.haltsByProvider);
    addCounts(total.review.overridesByProvider, t.review.overridesByProvider);
  }
  return total;
}

/**
 * A halt no override rejected, on a Story that then landed.
 *
 * @param {ReturnType<typeof emptyTelemetryTally>} tally
 * @param {boolean} landed
 * @returns {Record<string, number>}
 */
function confirmedHalts(tally, landed) {
  if (!landed) return {};
  const out = {};
  for (const [name, count] of Object.entries(tally.review.haltsByProvider)) {
    if (!tally.review.overridesByProvider[name]) out[name] = count;
  }
  return out;
}

/**
 * @param {{ storyId: number, config?: object, readFn?: typeof forEachLine }} args
 * @returns {Promise<ReturnType<typeof emptyTelemetryTally>>}
 */
async function readStoryTally({ storyId, config, readFn = forEachLine }) {
  const rows = [];
  try {
    await readFn(null, storyId, (parsed) => rows.push(parsed), config);
  } catch (err) {
    Logger.warn(
      `[close-telemetry] signal read failed for Story #${storyId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return tallyStoryTelemetry(rows);
}

/**
 * @param {{ storyId: number, config?: object, workerTokens?: number|null,
 *   landed?: boolean, readFn?: typeof forEachLine }} args
 * @returns {Promise<object>}
 */
async function buildCloseTelemetry({
  storyId,
  config,
  workerTokens = null,
  landed = false,
  readFn,
}) {
  const tally = await readStoryTally({ storyId, config, readFn });
  return {
    acceptanceRounds: tally.acceptanceRounds,
    retries: tally.retries,
    review: {
      ...tally.review,
      confirmedHaltsByProvider: confirmedHalts(tally, landed),
    },
    workerTokens: Number.isInteger(workerTokens) ? workerTokens : null,
  };
}

/**
 * Over the run's own Stories, not the friction recurrence window.
 *
 * @param {Array<string|number>} storyIds
 * @param {object} [config]
 * @param {{ readFn?: typeof forEachLine }} [opts]
 * @returns {Promise<ReturnType<typeof emptyTelemetryTally> & { storyCount: number }>}
 */
export async function gatherRunTelemetry(storyIds, config, { readFn } = {}) {
  const tallies = [];
  for (const raw of Array.isArray(storyIds) ? storyIds : []) {
    const storyId = Number(raw);
    if (!Number.isInteger(storyId) || storyId <= 0) continue;
    tallies.push(await readStoryTally({ storyId, config, readFn }));
  }
  return { ...mergeTelemetryTallies(tallies), storyCount: tallies.length };
}

/**
 * @param {unknown} raw
 * @returns {number|null}
 */
export function resolveWorkerTokens(raw) {
  const { tokens, warning } = parseWorkerTokens(raw);
  if (warning) Logger.warn(`[single-story-close] ${warning}`);
  return tokens;
}

/**
 * The retry goes first so the summary counts it; a failure leaves
 * `telemetry: null` and the close's status untouched.
 *
 * @param {{ terminal: object, result?: object|null, config?: object,
 *   workerTokens?: number|null, readFn?: typeof forEachLine }} args
 * @returns {Promise<void>}
 */
export async function recordCloseTelemetry({
  terminal,
  result,
  config,
  workerTokens = null,
  readFn,
}) {
  await emitCloseRetrySignal({ envelope: terminal, config });
  if (!result) return;
  try {
    result.telemetry = await buildCloseTelemetry({
      storyId: result.storyId,
      config,
      workerTokens,
      landed: terminal?.status === 'landed',
      readFn,
    });
  } catch (err) {
    Logger.warn(
      `[single-story-close] telemetry summary unavailable: ${err?.message ?? err}`,
    );
    result.telemetry = null;
  }
}
