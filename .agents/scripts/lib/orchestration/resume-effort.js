/**
 * Per-call effort for a resumed blocked Story. A Story that blocked before
 * gets more effort on its own story-worker spawn, so the operator need not
 * raise session effort (and rebuild the session's prompt cache) to resume it.
 *
 * Prior blocks are read from the Story's LOCAL signals stream only: a Story
 * blocked on another machine resumes at session effort, exactly as before.
 *
 * @module lib/orchestration/resume-effort
 */

import { getDeliveryRouting } from '../config/delivery-routing.js';
import { Logger } from '../Logger.js';
import { RUNTIME_FRICTION_CATEGORIES } from '../observability/runtime-friction.js';
import { forEachLine } from '../observability/signals-writer.js';
import { EVENT_KINDS } from '../signals/schema.js';

/** The Agent tool's per-call `effort` enum, lowest to highest. */
export const AGENT_EFFORT_LEVELS = Object.freeze([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/**
 * `--worker-effort` validation. Best-effort, like `--worker-model`: absence
 * is the normal case (a fresh Story or an inline close) and carries no
 * warning; a value outside the enum records null with one.
 *
 * @param {unknown} value
 * @returns {{ effort: string|null, warning: string|null }}
 */
export function parseWorkerEffort(value) {
  if (value == null) return { effort: null, warning: null };
  const raw = String(value).trim();
  if (AGENT_EFFORT_LEVELS.includes(raw)) {
    return { effort: raw, warning: null };
  }
  return {
    effort: null,
    warning: `--worker-effort must be one of ${AGENT_EFFORT_LEVELS.join('|')} (got ${JSON.stringify(value)}); telemetry.workerEffort records null.`,
  };
}

/**
 * Every entry to `agent::blocked` writes one `story-blocked` friction record;
 * leaving it writes a `recovered: true` twin, which is not a block.
 *
 * @param {unknown} record
 * @returns {boolean}
 */
export function isPriorBlockRecord(record) {
  return (
    record !== null &&
    typeof record === 'object' &&
    record.kind === EVENT_KINDS.FRICTION &&
    record.category === RUNTIME_FRICTION_CATEGORIES.STORY_BLOCKED &&
    record.details?.recovered !== true
  );
}

/**
 * The effort ladder — the single source. Absolute, not relative to session
 * effort (a script cannot read the session's): 0 prior blocks → `null` (no
 * per-call effort; the worker inherits the session), 1 → `high`, ≥2 → `xhigh`.
 *
 * @param {unknown} priorBlocks
 * @returns {'high'|'xhigh'|null}
 */
export function resumeEffortFor(priorBlocks) {
  const n = Number(priorBlocks);
  if (!Number.isInteger(n) || n < 1) return null;
  return n === 1 ? 'high' : 'xhigh';
}

/**
 * Count the Story's un-recovered `story-blocked` records, addressed exactly as
 * the emitter writes them (standalone: `epicId` null). A missing or unreadable
 * stream counts 0.
 *
 * @param {number} storyId
 * @param {{ config?: object, readFn?: typeof forEachLine }} [opts]
 * @returns {Promise<number>}
 */
export async function countPriorBlocks(
  storyId,
  { config, readFn = forEachLine } = {},
) {
  let count = 0;
  try {
    await readFn(
      null,
      storyId,
      (record) => {
        if (isPriorBlockRecord(record)) count += 1;
      },
      config,
    );
  } catch (err) {
    Logger.warn(
      `[resume-effort] signal read failed for Story #${storyId}: ${
        err instanceof Error ? err.message : String(err)
      } — counting 0 prior blocks.`,
    );
    return 0;
  }
  return count;
}

/**
 * @param {number} storyId
 * @param {{ config?: object, readFn?: typeof forEachLine }} [opts]
 * @returns {Promise<'high'|'xhigh'|null>}
 */
export async function resolveResumeEffort(storyId, opts) {
  return resumeEffortFor(await countPriorBlocks(storyId, opts));
}

/**
 * The resume inputs `resolveStoryDispatchMode` needs for a resolved run. Only
 * a one-Story run reads prior blocks — the count can change its dispatch mode,
 * and a multi-Story run is a sub-agent dispatch regardless.
 *
 * @param {Array<{ id: number }>} stories
 * @param {{ config?: object, countFn?: typeof countPriorBlocks }} [opts]
 * @returns {Promise<{ priorBlocksById: Map<number, number>,
 *   roleScopedAgents: boolean }>}
 */
export async function resolveRunDispatchInputs(
  stories,
  { config, countFn = countPriorBlocks } = {},
) {
  const priorBlocksById = new Map();
  if (stories.length === 1) {
    const [{ id }] = stories;
    priorBlocksById.set(id, await countFn(id, { config }));
  }
  return {
    priorBlocksById,
    roleScopedAgents: getDeliveryRouting(config).roleScopedAgents,
  };
}
