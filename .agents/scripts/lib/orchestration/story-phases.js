/**
 * Story lifecycle phases.
 *
 * A Story moves through these phases during `/epic-execute` + `story-close`:
 *
 *   UNSTARTED   → init hasn't run (no branch, no worktree).
 *   PRE_MERGE   → branch created, work in progress on story worktree.
 *   MERGING     → merge into the epic branch is underway (possibly conflicted).
 *   POST_MERGE  → merge complete, cleanup / cascade / close running.
 *   CLOSED      → tickets + branches reaped.
 *
 * Used by orchestration code (e.g. prior-phase detection in
 * `story-close-recovery.js`) to classify where a Story currently sits.
 */
export const PHASES = Object.freeze({
  UNSTARTED: 'unstarted',
  PRE_MERGE: 'pre-merge',
  MERGING: 'merging',
  POST_MERGE: 'post-merge',
  CLOSED: 'closed',
});
