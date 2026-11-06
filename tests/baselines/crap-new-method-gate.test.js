import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareCrap } from '../../.agents/scripts/lib/baselines/kinds/crap.js';
import {
  finalizeMethodRowsWithBaseline,
  resolveIncrementalContext,
  resolveQueueIncrementalFields,
  shouldSkipFileForNoCoverage,
} from '../../.agents/scripts/lib/crap-baseline-join.js';

// ---------------------------------------------------------------------------
// Story #5002 — the new-method ceiling stops capping untestable CLI wiring.
//
// `crap = c²·(1 − cov)³ + c` collapses to `c² + c` at zero coverage, so the
// default ceiling of 30 caps a brand-new method in an untested file at c ≈ 5.
// For argv parsing, `spawn` wiring and a CLI's top-level `main()` — code that
// is untestable by construction — that is a fragmentation tax, not a quality
// signal. A new method in a file whose every method scored 0% is therefore
// judged on its complexity term alone; every other file is unchanged.
// ---------------------------------------------------------------------------

/** A scanned row, defaulted to the shape `compareCrap` expects. */
function row({ file, method, startLine = 1, cyclomatic, coverage }) {
  return {
    file,
    method,
    startLine,
    cyclomatic,
    coverage,
    // The formula the scanner would have produced for this pair.
    crap: cyclomatic ** 2 * (1 - coverage) ** 3 + cyclomatic,
  };
}

const CEILING = 30;

function compareNew(currentRows) {
  return compareCrap({
    currentRows,
    baselineRows: [],
    newMethodCeiling: CEILING,
    tolerance: 0.001,
  });
}

describe('compareCrap — new-method ceiling in an uncovered file (#5002)', () => {
  it('AC-3: c=8 in an all-zero-coverage file clears the ceiling', () => {
    // c² + c = 72, far above the ceiling of 30. Complexity alone is 8.
    const wiring = row({
      file: '.agents/scripts/some-cli.js',
      method: 'main',
      cyclomatic: 8,
      coverage: 0,
    });
    assert.equal(wiring.crap, 72, 'fixture must be over the ceiling as scored');

    const result = compareNew([wiring]);
    assert.equal(result.newViolations, 0);
    assert.deepEqual(result.violations, []);
  });

  it('AC-3: the same method in a partially-covered file still scores c² + c', () => {
    const file = '.agents/scripts/lib/some-lib.js';
    const result = compareNew([
      row({ file, method: 'main', startLine: 1, cyclomatic: 8, coverage: 0 }),
      // One covered sibling is what makes the file "partially covered": the
      // tests reach this source, so a 0%-covered method in it is a measured
      // gap rather than an absent test surface.
      row({
        file,
        method: 'helper',
        startLine: 40,
        cyclomatic: 2,
        coverage: 1,
      }),
    ]);
    assert.equal(result.newViolations, 1);
    assert.equal(result.violations[0].method, 'main');
    assert.equal(result.violations[0].crap, 72);
    assert.equal(
      result.violations[0].gateScore,
      undefined,
      'a partially-covered file must be judged on the measured crap',
    );
  });

  it('still refuses a genuinely sprawling method in an uncovered file', () => {
    // The relief is the coverage term, not the ceiling: c alone must clear it.
    const result = compareNew([
      row({
        file: '.agents/scripts/sprawl.js',
        method: 'everything',
        cyclomatic: 41,
        coverage: 0,
      }),
    ]);
    assert.equal(result.newViolations, 1);
    assert.equal(result.violations[0].gateScore, 41);
    assert.ok(
      result.violations[0].crap > result.violations[0].gateScore,
      'the measured crap is preserved on the violation for the report',
    );
  });

  it('leaves an existing method regressing in an uncovered file alone', () => {
    // The relief is scoped to the NEW-method arm. A method with a baseline row
    // is still ratcheted against its own prior score.
    const file = '.agents/scripts/tracked.js';
    const result = compareCrap({
      currentRows: [row({ file, method: 'run', cyclomatic: 8, coverage: 0 })],
      baselineRows: [{ file, method: 'run', startLine: 1, crap: 6 }],
      newMethodCeiling: CEILING,
      tolerance: 0.001,
    });
    assert.equal(result.regressions, 1);
    assert.equal(result.newViolations, 0);
  });

  it('does not treat an unscorable-only file as uncovered', () => {
    // `coverage: null` is an absent observation, not a measured zero — it must
    // not buy a method the complexity-only ceiling.
    const file = '.agents/scripts/unmeasured.js';
    const result = compareNew([
      {
        file,
        method: 'a',
        startLine: 1,
        cyclomatic: 8,
        coverage: null,
        crap: null,
      },
      row({ file, method: 'b', startLine: 20, cyclomatic: 8, coverage: 0.5 }),
    ]);
    assert.equal(result.unscorable, 1);
    // `b` scores 8²·0.125 + 8 = 12, under the ceiling — the point is only that
    // it was judged on its crap, which the uncovered arm would not have done.
    assert.equal(result.violations.length, 0);
  });
});

describe('crap-baseline-join — the folded module is the one door (#5002)', () => {
  it('AC-4: every former crap-utils-incremental / crap-baseline-index export resolves here', () => {
    // `crap-baseline-index.js` and `crap-utils-incremental.js` are gone. The
    // two the scanner still calls across a module boundary are exported here;
    // `methodIdentityKey` / `indexBaselineRowsByFile` became module-local
    // because both of their callers moved inside this file, and
    // `shouldRunSerial` / `resolvedFromBaselineFlag` inlined at their single
    // call sites in `crap-utils.js#scanAndScore`.
    for (const fn of [
      resolveIncrementalContext,
      resolveQueueIncrementalFields,
      shouldSkipFileForNoCoverage,
      finalizeMethodRowsWithBaseline,
    ]) {
      assert.equal(typeof fn, 'function');
    }
  });

  it('AC-4: the folded index keys rows by method key, per file', () => {
    const { baselineByFile, touchedFiles } = resolveIncrementalContext({
      touchedFiles: ['a.js'],
      baselineRows: [
        { path: 'a.js', method: 'run', crap: 2 },
        { file: 'b.js', method: 'other', crap: 4 },
      ],
    });
    assert.ok(touchedFiles.has('a.js'));
    assert.equal(baselineByFile.get('a.js').get('run').crap, 2);
    assert.equal(baselineByFile.get('b.js').get('other').crap, 4);
  });

  it('AC-4: the queue wiring and the file-skip decision still compose', () => {
    const ctx = resolveIncrementalContext({
      touchedFiles: [],
      baselineRows: [{ file: 'b.js', method: 'other', crap: 4 }],
    });
    const item = resolveQueueIncrementalFields(
      { abs: '/abs/b.js', relPath: 'b.js', requireCoverage: true },
      ctx,
    );
    assert.equal(item.touched, false);
    // An untouched file with an indexed baseline row is NOT skipped for want
    // of a fresh coverage entry — that is the whole point of the join.
    assert.equal(
      shouldSkipFileForNoCoverage(true, null, item.touched, item.baselineByKey),
      false,
    );
    // A touched one still is.
    assert.equal(shouldSkipFileForNoCoverage(true, null, true, null), true);
  });
});
