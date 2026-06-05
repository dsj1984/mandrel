/**
 * scope-discovery.js — phase 1 of baseline-attribution.
 *
 * Resolve the Story branch's diff scope vs `origin/<epicBranch>` so the
 * downstream projection + attribution layers can split "this Story's
 * regressions" from "sibling drift inherited from the Epic branch".
 *
 * Pure helpers — every git invocation goes through the injected
 * `gitRunner` so tests can pin the diff math without spawning git.
 */

import { diffNameOnly } from '../../../../changed-files.js';
import { gitSpawn as defaultGitSpawn } from '../../../../git-utils.js';

/**
 * Compute repo-relative paths the Story branch changed vs `origin/<epicBranch>`.
 * Best-effort: a non-zero diff exit returns an empty array so the caller
 * conservatively treats every regression as non-attributable (the safer
 * default — the close blocks rather than absorbs sibling drift).
 */
export function computeStoryDiffPaths({
  cwd,
  epicBranch,
  storyBranch,
  gitRunner = { gitSpawn: defaultGitSpawn },
}) {
  if (!cwd || !epicBranch || !storyBranch) return [];
  try {
    return diffNameOnly({
      range: `origin/${epicBranch}...${storyBranch}`,
      cwd,
      gitSpawn: gitRunner.gitSpawn,
    });
  } catch {
    return [];
  }
}

/**
 * Guard for the projection phase — the projectors require a worktree + the
 * pair of branch refs to compute a meaningful diff.
 */
export function validateProjectionContext({ cwd, epicBranch, storyBranch }) {
  if (!cwd) return false;
  if (!epicBranch) return false;
  if (!storyBranch) return false;
  return true;
}
