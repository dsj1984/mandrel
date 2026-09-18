// tests/config/quality.floors.test.js
//
// Story #2193 / Task #2198 — DEFAULT_MI_FLOORS contract test.
//
// The pre-#2193 default `{ '*': { maintainability: 70 } }` silently no-oped
// inside `check-baselines.js#compareToFloor` because the maintainability
// rollup exposes `min` / `p50` / `p95` axes, not `maintainability`. The
// corrected default keys on `min` so the configured 70-MI floor enforces
// against `rollup['*'].min`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveCrapPreviewIncremental } from '../../.agents/scripts/lib/baselines/crap-preview-incremental.js';
import {
  MAINTAINABILITY_GATE_DEFAULTS,
  resolveQuality,
} from '../../.agents/scripts/lib/config/quality.js';

describe('DEFAULT_MI_FLOORS (Story #2193)', () => {
  it('exposes a `*` workspace key whose `min` floor is 70', () => {
    const floors = MAINTAINABILITY_GATE_DEFAULTS.floors;
    assert.ok(floors, 'maintainability gate defaults expose a floors object');
    assert.ok(
      Object.hasOwn(floors, '*'),
      'maintainability default floors key on the catch-all `*` workspace',
    );
    assert.equal(
      floors['*'].min,
      70,
      'default `*` floor pins the `min` axis at 70',
    );
  });

  it('does not key the default floor on the legacy `maintainability` axis', () => {
    const floor = MAINTAINABILITY_GATE_DEFAULTS.floors['*'];
    assert.equal(
      Object.hasOwn(floor, 'maintainability'),
      false,
      'the legacy `maintainability` axis (which never appears in the rollup) is gone',
    );
  });

  it('resolveQuality injects the corrected default when the consumer declares maintainability with empty floors', () => {
    // Story #2125's defaults-injection path merges the framework default
    // into the consumer block when the consumer omits the `*` workspace
    // key. Pre-#2193 that injected `{ maintainability: 70 }`; post-#2193
    // it must inject `{ min: 70 }`.
    const resolved = resolveQuality({
      gates: {
        maintainability: {
          enabled: true,
          baselinePath: 'baselines/maintainability.json',
          tolerance: { kind: 'absolute', value: 0.5 },
          floors: {},
        },
      },
    });
    assert.deepEqual(resolved.gates.maintainability.floors, {
      '*': { min: 70 },
    });
  });
});

