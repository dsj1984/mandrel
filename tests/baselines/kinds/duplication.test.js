import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyEpsilon,
  compare,
  projectRow,
  rollup,
  sortRows,
} from '../../../.agents/scripts/lib/baselines/kinds/duplication.js';

// ---------------------------------------------------------------------------
// duplication.test.js — pure-function coverage for the code-duplication
// (DRY) kind module (Story #3664). Higher duplication % is worse; the gate
// floor direction is `lte`.
// ---------------------------------------------------------------------------

function row(path, duplicatedLines, totalLines, percentage) {
  return { path, duplicatedLines, totalLines, percentage };
}

describe('kinds/duplication.projectRow()', () => {
  it('canonicalises path and coerces numeric fields', () => {
    const out = projectRow({
      path: 'src/a.js',
      duplicatedLines: '10',
      totalLines: '100',
      percentage: '10',
    });
    assert.deepEqual(out, {
      path: 'src/a.js',
      duplicatedLines: 10,
      totalLines: 100,
      percentage: 10,
    });
  });

  it('derives percentage from line counts when omitted', () => {
    const out = projectRow({
      path: 'src/a.js',
      duplicatedLines: 30,
      totalLines: 120,
    });
    assert.equal(out.percentage, 25);
  });

  it('accepts a `file` alias for the path field', () => {
    const out = projectRow({
      file: 'src/b.js',
      duplicatedLines: 0,
      totalLines: 50,
    });
    assert.equal(out.path, 'src/b.js');
    assert.equal(out.percentage, 0);
  });
});

describe('kinds/duplication.rollup()', () => {
  it('recomputes the aggregate ratio from raw line counts, not an average', () => {
    // A naive average of [50%, 0%] would be 25%. The exact aggregate is
    // 5 duplicated of 110 total = 4.55%.
    const rows = [row('src/big.js', 0, 100, 0), row('src/small.js', 5, 10, 50)];
    const out = rollup(rows);
    assert.equal(out['*'].duplicatedLines, 5);
    assert.equal(out['*'].totalLines, 110);
    assert.equal(out['*'].percentage, 4.55);
    assert.equal(out['*'].filesWithDuplication, 1);
  });

  it('returns a zeroed `*` rollup for an empty row set', () => {
    const out = rollup([]);
    assert.deepEqual(out['*'], {
      percentage: 0,
      duplicatedLines: 0,
      totalLines: 0,
      filesWithDuplication: 0,
    });
  });

  it('always carries the `*` key even with no components', () => {
    const out = rollup([row('src/a.js', 1, 10, 10)]);
    assert.ok(Object.hasOwn(out, '*'));
  });
});

describe('kinds/duplication.compare()', () => {
  it('classifies an increased percentage as a regression', () => {
    const head = { rows: [row('src/a.js', 20, 100, 20)] };
    const base = { rows: [row('src/a.js', 10, 100, 10)] };
    const out = compare(head, base);
    assert.equal(out.regressions.length, 1);
    assert.equal(out.regressions[0].key, 'src/a.js');
    assert.equal(out.improvements.length, 0);
  });

  it('classifies a decreased percentage as an improvement', () => {
    const head = { rows: [row('src/a.js', 5, 100, 5)] };
    const base = { rows: [row('src/a.js', 10, 100, 10)] };
    const out = compare(head, base);
    assert.equal(out.improvements.length, 1);
    assert.equal(out.regressions.length, 0);
  });

  it('classifies an equal percentage as unchanged', () => {
    const head = { rows: [row('src/a.js', 10, 100, 10)] };
    const base = { rows: [row('src/a.js', 10, 100, 10)] };
    const out = compare(head, base);
    assert.equal(out.unchanged.length, 1);
  });

  it('new paths land in additions, never regressions', () => {
    const head = { rows: [row('src/new.js', 40, 100, 40)] };
    const base = { rows: [] };
    const out = compare(head, base);
    assert.equal(out.additions.length, 1);
    assert.equal(out.regressions.length, 0);
  });

  it('removed paths with prior duplication count as improvements', () => {
    const head = { rows: [] };
    const base = { rows: [row('src/gone.js', 10, 100, 10)] };
    const out = compare(head, base);
    assert.equal(out.improvements.length, 1);
    assert.equal(out.improvements[0].key, 'src/gone.js');
  });

  it('removed clean paths (0%) count as unchanged', () => {
    const head = { rows: [] };
    const base = { rows: [row('src/clean.js', 0, 100, 0)] };
    const out = compare(head, base);
    assert.equal(out.unchanged.length, 1);
    assert.equal(out.improvements.length, 0);
  });
});

describe('kinds/duplication.applyEpsilon()', () => {
  const prior = [row('src/a.js', 10, 100, 10)];

  it('under-epsilon: prior row bytes preserved', () => {
    const regen = [row('src/a.js', 10, 100, 10.3)];
    const out = applyEpsilon(prior, regen, 0.5);
    assert.deepEqual(out, prior);
  });

  it('over-epsilon: regenerated row wins', () => {
    const regen = [row('src/a.js', 12, 100, 12)];
    const out = applyEpsilon(prior, regen, 0.5);
    assert.deepEqual(out, regen);
  });

  it('missing-prior rows fall through to regenerated', () => {
    const regen = [row('src/new.js', 5, 100, 5)];
    const out = applyEpsilon(prior, regen, 0.5);
    assert.deepEqual(out, regen);
  });

  it('treats a negative epsilon as 0 (exact-match only preserves)', () => {
    const regen = [row('src/a.js', 10, 100, 10.01)];
    const out = applyEpsilon(prior, regen, -1);
    assert.deepEqual(out, regen);
  });
});

describe('kinds/duplication.sortRows()', () => {
  it('sorts rows by path ascending', () => {
    const rows = [row('src/b.js', 1, 10, 10), row('src/a.js', 1, 10, 10)];
    const out = sortRows(rows);
    assert.deepEqual(
      out.map((r) => r.path),
      ['src/a.js', 'src/b.js'],
    );
  });
});
