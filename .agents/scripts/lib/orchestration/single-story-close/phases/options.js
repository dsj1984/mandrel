/**
 * phases/options.js — CLI / injection option parsing for
 * `single-story-close`.
 *
 * Handles the conditional param-vs-CLI branch and all flag defaults in one
 * place so the main `runSingleStoryClose` body stays focused on close
 * pipeline logic. Each `??` operator counts as a branch in escomplex; the
 * `resolveFlag` helper keeps the cyclomatic complexity tally bounded.
 */

import path from 'node:path';
import { parseSprintArgs } from '../../../cli-args.js';
import { PROJECT_ROOT } from '../../../project-root.js';

/**
 * Resolve a flag value from an explicit override, a parsed CLI arg, or a
 * hard default.
 *
 * @template T
 * @param {T|undefined} paramValue
 * @param {T|undefined} parsedValue
 * @param {T} defaultValue
 * @returns {T}
 */
function resolveFlag(paramValue, parsedValue, defaultValue) {
  return paramValue ?? parsedValue ?? defaultValue;
}

/**
 * Parse and resolve all CLI / injection options for `runSingleStoryClose`.
 *
 * @param {{ storyIdParam, cwdParam, skipValidationParam, skipSyncParam, noAutoMergeParam, noFullScopeCrapParam }} raw
 * @returns {{ storyId, cwd, skipValidation, skipSync, noAutoMerge, noFullScopeCrap }}
 */
export function parseCloseOptions({
  storyIdParam,
  cwdParam,
  skipValidationParam,
  skipSyncParam,
  noAutoMergeParam,
  noFullScopeCrapParam,
}) {
  const parsed =
    storyIdParam !== undefined
      ? {
          storyId: storyIdParam,
          cwd: cwdParam ?? null,
          skipValidation: !!skipValidationParam,
          skipSync: !!skipSyncParam,
          noAutoMerge: !!noAutoMergeParam,
          noFullScopeCrap: !!noFullScopeCrapParam,
        }
      : parseSprintArgs();
  return {
    storyId: parsed.storyId,
    cwd: path.resolve(cwdParam ?? parsed.cwd ?? PROJECT_ROOT),
    skipValidation: resolveFlag(
      skipValidationParam,
      parsed.skipValidation,
      false,
    ),
    skipSync: resolveFlag(skipSyncParam, parsed.skipSync, false),
    noAutoMerge: resolveFlag(noAutoMergeParam, parsed.noAutoMerge, false),
    noFullScopeCrap: resolveFlag(
      noFullScopeCrapParam,
      parsed.noFullScopeCrap,
      false,
    ),
  };
}
