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

const HISTORY_LIMIT = 10;

/** The comment body: a one-line summary, then the machine block. */
function formatDeliveryStageBody(fields) {
  const record = { kind: DELIVERY_STAGE_TYPE, ...fields };
  return `Delivery stage: **${fields.stage}** (Story #${fields.storyId}).\n\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\``;
}

const isEntry = (e) =>
  DELIVERY_STAGES.includes(e?.stage) && typeof e?.at === 'string';

const historyOf = (raw) =>
  (Array.isArray(raw) ? raw : [])
    .filter(isEntry)
    .map((e) => ({ stage: e.stage, at: e.at }));

/** The entries before `stage`, seeded from a pre-history record's own stage. */
function priorHistory(previous) {
  if (!previous) return [];
  if (previous.history.length > 0) return previous.history;
  return [{ stage: previous.stage, at: previous.updatedAt }];
}

/**
 * The stage record a comment body carries, or `null` for any other comment.
 * Exported for readers that list an issue's comments.
 *
 * @public
 * @param {unknown} body
 * @returns {object|null} The record; `history` is `[]` on an older one.
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
    ? {
        kind: DELIVERY_STAGE_TYPE,
        storyId,
        stage,
        prNumber,
        updatedAt,
        history: historyOf(record.history),
      }
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
    const previous = parseDeliveryStage(existing?.body);
    if (previous?.stage === stage) return 'unchanged';
    const updatedAt = now().toISOString();
    const body = formatDeliveryStageBody({
      storyId,
      stage,
      prNumber: Number.isInteger(prNumber) && prNumber > 0 ? prNumber : null,
      updatedAt,
      history: [...priorHistory(previous), { stage, at: updatedAt }].slice(
        -HISTORY_LIMIT,
      ),
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
