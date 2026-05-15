import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compare } from '../../../.agents/scripts/lib/baselines/kinds/bundle-size.js';

// ---------------------------------------------------------------------------
// bundle-size.compare.test.js — pure compare(head, base) for the
// bundle-size kind (Story #1961 / Task #1963). Higher size is worse.
// ---------------------------------------------------------------------------

function row(bundle, rawKb, gzippedKb) {
  return { bundle, rawKb, gzippedKb };
}

describe('kinds/bundle-size.compare()', () => {
  it('classifies an increased rawKb as a regression', () => {
    const head = { rows: [row('main', 220, 80)] };
    const base = { rows: [row('main', 200, 80)] };
    const out = compare(head, base);
    assert.equal(out.regressions.length, 1);
    assert.equal(out.regressions[0].key, 'main');
  });

  it('classifies a reduced gzippedKb as an improvement', () => {
    const head = { rows: [row('main', 200, 70)] };
    const base = { rows: [row('main', 200, 80)] };
    const out = compare(head, base);
    assert.equal(out.improvements.length, 1);
  });

  it('classifies identical sizes as unchanged', () => {
    const head = { rows: [row('main', 200, 80)] };
    const base = { rows: [row('main', 200, 80)] };
    const out = compare(head, base);
    assert.equal(out.unchanged.length, 1);
  });

  it('new bundles with size > 0 are regressions', () => {
    const head = { rows: [row('vendor', 100, 30)] };
    const base = { rows: [] };
    const out = compare(head, base);
    assert.equal(out.regressions.length, 1);
  });

  it('removed bundles with prior size are improvements', () => {
    const head = { rows: [] };
    const base = { rows: [row('legacy', 50, 20)] };
    const out = compare(head, base);
    assert.equal(out.improvements.length, 1);
  });

  it('produces stable output on identical inputs', () => {
    const head = { rows: [row('main', 200, 80), row('vendor', 100, 30)] };
    const base = { rows: [row('main', 200, 80), row('vendor', 110, 30)] };
    const a = compare(head, base);
    const b = compare(head, base);
    assert.deepEqual(a, b);
  });

  it('tolerates missing rows arrays', () => {
    const out = compare({}, {});
    assert.deepEqual(out, { regressions: [], improvements: [], unchanged: [] });
  });
});
