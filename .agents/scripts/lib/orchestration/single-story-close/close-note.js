/**
 * close-note.js — the human-readable `note` on close's result record
 * (Story #5266).
 *
 * ## Why this is its own module
 *
 * The note used to branch on `waitedForMerge` — whether close *waited* — and
 * not on `merged`. A bounded wait that expired with the PR still open
 * therefore wrote "Close-and-land: PR merge confirmed … the issue closed"
 * into `story-close-result-<id>.log` **beside `merged: false`**, while the
 * schema-validated terminal envelope correctly reported
 * `status: pending, phase: confirm-merge`. That log is what close's summary
 * line points the operator at, so the contradiction is what gets read first:
 * a merge that never happened, reported as confirmed.
 *
 * The invariant this module exists to hold:
 *
 *   > **No note may assert a state the same object denies.**
 *
 * Every branch below is therefore derived from the result's OWN
 * `merged` / `directMerged` / `autoMergeEnabled` / `landCompleted` fields —
 * the ones the note ships next to — so no input can produce a note that
 * contradicts them. Story #5279 added the fourth, because `merged: true`
 * used to imply the flip, the issue close and the post-land tail: a direct
 * squash-merge under `--no-wait-merge`, and a merge whose `agent::done` write
 * failed, now reach it with none of the three, and reusing the confirmed
 * wording for them would reintroduce the defect above one field over. The
 * unmerged branches deliberately claim nothing about the Story's label state
 * either: close's ending may be `pending` OR `blocked` with the same
 * `merged: false`, and the terminal envelope is the authority on which. They
 * also avoid the merge-completion vocabulary entirely — no `agent::done`, no
 * "the merge confirms" — so that a reader skimming for those words cannot
 * take a next-step instruction for a report of what happened.
 */

/**
 * The one line the note is not allowed to get wrong.
 *
 * @param {{ merged?: boolean, directMerged?: boolean,
 *   autoMergeEnabled?: boolean, landCompleted?: boolean }} result
 *   `landCompleted` — did THIS run flip `agent::done`, close the issue and
 *   run the post-land tail? Defaults to `merged`, the pre-#5279 equivalence.
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
