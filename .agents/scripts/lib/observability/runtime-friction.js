/**
 * runtime-friction.js — emit friction signals from what the runtime already
 * knows. Not via `gates/friction.js`, which drops records without an
 * `epicId` (every v2 Story has none). Best-effort: failures log and resolve
 * `false`.
 *
 * @module lib/observability/runtime-friction
 */

import crypto from 'node:crypto';

import { Logger } from '../Logger.js';
import { appendSignal, forEachLine } from './signals-writer.js';

/**
 * The retro aggregates by exact category string, so each is one coarse
 * bucket per failure mode.
 */
export const RUNTIME_FRICTION_CATEGORIES = Object.freeze({
  STORY_BLOCKED: 'story-blocked',
  CLOSE_FAILED: 'close-failed',
  MERGE_WAIT_EXHAUSTED: 'merge-wait-exhausted',
  /** A tool failed to execute — kept out of code-finding severity tiers. */
  TOOL_DEGRADED: 'tool-degraded',
  LIGHT_SCOPE_REJECTED: 'light-scope-rejected',
  /** A human shipped over a review blocker; a rising count means miscalibration. */
  REVIEW_BLOCK_OVERRIDDEN: 'review-block-overridden',
});

/**
 * The refusal class rides in the category because aggregation, graduator
 * idempotency and the `friction::*` label all key on it; a class-less
 * refusal keeps the bare category.
 *
 * @param {string|null} [refusalClass] A
 *   {@link module:lib/orchestration/light-suitability.LIGHT_REFUSAL_CLASSES}
 *   value, or nullish for the unclassified refusal.
 * @returns {string}
 */
export function lightScopeRejectedCategory(refusalClass) {
  const suffix = typeof refusalClass === 'string' ? refusalClass.trim() : '';
  const base = RUNTIME_FRICTION_CATEGORIES.LIGHT_SCOPE_REJECTED;
  return suffix === '' ? base : `${base}-${suffix}`;
}

/** Cap on free-form reason text copied into a signal's `details`. */
const REASON_PREVIEW_LIMIT = 500;

/**
 * @param {unknown} value
 * @returns {string}
 */
