import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handleCombinedMiCrapWorkerMessage } from '../../../.agents/scripts/lib/workers/combined-mi-crap-worker.js';

/**
 * Story #4192 — unit coverage for the combined MI + CRAP worker handler. The
 * handler derives BOTH the maintainability score and the CRAP method rows from
 * a single `analyzeOnce` parse. These tests pin every branch (bad-shape
 * rejection, read/transpile/parse failures, the coverage gate, success rows,
 * skipped methods) and — crucially — the invariant that the MI score is always
 * computed even when the CRAP coverage gate skips the file.
 */

const STUB_ENTRY = { fnMap: {}, statementMap: {}, s: {} };

const okItem = {
  abs: '/abs/file.js',
  relPath: 'src/file.js',
  requireCoverage: false,
  coverageEntry: STUB_ENTRY,
};

function stubDeps({
  readFile = () => 'export const x = 1;',
  transpile = (_abs, src) => src,
  analyze = () => ({ miScore: 80, crapRows: [], parseError: false }),
} = {}) {
  return { readFile, transpile, analyze };
}

describe('handleCombinedMiCrapWorkerMessage — control messages', () => {
  it('exit:true returns kind=exit', () => {
    assert.deepEqual(handleCombinedMiCrapWorkerMessage({ exit: true }), {
      kind: 'exit',
    });
  });

  it('rejects messages with no item', () => {
    const out = handleCombinedMiCrapWorkerMessage({}, stubDeps());
    assert.equal(out.kind, 'reply');
    assert.equal(out.message.ok, false);
    assert.match(out.message.error, /bad worker message/);
  });

  it('rejects messages with non-string abs', () => {
    const out = handleCombinedMiCrapWorkerMessage(
      { item: { abs: 5, relPath: 'a' } },
      stubDeps(),
    );
    assert.equal(out.message.ok, false);
  });

  it('rejects messages with non-string relPath', () => {
    const out = handleCombinedMiCrapWorkerMessage(
      { item: { abs: 'a', relPath: null } },
      stubDeps(),
    );
    assert.equal(out.message.ok, false);
  });
});

describe('handleCombinedMiCrapWorkerMessage — failure isolation', () => {
  it('readFile throws → miScore null AND crapRows null', () => {
    const out = handleCombinedMiCrapWorkerMessage(
      { item: okItem },
      stubDeps({
        readFile: () => {
          throw new Error('ENOENT');
        },
      }),
    );
    assert.equal(out.message.ok, true);
    assert.equal(out.message.result.miScore, null);
    assert.equal(out.message.result.crapRows, null);
  });

  it('transpile returns null → miScore 0 AND crapRows null', () => {
    const out = handleCombinedMiCrapWorkerMessage(
      { item: okItem },
      stubDeps({ transpile: () => null }),
    );
    assert.equal(out.message.result.miScore, 0);
    assert.equal(out.message.result.crapRows, null);
  });

  it('parse error → miScore 0 AND crapRows null', () => {
    const out = handleCombinedMiCrapWorkerMessage(
      { item: okItem },
      stubDeps({
        analyze: () => ({ miScore: 0, crapRows: [], parseError: true }),
      }),
    );
    assert.equal(out.message.result.miScore, 0);
    assert.equal(out.message.result.crapRows, null);
  });
});

describe('handleCombinedMiCrapWorkerMessage — coverage gate', () => {
  it('requireCoverage + null entry → skippedFileNoCoverage but MI STILL computed', () => {
    const out = handleCombinedMiCrapWorkerMessage(
      {
        item: { ...okItem, requireCoverage: true, coverageEntry: null },
      },
      stubDeps({
        analyze: () => ({ miScore: 73.5, crapRows: [], parseError: false }),
      }),
    );
    assert.equal(out.message.ok, true);
    assert.equal(out.message.result.skippedFileNoCoverage, true);
    assert.deepEqual(out.message.result.crapRows, []);
    // The load-bearing MI invariant: the module score is returned even though
    // CRAP skipped the file — MI never required coverage.
    assert.equal(out.message.result.miScore, 73.5);
  });

  it('requireCoverage + undefined entry → skippedFileNoCoverage, MI computed', () => {
    const { coverageEntry: _drop, ...itemNoCov } = okItem;
    const out = handleCombinedMiCrapWorkerMessage(
      { item: { ...itemNoCov, requireCoverage: true } },
      stubDeps({
        analyze: () => ({ miScore: 90, crapRows: [], parseError: false }),
      }),
    );
    assert.equal(out.message.result.skippedFileNoCoverage, true);
    assert.equal(out.message.result.miScore, 90);
  });

  it('requireCoverage:false continues even when coverageEntry is null', () => {
    const out = handleCombinedMiCrapWorkerMessage(
      { item: { ...okItem, coverageEntry: null } },
      stubDeps(),
    );
    assert.equal(out.message.result.skippedFileNoCoverage, false);
    assert.deepEqual(out.message.result.crapRows, []);
  });
});

describe('handleCombinedMiCrapWorkerMessage — success rows', () => {
  it('returns miScore and CRAP rows for fully-covered methods', () => {
    const rawRows = [
      { method: 'a', startLine: 5, cyclomatic: 2, coverage: 1, crap: 2 },
      { method: 'b', startLine: 9, cyclomatic: 4, coverage: 0.5, crap: 6 },
    ];
    const out = handleCombinedMiCrapWorkerMessage(
      { item: okItem },
      stubDeps({
        analyze: () => ({
          miScore: 65.25,
          crapRows: rawRows,
          parseError: false,
        }),
      }),
    );
    assert.equal(out.message.result.miScore, 65.25);
    assert.equal(out.message.result.crapRows.length, 2);
    assert.equal(out.message.result.skippedMethodsNoCoverage, 0);
  });

  it('skips methods with null crap or null coverage and counts them', () => {
    const rawRows = [
      { method: 'a', startLine: 5, cyclomatic: 2, coverage: 1, crap: 2 },
      { method: 'b', startLine: 9, cyclomatic: 1, coverage: null, crap: null },
      { method: 'c', startLine: 12, cyclomatic: 3, coverage: 0.8, crap: null },
    ];
    const out = handleCombinedMiCrapWorkerMessage(
      { item: okItem },
      stubDeps({
        analyze: () => ({ miScore: 50, crapRows: rawRows, parseError: false }),
      }),
    );
    assert.equal(out.message.result.crapRows.length, 1);
    assert.equal(out.message.result.skippedMethodsNoCoverage, 2);
    assert.equal(out.message.result.miScore, 50);
  });
});
