import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compare } from '../../../.agents/scripts/lib/baselines/kinds/maintainability.js';

// ---------------------------------------------------------------------------
// maintainability.compare.test.js — pure compare(head, base) for the MI kind
// (Story #1961 / Task #1966). Higher MI is better.
// ---------------------------------------------------------------------------

describe('kinds/maintainability.compare()', () => {
  it('classifies a dropped MI as a regression', () => {
    const head = { rows: [{ path: 'src/a.js', mi: 60 }] };
    const base = { rows: [{ path: 'src/a.js', mi: 80 }] };
    const out = compare(head, base);
    assert.equal(out.regressions.length, 1);
    assert.equal(out.regressions[0].key, 'src/a.js');
  });

  it('classifies a raised MI as an improvement', () => {
    const head = { rows: [{ path: 'src/a.js', mi: 90 }] };
    const base = { rows: [{ path: 'src/a.js', mi: 80 }] };
    const out = compare(head, base);
    assert.equal(out.improvements.length, 1);
  });

  it('classifies identical MI as unchanged', () => {
    const head = { rows: [{ path: 'src/a.js', mi: 75 }] };
    const base = { rows: [{ path: 'src/a.js', mi: 75 }] };
    const out = compare(head, base);
    assert.equal(out.unchanged.length, 1);
  });

  it('new files (any MI) land in additions, not regressions (Story #2012)', () => {
    const head = { rows: [{ path: 'src/new.js', mi: 70 }] };
    const base = { rows: [] };
    const out = compare(head, base);
    assert.equal(out.regressions.length, 0);
    assert.equal(out.additions.length, 1);
    assert.equal(out.additions[0].key, 'src/new.js');
    assert.equal(out.additions[0].base, null);
  });

  it('low-MI new files (e.g. 22 vs implicit 100) are additions, not regressions', () => {
    // Regression test for the specific Story #2012 scenario: a new file
    // with an MI well below 100 used to surface as a -78 MI drop and
    // breached every reasonable miDropCap. With the fix it lands in
    // `additions` and the regression arm stays empty.
    const head = { rows: [{ path: 'lib/new.js', mi: 22 }] };
    const base = { rows: [] };
    const out = compare(head, base);
    assert.deepEqual(out.regressions, []);
    assert.equal(out.additions.length, 1);
  });

  it('removed files with MI < 100 are improvements', () => {
    const head = { rows: [] };
    const base = { rows: [{ path: 'src/old.js', mi: 50 }] };
    const out = compare(head, base);
    assert.equal(out.improvements.length, 1);
  });

  it('produces stable output on identical inputs', () => {
    const head = { rows: [{ path: 'src/a.js', mi: 85 }] };
    const base = { rows: [{ path: 'src/a.js', mi: 80 }] };
    const a = compare(head, base);
    const b = compare(head, base);
    assert.deepEqual(a, b);
  });

  it('tolerates missing rows arrays', () => {
    const out = compare({}, {});
    assert.deepEqual(out, {
      regressions: [],
      improvements: [],
      unchanged: [],
      additions: [],
    });
  });
});
