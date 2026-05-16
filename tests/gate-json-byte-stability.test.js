import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCrapReport,
  compareCrap,
} from '../.agents/scripts/lib/baselines/kinds/crap.js';
import { buildMaintainabilityReport } from '../.agents/scripts/lib/baselines/kinds/maintainability.js';

/**
 * Story #1476 — snapshot guard that the `--json` envelopes from the
 * baseline gates are byte-stable across the lib/gates/* refactor. The
 * inline snapshots below were captured against the pre-refactor scorers
 * and are pinned so any future change to the envelope shape (or the
 * ordering of its keys) trips this test rather than silently breaking
 * downstream tooling (`quality-preview`, the auto-refresh evaluator).
 */

describe('check-crap --json envelope — byte stability', () => {
  it('regression envelope serialises to the canonical snapshot', () => {
    const currentRows = [
      {
        file: 'lib/a.js',
        method: 'doWork',
        startLine: 42,
        cyclomatic: 8,
        coverage: 0.2,
        crap: 40.768,
      },
    ];
    const baselineRows = [
      { file: 'lib/a.js', method: 'doWork', startLine: 42, crap: 18 },
    ];
    const envelope = buildCrapReport({
      compareResult: compareCrap({
        currentRows,
        baselineRows,
        newMethodCeiling: 30,
        tolerance: 0.001,
      }),
      scanSummary: { skippedFilesNoCoverage: 0, skippedMethodsNoCoverage: 0 },
      kernelVersion: '1.1.0',
      escomplexVersion: '7.3.2',
      newMethodCeiling: 30,
      scopeInfo: { scope: 'diff', diffRef: 'main' },
    });

    const serialised = JSON.stringify(envelope, null, 2);
    const expected = `{
  "kernelVersion": "1.1.0",
  "escomplexVersion": "7.3.2",
  "summary": {
    "total": 1,
    "regressions": 1,
    "newViolations": 0,
    "drifted": 0,
    "removed": 0,
    "skippedNoCoverage": 0,
    "scope": "diff",
    "diffRef": "main"
  },
  "violations": [
    {
      "file": "lib/a.js",
      "method": "doWork",
      "startLine": 42,
      "cyclomatic": 8,
      "coverage": 0.2,
      "crap": 40.768,
      "baseline": 18,
      "ceiling": 30,
      "kind": "regression",
      "fixGuidance": {
        "crapCeiling": 18,
        "minComplexityAt100Cov": 4,
        "minCoverageAtCurrentComplexity": 0.46139132749202905
      }
    }
  ]
}`;
    assert.equal(serialised, expected);
  });

  it('empty envelope serialises to the canonical snapshot', () => {
    const envelope = buildCrapReport({
      compareResult: compareCrap({
        currentRows: [],
        baselineRows: [],
        newMethodCeiling: 30,
        tolerance: 0.001,
      }),
      scanSummary: {},
      kernelVersion: '1.1.0',
      escomplexVersion: '7.3.2',
      newMethodCeiling: 30,
      scopeInfo: { scope: 'full', diffRef: null },
    });
    const expected = `{
  "kernelVersion": "1.1.0",
  "escomplexVersion": "7.3.2",
  "summary": {
    "total": 0,
    "regressions": 0,
    "newViolations": 0,
    "drifted": 0,
    "removed": 0,
    "skippedNoCoverage": 0,
    "scope": "full",
    "diffRef": null
  },
  "violations": []
}`;
    assert.equal(JSON.stringify(envelope, null, 2), expected);
  });
});

describe('check-maintainability --json envelope — byte stability', () => {
  it('regression envelope serialises to the canonical snapshot', () => {
    const scores = { 'lib/x.js': 70.5, 'lib/y.js': 82 };
    const stats = {
      regressions: 1,
      newFiles: 0,
      improvements: 0,
      regressedFiles: [
        { file: 'lib/x.js', current: 70.5, baseline: 85, drop: 14.5 },
      ],
    };
    const envelope = buildMaintainabilityReport(scores, stats, {
      scope: 'diff',
      diffRef: 'main',
    });
    const expected = `{
  "kernelVersion": "1.1.0",
  "summary": {
    "total": 2,
    "regressions": 1,
    "newFiles": 0,
    "improvements": 0,
    "scope": "diff",
    "diffRef": "main"
  },
  "violations": [
    {
      "file": "lib/x.js",
      "current": 70.5,
      "baseline": 85,
      "drop": 14.5,
      "kind": "regression"
    }
  ]
}`;
    assert.equal(JSON.stringify(envelope, null, 2), expected);
  });

  it('empty envelope serialises to the canonical snapshot', () => {
    const envelope = buildMaintainabilityReport(
      {},
      { regressions: 0, newFiles: 0, improvements: 0, regressedFiles: [] },
      { scope: 'full', diffRef: null },
    );
    const expected = `{
  "kernelVersion": "1.1.0",
  "summary": {
    "total": 0,
    "regressions": 0,
    "newFiles": 0,
    "improvements": 0,
    "scope": "full",
    "diffRef": null
  },
  "violations": []
}`;
    assert.equal(JSON.stringify(envelope, null, 2), expected);
  });
});
