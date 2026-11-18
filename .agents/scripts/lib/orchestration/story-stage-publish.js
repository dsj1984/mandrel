/**
 * The delivery stage a Story has reached, published as one `delivery-stage`
 * structured comment on the Story issue so a tool on another machine can show
 * progress for a run it cannot see locally.
 *
 * Advisory only, like the local story-progress record: nothing decides on
 * it, one attempt with no retry, and any failure is logged at debug and
 * swallowed, so no delivery result changes because of it.
 */

import { Logger } from '../Logger.js';
import { findStructuredComment } from './ticketing/reads.js';
import { upsertStructuredComment } from './ticketing/state.js';

const DELIVERY_STAGE_TYPE = 'delivery-stage';
const DELIVERY_STAGES = Object.freeze([
  'build',
  'check',
  'handoff',
  'close',
  'merge',
]);

const RECORD_RE = /```json\n(\{[^\n]*"kind":"delivery-stage"[^\n]*\})\n```/;

/**
 * The comment body: a one-line summary, then the machine block.
 *
 * @param {{ storyId: number, stage: string, prNumber: number|null, updatedAt: string }} record
 * @returns {string}
 */
function formatDeliveryStageBody({ storyId, stage, prNumber, updatedAt }) {
  const record = {
    kind: DELIVERY_STAGE_TYPE,
    storyId,
    stage,
    prNumber,
    updatedAt,
  };
  return `Delivery stage: **${stage}** (Story #${storyId}).\n\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\``;
}

/**
 * The stage record a comment body carries, or `null` for any other comment.
 * Exported for readers that list an issue's comments.
 *
 * @public
 * @param {unknown} body
 * @returns {{ kind: 'delivery-stage', storyId: number, stage: string, prNumber: number|null, updatedAt: string }|null}
 */
export function parseDeliveryStage(body) {
  const match = typeof body === 'string' ? RECORD_RE.exec(body) : null;
  if (!match) return null;
  let record;
  try {
    record = JSON.parse(match[1]);
  } catch {
    return null;
  }
  const { storyId, stage, prNumber, updatedAt } = record;
  const valid =
    Number.isInteger(storyId) &&
    DELIVERY_STAGES.includes(stage) &&
    (prNumber === null || Number.isInteger(prNumber)) &&
    typeof updatedAt === 'string';
  return valid
    ? { kind: DELIVERY_STAGE_TYPE, storyId, stage, prNumber, updatedAt }
    : null;
}

/**
 * Publish `stage` for `storyId`, skipping the write when the comment already
 * names it. Never throws.
 *
 * @param {{ storyId: number, stage: string, prNumber?: number|null,
 *   provider: object|(() => object)|null|undefined, now?: () => Date,
 *   debug?: (msg: string) => void }} args `provider` may be a thunk so a
 *   provider that fails to build is swallowed too; a missing one skips.
 * @returns {Promise<'published'|'unchanged'|'skipped'>}
 */
export async function publishDeliveryStage({
  storyId,
  stage,
  prNumber = null,
  provider,
  now = () => new Date(),
  debug = (msg) => Logger.debug(msg),
}) {
  try {
    const resolved = typeof provider === 'function' ? provider() : provider;
    if (!resolved) return 'skipped';
    const existing = await findStructuredComment(
      resolved,
      storyId,
      DELIVERY_STAGE_TYPE,
    );
    if (parseDeliveryStage(existing?.body)?.stage === stage) return 'unchanged';
    const body = formatDeliveryStageBody({
      storyId,
      stage,
      prNumber: Number.isInteger(prNumber) && prNumber > 0 ? prNumber : null,
      updatedAt: now().toISOString(),
    });
    await upsertStructuredComment(resolved, storyId, DELIVERY_STAGE_TYPE, body);
    return 'published';
  } catch (err) {
    debug(
      `[story-stage] ${stage} not published for Story #${storyId}: ${err?.message ?? err}`,
    );
    return 'skipped';
  }
}

/**
 * A pipeline phase `(ctx, deps)` that publishes `stage` and never ends the run.
 *
 * @param {string} stage
 * @returns {(ctx: { storyId: number }, deps: { provider: object }) => Promise<null>}
 */
export function publishStagePhase(stage) {
  return async (ctx, deps) => {
    await publishDeliveryStage({
      provider: deps.provider,
      storyId: ctx.storyId,
      stage,
    });
    return null;
  };
}
