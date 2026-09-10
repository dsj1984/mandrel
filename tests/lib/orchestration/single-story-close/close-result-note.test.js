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
 * `deriveCloseNote` is exercised directly (it is what `closeResult` calls, and
 * production imports it — it is not a test-only export). The exhaustive
 * cross-product below is the AC-2 assertion: no input of the three fields the
 * note ships beside can produce a note contradicting them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveCloseNote } from '../../../../.agents/scripts/lib/orchestration/single-story-close/close-note.js';

/** Any phrasing that claims the merge happened. */
const CLAIMS_MERGE = /merge confirmed|agent::done|issue closed|post-land tail/i;

describe('deriveCloseNote — the note never contradicts merged (Story #5266)', () => {
  it('a wait that expired unmerged says the PR is still open, not "merge confirmed"', () => {
    // The exact regression: close waited, the wait expired, merged is false.
    const note = deriveCloseNote({ merged: false, autoMergeEnabled: true });
    assert.doesNotMatch(note, CLAIMS_MERGE);
    assert.match(note, /NOT merged/);
    assert.match(note, /terminal envelope/i);
  });

  it('a confirmed merge still reports the flip, the close and the tail', () => {
    const note = deriveCloseNote({ merged: true, autoMergeEnabled: true });
    assert.match(note, /PR merge confirmed/);
    assert.match(note, /agent::closing → agent::done/);
    assert.match(note, /post-land tail ran/);
  });

  it('a direct squash-merge is reported as one, and still as merged', () => {
    const note = deriveCloseNote({ merged: true, directMerged: true });
    assert.match(note, /DIRECT squash-merge/);
    assert.match(note, /PR merge confirmed/);
  });

  it('an unmerged PR with no arm points at the operator merge', () => {
    const note = deriveCloseNote({ merged: false, autoMergeEnabled: false });
    assert.doesNotMatch(note, CLAIMS_MERGE);
    assert.match(note, /auto-merge was not armed/);
    assert.match(note, /single-story-confirm-merge\.js/);
  });

  it('every branch agrees with its own merged flag (AC-2, exhaustive)', () => {
    for (const merged of [true, false]) {
      for (const directMerged of [true, false]) {
        for (const autoMergeEnabled of [true, false]) {
          const input = { merged, directMerged, autoMergeEnabled };
          const note = deriveCloseNote(input);
          assert.equal(
            CLAIMS_MERGE.test(note),
            merged,
            `note claims a merge that ${JSON.stringify(input)} denies: ${note}`,
          );
          assert.equal(
            /DIRECT squash-merge/.test(note),
            merged && directMerged,
            `direct-merge wording disagrees with ${JSON.stringify(input)}`,
          );
        }
      }
    }
  });

  it('defaults to the safest reading when handed nothing at all', () => {
    const note = deriveCloseNote();
    assert.doesNotMatch(note, CLAIMS_MERGE);
    assert.ok(note.length > 0);
  });
});
