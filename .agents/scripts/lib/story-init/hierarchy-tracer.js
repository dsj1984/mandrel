import { Logger } from '../Logger.js';
/**
 * hierarchy-tracer.js — Stage 2 of the story-init pipeline.
 *
 * Given an epicId, resolves the linked PRD and Tech Spec issue IDs by
 * fetching the Epic. Fetch failures are logged but non-fatal — the result
 * simply reports `null` for whichever linkage could not be resolved, which
 * mirrors legacy behaviour in story-init.js.
 */

/**
 * @param {object} deps
 * @param {object} deps.provider
 * @param {object} [deps.logger]
 * @param {object} deps.input
 * @param {number} deps.input.epicId
 * @returns {Promise<{ prdId: number|null, techSpecId: number|null }>}
 */
export async function traceHierarchy({ provider, logger, input }) {
  const { epicId } = input;
  const warn = logger?.warn ?? ((msg) => Logger.error(msg));

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
