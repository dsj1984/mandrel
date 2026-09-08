/**
 * lib/orchestration/light-backstop.js — the light path's diff-backstop pass
 * (Story #4856).
 *
 * The backstop is invariant 3 of the light path: after implementation the
 * **actual** change set is re-checked, because the diff — not the prompt — is
 * the real scope signal. This module owns that pass end to end so
 * `deliver-light.js` stays the thin CLI shell it claims to be: it reads the two
 * git surfaces, applies
 * {@link module:lib/orchestration/light-suitability.checkLightDiffBackstop},
 * and resolves what a refusal means.
 *
 * ## Two git surfaces, each used for what it reports reliably
 *
 *   - `--name-only`, via the one canonical `computeChangeSet` enumerator, gives
 *     the clean full file list. Sensitive-path derivation and
 *     implementation-file counting both read it, so the backstop and every
 *     other consumer are looking at the same change set.
 *   - `--numstat` gives per-file line counts, the only surface carrying them.
 *
 * Both read committed state, which is why a third read exists
 * ({@link module:lib/orchestration/worktree-dirty.hasUncommittedWork}): an
 * empty diff is ambiguous between "no work" and "work not committed yet", and
 * only one of those is about scope.
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
 * Run the diff backstop against a Story branch's actual change set.
 *
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
    // Only an ENUMERATED-empty diff can be explained by uncommitted work, so
    // the probe's two git calls are spent only where they can change what the
    // refusal tells the agent to do.
    uncommittedWork:
      Array.isArray(files) && files.length === 0
        ? dirtyProbeFn({ branch: headRef, cwd, gitFn })
        : false,
  });
}

/**
 * Is this refusal the one that is NOT about scope?
 *
 * @param {{ refusalClass?: string|null }} result
 * @returns {boolean}
 */
function isUncommittedRefusal(result) {
  return result.refusalClass === LIGHT_REFUSAL_CLASSES.UNCOMMITTED_WORK;
}

/**
 * Close the refusal log line: what became of the work, and what to run next.
 *
 * A `null` preservation is the uncommitted-work refusal by construction — that
 * is the one path that does not push, because there is nothing a push could
 * preserve: it would publish a branch at its base and then report uncommitted
 * work as safe on `origin`, which is the opposite of true.
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
 * Resolve the backstop pass into everything the CLI needs to print and exit
 * with: the verdict, the recycle command on a refusal (`null` when clean), the
 * exit code, and the log line.
 *
 * A refusal also **preserves** the work before it reports (Story #4875): the
 * implementation is finished and the recycle command hands the receipt to
 * `/mandrel-plan`, so leaving it on an untracked local branch that routine cleanup may
 * reap is not an acceptable end state. Preservation is best-effort and its
 * outcome is reported either way — a failed push degrades the message, never
 * the verdict or the exit code.
 *
 * @param {{
 *   storyId: number,
 *   runFn?: typeof runDiffBackstop,
 *   handleBlockedFn?: typeof handleBlockedBackstop,
 *   preserveFn?: typeof preserveRefusedWork,
 * }} args Any further keys (`baseRef`, `cwd`, `computeFn`, `readRowsFn`,
 *   `dirtyProbeFn`, `gitFn`, `injectedRules`) forward to the backstop run, so
 *   the git-surface join is drivable through this one entry point.
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
