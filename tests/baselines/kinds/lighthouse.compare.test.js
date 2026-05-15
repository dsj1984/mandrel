import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compare } from '../../../.agents/scripts/lib/baselines/kinds/lighthouse.js';

// ---------------------------------------------------------------------------
// lighthouse.compare.test.js — pure compare(head, base) for the lighthouse
// kind (Story #1961 / Task #1963). Higher score is better.
// ---------------------------------------------------------------------------

function row(route, perf, a11y = 100, bp = 100, seo = 100) {
  return {
    route,
    performance: perf,
    accessibility: a11y,
    bestPractices: bp,
    seo,
  };
}

describe('kinds/lighthouse.compare()', () => {
  it('classifies a dropped score on any axis as a regression', () => {
    const head = { rows: [row('/dashboard', 80)] };
    const base = { rows: [row('/dashboard', 95)] };
    const out = compare(head, base);
    assert.equal(out.regressions.length, 1);
    assert.equal(out.regressions[0].key, '/dashboard');
  });

  it('classifies a raised score (with no drops) as an improvement', () => {
    const head = { rows: [row('/dashboard', 95)] };
    const base = { rows: [row('/dashboard', 80)] };
    const out = compare(head, base);
    assert.equal(out.improvements.length, 1);
  });

  it('classifies identical scores as unchanged', () => {
    const head = { rows: [row('/dashboard', 90)] };
    const base = { rows: [row('/dashboard', 90)] };
    const out = compare(head, base);
    assert.equal(out.unchanged.length, 1);
  });

  it('treats mixed up+down as a regression (any drop dominates)', () => {
    const head = { rows: [row('/dashboard', 95, 80)] };
    const base = { rows: [row('/dashboard', 90, 90)] };
    const out = compare(head, base);
    assert.equal(out.regressions.length, 1);
  });

  it('new routes with sub-100 scores register as regressions', () => {
    const head = { rows: [row('/new', 80)] };
    const base = { rows: [] };
    const out = compare(head, base);
    assert.equal(out.regressions.length, 1);
  });

  it('removed routes with sub-100 scores register as improvements', () => {
    const head = { rows: [] };
    const base = { rows: [row('/old', 70)] };
    const out = compare(head, base);
    assert.equal(out.improvements.length, 1);
  });

  it('produces stable output on identical inputs', () => {
    const head = { rows: [row('/a', 90), row('/b', 80)] };
    const base = { rows: [row('/a', 90), row('/b', 85)] };
    const a = compare(head, base);
    const b = compare(head, base);
    assert.deepEqual(a, b);
  });

  it('tolerates missing rows arrays', () => {
    const out = compare({}, {});
    assert.deepEqual(out, { regressions: [], improvements: [], unchanged: [] });
  });
});
