/**
 * context-resolver.js — Stage 1 of the story-init pipeline.
 *
 * Fetches the Story ticket, validates it carries `type::story`, parses its
 * body for hierarchy markers, and (optionally) injects/validates the
 * `recut-of` marker when `input.recutOf` is supplied.
 *
 * Pure stage signature: ({ provider, git, fs, logger, input }) → result.
 * `git` and `fs` are accepted for signature conformance but unused here.
 */

import { TYPE_LABELS } from '../label-constants.js';
import { injectRecutMarker, parseRecutMarker } from '../orchestration/recut.js';
import { resolveStoryHierarchy } from '../story-lifecycle.js';

/**
 * @param {object} deps
 * @param {object} deps.provider  Ticketing provider (getTicket, updateTicket).
 * @param {object} [deps.logger]  `{ progress?: (phase, msg) => void }`.
 * @param {object} deps.input
 * @param {number} deps.input.storyId
 * @param {number|null} [deps.input.recutOf]
 * @param {boolean} [deps.input.dryRun]
 * @returns {Promise<{ story: object, body: string, epicId: number, parentId: number|null }>}
 */
export async function resolveContext({ provider, logger, input }) {
  const { storyId, recutOf = null, dryRun = false } = input;
  const progress = logger?.progress ?? (() => {});

  let story;
  try {
    story = await provider.getTicket(storyId);
  } catch (err) {
    throw new Error(`Failed to fetch Story #${storyId}: ${err.message}`, {
      cause: err,
    });
  }

  if (!story.labels.includes(TYPE_LABELS.STORY)) {
    throw new Error(
      `Issue #${storyId} is not a Story (labels: ${story.labels.join(', ')}). Use the dispatcher for Epics.`,
    );
  }

  let body = story.body ?? '';
  const { epicId, parentId } = resolveStoryHierarchy(body);

  if (!epicId) {
    throw new Error(
      `Story #${storyId} has no "Epic: #N" reference in its body. Cannot resolve hierarchy.`,
    );
  }

  if (recutOf) {
    if (recutOf === storyId) {
      throw new Error(
        `[story-init] --recut-of #${recutOf} cannot point at the Story itself.`,
      );
    }
    const existing = parseRecutMarker(body);
    if (existing && existing.parentStoryId !== recutOf) {
      progress(
        'RECUT',
        `⚠️ Story #${storyId} already marked recut-of #${existing.parentStoryId}; overwriting with #${recutOf}.`,
      );
    }
    if (!existing || existing.parentStoryId !== recutOf) {
      const patched = injectRecutMarker(body, recutOf);
      if (!dryRun) {
        await provider.updateTicket(storyId, { body: patched });
        progress(
          'RECUT',
          `🪪 Marked Story #${storyId} as recut-of #${recutOf} on the ticket body.`,
        );
      } else {
        progress(
          'RECUT',
          `[DRY-RUN] Would mark Story #${storyId} as recut-of #${recutOf}.`,
        );
      }
      body = patched;
      story = { ...story, body: patched };
    } else {
      progress(
        'RECUT',
        `Story #${storyId} already carries recut-of #${recutOf} marker.`,
      );
    }
  }

  return { story, body, epicId, parentId };
}
