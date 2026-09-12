// tests/lib/baselines/crap-preview-advisories.test.js
//
// Story #5313 — the CRAP preview scan lists every scanned method at or over
// the fixed cyclomatic ceiling as an ADVISORY. Pure over the scan rows, so a
// verdict on complexity alone can never come out of the preview.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { listCyclomaticAdvisories } from '../../../.agents/scripts/lib/baselines/crap-preview-scan.js';
import { CYCLOMATIC_CEILING } from '../../../.agents/scripts/lib/cyclomatic-ceiling.js';

describe('listCyclomaticAdvisories', () => {
  test('keeps methods at or over the ceiling, projected to the four reported fields', () => {
    const rows = [
      { file: 'a.js', method: 'ok', startLine: 1, cyclomatic: 11, crap: 11 },
      { file: 'a.js', method: 'edge', startLine: 5, cyclomatic: 12, crap: 12 },
      { file: 'b.js', method: 'bad', startLine: 9, cyclomatic: 30, crap: 900 },
    ];
    assert.equal(CYCLOMATIC_CEILING, 12);
    assert.deepEqual(listCyclomaticAdvisories(rows), [
      { file: 'a.js', method: 'edge', startLine: 5, cyclomatic: 12 },
      { file: 'b.js', method: 'bad', startLine: 9, cyclomatic: 30 },
    ]);
  });

  test('is total over junk input', () => {
    assert.deepEqual(listCyclomaticAdvisories(null), []);
    assert.deepEqual(
      listCyclomaticAdvisories([null, {}, { cyclomatic: 'x' }]),
      [],
    );
  });
});
