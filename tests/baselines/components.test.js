// tests/baselines/components.test.js
//
// Story #1892 / Task #1902 — covers the shared component resolver and
// row grouper.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  groupRows,
  resolveComponents,
} from '../../.agents/scripts/lib/baselines/components.js';

describe('resolveComponents', () => {
  it("returns {'*': ['**']} when called with an empty object", () => {
    const out = resolveComponents({});
    assert.deepEqual(out, { '*': ['**'] });
  });

  it('returns the default when called with null / undefined', () => {
    assert.deepEqual(resolveComponents(null), { '*': ['**'] });
    assert.deepEqual(resolveComponents(undefined), { '*': ['**'] });
  });

  it('returns the default when components is missing', () => {
    assert.deepEqual(resolveComponents({ enabled: true }), { '*': ['**'] });
  });

  it('returns the default when components is an empty object', () => {
    assert.deepEqual(resolveComponents({ components: {} }), {
      '*': ['**'],
    });
  });

  it('passes operator-declared components through unchanged', () => {
    const out = resolveComponents({
      components: { app: ['src/app/**'], worker: ['src/worker/**'] },
    });
    assert.deepEqual(out, {
      app: ['src/app/**'],
      worker: ['src/worker/**'],
    });
  });

  it('coerces non-array values to []', () => {
    const out = resolveComponents({ components: { broken: 'not-array' } });
    assert.deepEqual(out, { broken: [] });
  });
});

describe('groupRows', () => {
  const rows = [
    { path: 'src/app/handler.js', mi: 80 },
    { path: 'src/worker/queue.js', mi: 90 },
    { path: 'src/shared/util.js', mi: 70 },
  ];

  it("assigns every row to '*' (the catch-all bucket)", () => {
    const grouped = groupRows(rows, { '*': ['**'] });
    assert.equal(grouped['*'].length, 3);
  });

  it('matches rows against per-component globs', () => {
    const grouped = groupRows(rows, {
      app: ['src/app/**'],
      worker: ['src/worker/**'],
    });
    assert.deepEqual(
      grouped.app.map((r) => r.path),
      ['src/app/handler.js'],
    );
    assert.deepEqual(
      grouped.worker.map((r) => r.path),
      ['src/worker/queue.js'],
    );
  });

  it('allows overlap — a row in two components appears in both', () => {
    const grouped = groupRows(rows, {
      '*': ['**'],
      app: ['src/app/**'],
      worker: ['src/worker/**'],
    });
    assert.equal(grouped['*'].length, 3);
    assert.equal(grouped.app.length, 1);
    assert.equal(grouped.worker.length, 1);
  });

  it("defaults keyField to 'path'", () => {
    const grouped = groupRows(rows, { app: ['src/app/**'] });
    assert.equal(grouped.app.length, 1);
  });

  it("accepts keyField='route' for lighthouse rows", () => {
    const lhRows = [
      { route: '/login', performance: 90 },
      { route: '/dashboard', performance: 80 },
    ];
    const grouped = groupRows(lhRows, { auth: ['/login', '/signup'] }, 'route');
    assert.deepEqual(
      grouped.auth.map((r) => r.route),
      ['/login'],
    );
  });

  it("accepts keyField='bundle' for bundle-size rows", () => {
    const bsRows = [
      { bundle: 'main.js', rawKb: 200 },
      { bundle: 'vendor.js', rawKb: 600 },
    ];
    const grouped = groupRows(
      bsRows,
      { app: ['main.js'], vendor: ['vendor.js'] },
      'bundle',
    );
    assert.equal(grouped.app[0].bundle, 'main.js');
    assert.equal(grouped.vendor[0].bundle, 'vendor.js');
  });

  it('returns empty arrays for components with no matches', () => {
    const grouped = groupRows(rows, { nothing: ['nonexistent/**'] });
    assert.deepEqual(grouped.nothing, []);
  });

  it('normalises Windows backslash paths before matching', () => {
    const winRows = [{ path: 'src\\app\\handler.js', mi: 80 }];
    const grouped = groupRows(winRows, { app: ['src/app/**'] });
    assert.equal(grouped.app.length, 1);
  });

  it('handles empty rows array', () => {
    const grouped = groupRows([], { '*': ['**'] });
    assert.deepEqual(grouped, { '*': [] });
  });
});
