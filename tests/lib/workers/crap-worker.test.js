import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handleCrapWorkerMessage } from '../../../.agents/scripts/lib/workers/crap-worker.js';

// Coverage is now pre-resolved on the host and attached as item.coverageEntry.
const STUB_ENTRY = { fnMap: {}, statementMap: {}, s: {} };

const okItem = {
  abs: '/abs/file.js',
  relPath: 'src/file.js',
  requireCoverage: false,
  coverageEntry: STUB_ENTRY,
};

// One resolved method and two the coverage join could not resolve — `b` has
// no coverage at all, `c` resolved a ratio but no crap (a malformed row).
const UNRESOLVED_METHODS = [
  { method: 'a', startLine: 5, cyclomatic: 2, coverage: 1, crap: 2 },
  { method: 'b', startLine: 9, cyclomatic: 1, coverage: null, crap: null },
  { method: 'c', startLine: 12, cyclomatic: 3, coverage: 0.8, crap: null },
];

function stubDeps({
  readFile = () => 'export const x = 1;',
  transpile = (_abs, src) => src,
  calculateCrap = () => [],
} = {}) {
  return { readFile, transpile, calculateCrap };
}

describe('handleCrapWorkerMessage — control messages', () => {
  it('exit:true returns kind=exit', () => {
    assert.deepEqual(handleCrapWorkerMessage({ exit: true }, null), {
      kind: 'exit',
    });
  });

  it('rejects messages with no item', () => {
    const out = handleCrapWorkerMessage({}, null, stubDeps());
    assert.equal(out.kind, 'reply');
    assert.equal(out.message.ok, false);
    assert.match(out.message.error, /bad worker message/);
  });

  it('rejects messages with non-string abs', () => {
    const out = handleCrapWorkerMessage(
      { item: { abs: 5, relPath: 'a' } },
      null,
      stubDeps(),
    );
    assert.equal(out.message.ok, false);
  });

  it('rejects messages with non-string relPath', () => {
    const out = handleCrapWorkerMessage(
      { item: { abs: 'a', relPath: null } },
      null,
      stubDeps(),
    );
    assert.equal(out.message.ok, false);
  });
});

describe('handleCrapWorkerMessage — coverage gate', () => {
  it('requireCoverage + missing entry (null coverageEntry) → skippedFileNoCoverage', () => {
    const out = handleCrapWorkerMessage(
      { item: { ...okItem, requireCoverage: true, coverageEntry: null } },
      null,
      stubDeps(),
    );
    assert.equal(out.message.ok, true);
    assert.equal(out.message.result.skippedFileNoCoverage, true);
    assert.deepEqual(out.message.result.rows, []);
  });

  it('requireCoverage + missing entry (undefined coverageEntry) → skippedFileNoCoverage', () => {
    const { coverageEntry: _, ...itemNoCov } = okItem;
    const out = handleCrapWorkerMessage(
      { item: { ...itemNoCov, requireCoverage: true } },
      null,
      stubDeps(),
    );
    assert.equal(out.message.ok, true);
    assert.equal(out.message.result.skippedFileNoCoverage, true);
  });

  it('requireCoverage:false continues even when coverageEntry is null', () => {
    const out = handleCrapWorkerMessage(
      { item: { ...okItem, coverageEntry: null } },
      null,
      stubDeps(),
    );
    assert.equal(out.message.result.skippedFileNoCoverage, false);
    assert.deepEqual(out.message.result.rows, []);
  });
});

describe('handleCrapWorkerMessage — failure isolation', () => {
  it('readFile throws → rows=null, no error propagation', () => {
    const out = handleCrapWorkerMessage(
      { item: okItem },
      null,
      stubDeps({
        readFile: () => {
          throw new Error('ENOENT');
        },
      }),
    );
    assert.equal(out.message.ok, true);
    assert.equal(out.message.result.rows, null);
  });

  it('transpile returns null → rows=null', () => {
    const out = handleCrapWorkerMessage(
      { item: okItem },
      null,
      stubDeps({ transpile: () => null }),
    );
    assert.equal(out.message.result.rows, null);
  });

  it('calculateCrap throws Error → rows=null + error string', () => {
    const out = handleCrapWorkerMessage(
      { item: okItem },
      null,
      stubDeps({
        calculateCrap: () => {
          throw new Error('parse failed');
        },
      }),
    );
    assert.equal(out.message.result.rows, null);
    assert.equal(out.message.result.error, 'parse failed');
  });

  it('calculateCrap returns UNSCORABLE (null) → rows=null, not an empty scored file', () => {
    // Story #5311: the kernel signals an unparseable source with `null`. This
    // branch is the whole reason the drop path exists — collapsing it into
    // `rows: []` reported the file as scored-with-no-methods and took its
    // baseline rows with it, silently.
    const out = handleCrapWorkerMessage(
      { item: okItem },
      null,
      stubDeps({ calculateCrap: () => null }),
    );
    assert.equal(out.message.ok, true);
    assert.equal(out.message.result.rows, null);
    assert.equal(out.message.result.skippedFileNoCoverage, false);
  });

  it('calculateCrap throws non-Error → error stringified', () => {
    const out = handleCrapWorkerMessage(
      { item: okItem },
      null,
      stubDeps({
        calculateCrap: () => {
          throw 'literal string thrown';
        },
      }),
    );
    assert.equal(out.message.result.error, 'literal string thrown');
  });
});

describe('handleCrapWorkerMessage — success rows', () => {
  it('returns rows for fully-covered methods', () => {
    const methods = [
      { method: 'a', startLine: 5, cyclomatic: 2, coverage: 1, crap: 2 },
      { method: 'b', startLine: 9, cyclomatic: 4, coverage: 0.5, crap: 6 },
    ];
    const out = handleCrapWorkerMessage(
      { item: okItem },
      null,
      stubDeps({ calculateCrap: () => methods }),
    );
    assert.equal(out.message.result.rows.length, 2);
    assert.equal(out.message.result.skippedMethodsNoCoverage, 0);
  });

  it('skips methods with null crap or null coverage under requireCoverage', () => {
    const out = handleCrapWorkerMessage(
      { item: { ...okItem, requireCoverage: true } },
      null,
      stubDeps({ calculateCrap: () => UNRESOLVED_METHODS }),
    );
    assert.equal(out.message.result.rows.length, 1);
    assert.equal(out.message.result.skippedMethodsNoCoverage, 2);
    assert.equal(out.message.result.resolvedMethods, 1);
    assert.equal(out.message.result.totalMethods, 3);
  });

  it('scores unresolved methods at 0% when requireCoverage is false', () => {
    // Story #4775 (AC-5): the flag means "score it anyway". Dropping the
    // method individually made it a no-op for baseline population.
    const out = handleCrapWorkerMessage(
      { item: { ...okItem, requireCoverage: false } },
      null,
      stubDeps({ calculateCrap: () => UNRESOLVED_METHODS }),
    );
    assert.equal(out.message.result.rows.length, 3);
    assert.equal(out.message.result.skippedMethodsNoCoverage, 0);
    for (const name of ['b', 'c']) {
      const row = out.message.result.rows.find((r) => r.method === name);
      assert.equal(row.coverage, 0);
      assert.equal(row.crap, row.cyclomatic ** 2 + row.cyclomatic);
    }
    // The telemetry still reports the JOIN, not the fill.
    assert.equal(out.message.result.resolvedMethods, 1);
    assert.equal(out.message.result.totalMethods, 3);
  });
});