function preview(value) {
  return String(value ?? '').slice(0, REASON_PREVIEW_LIMIT);
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function positiveIntOrNull(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Append one `friction` record. Never throws.
 *
 * @param {object} args
 * @param {number} args.storyId
 * @param {number|null} [args.epicId]
 * @param {string} args.category
 * @param {string} args.tool
 * @param {object} [args.details]
 * @param {object} [args.config]
 * @returns {Promise<boolean>} true when a record was appended.
 */
export async function emitRuntimeFriction({
  storyId,
  epicId = null,
  category,
  tool,
  details = {},
  config,
} = {}) {
  const sid = positiveIntOrNull(storyId);
  if (sid === null) {
    return false;
  }
  if (typeof category !== 'string' || category.trim() === '') {
    Logger.warn('[runtime-friction] refusing to emit a category-less signal');
    return false;
  }

  const signal = {
    kind: 'friction',
    eventId: crypto.randomUUID(),
    ts: new Date().toISOString(),
    epicId: positiveIntOrNull(epicId),
    storyId: sid,
    taskId: null,
    category: category.trim(),
    emitter: { tool: tool || 'runtime-friction' },
    details: details && typeof details === 'object' ? details : {},
  };

  try {
    return await appendSignal({
      epicId: signal.epicId,
      storyId: sid,
      signal,
      config,
    });
  } catch (err) {
    Logger.warn(
      `[runtime-friction] append failed for Story #${sid} (${category}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/**
 * A `recovered: true` `story-blocked` record on leaving `agent::blocked`, so
 * the retro nets the block out (same category, or it would aggregate itself).
 *
 * @param {object} args
 * @param {number} args.storyId
 * @param {string} [args.fromState]
 * @param {string} [args.toState]
 * @param {object} [args.config]
 * @returns {Promise<boolean>} true when a record was appended.
 */
export async function emitBlockRecoveredFriction({
  storyId,
  fromState,
  toState,
  config,
} = {}) {
  return emitRuntimeFriction({
    storyId,
    category: RUNTIME_FRICTION_CATEGORIES.STORY_BLOCKED,
    tool: 'transitionTicketState',
    details: {
      recovered: true,
      fromState: fromState ?? null,
      toState: toState ?? null,
    },
    config,
  });
}

/**
 * On land, emit a `recovered: true` marker in `category` so the retro nets
 * the `(category, storyId)` incident out. Hung off `runPostLandTail` because
 * the `landed` envelope arrives after follow-ups are already filed. Only
 * emitted over an existing un-recovered record — otherwise it would suppress
 * a bucket the Story never hit. A read failure emits nothing.
 *
 * @param {object} args
 * @param {number} args.storyId
 * @param {string} args.category
 * @param {string} [args.tool]
 * @param {object} [args.config]
 * @returns {Promise<boolean>} true when a record was appended.
 */
export async function emitRecoveredFrictionMarker({
  storyId,
  category,
  tool,
  config,
} = {}) {
  const sid = positiveIntOrNull(storyId);
  if (sid === null) return false;
  if (typeof category !== 'string' || category.trim() === '') {
    Logger.warn(
      '[runtime-friction] refusing to emit a category-less recovery marker',
    );
    return false;
  }
  const cat = category.trim();

  let incident = false;
  let recovered = false;
  try {
    await forEachLine(
      null,
      sid,
      (parsed) => {
        if (!parsed || typeof parsed !== 'object') return;
        if (parsed.category !== cat) return;
        if (isRecoveredSignal(parsed)) recovered = true;
        else incident = true;
      },
      config,
    );
  } catch (err) {
    Logger.warn(
      `[runtime-friction] ${cat} recovery probe failed for Story #${sid}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
  if (!incident || recovered) return false;

  return emitRuntimeFriction({
    storyId: sid,
    category: cat,
    tool: tool || 'runPostLandTail',
    details: { recovered: true },
    config,
  });
}

/**
 * @param {object} args
 * @param {number} args.storyId
 * @param {object} [args.config]
 * @returns {Promise<boolean>} true when a record was appended.
 */
export async function emitCloseRecoveredFriction({ storyId, config } = {}) {
  return emitRecoveredFrictionMarker({
    storyId,
    category: RUNTIME_FRICTION_CATEGORIES.CLOSE_FAILED,
    config,
  });
}

/**
 * One raw row → the retro composer's shape (`null` without a category).
 * Shared by both gathers so they cannot drift; dropping `storyId`/`details`
 * silently breaks recovery netting. `tool` is descriptive, never a routing key.
 *
 * @param {unknown} parsed
 * @param {number}  fallbackStoryId Used when the row has no `storyId`.
 * @returns {{ category: string, source: 'framework'|'consumer', storyId: number, tool: string, ts: string|null, details: object }|null}
 */
export function normalizeGatheredSignal(parsed, fallbackStoryId) {
  if (!parsed || typeof parsed !== 'object') return null;
  const category =
    typeof parsed.category === 'string' ? parsed.category.trim() : '';
  if (!category) return null;
  const recordStoryId = Number(parsed.storyId);
  const emitterTool =
    parsed.emitter && typeof parsed.emitter === 'object'
      ? parsed.emitter.tool
      : undefined;
  return {
    category,
    source: parsed.source === 'framework' ? 'framework' : 'consumer',
    storyId: Number.isInteger(recordStoryId) ? recordStoryId : fallbackStoryId,
    tool: typeof emitterTool === 'string' ? emitterTool.trim() : '',
    ts: parsableTimestamp(parsed.ts),
    details:
      parsed.details && typeof parsed.details === 'object'
        ? parsed.details
        : {},
  };
}

/**
 * `null` for an unreadable `ts`, so the row is excluded from the recurrence
 * window rather than aged in as recent.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function parsableTimestamp(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return Number.isFinite(Date.parse(trimmed)) ? trimmed : null;
}

/**
 * Category-agnostic recovery-marker test; a marker only cancels its own
 * `(category, storyId)` bucket.
 *
 * @param {object} signal
 * @returns {boolean}
 */
export function isRecoveredSignal(signal) {
  return (
    signal !== null &&
    typeof signal === 'object' &&
    typeof signal.category === 'string' &&
    signal.category.trim() !== '' &&
    signal.details !== null &&
    typeof signal.details === 'object' &&
    signal.details.recovered === true
  );
}

/**
 * The friction a terminal envelope implies; each incident is emitted from one
 * place only. `blocked` → null (the transition mutator emits it); `failed` →
 * `close-failed`; `pending` → `merge-wait-exhausted` only when the cumulative
 * budget is provably spent — a routine window rollover or an operator-merge
 * `pending` (no `waitBudget`) emits nothing.
 *
 * @param {object} envelope A `story-deliver-terminal` envelope.
 * @returns {{ category: string, details: object }|null}
 */
function frictionForTerminal(envelope) {
  if (!envelope || typeof envelope !== 'object') return null;
  const { status, phase, waitBudget, failure, pr } = envelope;

  if (status === 'failed') {
    return {
      category: RUNTIME_FRICTION_CATEGORIES.CLOSE_FAILED,
      details: {
        phase: phase ?? null,
        reason: preview(failure?.reason),
      },
    };
  }

  if (status === 'pending' && waitBudget) {
    const cumulativeSeconds = Number(waitBudget.cumulativeSeconds);
    const maxBudgetSeconds = Number(waitBudget.maxBudgetSeconds);
    if (
      !Number.isFinite(cumulativeSeconds) ||
      !Number.isFinite(maxBudgetSeconds) ||
      cumulativeSeconds < maxBudgetSeconds
    ) {
      return null;
    }
    return {
      category: RUNTIME_FRICTION_CATEGORIES.MERGE_WAIT_EXHAUSTED,
      details: {
        phase: phase ?? null,
        prNumber: pr?.number ?? null,
        checksStatus: pr?.checksStatus ?? null,
        waitedSeconds: waitBudget.waitedSeconds ?? null,
        cumulativeSeconds: waitBudget.cumulativeSeconds ?? null,
        maxBudgetSeconds: waitBudget.maxBudgetSeconds ?? null,
      },
    };
  }

  return null;
}

/**
 * `tool` must be the calling CLI's name: two CLIs emit terminal envelopes and
 * the retro attributes by `emitter.tool`.
 *
 * @param {object} args
 * @param {object} args.envelope
 * @param {string} [args.tool]
 * @param {object} [args.config]
 * @returns {Promise<boolean>} true when a record was appended.
 */
export async function emitTerminalFriction({
  envelope,
  tool = 'single-story-close',
  config,
} = {}) {
  const verdict = frictionForTerminal(envelope);
  if (!verdict) return false;
  return emitRuntimeFriction({
    storyId: envelope?.storyId,
    category: verdict.category,
    tool,
    details: verdict.details,
    config,
  });
}
