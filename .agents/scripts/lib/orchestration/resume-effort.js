/**
 * Per-call story-worker effort for a resumed blocked Story, from its local
 * signals only.
 *
 * @module lib/orchestration/resume-effort
 */

import { getDeliveryRouting } from '../config/delivery-routing.js';
import { Logger } from '../Logger.js';
import { RUNTIME_FRICTION_CATEGORIES } from '../observability/runtime-friction.js';
import { forEachLine } from '../observability/signals-writer.js';
import { EVENT_KINDS } from '../signals/schema.js';

const AGENT_EFFORT_LEVELS = Object.freeze([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/**
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
 * @param {unknown} record
 * @returns {boolean}
 */
function isPriorBlockRecord(record) {
  return (
    record !== null &&
    typeof record === 'object' &&
    record.kind === EVENT_KINDS.FRICTION &&
    record.category === RUNTIME_FRICTION_CATEGORIES.STORY_BLOCKED &&
    record.details?.recovered !== true
  );
}

/**
 * The ladder's single source; absolute, not relative to session effort.
 *
 * @param {number} priorBlocks
 * @returns {'high'|'xhigh'|null}
 */
function resumeEffortFor(priorBlocks) {
  if (priorBlocks < 1) return null;
  return priorBlocks === 1 ? 'high' : 'xhigh';
}

/**
 * @param {number} storyId
 * @param {{ config?: object, readFn?: typeof forEachLine }} [opts]
 * @returns {Promise<number>}
 */
async function countPriorBlocks(
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
