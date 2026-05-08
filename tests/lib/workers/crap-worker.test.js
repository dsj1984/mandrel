import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handleCrapWorkerMessage } from '../../../.agents/scripts/lib/workers/crap-worker.js';

const okItem = {
  abs: '/abs/file.js',
  relPath: 'src/file.js',
  requireCoverage: false,
};

function stubDeps({
  readFile = () => 'export const x = 1;',
  transpile = (_abs, src) => src,
  calculateCrap = () => [],
  findEntry = () => ({ fnMap: {}, statementMap: {}, s: {} }),
} = {}) {
  return { readFile, transpile, calculateCrap, findEntry };
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
  it('requireCoverage + missing entry → skippedFileNoCoverage', () => {
    const out = handleCrapWorkerMessage(
      { item: { ...okItem, requireCoverage: true } },
      null,
      stubDeps({ findEntry: () => null }),
    );
    assert.equal(out.message.ok, true);
    assert.equal(out.message.result.skippedFileNoCoverage, true);
    assert.deepEqual(out.message.result.rows, []);
  });

  it('requireCoverage:false continues even when entry is null', () => {
    const out = handleCrapWorkerMessage(
      { item: okItem },
      null,
      stubDeps({ findEntry: () => null }),
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

  it('skips methods with null crap or null coverage and counts them', () => {
    const methods = [
      { method: 'a', startLine: 5, cyclomatic: 2, coverage: 1, crap: 2 },
      { method: 'b', startLine: 9, cyclomatic: 1, coverage: null, crap: null },
      { method: 'c', startLine: 12, cyclomatic: 3, coverage: 0.8, crap: null },
    ];
    const out = handleCrapWorkerMessage(
      { item: okItem },
      null,
      stubDeps({ calculateCrap: () => methods }),
    );
    assert.equal(out.message.result.rows.length, 1);
    assert.equal(out.message.result.skippedMethodsNoCoverage, 2);
  });
});
