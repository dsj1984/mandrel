import { parseFencedJsonComment } from './structured-comment-parser.js';
import { findStructuredComment } from './ticketing.js';

/**
 * Read the v2 Story planning checkpoint. Missing/malformed comments degrade
 * to null so unplanned Stories still receive the neutral review posture.
 */
export async function readStoryPlanState({
  provider,
  storyId,
  findCommentFn = findStructuredComment,
}) {
  const comment = await findCommentFn(
    provider,
    Number(storyId),
    'story-plan-state',
  );
  const state = parseFencedJsonComment(comment);
  return state && typeof state === 'object' ? state : null;
}

export async function readStoryPlanningRisk(args) {
  const state = await readStoryPlanState(args);
  return state?.planningRisk ?? null;
}

export async function readStoryPlanningRiskSafe(args) {
  try {
    return await readStoryPlanningRisk(args);
  } catch {
    return null;
  }
}

/**
 * Prefer an explicit `planningRisk` override; otherwise load the Story
 * checkpoint. Callers that omit the field (or pass `undefined`) get the
 * persisted plan risk; callers that pass `null` keep the neutral posture.
 */
export async function resolveStoryPlanningRisk({
  provider,
  storyId,
  planningRisk,
  findCommentFn,
}) {
  if (planningRisk !== undefined) return planningRisk;
  return readStoryPlanningRiskSafe({ provider, storyId, findCommentFn });
}
