import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compare } from '../../../.agents/scripts/lib/baselines/kinds/lint.js';

// ---------------------------------------------------------------------------
// lint.compare.test.js — pure compare(head, base) for the lint kind
// (Story #1961 / Task #1963). Covers regression / improvement / unchanged
// classification and added/removed-row handling on synthetic envelopes.
// ---------------------------------------------------------------------------

function envelope(rows) {
  return { rows };
}

describe('kinds/lint.compare()', () => {
  it('classifies higher errorCount as a regression', () => {
    const head = envelope([{ path: 'src/a.js', errorCount: 3, warningCount: 0 }]);
    const base = envelope([{ path: 'src/a.js', errorCount: 1, warningCount: 0 }]);
    const out = compare(head, base);
    assert.equal(out.regressions.length, 1);
    assert.equal(out.regressions[0].key, 'src/a.js');
    assert.equal(out.improvements.length, 0);
    assert.equal(out.unchanged.length, 0);
  });

  it('classifies lower warningCount as an improvement', () => {
    const head = envelope([{ path: 'src/a.js', errorCount: 0, warningCount: 1 }]);
    const base = envelope([{ path: 'src/a.js', errorCount: 0, warningCount: 5 }]);
    const out = compare(head, base);
    assert.equal(out.improvements.length, 1);
    assert.equal(out.improvements[0].key, 'src/a.js');
    assert.equal(out.regressions.length, 0);
  });

  it('classifies identical counts as unchanged', () => {
    const head = envelope([{ path: 'src/a.js', errorCount: 2, warningCount: 1 }]);
    const base = envelope([{ path: 'src/a.js', errorCount: 2, warningCount: 1 }]);
    const out = compare(head, base);
    assert.equal(out.unchanged.length, 1);
    assert.equal(out.regressions.length, 0);
    assert.equal(out.improvements.length, 0);
  });

  it('treats new files with findings as regressions', () => {
    const head = envelope([{ path: 'src/new.js', errorCount: 1, warningCount: 0 }]);
    const base = envelope([]);
    const out = compare(head, base);
    assert.equal(out.regressions.length, 1);
    assert.equal(out.regressions[0].base, null);
  });

  it('treats removed files with prior findings as improvements', () => {
    const head = envelope([]);
    const base = envelope([{ path: 'src/old.js', errorCount: 4, warningCount: 0 }]);
    const out = compare(head, base);
    assert.equal(out.improvements.length, 1);
    assert.equal(out.improvements[0].head, null);
  });

  it('produces stable output on identical inputs (referential transparency)', () => {
    const head = envelope([
      { path: 'src/a.js', errorCount: 0, warningCount: 0 },
      { path: 'src/b.js', errorCount: 1, warningCount: 1 },
    ]);
    const base = envelope([
      { path: 'src/a.js', errorCount: 0, warningCount: 0 },
      { path: 'src/b.js', errorCount: 0, warningCount: 1 },
    ]);
    const a = compare(head, base);
    const b = compare(head, base);
    assert.deepEqual(a, b);
  });

  it('tolerates missing rows arrays', () => {
    const out = compare({}, {});
    assert.deepEqual(out, { regressions: [], improvements: [], unchanged: [] });
  });
});
