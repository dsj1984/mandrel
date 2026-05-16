/**
 * mergeRows.test.js — per-kind scope-aware merge primitive
 * (Story #1974 / Task #1980, Epic #1943).
 *
 * Each of the seven shipped kinds exports `mergeRows(prior, regenerated,
 * scope)`. The merge is pure:
 *
 *   - **Full mode** (`scope.mode === 'full'`, or `scope` omitted/null) —
 *     regenerated wins everywhere; prior is ignored.
 *   - **Diff mode** (`scope.mode === 'diff'`) — rows whose scope key
 *     (`path` for coverage/crap/maintainability/mutation/lint, `route`
 *     for lighthouse, `bundle` for bundle-size) is INSIDE `scope.files`
 *     come from regenerated; rows whose scope key is OUTSIDE
 *     `scope.files` are preserved from prior verbatim.
 *   - **Missing-prior** — regenerated wins regardless of mode (prior is
 *     empty, so there is nothing to preserve).
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

describe('mergeRows export — every kind', () => {
  for (const [name, mod] of ALL_KINDS) {
    it(`${name} exports a callable mergeRows`, () => {
      assert.equal(
        typeof mod.mergeRows,
        'function',
        `${name}.mergeRows must be a function`,
      );
    });
  }
});

// -- Path-keyed kinds (coverage / maintainability / mutation / lint) ---------

const PATH_KINDS = [
  [
    'coverage',
    coverage,
    [
      { path: 'src/a.js', lines: 90, branches: 80, functions: 100 },
      { path: 'src/b.js', lines: 85, branches: 80, functions: 90 },
    ],
    [
      { path: 'src/a.js', lines: 95, branches: 85, functions: 100 },
      { path: 'src/b.js', lines: 70, branches: 60, functions: 70 },
    ],
  ],
  [
    'maintainability',
    maintainability,
    [
      { path: 'src/a.js', mi: 70 },
      { path: 'src/b.js', mi: 80 },
    ],
    [
      { path: 'src/a.js', mi: 75 },
      { path: 'src/b.js', mi: 60 },
    ],
  ],
  [
    'mutation',
    mutation,
    [
      { path: 'src/a.js', score: 90, killed: 9, survived: 1 },
      { path: 'src/b.js', score: 80, killed: 8, survived: 2 },
    ],
    [
      { path: 'src/a.js', score: 95, killed: 10, survived: 0 },
      { path: 'src/b.js', score: 60, killed: 6, survived: 4 },
    ],
  ],
  [
    'lint',
    lint,
    [
      { path: 'src/a.js', errorCount: 0, warningCount: 1 },
      { path: 'src/b.js', errorCount: 0, warningCount: 0 },
    ],
    [
      { path: 'src/a.js', errorCount: 0, warningCount: 2 },
      { path: 'src/b.js', errorCount: 5, warningCount: 5 },
    ],
  ],
];

describe('mergeRows — path-keyed kinds', () => {
  for (const [name, mod, prior, regen] of PATH_KINDS) {
    describe(name, () => {
      it('full mode: regenerated wins everywhere', () => {
        const out = mod.mergeRows(prior, regen, {
          mode: 'full',
          files: new Set(),
        });
        assert.deepEqual(out, regen);
      });

      it('no scope: regenerated wins everywhere', () => {
        const out = mod.mergeRows(prior, regen, null);
        assert.deepEqual(out, regen);
      });

      it('undefined scope: regenerated wins everywhere', () => {
        const out = mod.mergeRows(prior, regen);
        assert.deepEqual(out, regen);
      });

      it('diff mode: prior wins outside scope', () => {
        // Only src/a.js is in scope. Regen for src/a.js wins; prior for
        // src/b.js is preserved verbatim.
        const out = mod.mergeRows(prior, regen, {
          mode: 'diff',
          files: new Set(['src/a.js']),
        });
        const byPath = Object.fromEntries(out.map((r) => [r.path, r]));
        assert.equal(out.length, 2);
        assert.deepEqual(byPath['src/a.js'], regen[0]);
        assert.deepEqual(byPath['src/b.js'], prior[1]);
      });

      it('missing-prior: regenerated wins (full passthrough — nothing to preserve)', () => {
        const out = mod.mergeRows([], regen, {
          mode: 'diff',
          files: new Set(['src/a.js']),
        });
        // With no prior to preserve, the result is the regen rows verbatim.
        assert.deepEqual(out, regen);
      });

      it('null prior: regenerated wins', () => {
        const out = mod.mergeRows(null, regen, {
          mode: 'diff',
          files: new Set(['src/a.js']),
        });
        assert.deepEqual(out, regen);
      });
    });
  }
});

// -- CRAP (composite identity but path-scoped) -------------------------------

describe('mergeRows — crap (composite identity, path-scoped)', () => {
  const prior = [
    { path: 'src/a.js', method: 'foo', startLine: 10, crap: 4 },
    { path: 'src/a.js', method: 'bar', startLine: 20, crap: 6 },
    { path: 'src/b.js', method: 'baz', startLine: 5, crap: 3 },
  ];
  const regen = [
    { path: 'src/a.js', method: 'foo', startLine: 10, crap: 9 },
    { path: 'src/a.js', method: 'bar', startLine: 20, crap: 8 },
    { path: 'src/b.js', method: 'baz', startLine: 5, crap: 30 },
  ];

  it('full mode: regenerated wins everywhere', () => {
    const out = crap.mergeRows(prior, regen, {
      mode: 'full',
      files: new Set(),
    });
    assert.deepEqual(out, regen);
  });

  it('diff mode: prior wins for files outside scope (all methods on that file preserved)', () => {
    const out = crap.mergeRows(prior, regen, {
      mode: 'diff',
      files: new Set(['src/a.js']),
    });
    // src/a.js methods come from regen; src/b.js method is preserved.
    assert.equal(out.length, 3);
    const aFoo = out.find((r) => r.path === 'src/a.js' && r.method === 'foo');
    const aBar = out.find((r) => r.path === 'src/a.js' && r.method === 'bar');
    const bBaz = out.find((r) => r.path === 'src/b.js' && r.method === 'baz');
    assert.equal(aFoo.crap, 9);
    assert.equal(aBar.crap, 8);
    assert.equal(bBaz.crap, 3);
  });

  it('missing-prior: regenerated wins (full passthrough)', () => {
    const out = crap.mergeRows([], regen, {
      mode: 'diff',
      files: new Set(['src/a.js']),
    });
    assert.deepEqual(out, regen);
  });
});

// -- Lighthouse (route-keyed) ------------------------------------------------

describe('mergeRows — lighthouse (route-keyed)', () => {
  const prior = [
    {
      route: '/',
      performance: 90,
      accessibility: 95,
      bestPractices: 92,
      seo: 88,
    },
    {
      route: '/dashboard',
      performance: 70,
      accessibility: 80,
      bestPractices: 85,
      seo: 80,
    },
  ];
  const regen = [
    {
      route: '/',
      performance: 95,
      accessibility: 95,
      bestPractices: 95,
      seo: 90,
    },
    {
      route: '/dashboard',
      performance: 50,
      accessibility: 60,
      bestPractices: 70,
      seo: 70,
    },
  ];

  it('full mode: regenerated wins everywhere', () => {
    const out = lighthouse.mergeRows(prior, regen, {
      mode: 'full',
      files: new Set(),
    });
    assert.deepEqual(out, regen);
  });

  it('diff mode: prior wins for routes outside scope', () => {
    const out = lighthouse.mergeRows(prior, regen, {
      mode: 'diff',
      files: new Set(['/']),
    });
    assert.equal(out.length, 2);
    const byRoute = Object.fromEntries(out.map((r) => [r.route, r]));
    assert.deepEqual(byRoute['/'], regen[0]);
    assert.deepEqual(byRoute['/dashboard'], prior[1]);
  });

  it('missing-prior: regenerated wins', () => {
    const out = lighthouse.mergeRows([], regen);
    assert.deepEqual(out, regen);
  });
});

// -- Bundle-size (bundle-name-keyed) -----------------------------------------

describe('mergeRows — bundle-size (bundle-keyed)', () => {
  const prior = [
    { bundle: 'main', rawKb: 100, gzippedKb: 30 },
    { bundle: 'vendor', rawKb: 500, gzippedKb: 150 },
  ];
  const regen = [
    { bundle: 'main', rawKb: 110, gzippedKb: 32 },
    { bundle: 'vendor', rawKb: 600, gzippedKb: 180 },
  ];

  it('full mode: regenerated wins everywhere', () => {
    const out = bundleSize.mergeRows(prior, regen, {
      mode: 'full',
      files: new Set(),
    });
    assert.deepEqual(out, regen);
  });

  it('diff mode: prior wins for bundles outside scope', () => {
    const out = bundleSize.mergeRows(prior, regen, {
      mode: 'diff',
      files: new Set(['main']),
    });
    assert.equal(out.length, 2);
    const byBundle = Object.fromEntries(out.map((r) => [r.bundle, r]));
    assert.deepEqual(byBundle.main, regen[0]);
    assert.deepEqual(byBundle.vendor, prior[1]);
  });

  it('missing-prior: regenerated wins', () => {
    const out = bundleSize.mergeRows([], regen);
    assert.deepEqual(out, regen);
  });
});

// -- Stable row ordering (downstream sortRows is the canonical sort) ---------

describe('mergeRows — stable row ordering', () => {
  it('returns a new array (no mutation of inputs)', () => {
    const prior = [{ path: 'a.js', mi: 70 }];
    const regen = [{ path: 'b.js', mi: 80 }];
    const out = maintainability.mergeRows(prior, regen, {
      mode: 'diff',
      files: new Set(['b.js']),
    });
    out.push({ path: 'mutant', mi: 0 });
    assert.equal(prior.length, 1);
    assert.equal(regen.length, 1);
  });
});
