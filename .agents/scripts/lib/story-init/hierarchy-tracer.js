import { Logger } from '../Logger.js';
/**
 * hierarchy-tracer.js — Stage 2 of the story-init pipeline.
 *
 * Resolves the linked Tech Spec issue ID for a Story's parent Epic.
 *
 * Story #4253: when `techSpecId` is supplied as input (the `/deliver` fan-out
 * resolves the immutable Epic once at the top of the run and threads the id
 * down via `story-init.js --tech-spec`), this stage short-circuits and does
 * NOT call `provider.getEpic`. The Epic issue is invariant for the lifetime of
 * a delivery run, so the N per-Story `getEpic` round-trips collapse to one
 * parent-side resolution.
 *
 * When the flag is absent (interactive / single-story use), the legacy
 * `getEpic` resolution runs unchanged. Fetch failures are logged but
 * non-fatal — the result reports `null` when the linkage could not be
 * resolved, preserving the graceful degradation on a missing Epic.
 *
 * Story #4314: the PRD artifact class is retired, so only the Tech Spec is
 * traced and threaded.
 */

/**
 * @param {object} deps
 * @param {object} deps.provider
 * @param {object} [deps.logger]
 * @param {object} deps.input
 * @param {number} deps.input.epicId
 * @param {number|null} [deps.input.techSpecId] Pre-resolved Tech Spec id
 *   (from --tech-spec). When supplied, `getEpic` is skipped.
 * @returns {Promise<{ techSpecId: number|null }>}
 */
export async function traceHierarchy({ provider, logger, input }) {
  const { epicId } = input;
  const warn = logger?.warn ?? ((msg) => Logger.error(msg));

  // Short-circuit: the parent already resolved the linkage once and threaded
  // it in, so there is nothing left to fetch. Skip the per-Story getEpic.
  const suppliedTechSpecId = input.techSpecId ?? null;
  if (suppliedTechSpecId !== null) {
    return { techSpecId: suppliedTechSpecId };
  }

  let techSpecId = null;
  try {
    const epic = await provider.getEpic(epicId);
    techSpecId = epic.linkedIssues?.techSpec ?? null;
  } catch (err) {
    warn(
      `[story-init] Warning: Could not fetch Epic #${epicId}: ${err.message}`,
    );
  }

  return { techSpecId };
}
