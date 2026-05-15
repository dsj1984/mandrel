import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compare } from '../../../.agents/scripts/lib/baselines/kinds/mutation.js';

// ---------------------------------------------------------------------------
// mutation.compare.test.js — pure compare(head, base) for the mutation kind
// (Story #1961 / Task #1966). Higher score is better.
// ---------------------------------------------------------------------------

function row(path, score, killed = 0, survived = 0) {
  return { path, score, killed, survived };
}

describe('kinds/mutation.compare()', () => {
  it('classifies a dropped score as a regression', () => {
    const head = { rows: [row('src/a.js', 70)] };
    const base = { rows: [row('src/a.js', 85)] };
    const out = compare(head, base);
    assert.equal(out.regressions.length, 1);
    assert.equal(out.regressions[0].key, 'src/a.js');
  });

  it('classifies a raised score as an improvement', () => {
    const head = { rows: [row('src/a.js', 90)] };
    const base = { rows: [row('src/a.js', 80)] };
    const out = compare(head, base);
    assert.equal(out.improvements.length, 1);
  });

  it('classifies identical scores as unchanged', () => {
    const head = { rows: [row('src/a.js', 80)] };
    const base = { rows: [row('src/a.js', 80)] };
    const out = compare(head, base);
    assert.equal(out.unchanged.length, 1);
  });

  it('new files with score < 100 are regressions', () => {
    const head = { rows: [row('src/new.js', 75)] };
    const base = { rows: [] };
    const out = compare(head, base);
    assert.equal(out.regressions.length, 1);
  });

  it('removed files with score < 100 are improvements', () => {
    const head = { rows: [] };
    const base = { rows: [row('src/old.js', 50)] };
    const out = compare(head, base);
    assert.equal(out.improvements.length, 1);
  });

  it('produces stable output on identical inputs', () => {
    const head = { rows: [row('src/a.js', 85)] };
    const base = { rows: [row('src/a.js', 80)] };
    const a = compare(head, base);
    const b = compare(head, base);
    assert.deepEqual(a, b);
  });

  it('tolerates missing rows arrays', () => {
    const out = compare({}, {});
    assert.deepEqual(out, { regressions: [], improvements: [], unchanged: [] });
  });
});
