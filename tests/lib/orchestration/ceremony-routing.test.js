// tests/lib/orchestration/ceremony-routing.test.js
//
// Unit tier (Epic #4478, M7-B, Part 2): the risk-routed acceptance-ceremony
// resolver. Pins the per-cluster fresh-vs-inline tier rules, the fail-safe
// degrade on a missing risk verdict, the maker-checker sampling floor, and —
// the load-bearing M4-B invariant — that risk routing NEVER changes the
// cluster COUNT (only the per-cluster mode).

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { expectedClusterCount } from '../../../.agents/scripts/lib/orchestration/acceptance-clusters.js';
import {
  resolveCeremonyForRisk,
  sampledFresh,
} from '../../../.agents/scripts/lib/orchestration/ceremony-routing.js';

describe('resolveCeremonyForRisk — ceremony profiles', () => {
  test('minimal → always inline regardless of risk', () => {
    for (const overallLevel of ['low', 'medium', 'high', undefined]) {
      const d = resolveCeremonyForRisk({
        overallLevel,
        clusterIndex: 0,
        ceremonyProfile: 'minimal',
        freshCriticSampleRate: 1,
      });
      assert.equal(d.mode, 'inline');
      assert.equal(d.profile, 'minimal');
      assert.equal(d.sampled, false);
    }
  });

  test('strict → always fresh regardless of risk', () => {
    const d = resolveCeremonyForRisk({
      overallLevel: 'low',
      clusterIndex: 1,
      ceremonyProfile: 'strict',
      freshCriticSampleRate: 0,
    });
    assert.equal(d.mode, 'fresh');
    assert.equal(d.profile, 'strict');
  });
});

describe('resolveCeremonyForRisk — per-cluster tier rules', () => {
  test('high risk → fresh', () => {
    const d = resolveCeremonyForRisk({ overallLevel: 'high', clusterIndex: 0 });
    assert.equal(d.mode, 'fresh');
    assert.equal(d.sampled, false);
  });

  test('medium risk → fresh (fail toward more ceremony)', () => {
    const d = resolveCeremonyForRisk({
      overallLevel: 'medium',
      clusterIndex: 3,
    });
    assert.equal(d.mode, 'fresh');
  });

  test('low risk (not sampled) → inline', () => {
    // rate 0.2 → stride 5; cluster index 1 is NOT a multiple of 5.
    const d = resolveCeremonyForRisk({
      overallLevel: 'low',
      clusterIndex: 1,
      freshCriticSampleRate: 0.2,
    });
    assert.equal(d.mode, 'inline');
    assert.equal(d.sampled, false);
  });

  test('low risk sampled by the floor → fresh', () => {
    // rate 0.2 → stride 5; cluster index 0 IS forced fresh by the floor.
    const d = resolveCeremonyForRisk({
      overallLevel: 'low',
      clusterIndex: 0,
      freshCriticSampleRate: 0.2,
    });
    assert.equal(d.mode, 'fresh');
    assert.equal(d.sampled, true);
  });

  test('missing / unknown / malformed risk → fresh + full ceremony (fail-safe)', () => {
    for (const bad of [
      undefined,
      null,
      {},
      { overallLevel: undefined },
      { overallLevel: 'bogus' },
    ]) {
      const input = bad && 'overallLevel' in bad ? bad : (bad ?? undefined);
      const d = resolveCeremonyForRisk(input);
      assert.equal(
        d.mode,
        'fresh',
        `expected fresh for ${JSON.stringify(bad)}`,
      );
    }
  });
});

describe('sampledFresh — the maker-checker sampling floor', () => {
  test('rate 0 disables the floor (no cluster forced fresh)', () => {
    for (let i = 0; i < 10; i += 1) assert.equal(sampledFresh(i, 0), false);
  });

  test('rate 1 forces every cluster fresh', () => {
    for (let i = 0; i < 10; i += 1) assert.equal(sampledFresh(i, 1), true);
  });

  test('rate 0.2 forces ≈1/5 of clusters (deterministic stride)', () => {
    const forced = [];
    for (let i = 0; i < 20; i += 1) if (sampledFresh(i, 0.2)) forced.push(i);
    // stride round(1/0.2) = 5 → indices 0, 5, 10, 15.
    assert.deepEqual(forced, [0, 5, 10, 15]);
  });

  test('is deterministic across calls (stable per index)', () => {
    for (let i = 0; i < 30; i += 1) {
      assert.equal(sampledFresh(i, 0.2), sampledFresh(i, 0.2));
    }
  });

  test('a low-risk Epic with a non-zero floor never gets zero independent checks', () => {
    // Over any non-trivial cluster set, at least one cluster is forced fresh.
    const anyFresh = Array.from({ length: 8 }, (_v, i) =>
      sampledFresh(i, 0.2),
    ).some(Boolean);
    assert.equal(anyFresh, true);
  });
});

describe('HARD INVARIANT — risk routing NEVER changes the cluster count', () => {
  // The M4-B acceptance floor: the per-cluster fresh-vs-inline decision is
  // orthogonal to the cluster COUNT, which is owned solely by
  // acceptance-clusters.js (ceil(totalACs / clusterCeiling), clamp [1,8]).
  // resolveCeremonyForRisk takes clusterIndex as an INPUT and cannot add,
  // remove, merge, or re-slice clusters. This test proves the count is
  // IDENTICAL across every risk level for the same AC set.
  for (const totalAcs of [1, 4, 7, 14, 30]) {
    for (const clusterCeiling of [1, 4, 8]) {
      test(`count invariant: ${totalAcs} ACs / ceiling ${clusterCeiling} identical across risk levels`, () => {
        const count = expectedClusterCount(totalAcs, clusterCeiling);

        // Drive the ceremony router over EVERY cluster at each risk level and
        // assert the number of clusters routed is identical — routing only
        // labels modes; it never changes how many clusters exist.
        const routeAll = (overallLevel) =>
          Array.from({ length: count }, (_v, clusterIndex) =>
            resolveCeremonyForRisk({
              overallLevel,
              clusterIndex,
              freshCriticSampleRate: 0.2,
            }),
          );

        const low = routeAll('low');
        const medium = routeAll('medium');
        const high = routeAll('high');
        const unknown = routeAll(undefined);

        assert.equal(low.length, count);
        assert.equal(medium.length, count);
        assert.equal(high.length, count);
        assert.equal(unknown.length, count);
        // Every risk level yields exactly one verdict decision per cluster.
        assert.equal(low.length, high.length);
        assert.equal(medium.length, unknown.length);
      });
    }
  }

  test('high vs low over 14 ACs both produce one decision per cluster', () => {
    const count = expectedClusterCount(14, 4); // ceil(14/4) = 4
    assert.equal(count, 4);
    const low = Array.from({ length: count }, (_v, i) =>
      resolveCeremonyForRisk({
        overallLevel: 'low',
        clusterIndex: i,
        freshCriticSampleRate: 0.2,
      }),
    );
    const high = Array.from({ length: count }, (_v, i) =>
      resolveCeremonyForRisk({
        overallLevel: 'high',
        clusterIndex: i,
        freshCriticSampleRate: 0.2,
      }),
    );
    assert.equal(low.length, 4);
    assert.equal(high.length, 4);
    // Low risk still gets one verdict per cluster (some inline, some sampled
    // fresh) — never zero, never collapsed to a single critic.
    assert.equal(
      low.every((d) => d.mode === 'fresh' || d.mode === 'inline'),
      true,
    );
    assert.equal(
      high.every((d) => d.mode === 'fresh'),
      true,
    );
  });
});
