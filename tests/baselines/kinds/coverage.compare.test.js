import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compare } from '../../../.agents/scripts/lib/baselines/kinds/coverage.js';

// ---------------------------------------------------------------------------
// coverage.compare.test.js — pure compare(head, base) for the coverage kind
// (Story #1961 / Task #1966). Higher % is better.
// ---------------------------------------------------------------------------

function row(path, lines, branches = lines, functions = lines) {
  return { path, lines, branches, functions };
}

describe('kinds/coverage.compare()', () => {
  it('classifies a dropped axis as a regression', () => {
    const head = { rows: [row('src/a.js', 70)] };
    const base = { rows: [row('src/a.js', 90)] };
    const out = compare(head, base);
    assert.equal(out.regressions.length, 1);
    assert.equal(out.regressions[0].key, 'src/a.js');
  });

  it('classifies a raised axis (no drops) as an improvement', () => {
    const head = { rows: [row('src/a.js', 95)] };
    const base = { rows: [row('src/a.js', 80)] };
    const out = compare(head, base);
    assert.equal(out.improvements.length, 1);
  });

  it('classifies identical percentages as unchanged', () => {
    const head = { rows: [row('src/a.js', 80)] };
    const base = { rows: [row('src/a.js', 80)] };
    const out = compare(head, base);
    assert.equal(out.unchanged.length, 1);
  });

  it('mixed up+down is a regression (any drop dominates)', () => {
    const head = {
      rows: [{ path: 'src/a.js', lines: 95, branches: 50, functions: 80 }],
    };
    const base = {
      rows: [{ path: 'src/a.js', lines: 90, branches: 80, functions: 80 }],
    };
    const out = compare(head, base);
    assert.equal(out.regressions.length, 1);
  });

  it('new files with sub-100% coverage land in additions, not regressions (Story #2012)', () => {
    const head = { rows: [row('src/new.js', 70)] };
    const base = { rows: [] };
    const out = compare(head, base);
    assert.equal(out.regressions.length, 0);
    assert.equal(out.additions.length, 1);
    assert.equal(out.additions[0].key, 'src/new.js');
    assert.equal(out.additions[0].base, null);
  });

  it('removed files with sub-100% coverage register as improvements', () => {
    const head = { rows: [] };
    const base = { rows: [row('src/old.js', 60)] };
    const out = compare(head, base);
    assert.equal(out.improvements.length, 1);
  });

  it('produces stable output on identical inputs', () => {
    const head = { rows: [row('src/a.js', 90), row('src/b.js', 80)] };
    const base = { rows: [row('src/a.js', 90), row('src/b.js', 85)] };
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

describe('kinds/coverage.compare() — new-file minimum and renames (#6068)', () => {
  const MIN = { lines: 97, branches: 88, functions: 91 };
  const zero = { path: 'new.ts', lines: 0, branches: 0, functions: 0 };

  it('AC-1: a new file under the minimum is a regression, not an addition', () => {
    const out = compare(
      { rows: [zero] },
      { rows: [] },
      { newFileMinimum: MIN },
    );
    assert.equal(out.additions.length, 0);
    assert.equal(out.regressions.length, 1);
    assert.equal(out.regressions[0].key, 'new.ts');
    assert.deepEqual(out.regressions[0].base, { path: 'new.ts', ...MIN });
  });

  it('AC-1: without the third argument the output is unchanged', () => {
    assert.deepEqual(compare({ rows: [zero] }, { rows: [] }), {
      regressions: [],
      improvements: [],
      unchanged: [],
      additions: [{ key: 'new.ts', head: zero, base: null }],
    });
  });

  it('a new file at or above the minimum stays an addition', () => {
    const ok = { path: 'new.ts', lines: 97, branches: 90, functions: 100 };
    const out = compare({ rows: [ok] }, { rows: [] }, { newFileMinimum: MIN });
    assert.equal(out.regressions.length, 0);
    assert.equal(out.additions.length, 1);
  });

  it('compares a renamed file against its old base row', () => {
    const renames = new Map([['src/new.js', 'src/old.js']]);
    const out = compare(
      { rows: [row('src/new.js', 0)] },
      { rows: [row('src/old.js', 100)] },
      { renames },
    );
    assert.equal(out.regressions.length, 1);
    assert.equal(out.regressions[0].key, 'src/new.js');
    assert.equal(out.regressions[0].renamedFrom, 'src/old.js');
    assert.equal(out.improvements.length, 0, 'the old row is consumed');
    assert.equal(out.additions.length, 0);
  });

  it('ignores a rename whose source has no base row', () => {
    const renames = new Map([['src/new.js', 'src/gone.js']]);
    const out = compare(
      { rows: [row('src/new.js', 50)] },
      { rows: [] },
      { renames },
    );
    assert.equal(out.additions.length, 1);
  });
});
