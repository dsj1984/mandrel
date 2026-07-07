import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_GATE_REGISTRY,
  resolveGateMeta,
} from '../../../../.agents/scripts/lib/orchestration/story-close/baseline-attribution/phases/gate-failure.js';
import {
  COMPOSITE_SUBGATES,
  projectRegressionsForGate,
} from '../../../../.agents/scripts/lib/orchestration/story-close/baseline-attribution/phases/regression-projection.js';

/**
 * baseline-attribution-composite-gate.test.js — framework-gap #4377.
 *
 * The baseline pipeline was unified behind a single `check-baselines` gate,
 * but the attribution layer kept keying on the per-kind gate names
 * (`check-maintainability` / `check-crap`). A `check-baselines` failure
 * therefore projected zero regressions and the gate-failure handler dead-ended
 * on an unrecognised gate name — the auto-refresh path silently no-op'd and a
 * legitimate MI/CRAP regression hard-failed the close. These tests pin the
 * composite decomposition so that path can never regress silently again.
 */

describe('COMPOSITE_SUBGATES', () => {
  it('maps the unified check-baselines gate to its per-kind sub-gates', () => {
    assert.deepEqual(COMPOSITE_SUBGATES['check-baselines'], [
      'check-maintainability',
      'check-crap',
    ]);
  });
});

describe('projectRegressionsForGate — gate-name contract', () => {
  it('returns [] for a genuinely unknown gate (unchanged behaviour)', () => {
    assert.deepEqual(
      projectRegressionsForGate({
        gateName: 'check-typecheck',
        cwd: '/repo',
        epicBranch: 'epic/1',
        storyBranch: 'story-2',
        config: {},
      }),
      [],
    );
  });
});

describe('resolveGateMeta — composite check-baselines decomposition', () => {
  const registry = DEFAULT_GATE_REGISTRY;

  it('passes a direct per-kind gate straight through', () => {
    const regressions = [{ path: 'a.js' }];
    const out = resolveGateMeta({
      gateName: 'check-maintainability',
      regressions,
      gateRegistry: registry,
    });
    assert.equal(out.meta.kind, 'maintainability');
    assert.deepEqual(out.regressions, regressions);
  });

  it('selects the first regressed kind and scopes regressions to it', () => {
    const regressions = [
      { path: 'a.js', _gateKind: 'maintainability' },
      { path: 'b.js', _gateKind: 'crap' },
    ];
    const out = resolveGateMeta({
      gateName: 'check-baselines',
      regressions,
      cycleState: { refreshedKinds: new Set() },
      gateRegistry: registry,
    });
    assert.equal(out.meta.kind, 'maintainability');
    assert.deepEqual(
      out.regressions.map((r) => r.path),
      ['a.js'],
    );
  });

  it('skips a kind already refreshed this cycle and moves to the next', () => {
    const regressions = [
      { path: 'a.js', _gateKind: 'maintainability' },
      { path: 'b.js', _gateKind: 'crap' },
    ];
    const out = resolveGateMeta({
      gateName: 'check-baselines',
      regressions,
      cycleState: { refreshedKinds: new Set(['maintainability']) },
      gateRegistry: registry,
    });
    assert.equal(out.meta.kind, 'crap');
    assert.deepEqual(
      out.regressions.map((r) => r.path),
      ['b.js'],
    );
  });

  it('returns null once every regressed kind has been refreshed (loop terminates)', () => {
    const out = resolveGateMeta({
      gateName: 'check-baselines',
      regressions: [{ path: 'a.js', _gateKind: 'maintainability' }],
      cycleState: { refreshedKinds: new Set(['maintainability']) },
      gateRegistry: registry,
    });
    assert.equal(out, null);
  });

  it('returns null for an empty regression list', () => {
    assert.equal(
      resolveGateMeta({
        gateName: 'check-baselines',
        regressions: [],
        gateRegistry: registry,
      }),
      null,
    );
  });

  it('returns null for a composite row whose _gateKind has no registry entry', () => {
    assert.equal(
      resolveGateMeta({
        gateName: 'check-baselines',
        regressions: [{ path: 'a.js', _gateKind: 'lighthouse' }],
        gateRegistry: registry,
      }),
      null,
    );
  });
});
