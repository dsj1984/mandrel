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

  it('new files with sub-100% coverage register as regressions', () => {
    const head = { rows: [row('src/new.js', 70)] };
    const base = { rows: [] };
    const out = compare(head, base);
    assert.equal(out.regressions.length, 1);
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
    assert.deepEqual(out, { regressions: [], improvements: [], unchanged: [] });
  });
});
