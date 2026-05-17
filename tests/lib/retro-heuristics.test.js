import assert from 'node:assert';
import { test } from 'node:test';
import { isCleanManifest } from '../../.agents/scripts/lib/orchestration/retro-heuristics.js';

test('isCleanManifest - all zeros returns true', () => {
  assert.strictEqual(
    isCleanManifest({
      friction: 0,
      parked: 0,
      recuts: 0,
      hotfixes: 0,
      hitl: 0,
    }),
    true,
  );
});

test('isCleanManifest - no arguments returns true (all dimensions default to 0)', () => {
  assert.strictEqual(isCleanManifest(), true);
  assert.strictEqual(isCleanManifest({}), true);
});

test('isCleanManifest - each single non-zero signal returns false', () => {
  const dimensions = [
    'friction',
    'parked',
    'recuts',
    'hotfixes',
    'hitl',
    'interventions',
  ];
  for (const dim of dimensions) {
    const counts = {
      friction: 0,
      parked: 0,
      recuts: 0,
      hotfixes: 0,
      hitl: 0,
      interventions: 0,
    };
    counts[dim] = 1;
    assert.strictEqual(
      isCleanManifest(counts),
      false,
      `expected false when ${dim}=1, got true`,
    );
  }
});

test('isCleanManifest - larger non-zero values also return false', () => {
  assert.strictEqual(isCleanManifest({ friction: 12 }), false);
  assert.strictEqual(isCleanManifest({ parked: 3 }), false);
  assert.strictEqual(isCleanManifest({ recuts: 2 }), false);
  assert.strictEqual(isCleanManifest({ hotfixes: 5 }), false);
  assert.strictEqual(isCleanManifest({ hitl: 1 }), false);
});

test('isCleanManifest - missing dimensions are treated as 0', () => {
  assert.strictEqual(isCleanManifest({ friction: 0 }), true);
  assert.strictEqual(isCleanManifest({ friction: 1 }), false);
});

test('isCleanManifest - non-number values are treated as 0 (defensive)', () => {
  assert.strictEqual(
    isCleanManifest({
      friction: undefined,
      parked: null,
      recuts: 'nope',
      hotfixes: NaN,
      hitl: 0,
    }),
    true,
  );
});

test('isCleanManifest - multiple non-zero signals return false', () => {
  assert.strictEqual(
    isCleanManifest({
      friction: 2,
      parked: 1,
      recuts: 0,
      hotfixes: 0,
      hitl: 0,
    }),
    false,
  );
});

// Verifies the 5.30.0 metric-definition change: hitl now counts
// agent::blocked events raised mid-sprint (the runtime HITL pause point),
// not risk::high labels (informational/planning metadata only).
test('isCleanManifest - hitl reflects agent::blocked event count (fixture replay)', () => {
  // Fixture: an Epic where the caller scanned label events on every child
  // ticket and tallied N=3 distinct tickets that received agent::blocked
  // at any point during execution.
  const fixture = {
    friction: 0,
    parked: 0,
    recuts: 0,
    hotfixes: 0,
    hitl: 3,
  };
  assert.strictEqual(
    isCleanManifest(fixture),
    false,
    'three agent::blocked events should disqualify the compact-retro path',
  );

  // Same Epic re-scanned after the operator unblocked everything and the
  // sprint completed cleanly: zero agent::blocked events remain in the
  // tally, so the heuristic falls back to the compact retro.
  fixture.hitl = 0;
  assert.strictEqual(isCleanManifest(fixture), true);
});

// Story #2289 — interventions count now feeds the predicate so the retro
// shape agrees with the auto-merge gate on what "clean" means.
test('isCleanManifest - interventions > 0 disqualifies the compact path', () => {
  assert.strictEqual(
    isCleanManifest({
      friction: 0,
      parked: 0,
      recuts: 0,
      hotfixes: 0,
      hitl: 0,
      interventions: 5,
    }),
    false,
    'recorded manual interventions should route to the full retro',
  );
});
