/**
 * lib/orchestration/light-backstop.js — the light path's diff backstop: the
 * actual diff, not the prompt, is the real scope signal. Files come from the
 * canonical `computeChangeSet`, line counts from numstat; both read committed
 * state, so an empty diff is disambiguated by `hasUncommittedWork`.
 *
 * @module lib/orchestration/light-backstop
 */

import { gitSpawn } from '../git-utils.js';
import { computeChangeSet } from './change-set.js';
import { readNumstatRows, summarizeDiffMagnitude } from './diff-magnitude.js';
import {
  handleBlockedBackstop,
  preserveRefusedWork,
} from './light-escalation.js';
import {
  checkLightDiffBackstop,
  LIGHT_REFUSAL_CLASSES,
} from './light-suitability.js';
import { hasUncommittedWork } from './worktree-dirty.js';

/** Exit code when the diff backstop blocked the land. */
const EXIT_BACKSTOP_BLOCKED = 3;

/**
 * @param {{
 *   storyId: number,
 *   baseRef?: string,
 *   cwd?: string,
 *   computeFn?: typeof computeChangeSet,
 *   readRowsFn?: typeof readNumstatRows,
 *   dirtyProbeFn?: typeof hasUncommittedWork,
 *   gitFn?: typeof gitSpawn,
 *   injectedRules?: object,
 * }} args
 * @returns {ReturnType<typeof checkLightDiffBackstop>}
 */
function runDiffBackstop({
  storyId,
  baseRef = 'main',
  cwd = process.cwd(),
  computeFn = computeChangeSet,
  readRowsFn = readNumstatRows,
  dirtyProbeFn = hasUncommittedWork,
  gitFn = gitSpawn,
  injectedRules,
} = {}) {
  const headRef = `story-${storyId}`;
  const { files } = computeFn({ baseRef, headRef, cwd });
  const rows = readRowsFn({ baseRef, headRef, cwd });
  const magnitude = summarizeDiffMagnitude({ changedFiles: files, rows });
  return checkLightDiffBackstop({
    changedFiles: files,
    magnitude,
    injectedRules,
    storyBranch: headRef,
    // Only an enumerated-empty diff can be explained by uncommitted work.
    uncommittedWork:
      Array.isArray(files) && files.length === 0
        ? dirtyProbeFn({ branch: headRef, cwd, gitFn })
        : false,
  });
}

/**
 * @param {{ refusalClass?: string|null }} result
 * @returns {boolean}
 */
function isUncommittedRefusal(result) {
  return result.refusalClass === LIGHT_REFUSAL_CLASSES.UNCOMMITTED_WORK;
}

/**
 * `null` preservation means the uncommitted-work refusal, which never pushes
 * (it would falsely report uncommitted work as safe on `origin`).
 *
 * @param {{
 *   storyId: number,
 *   preservation: { detail: string }|null,
 *   nextCommand: string,
 * }} args
 * @returns {string}
 */
function describeBlockedTail({ storyId, preservation, nextCommand }) {
  return preservation === null
    ? `nothing is committed yet, so there is no work to preserve; ` +
        `commit on story-${storyId}, then re-run: "${nextCommand}"`
    : `${preservation.detail}; recycle the receipt with "${nextCommand}"`;
}

/**
 * Resolve the backstop into verdict, next command, exit code and log line.
 * A scope refusal first preserves the finished work on `origin`;
 * a failed push degrades the message, never the verdict.
 *
 * @param {{
 *   storyId: number,
 *   runFn?: typeof runDiffBackstop,
 *   handleBlockedFn?: typeof handleBlockedBackstop,
 *   preserveFn?: typeof preserveRefusedWork,
 * }} args Further keys forward to the backstop run.
 * @returns {Promise<{
 *   result: ReturnType<typeof checkLightDiffBackstop>,
 *   nextCommand: string|null,
 *   preservation: ReturnType<typeof preserveRefusedWork>|null,
 *   exitCode: number,
 *   message: string,
 * }>}
 */
export async function resolveBackstopOutcome({
  storyId,
  runFn = runDiffBackstop,
  handleBlockedFn = handleBlockedBackstop,
  preserveFn = preserveRefusedWork,
  ...seams
} = {}) {
  const result = runFn({ storyId, ...seams });
  if (!result.blocked) {
    return {
      result,
      nextCommand: null,
      preservation: null,
      exitCode: 0,
      message: `[deliver-light] diff backstop clean for Story #${storyId}.`,
    };
  }
  const preservation = isUncommittedRefusal(result)
    ? null
    : preserveFn({ storyId, cwd: seams.cwd });
  const nextCommand = await handleBlockedFn({ storyId, result, preservation });
  return {
    result,
    nextCommand,
    preservation,
    exitCode: EXIT_BACKSTOP_BLOCKED,
    message:
      `[deliver-light] diff backstop BLOCKED Story #${storyId}: ` +
      `${result.reasons.join('; ')} — ` +
      describeBlockedTail({ storyId, preservation, nextCommand }),
  };
}
