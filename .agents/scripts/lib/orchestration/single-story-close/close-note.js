/**
 * close-note.js — the human-readable `note` on close's result record.
 *
 * Invariant: no note may assert a state the same object denies, so every
 * branch derives from the result's own fields. A merge is not a completed
 * land (`landCompleted`), and the unmerged branches claim nothing about label
 * state and avoid merge-completion vocabulary — the terminal envelope is the
 * authority on pending vs blocked.
 */

/**
 * @param {{ merged?: boolean, directMerged?: boolean,
 *   autoMergeEnabled?: boolean, landCompleted?: boolean }} result
 *   `landCompleted` — did THIS run flip `agent::done`, close the issue and
 *   run the post-land tail? Defaults to `merged`.
 * @returns {string}
 */
export function deriveCloseNote({
  merged = false,
  directMerged = false,
  autoMergeEnabled = false,
  landCompleted = merged,
} = {}) {
  if (merged) {
    const how = directMerged
      ? 'PR merge confirmed by a DIRECT squash-merge (native auto-merge was ' +
        'unavailable on this repository).'
      : 'PR merge confirmed.';
    return landCompleted
      ? `Close-and-land: ${how} Story flipped agent::closing → agent::done, ` +
          'the issue closed (confirmStoryMerged), and the post-land tail ran.'
      : `Close-and-land: ${how} This close did NOT finish the land: ` +
          'agent::done was not flipped and the post-land tail did not run. ' +
          'Finish it with single-story-confirm-merge.js, idempotent against an ' +
          'already-merged PR. The terminal envelope is authoritative.';
  }
  if (autoMergeEnabled) {
    return (
      'PR open against baseBranch and NOT merged; auto-merge is armed. ' +
      'GitHub will squash-merge it once the required checks pass — resume ' +
      'with single-story-confirm-merge.js then, to finish the land and ' +
      'release the lease this close is still holding. The terminal envelope ' +
      '(status / phase / blocked) is authoritative for what happened here.'
    );
  }
  return (
    'PR open against baseBranch and NOT merged; auto-merge was not armed ' +
    '(see autoMergeReason). The operator owns the land: merge via the GitHub ' +
    'UI, then resume with single-story-confirm-merge.js to finish the land ' +
    'and release the lease this close is still holding. The terminal ' +
    'envelope (status / phase / blocked) is authoritative for what happened ' +
    'here.'
  );
}
