import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compare } from '../../../.agents/scripts/lib/baselines/kinds/crap.js';
import { resolveIncrementalContext } from '../../../.agents/scripts/lib/crap-baseline-join.js';

/**
 * The per-file baseline index, read through its production door.
 *
 * `indexBaselineRowsByFile` / `methodIdentityKey` became module-local when
 * Story #5002 folded `crap-baseline-index.js` into `crap-baseline-join.js` —
 * both callers now live inside that module, so exporting them would have left
 * two entry points nothing in production reaches.
 * `resolveIncrementalContext` is the one that does.
 *
 * @param {Array<object>|undefined} baselineRows
 * @returns {Map<string, Map<string, object>>}
 */
function indexBaselineRowsByFile(baselineRows) {
  return resolveIncrementalContext({ baselineRows }).baselineByFile;
}

// ---------------------------------------------------------------------------
// crap.compare.test.js — pure compare(head, base) for the CRAP kind
// (Story #1961 / Task #1966). Higher CRAP is worse. Rows are keyed by
// `path::method` — no line number reaches the persisted identity.
// ---------------------------------------------------------------------------

function row(path, method, _startLine, crap) {
  return { path, method, crap };
}

describe('kinds/crap.compare()', () => {
  it('classifies an increased crap score as a regression', () => {
    const head = { rows: [row('src/a.js', 'foo', 10, 25)] };
    const base = { rows: [row('src/a.js', 'foo', 10, 18)] };
    const out = compare(head, base);
    assert.equal(out.regressions.length, 1);
    assert.equal(out.regressions[0].key, 'src/a.js::foo');
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

  it('new methods land in additions, not regressions (Story #2012)', () => {
    const head = { rows: [row('src/new.js', 'bar', 5, 15)] };
    const base = { rows: [] };
    const out = compare(head, base);
    assert.equal(out.regressions.length, 0);
    assert.equal(out.additions.length, 1);
    assert.equal(out.additions[0].key, 'src/new.js::bar');
    assert.equal(out.additions[0].base, null);
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
    assert.deepEqual(out, {
      regressions: [],
      improvements: [],
      unchanged: [],
      additions: [],
    });
  });
});

// Story #4981 — the incremental-coverage join reuses this method-identity
// half-key (the row identity minus the file component) rather than reinventing
// file diffing or a second identity scheme.
describe('the per-file baseline index (Story #4981, folded by #5002)', () => {
  it("keys each file's rows by the per-file half of the row identity", () => {
    const idx = indexBaselineRowsByFile([row('src/a.js', 'foo', 10, 25)]);
    assert.deepEqual([...idx.get('src/a.js').keys()], ['foo']);
  });

  it('indexes rows by file, then by method identity', () => {
    const rows = [
      row('src/a.js', 'foo', 10, 25),
      row('src/a.js', 'bar', 20, 5),
      row('src/b.js', 'baz', 1, 3),
    ];
    const idx = indexBaselineRowsByFile(rows);
    assert.equal(idx.size, 2);
    assert.equal(idx.get('src/a.js').get('foo').crap, 25);
    assert.equal(idx.get('src/a.js').get('bar').crap, 5);
    assert.equal(idx.get('src/b.js').get('baz').crap, 3);
  });

  it('accepts the legacy `file` key as well as `path`', () => {
    const idx = indexBaselineRowsByFile([
      { file: 'src/a.js', method: 'foo', crap: 25 },
    ]);
    assert.equal(idx.get('src/a.js').get('foo').crap, 25);
  });

  it('ignores rows with no resolvable file/path and tolerates a missing list', () => {
    assert.equal(indexBaselineRowsByFile([{ method: 'foo' }]).size, 0);
    assert.equal(indexBaselineRowsByFile(undefined).size, 0);
  });
});
