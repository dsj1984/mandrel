import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compare } from '../../../.agents/scripts/lib/baselines/kinds/crap.js';

// ---------------------------------------------------------------------------
// crap.compare.test.js — pure compare(head, base) for the CRAP kind
// (Story #1961 / Task #1966). Higher CRAP is worse. Rows are keyed by
// `path::method@startLine`.
// ---------------------------------------------------------------------------

function row(path, method, startLine, crap) {
  return { path, method, startLine, crap };
}

describe('kinds/crap.compare()', () => {
  it('classifies an increased crap score as a regression', () => {
    const head = { rows: [row('src/a.js', 'foo', 10, 25)] };
    const base = { rows: [row('src/a.js', 'foo', 10, 18)] };
    const out = compare(head, base);
    assert.equal(out.regressions.length, 1);
    assert.equal(out.regressions[0].key, 'src/a.js::foo@10');
  });

  it('classifies a decreased crap score as an improvement', () => {
    const head = { rows: [row('src/a.js', 'foo', 10, 8)] };
    const base = { rows: [row('src/a.js', 'foo', 10, 18)] };
    const out = compare(head, base);
    assert.equal(out.improvements.length, 1);
  });

  it('classifies identical crap as unchanged', () => {
    const head = { rows: [row('src/a.js', 'foo', 10, 10)] };
    const base = { rows: [row('src/a.js', 'foo', 10, 10)] };
    const out = compare(head, base);
    assert.equal(out.unchanged.length, 1);
  });

  it('treats new methods with crap > 0 as regressions', () => {
    const head = { rows: [row('src/new.js', 'bar', 5, 15)] };
    const base = { rows: [] };
    const out = compare(head, base);
    assert.equal(out.regressions.length, 1);
  });

  it('treats removed methods with prior crap as improvements', () => {
    const head = { rows: [] };
    const base = { rows: [row('src/old.js', 'baz', 5, 30)] };
    const out = compare(head, base);
    assert.equal(out.improvements.length, 1);
  });

  it('keys methods independently within the same file', () => {
    const head = {
      rows: [row('src/a.js', 'foo', 10, 5), row('src/a.js', 'bar', 30, 25)],
    };
    const base = {
      rows: [row('src/a.js', 'foo', 10, 5), row('src/a.js', 'bar', 30, 12)],
    };
    const out = compare(head, base);
    assert.equal(out.regressions.length, 1);
    assert.equal(out.unchanged.length, 1);
  });

  it('produces stable output on identical inputs', () => {
    const head = { rows: [row('src/a.js', 'foo', 10, 12)] };
    const base = { rows: [row('src/a.js', 'foo', 10, 8)] };
    const a = compare(head, base);
    const b = compare(head, base);
    assert.deepEqual(a, b);
  });

  it('tolerates missing rows arrays', () => {
    const out = compare({}, {});
    assert.deepEqual(out, { regressions: [], improvements: [], unchanged: [] });
  });
});
