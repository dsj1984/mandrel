/**
 * The one write-time checklist call both delivery paths make —
 * `single-story-init.js` (every path, a one-Story inline run included) and
 * `deliver-run.js` (the multi-Story dispatch prompt) — so both name the SAME
 * Story-scoped path under `<tempRoot>/standalone/stories/story-<id>/`.
 */

import { storyTempDir } from '../config/temp-paths.js';
import { parse as parseStoryBody } from '../story-body/story-body.js';
import { buildDispatchChecklist } from './dispatch-checklist.js';

/**
 * `changes[]` + `references[]` off the Story body; an unparseable body is an
 * empty footprint.
 *
 * @param {string} body
 * @returns {{ changes: unknown[], references: unknown[] }}
 */
function footprintOf(body) {
  try {
    // Path entries live on `.body`, not at the top level of the parse result.
    const { body: parsed } = parseStoryBody(body ?? '');
    return {
      changes: parsed?.changes ?? [],
      references: parsed?.references ?? [],
    };
  } catch {
    return { changes: [], references: [] };
  }
}

/**
 * Never throws: a builder failure costs the checklist (`checklistPath: null`),
 * never the caller.
 *
 * @param {object} args
 * @param {number} args.storyId
 * @param {string} [args.body]
 * @param {object} [args.config]
 * @param {(tag: string, msg: string) => void} [args.progress]
 * @param {typeof buildDispatchChecklist} [args.buildChecklistFn]
 * @returns {{ checklistPath: string|null }}
 */
export function buildStoryChecklist({
  storyId,
  body,
  config,
  progress = () => {},
  buildChecklistFn = buildDispatchChecklist,
}) {
  try {
    const { checklistPath } = buildChecklistFn({
      storyId,
      ...footprintOf(body),
      runTempDir: storyTempDir(null, storyId, config),
    });
    return { checklistPath: checklistPath ?? null };
  } catch (err) {
    progress(
      'CHECKLIST',
      `⚠ write-time checklist skipped: ${err?.message ?? err}`,
    );
    return { checklistPath: null };
  }
}
