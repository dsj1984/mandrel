/**
 * phases/drift-detection.js — plan-vs-actual drift findings at close.
 *
 * Story #3260 (Epic #3212) — At single-story-close time, reads the most recent
 * `story-plan` structured comment (if any) and compares its `files_to_touch`
 * list against the actual branch diff (`git diff --name-only origin/<base>...HEAD`).
 *
 * Two non-blocking soft findings are emitted as `notification` comments on the
 * Story thread:
 *
 *   - `story-plan-files-added`  — files in the diff absent from the plan.
 *   - `story-plan-files-missed` — files named in the plan not in the diff.
 *
 * Both findings are informational only. The gate decision is unchanged when
 * only drift findings are present. Failures to read the plan comment or run
 * git are swallowed as warnings so the close path is never blocked.
 */

import { findStructuredComment } from '../../ticketing/reads.js';
import { postStructuredComment } from '../../ticketing/state.js';

/**
 * Derive the set of files touched by the Story branch relative to the base.
 *
 * @param {(cwd: string, ...args: string[]) => string} gitSync
 * @param {string} cwd
 * @param {string} baseBranch
 * @returns {string[]} sorted list of touched file paths (may be empty).
 */
export function getDiffFiles(gitSync, cwd, baseBranch) {
  try {
    const raw = gitSync(
      cwd,
      'diff',
      '--name-only',
      `origin/${baseBranch}...HEAD`,
    );
    if (typeof raw !== 'string') return [];
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Extract the `files_to_touch` array from a raw story-plan comment body.
 * Returns `null` when the comment is absent or cannot be parsed.
 *
 * @param {object|null} comment - Raw comment object from `findStructuredComment`.
 * @returns {string[]|null}
 */
export function extractPlanFiles(comment) {
  if (!comment) return null;
  const body = comment.body ?? '';
  const jsonMatch = body.match(/```json\s*([\s\S]*?)```/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[1].trim());
    if (!Array.isArray(parsed?.files_to_touch)) return null;
    return parsed.files_to_touch.filter(
      (f) => typeof f === 'string' && f.length > 0,
    );
  } catch {
    return null;
  }
}

/**
 * Compare the planned file set against the actual diff.
 * Returns two disjoint lists that, combined, describe all drift.
 *
 * @param {{ planFiles: string[], diffFiles: string[] }} opts
 * @returns {{ added: string[], missed: string[] }}
 *   `added`  — files in the diff but not in the plan.
 *   `missed` — files in the plan but not in the diff.
 */
export function computeDriftFindings({ planFiles, diffFiles }) {
  const planSet = new Set(planFiles);
  const diffSet = new Set(diffFiles);
  const added = [...diffSet].filter((f) => !planSet.has(f)).sort();
  const missed = [...planSet].filter((f) => !diffSet.has(f)).sort();
  return { added, missed };
}

/**
 * Format the `story-plan-files-added` finding body.
 *
 * @param {{ storyId: number, addedFiles: string[] }} opts
 * @returns {string}
 */
export function formatAddedFinding({ storyId, addedFiles }) {
  const list = addedFiles.map((f) => `- \`${f}\``).join('\n');
  return (
    `### story-plan-files-added (soft finding)\n\n` +
    `Story #${storyId}: the following file(s) were touched in the branch diff ` +
    `but were **not listed** in the \`story-plan\` comment. ` +
    `This is informational — close is not blocked.\n\n${list}`
  );
}

/**
 * Format the `story-plan-files-missed` finding body.
 *
 * @param {{ storyId: number, missedFiles: string[] }} opts
 * @returns {string}
 */
export function formatMissedFinding({ storyId, missedFiles }) {
  const list = missedFiles.map((f) => `- \`${f}\``).join('\n');
  return (
    `### story-plan-files-missed (soft finding)\n\n` +
    `Story #${storyId}: the following file(s) were listed in the \`story-plan\` comment ` +
    `but were **not touched** in the branch diff. ` +
    `This is informational — close is not blocked.\n\n${list}`
  );
}

/**
 * Orchestrate the drift-detection step for `single-story-close`.
 *
 * Reads the `story-plan` comment, diffs against the actual branch,
 * and posts non-blocking `notification` findings on the Story thread.
 * All errors are caught and logged as warnings so close is never blocked.
 *
 * @param {{
 *   cwd: string,
 *   storyBranch: string,
 *   baseBranch: string,
 *   storyId: number,
 *   provider: object,
 *   progress: (tag: string, msg: string) => void,
 *   injectedFindStructuredComment?: typeof findStructuredComment,
 *   injectedGitSync?: Function,
 * }} args
 * @returns {Promise<{ added: string[], missed: string[], skipped: boolean }>}
 */
export async function runDriftDetectionPhase({
  cwd,
  baseBranch,
  storyId,
  provider,
  progress,
  injectedFindStructuredComment = findStructuredComment,
  injectedGitSync,
}) {
  // Dynamic import kept inside function so unit tests can inject without
  // module-URL mocking.
  const { gitSync: defaultGitSync } = await import('../../../git-utils.js');
  const gitSyncFn = injectedGitSync ?? defaultGitSync;

  progress('DRIFT', `Checking plan-vs-actual drift for Story #${storyId}...`);

  let planComment;
  try {
    planComment = await injectedFindStructuredComment(
      provider,
      storyId,
      'story-plan',
    );
  } catch (err) {
    progress(
      'DRIFT',
      `⚠️ Could not read story-plan comment: ${err?.message ?? err}. Skipping drift check.`,
    );
    return { added: [], missed: [], skipped: true };
  }

  const planFiles = extractPlanFiles(planComment);
  if (planFiles === null) {
    progress(
      'DRIFT',
      'No story-plan comment found (or unparseable). Skipping drift check.',
    );
    return { added: [], missed: [], skipped: true };
  }

  const diffFiles = getDiffFiles(gitSyncFn, cwd, baseBranch);
  const { added, missed } = computeDriftFindings({ planFiles, diffFiles });

  if (added.length === 0 && missed.length === 0) {
    progress('DRIFT', '✅ No plan-vs-actual drift detected.');
    return { added, missed, skipped: false };
  }

  // Post soft findings — non-blocking; errors are swallowed.
  if (added.length > 0) {
    const body = formatAddedFinding({ storyId, addedFiles: added });
    try {
      await postStructuredComment(provider, storyId, 'notification', body);
      progress(
        'DRIFT',
        `📝 story-plan-files-added: ${added.length} extra file(s) posted to Story #${storyId}.`,
      );
    } catch (err) {
      progress(
        'DRIFT',
        `⚠️ Failed to post story-plan-files-added finding: ${err?.message ?? err}`,
      );
    }
  }

  if (missed.length > 0) {
    const body = formatMissedFinding({ storyId, missedFiles: missed });
    try {
      await postStructuredComment(provider, storyId, 'notification', body);
      progress(
        'DRIFT',
        `📝 story-plan-files-missed: ${missed.length} missed file(s) posted to Story #${storyId}.`,
      );
    } catch (err) {
      progress(
        'DRIFT',
        `⚠️ Failed to post story-plan-files-missed finding: ${err?.message ?? err}`,
      );
    }
  }

  return { added, missed, skipped: false };
}
