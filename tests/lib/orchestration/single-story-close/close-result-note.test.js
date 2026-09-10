/**
 * tests/lib/orchestration/single-story-close/close-result-note.test.js
 *
 * Story #5266 — close's result `note` may never assert a state the same
 * object denies.
 *
 * The defect: `closeResult` branched its note on `waitedForMerge` — whether
 * close WAITED — not on `merged`. A bounded wait that expired with the PR
 * still open therefore wrote "Close-and-land: PR merge confirmed … the issue
 * closed" into `story-close-result-<id>.log` beside `merged: false`, while
 * the schema-validated terminal envelope reported `status: pending,
 * phase: confirm-merge`. That log is what close's summary line points the
 * operator at, so the false claim is the first thing read.
 *
 * Story #5279 — the same invariant, from the other side. `merged` itself was
 * not derived from what the run observed: it denied two merges the run had
 * seen. Fixing that made `merged: true` reachable without the flip, the issue
 * close or the post-land tail, which the #5266 wording asserts unconditionally
 * — so the note is now scored against the OBSERVED inputs (did the run see a
 * merge? did it finish the land?) rather than against its own `merged` flag,
 * which is what let the old wording agree with a wrong flag.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveCloseNote } from '../../../../.agents/scripts/lib/orchestration/single-story-close/close-note.js';

/** Any phrasing that claims the merge happened. */
const CLAIMS_MERGE = /merge confirmed|agent::done|issue closed|post-land tail/i;
/** Any phrasing that claims THIS run finished the land. */
const CLAIMS_LAND =
  /Story flipped agent::closing → agent::done, the issue closed \(confirmStoryMerged\), and the post-land tail ran/;

describe('deriveCloseNote — the note never contradicts merged (Story #5266)', () => {
  it('a wait that expired unmerged says the PR is still open, not "merge confirmed"', () => {
    // The exact regression: close waited, the wait expired, merged is false.
    const note = deriveCloseNote({ merged: false, autoMergeEnabled: true });
    assert.doesNotMatch(note, CLAIMS_MERGE);
    assert.match(note, /NOT merged/);
    assert.match(note, /terminal envelope/i);
  });

  it('a confirmed merge still reports the flip, the close and the tail', () => {
    const note = deriveCloseNote({
      merged: true,
      autoMergeEnabled: true,
      landCompleted: true,
    });
    assert.match(note, /PR merge confirmed/);
    assert.match(note, CLAIMS_LAND);
  });

  it('a direct squash-merge is reported as one, and still as merged', () => {
    const note = deriveCloseNote({
      merged: true,
      directMerged: true,
      landCompleted: true,
    });
    assert.match(note, /DIRECT squash-merge/);
    assert.match(note, /PR merge confirmed/);
  });

  it('an unmerged PR with no arm points at the operator merge', () => {
    const note = deriveCloseNote({ merged: false, autoMergeEnabled: false });
    assert.doesNotMatch(note, CLAIMS_MERGE);
    assert.match(note, /auto-merge was not armed/);
    assert.match(note, /single-story-confirm-merge\.js/);
  });

  it('defaults to the safest reading when handed nothing at all', () => {
    const note = deriveCloseNote();
    assert.doesNotMatch(note, CLAIMS_MERGE);
    assert.ok(note.length > 0);
  });
});

describe('deriveCloseNote — scored against the observed inputs (Story #5279)', () => {
  /**
   * The full input space the note ships beside, with the two facts the note
   * may assert derived from the INPUTS rather than read back off the note.
   * `landCompleted` is omitted from half the cases so the pre-#5279 default
   * (`landCompleted = merged`) stays covered.
   */
  const cases = [];
  for (const merged of [true, false]) {
    for (const directMerged of [true, false]) {
      for (const autoMergeEnabled of [true, false]) {
        for (const landCompleted of [true, false, undefined]) {
          const input = { merged, directMerged, autoMergeEnabled };
          if (landCompleted !== undefined) input.landCompleted = landCompleted;
          cases.push({
            input,
            // Observed: did the run see a merge, and did it finish the land?
            // A land cannot complete without a merge, so the merge gates it —
            // that pairing is exactly what the note may never get wrong.
            observedMerge: merged,
            observedLand: merged && (landCompleted ?? merged),
          });
        }
      }
    }
  }

  it('claims a merge exactly when the run observed one', () => {
    for (const { input, observedMerge } of cases) {
      const note = deriveCloseNote(input);
      assert.equal(
        CLAIMS_MERGE.test(note),
        observedMerge,
        `note's merge claim disagrees with the observed merge for ${JSON.stringify(input)}: ${note}`,
      );
    }
  });

  it('claims the flip, the issue close and the tail exactly when the run completed the land', () => {
    // The #5279 hazard: `merged: true` no longer implies any of the three, so
    // reusing the confirmed wording would reintroduce #5266 one field over.
    for (const { input, observedLand } of cases) {
      const note = deriveCloseNote(input);
      assert.equal(
        CLAIMS_LAND.test(note),
        observedLand,
        `note's land claim disagrees with the observed land for ${JSON.stringify(input)}: ${note}`,
      );
    }
  });

  it('reports a direct squash-merge exactly when one was observed', () => {
    for (const { input, observedMerge } of cases) {
      const note = deriveCloseNote(input);
      assert.equal(
        /DIRECT squash-merge/.test(note),
        observedMerge && input.directMerged,
        `direct-merge wording disagrees with ${JSON.stringify(input)}`,
      );
    }
  });

  it('a merge with an unfinished land names the command that finishes it', () => {
    // Both #5279 endings: a direct squash-merge under `--no-wait-merge`, and
    // a merge whose `agent::done` write failed. The land is real work still
    // owed, so the note must say so and name the idempotent resume.
    for (const directMerged of [true, false]) {
      const note = deriveCloseNote({
        merged: true,
        directMerged,
        landCompleted: false,
      });
      assert.match(note, /PR merge confirmed/);
      assert.match(note, /did NOT finish the land/);
      assert.match(note, /single-story-confirm-merge\.js/);
      assert.match(note, /idempotent/);
      assert.doesNotMatch(note, CLAIMS_LAND);
    }
  });
});
