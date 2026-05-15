/**
 * applyEpsilon.test.js — per-kind epsilon stabilizer (Story #1964 / Task #1971).
 *
 * Each of the seven shipped kinds exports `applyEpsilon(prior, regenerated,
 * epsilon)`. The stabilizer is pure: under-epsilon row deltas resolve to
 * the prior row bytes (so the writer never re-serialises sub-significant
 * env variance), over-epsilon deltas yield the regenerated row, and rows
 * missing from `prior` always fall through to the regenerated row.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as bundleSize from '../../../.agents/scripts/lib/baselines/kinds/bundle-size.js';
import * as coverage from '../../../.agents/scripts/lib/baselines/kinds/coverage.js';
import * as crap from '../../../.agents/scripts/lib/baselines/kinds/crap.js';
import * as lighthouse from '../../../.agents/scripts/lib/baselines/kinds/lighthouse.js';
import * as lint from '../../../.agents/scripts/lib/baselines/kinds/lint.js';
import * as maintainability from '../../../.agents/scripts/lib/baselines/kinds/maintainability.js';
import * as mutation from '../../../.agents/scripts/lib/baselines/kinds/mutation.js';

const ALL_KINDS = [
  ['coverage', coverage],
  ['crap', crap],
  ['maintainability', maintainability],
  ['mutation', mutation],
  ['lint', lint],
  ['lighthouse', lighthouse],
  ['bundle-size', bundleSize],
];

describe('applyEpsilon export — every kind', () => {
  for (const [name, mod] of ALL_KINDS) {
    it(`${name} exports a callable applyEpsilon`, () => {
      assert.equal(
        typeof mod.applyEpsilon,
        'function',
        `${name}.applyEpsilon must be a function`,
      );
    });
  }
});

describe('coverage.applyEpsilon', () => {
  const prior = [{ path: 'src/a.js', lines: 90, branches: 80, functions: 100 }];
  const regenUnder = [
    { path: 'src/a.js', lines: 90.05, branches: 80, functions: 100 },
  ];
  const regenOver = [
    { path: 'src/a.js', lines: 91, branches: 80, functions: 100 },
  ];

  it('under-epsilon: prior row bytes preserved', () => {
    const out = coverage.applyEpsilon(prior, regenUnder, 0.1);
    assert.deepEqual(out, prior);
  });
  it('over-epsilon: regenerated wins', () => {
    const out = coverage.applyEpsilon(prior, regenOver, 0.1);
    assert.deepEqual(out, regenOver);
  });
  it('missing-prior: regenerated wins', () => {
    const newRow = [
      { path: 'src/new.js', lines: 50, branches: 50, functions: 50 },
    ];
    const out = coverage.applyEpsilon(prior, newRow, 0.1);
    assert.deepEqual(out, newRow);
  });
});

describe('crap.applyEpsilon', () => {
  const prior = [
    { path: 'src/a.js', method: 'foo', startLine: 10, crap: 4.2 },
  ];
  const regenUnder = [
    { path: 'src/a.js', method: 'foo', startLine: 10, crap: 4.5 },
  ];
  const regenOver = [
    { path: 'src/a.js', method: 'foo', startLine: 10, crap: 6.0 },
  ];

  it('under-epsilon: prior row bytes preserved', () => {
    const out = crap.applyEpsilon(prior, regenUnder, 0.5);
    assert.deepEqual(out, prior);
  });
  it('over-epsilon: regenerated wins', () => {
    const out = crap.applyEpsilon(prior, regenOver, 0.5);
    assert.deepEqual(out, regenOver);
  });
  it('missing-prior (different method): regenerated wins', () => {
    const newRow = [
      { path: 'src/a.js', method: 'bar', startLine: 20, crap: 1 },
    ];
    const out = crap.applyEpsilon(prior, newRow, 0.5);
    assert.deepEqual(out, newRow);
  });
});

describe('maintainability.applyEpsilon', () => {
  const prior = [{ path: 'src/a.js', mi: 72 }];
  const regenUnder = [{ path: 'src/a.js', mi: 72.3 }];
  const regenOver = [{ path: 'src/a.js', mi: 70 }];

  it('under-epsilon: prior row bytes preserved', () => {
    const out = maintainability.applyEpsilon(prior, regenUnder, 0.5);
    assert.deepEqual(out, prior);
  });
  it('over-epsilon: regenerated wins', () => {
    const out = maintainability.applyEpsilon(prior, regenOver, 0.5);
    assert.deepEqual(out, regenOver);
  });
  it('missing-prior: regenerated wins', () => {
    const newRow = [{ path: 'src/new.js', mi: 95 }];
    const out = maintainability.applyEpsilon(prior, newRow, 0.5);
    assert.deepEqual(out, newRow);
  });
});

describe('mutation.applyEpsilon', () => {
  const prior = [{ path: 'src/a.js', score: 80, killed: 8, survived: 2 }];
  const regenUnder = [
    { path: 'src/a.js', score: 80.3, killed: 8, survived: 2 },
  ];
  const regenOver = [{ path: 'src/a.js', score: 75, killed: 7, survived: 3 }];

  it('under-epsilon: prior row bytes preserved', () => {
    const out = mutation.applyEpsilon(prior, regenUnder, 0.5);
    assert.deepEqual(out, prior);
  });
  it('over-epsilon: regenerated wins', () => {
    const out = mutation.applyEpsilon(prior, regenOver, 0.5);
    assert.deepEqual(out, regenOver);
  });
  it('missing-prior: regenerated wins', () => {
    const newRow = [{ path: 'src/new.js', score: 50, killed: 5, survived: 5 }];
    const out = mutation.applyEpsilon(prior, newRow, 0.5);
    assert.deepEqual(out, newRow);
  });
});

describe('lint.applyEpsilon', () => {
  const prior = [{ path: 'src/a.js', errorCount: 0, warningCount: 1 }];
  const regenSame = [{ path: 'src/a.js', errorCount: 0, warningCount: 1 }];
  const regenOver = [{ path: 'src/a.js', errorCount: 1, warningCount: 1 }];

  it('under-epsilon (zero delta, eps=0): prior row bytes preserved', () => {
    const out = lint.applyEpsilon(prior, regenSame, 0);
    assert.deepEqual(out, prior);
  });
  it('over-epsilon: regenerated wins', () => {
    const out = lint.applyEpsilon(prior, regenOver, 0);
    assert.deepEqual(out, regenOver);
  });
  it('missing-prior: regenerated wins', () => {
    const newRow = [{ path: 'src/new.js', errorCount: 2, warningCount: 0 }];
    const out = lint.applyEpsilon(prior, newRow, 0);
    assert.deepEqual(out, newRow);
  });
});

describe('lighthouse.applyEpsilon', () => {
  const prior = [
    {
      route: '/',
      performance: 90,
      accessibility: 95,
      bestPractices: 92,
      seo: 100,
    },
  ];
  const regenUnder = [
    {
      route: '/',
      performance: 90.5,
      accessibility: 95,
      bestPractices: 92,
      seo: 100,
    },
  ];
  const regenOver = [
    {
      route: '/',
      performance: 85,
      accessibility: 95,
      bestPractices: 92,
      seo: 100,
    },
  ];

  it('under-epsilon: prior row bytes preserved', () => {
    const out = lighthouse.applyEpsilon(prior, regenUnder, 1);
    assert.deepEqual(out, prior);
  });
  it('over-epsilon: regenerated wins', () => {
    const out = lighthouse.applyEpsilon(prior, regenOver, 1);
    assert.deepEqual(out, regenOver);
  });
  it('missing-prior (new route): regenerated wins', () => {
    const newRow = [
      {
        route: 'pricing',
        performance: 60,
        accessibility: 70,
        bestPractices: 80,
        seo: 90,
      },
    ];
    const out = lighthouse.applyEpsilon(prior, newRow, 1);
    assert.deepEqual(out, newRow);
  });
});

describe('bundle-size.applyEpsilon', () => {
  const prior = [{ bundle: 'main', rawKb: 250, gzippedKb: 80 }];
  const regenUnder = [{ bundle: 'main', rawKb: 250.5, gzippedKb: 80.2 }];
  const regenOver = [{ bundle: 'main', rawKb: 300, gzippedKb: 95 }];

  it('under-epsilon: prior row bytes preserved', () => {
    const out = bundleSize.applyEpsilon(prior, regenUnder, 1024);
    assert.deepEqual(out, prior);
  });
  it('over-epsilon (eps=1KB): regenerated wins', () => {
    const out = bundleSize.applyEpsilon(prior, regenOver, 1);
    assert.deepEqual(out, regenOver);
  });
  it('missing-prior (new bundle): regenerated wins', () => {
    const newRow = [{ bundle: 'vendor', rawKb: 100, gzippedKb: 30 }];
    const out = bundleSize.applyEpsilon(prior, newRow, 1024);
    assert.deepEqual(out, newRow);
  });
});
