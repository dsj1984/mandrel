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
