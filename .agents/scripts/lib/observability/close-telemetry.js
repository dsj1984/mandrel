/**
 * close-telemetry.js — what a Story actually cost, from what close can see
 * deterministically: one `retry` signal per non-landed close (with its
 * cause), code-review halts and overrides attributed to the review provider
 * that raised the critical findings, acceptance rounds, and the one
 * host-supplied number (the story-worker's token total).
 *
 * Everything here is best-effort: a failed write or read is a missing
 * metric, never a failed or blocked close. Summaries stay local (ADR
 * 20260828-5077c) — nothing here posts to a ticket or PR.
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

/** The documented `retry` causes; anything unclassified is `other`. */
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
 * The retry cause a terminal envelope implies, or `null` when the close did
 * not end in a retry (landed, pending, or no envelope).
 *
 * @param {object|null|undefined} envelope A `story-deliver-terminal` envelope.
 * @returns {string|null}
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
 * Append exactly one `retry` signal for a non-landed close. Never throws.
 *
 * @param {{ envelope: object, config?: object, appendFn?: typeof appendSignal }} args
 * @returns {Promise<boolean>} true when a record was appended.
 */
export async function emitCloseRetrySignal({
  envelope,
  config,
  appendFn = appendSignal,
} = {}) {
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
  try {
    return (await appendFn({ epicId: null, storyId, signal, config })) === true;
  } catch (err) {
    Logger.warn(
      `[close-telemetry] retry signal append failed for Story #${storyId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/**
 * Every signal a terminal envelope implies — the `retry` record, then the
 * terminal friction — for an entry point that emits both. Never throws.
 *
 * @param {{ envelope: object, config?: object }} args
 * @returns {Promise<void>}
 */
export async function emitCloseTerminalSignals({ envelope, config } = {}) {
  await emitCloseRetrySignal({ envelope, config });
  await emitTerminalFriction({ envelope, config });
}

/**
 * A critical code-review halt, attributed to each review provider that
 * raised a critical finding. Never throws (a missing metric, not a crash).
 *
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
 * Per-provider critical counts, keeping only providers that contributed.
 *
 * @param {unknown} value
 * @returns {Record<string, number>}
 */
function normalizeCriticalByProvider(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [name, count] of Object.entries(value)) {
    if (Number.isInteger(count) && count > 0) out[name] = count;
  }
  return out;
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

/**
 * An empty tally; the shape both the close result and the epilogue report.
 *
 * @returns {{ acceptanceRounds: number, retries: { total: number, byCause: Record<string, number> }, review: { haltsByProvider: Record<string, number>, overridesByProvider: Record<string, number> } }}
 */
function emptyTelemetryTally() {
  return {
    acceptanceRounds: 0,
    retries: { total: 0, byCause: {} },
    review: { haltsByProvider: {}, overridesByProvider: {} },
  };
}

/**
 * Providers named on a review friction row — one halt/override per provider
 * that raised a critical finding, not one per finding.
 *
 * @param {object} details
 * @returns {Record<string, number>}
 */
function providerIncidents(details) {
  const out = {};
  for (const name of Object.keys(
    normalizeCriticalByProvider(details?.criticalByProvider),
  )) {
    out[name] = 1;
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
 * Fold one Story's raw signal rows into a tally. Pure.
 *
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
 * Sum per-Story tallies into a run-level one (acceptance rounds add up
 * across Stories). Pure.
 *
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
 * A halt the operator did not override, on a Story that then landed, is a
 * confirmed halt; anything short of a land stays unconfirmed.
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
 * Read one Story's signal stream into a tally. A read failure yields the
 * empty tally, never a throw.
 *
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
 * The `telemetry` object close's result carries. Never throws.
 *
 * @param {{ storyId: number, config?: object, workerTokens?: number|null,
 *   landed?: boolean, readFn?: typeof forEachLine }} args
 * @returns {Promise<object>}
 */
export async function buildCloseTelemetry({
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
 * Run-level tallies over the run's own Stories (not the recurrence window).
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
 * The `--worker-tokens` value as a number, or `null` — logging the warning
 * an absent or invalid value carries. Never throws.
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
export function resolveWorkerTokens(raw) {
  const { tokens, warning } = parseWorkerTokens(raw);
  if (warning) Logger.warn(`[single-story-close] ${warning}`);
  return tokens;
}

/**
 * Close's terminal telemetry: the `retry` record a non-landed ending implies
 * (appended first, so the summary counts this run's own retry), then the
 * `telemetry` object on `result`. A failure is a missing metric — `result`
 * carries `telemetry: null` and the close's status is untouched.
 *
 * @param {{ terminal: object, result?: object|null, config?: object,
 *   workerTokens?: number|null }} args
 * @returns {Promise<void>}
 */
export async function recordCloseTelemetry({
  terminal,
  result,
  config,
  workerTokens = null,
}) {
  await emitCloseRetrySignal({ envelope: terminal, config });
  if (!result) return;
  try {
    result.telemetry = await buildCloseTelemetry({
      storyId: result.storyId,
      config,
      workerTokens,
      landed: terminal?.status === 'landed',
    });
  } catch (err) {
    Logger.warn(
      `[single-story-close] telemetry summary unavailable: ${err?.message ?? err}`,
    );
    result.telemetry = null;
  }
}
