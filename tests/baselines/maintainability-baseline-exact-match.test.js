import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { getBaseline } from '../../.agents/scripts/lib/baselines/maintainability-baseline-io.js';

// ---------------------------------------------------------------------------
// maintainability-baseline-exact-match.test.js — Story #4603.
//
// Records (and enforces) the ruling-out of the suffix-collision hypothesis
// raised while root-causing why #4593's -5.86 MI ratchet violation landed
// un-gated.
//
// THE HYPOTHESIS. The real `baselines/maintainability.json` carries two rows:
//
//   A  .agents/scripts/lib/orchestration/single-story-close/phases/code-review.js  mi 90.602
//   B  .agents/scripts/lib/orchestration/story-close/phases/code-review.js         mi 96.469
//
// They collide on a shared TAIL — `story-close/phases/code-review.js` — because
// `single-story-close` itself ends with `story-close`. Both A and B satisfy
// `path.endsWith('story-close/phases/code-review.js')`, so any suffix- or
// substring-keyed lookup for B is AMBIGUOUS and a `find()`-style resolver
// returns A (90.602) first. That number is ~B's post-#4593 score (90.61), which
// would make a real -5.86 regression present as a ~0.008 delta and sail through
// the 0.5 tolerance. That is precisely the masking the hypothesis proposed.
//
// (Note the hypothesis as originally stated — "A ends with B" — is literally
// false for the FULL paths: `A.endsWith(B) === false`, since B carries the
// `.agents/scripts/lib/orchestration/` prefix. The real collision is on the
// shared tail, which is the only shape a fuzzy resolver could confuse.)
//
// THE VERDICT: FALSE. Resolution is a plain object-key lookup —
// `projectMaintainabilityEnvelopeToFlat` builds `flat[row.path]` and
// `preview-gates.js#compareScores` reads `baseline[file]`. Exact match; no
// `endsWith`, no substring, no basename fallback anywhere under
// `.agents/scripts/lib/baselines/`. A and B resolve independently, and a
// partial key resolves to nothing at all.
//
// These tests are that evidence, made executable: a future refactor toward
// fuzzy/suffix path resolution fails loudly here rather than silently blinding
// the MI ratchet again.
// ---------------------------------------------------------------------------

/** The two suffix-colliding paths as they appear in the real baseline. */
const ROW_A =
  '.agents/scripts/lib/orchestration/single-story-close/phases/code-review.js';
const ROW_B =
  '.agents/scripts/lib/orchestration/story-close/phases/code-review.js';
/** The tail both rows end with — the ambiguous key. */
const SHARED_TAIL = 'story-close/phases/code-review.js';

/** Write an envelope-shaped baseline to a temp file; returns its path. */
function writeBaseline(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-baseline-exact-'));
  const file = path.join(dir, 'maintainability.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      $schema: './schemas/maintainability.schema.json',
      rows,
    }),
  );
  return file;
}

describe('maintainability baseline resolution is exact-match (Story #4603)', () => {
  it('the fixture reproduces the real shared-tail collision', () => {
    // Guards the premise of every assertion below.
    assert.ok(
      ROW_A.endsWith(SHARED_TAIL),
      'row A must end with the shared tail',
    );
    assert.ok(
      ROW_B.endsWith(SHARED_TAIL),
      'row B must end with the shared tail',
    );
    assert.equal(
      ROW_A.endsWith(ROW_B),
      false,
      'the full paths are NOT in a suffix relation — the collision is tail-only',
    );
  });

  it('resolves each colliding row to its own score, not the other', () => {
    const flat = getBaseline(
      writeBaseline([
        { path: ROW_A, mi: 90.602 },
        { path: ROW_B, mi: 96.469 },
      ]),
    );

    assert.equal(flat[ROW_A], 90.602);
    assert.equal(
      flat[ROW_B],
      96.469,
      'row B must resolve to its OWN baseline — reading row A (90.602) here is ' +
        'exactly how a -5.86 regression would present as a ~0.008 delta',
    );
  });

  it('does not resolve the ambiguous shared tail to either row', () => {
    // A suffix/substring resolver would match BOTH rows on this key and return
    // whichever came first. Exact-match resolution returns nothing.
    const flat = getBaseline(
      writeBaseline([
        { path: ROW_A, mi: 90.602 },
        { path: ROW_B, mi: 96.469 },
      ]),
    );

    assert.equal(
      flat[SHARED_TAIL],
      undefined,
      'a partial/suffix key must NOT resolve to any row',
    );
  });

  it('does not resolve a path by suffix when no exact row exists', () => {
    // With ONLY row A present, a lookup for row B must miss. An unmatched path
    // is a new file (an addition), never a silent hit on a neighbouring row.
    const flat = getBaseline(writeBaseline([{ path: ROW_A, mi: 90.602 }]));

    assert.equal(flat[ROW_A], 90.602);
    assert.equal(flat[ROW_B], undefined);
  });

  it('does not resolve a path by substring or bare basename', () => {
    const flat = getBaseline(
      writeBaseline([{ path: 'a/b/c/code-review.js', mi: 80 }]),
    );

    assert.equal(flat['a/b/c/code-review.js'], 80);
    assert.equal(flat['code-review.js'], undefined);
    assert.equal(flat['b/c/code-review.js'], undefined);
  });
});
