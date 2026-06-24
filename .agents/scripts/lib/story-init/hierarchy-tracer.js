import { Logger } from '../Logger.js';
/**
 * hierarchy-tracer.js — Stage 2 of the story-init pipeline.
 *
 * Resolves the linked PRD and Tech Spec issue IDs for a Story's parent Epic.
 *
 * Story #4253: when both `prdId` and `techSpecId` are supplied as input
 * (the `/deliver` fan-out resolves the immutable Epic once at the top of the
 * run and threads the two ids down via `story-init.js --prd/--tech-spec`),
 * this stage short-circuits and does NOT call `provider.getEpic`. The Epic
 * issue is invariant for the lifetime of a delivery run, so the N per-Story
 * `getEpic` round-trips collapse to one parent-side resolution.
 *
 * When the flags are absent (interactive / single-story use), the legacy
 * `getEpic` resolution runs unchanged. Fetch failures are logged but
 * non-fatal — the result simply reports `null` for whichever linkage could
 * not be resolved, preserving the graceful degradation on a missing Epic.
 */

/**
 * @param {object} deps
 * @param {object} deps.provider
 * @param {object} [deps.logger]
 * @param {object} deps.input
 * @param {number} deps.input.epicId
 * @param {number|null} [deps.input.prdId] Pre-resolved PRD id (from --prd).
 * @param {number|null} [deps.input.techSpecId] Pre-resolved Tech Spec id
 *   (from --tech-spec). When both `prdId` and `techSpecId` are supplied,
 *   `getEpic` is skipped.
 * @returns {Promise<{ prdId: number|null, techSpecId: number|null }>}
 */
export async function traceHierarchy({ provider, logger, input }) {
  const { epicId } = input;
  const warn = logger?.warn ?? ((msg) => Logger.error(msg));

  // Short-circuit: the parent already resolved both linkages once and threaded
  // them in, so there is nothing left to fetch. Skip the per-Story getEpic.
  const suppliedPrdId = input.prdId ?? null;
  const suppliedTechSpecId = input.techSpecId ?? null;
  if (suppliedPrdId !== null && suppliedTechSpecId !== null) {
    return { prdId: suppliedPrdId, techSpecId: suppliedTechSpecId };
  }

  let prdId = null;
  let techSpecId = null;
  try {
    const epic = await provider.getEpic(epicId);
    prdId = epic.linkedIssues?.prd ?? null;
    techSpecId = epic.linkedIssues?.techSpec ?? null;
  } catch (err) {
    warn(
      `[story-init] Warning: Could not fetch Epic #${epicId}: ${err.message}`,
    );
  }

  return { prdId, techSpecId };
}
