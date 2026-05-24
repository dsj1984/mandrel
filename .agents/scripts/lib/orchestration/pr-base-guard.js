// .agents/scripts/lib/orchestration/pr-base-guard.js
/**
 * pr-base-guard.js — refuse to open a pull request that would route an
 * Epic-attached Story's work directly into `main` instead of into the
 * parent Epic integration branch.
 *
 * Background: Story #2960 — during Epic #2880 wave 5 a sub-agent fell
 * back to `gh pr create --base main` after `story-close.js`
 * short-circuited as a no-op. The orphaned PR forced a manual recovery
 * (`git merge origin/main` back into `epic/2880`). This module is the
 * defence-in-depth call any framework helper that triggers `gh pr create`
 * MUST invoke before shelling out.
 *
 * Scope: the guard fires only when the Story body declares an
 * `Epic: #N` (or `Parent: #N`) reference. Stand-alone Stories — the
 * `/single-story-deliver` surface — are unaffected because they have no
 * parent reference to detect.
 */

import { resolveStoryHierarchy } from '../story-lifecycle.js';

/**
 * Inspect a Story's body for an Epic parent reference and refuse a PR
 * whose `baseBranch` is not the matching `epic/<N>` integration branch.
 *
 * @param {object} args
 * @param {number} args.storyId — Story ticket id (used in the error
 *   message so the operator can grep the failing surface).
 * @param {string|null|undefined} args.storyBody — raw Story body markdown.
 *   When falsy, the guard short-circuits (no parent → nothing to enforce).
 * @param {string} args.baseBranch — the `--base` value about to be passed
 *   to `gh pr create`.
 * @throws {Error} when the Story is Epic-attached and `baseBranch` is not
 *   the parent Epic's branch. The message matches the AC verbatim so
 *   reviewers can grep it.
 */
export function assertStoryPrBaseAllowed({ storyId, storyBody, baseBranch }) {
  if (!storyBody) return;
  const { epicId } = resolveStoryHierarchy(storyBody);
  if (epicId == null) return;
  const expected = `epic/${epicId}`;
  if (baseBranch === expected) return;
  throw new Error(
    `Story #${storyId} is parented by Epic #${epicId} — merge into ${expected}, not ${baseBranch}. ` +
      'To bypass, use /single-story-deliver explicitly.',
  );
}