// ---------------------------------------------------------------------------
// Story #5173 — `gates.crap.incrementalCoverage` is two independent switches.
//
// They are defaulted differently on purpose: `skipWhenUnchanged` is a pure
// saving (the gates score exactly what they scored before, because nothing
// they score moved) while `baselineJoin` loosens what the CRAP gate demands.
// Bundling them under one `enabled` switch is what forced the earlier default
// flip to be reverted, so what these pin is the *independence*, not just the
// values.
// ---------------------------------------------------------------------------
describe('gates.crap.incrementalCoverage (Story #5173)', () => {
  const resolveCrap = (userCrap) =>
    resolveQuality({ gates: { crap: userCrap } }).crap.incrementalCoverage;

  it('AC-1: an absent key inherits the saving without the loosening', () => {
    const resolved = resolveQuality({}).crap.incrementalCoverage;
    assert.equal(resolved.skipWhenUnchanged, true);
    assert.equal(resolved.baselineJoin, false);
    assert.equal(resolved.baseRef, null);
  });

  it('AC-1: an empty incrementalCoverage block resolves to the same defaults', () => {
    assert.deepEqual(resolveCrap({ incrementalCoverage: {} }), {
      skipWhenUnchanged: true,
      baselineJoin: false,
      baseRef: null,
    });
  });

  it('AC-2: the deprecated `enabled: true` alias sets both switches', () => {
    assert.deepEqual(resolveCrap({ incrementalCoverage: { enabled: true } }), {
      skipWhenUnchanged: true,
      baselineJoin: true,
      baseRef: null,
    });
  });

  it('AC-2: `enabled: false` is an explicit opt-out of both', () => {
    assert.deepEqual(resolveCrap({ incrementalCoverage: { enabled: false } }), {
      skipWhenUnchanged: false,
      baselineJoin: false,
      baseRef: null,
    });
  });

  it('AC-2: an explicit switch overrides the alias on its own axis only', () => {
    assert.deepEqual(
      resolveCrap({
        incrementalCoverage: { enabled: true, baselineJoin: false },
      }),
      { skipWhenUnchanged: true, baselineJoin: false, baseRef: null },
    );
  });

  it('AC-3: the two switches resolve independently', () => {
    assert.deepEqual(
      resolveCrap({
        incrementalCoverage: {
          skipWhenUnchanged: false,
          baselineJoin: true,
          baseRef: 'origin/main',
        },
      }),
      { skipWhenUnchanged: false, baselineJoin: true, baseRef: 'origin/main' },
    );
  });

  it('keeps baseRef null-means-caller-resolves for a blank string', () => {
    assert.equal(
      resolveCrap({ incrementalCoverage: { baseRef: '' } }).baseRef,
      null,
    );
  });

  // AC-3, join half: the CRAP join must read `baselineJoin` and nothing else.
  // A consumer that took the (safe) capture skip has not thereby asked for the
  // (unsafe) baseline-resolved join, so `skipWhenUnchanged` must not switch it
  // on — and must not switch it off either.
  describe('resolveCrapPreviewIncremental reads baselineJoin alone', () => {
    const invoke = (incrementalCoverage) =>
      resolveCrapPreviewIncremental({
        crap: { incrementalCoverage },
        diffRef: 'main',
        cwd: '/repo',
        baselineRows: [{ file: 'a.js', method: 'f', startLine: 1, crap: 3 }],
        getChangedFilesImpl: () => ['a.js'],
      });

    it('stays off under the inherited default (skip on, join off)', () => {
      assert.equal(
        invoke({ skipWhenUnchanged: true, baselineJoin: false, baseRef: null }),
        null,
      );
    });

    it('engages on baselineJoin even when the capture skip is off', () => {
      const ctx = invoke({
        skipWhenUnchanged: false,
        baselineJoin: true,
        baseRef: null,
      });
      assert.ok(ctx, 'expected an incremental join context');
      assert.deepEqual([...ctx.touchedFiles], ['a.js']);
      assert.equal(ctx.baselineRows.length, 1);
    });

    // Story #5365 inverted this. It used to prefer its own `baseRef` over the
    // caller's `diffRef`, which meant `.husky/pre-push` — which captures at
    // `--ref origin/main` and previews at `--changed-since origin/main` — could
    // resolve two different change sets one line apart in any consumer that
    // configured `baseRef`. The ref the caller named now wins, through the one
    // shared `resolveChangedFilesRef` rule; `baseRef` still answers a caller
    // that named none, which is the case the key was added for.
    it('prefers the caller diffRef over its own baseRef', () => {
      const seen = [];
      resolveCrapPreviewIncremental({
        crap: { incrementalCoverage: { baselineJoin: true, baseRef: 'v1' } },
        diffRef: 'main',
        cwd: '/repo',
        baselineRows: [],
        getChangedFilesImpl: (args) => {
          seen.push(args.ref);
          return [];
        },
      });
      assert.deepEqual(seen, ['main']);
    });

    it('falls back to its own baseRef when the caller named no ref', () => {
      const seen = [];
      resolveCrapPreviewIncremental({
        crap: { incrementalCoverage: { baselineJoin: true, baseRef: 'v1' } },
        diffRef: null,
        cwd: '/repo',
        baselineRows: [],
        getChangedFilesImpl: (args) => {
          seen.push(args.ref);
          return [];
        },
      });
      assert.deepEqual(seen, ['v1']);
    });

    it('falls back to full scope when the ref cannot be resolved', () => {
      assert.equal(
        resolveCrapPreviewIncremental({
          crap: { incrementalCoverage: { baselineJoin: true } },
          diffRef: 'main',
          cwd: '/repo',
          baselineRows: [],
          getChangedFilesImpl: () => {
            throw new Error('bad ref');
          },
        }),
        null,
      );
    });
  });
});
