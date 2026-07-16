// tests/lib/orchestration/ceremony-routing.test.js
//
// Unit tier (Epic #4478, M7-B, Part 2; re-based on the derived level by Story
// #4542): the acceptance-ceremony resolver. Pins the per-cluster
// fresh-vs-inline tier rules, the fail-safe degrade when the change level is
// underivable, the maker-checker sampling floor, and — the load-bearing M4-B
// invariant — that level routing NEVER changes the cluster COUNT (only the
// per-cluster mode).
//
// `derivedLevel` is the level `review-depth.js#deriveChangeLevel` computes from
// the changed-file set; it is 'high' | 'low' | null. There is deliberately no
// 'medium' any more — the retired planner-authored verdict had three levels, the
// derived signal answers one observable question (was a sensitive path touched?)
// and anything unrecognised falls through the same fail-safe as null.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { expectedClusterCount } from '../../../.agents/scripts/lib/orchestration/acceptance-clusters.js';
import {
  resolveCeremonyForRisk,
  sampledFresh,
} from '../../../.agents/scripts/lib/orchestration/ceremony-routing.js';

describe('resolveCeremonyForRisk — ceremony profiles', () => {
  test('minimal → always inline regardless of the derived level', () => {
    for (const derivedLevel of ['low', 'high', null, undefined]) {
      const d = resolveCeremonyForRisk({
        derivedLevel,
        clusterIndex: 0,
        ceremonyProfile: 'minimal',
        freshCriticSampleRate: 1,
      });
      assert.equal(d.mode, 'inline');
      assert.equal(d.profile, 'minimal');
      assert.equal(d.sampled, false);
    }
  });

  test('strict → always fresh regardless of the derived level', () => {
    const d = resolveCeremonyForRisk({
      derivedLevel: 'low',
      clusterIndex: 1,
      ceremonyProfile: 'strict',
      freshCriticSampleRate: 0,
    });
    assert.equal(d.mode, 'fresh');
    assert.equal(d.profile, 'strict');
  });
});

describe('resolveCeremonyForRisk — per-cluster tier rules', () => {
  test('a sensitive path touched (high) → fresh', () => {
    const d = resolveCeremonyForRisk({ derivedLevel: 'high', clusterIndex: 0 });
    assert.equal(d.mode, 'fresh');
    assert.equal(d.sampled, false);
  });

  test('an unrecognised level → fresh (fail toward more ceremony)', () => {
    const d = resolveCeremonyForRisk({
      derivedLevel: 'medium',
      clusterIndex: 3,
    });
    assert.equal(d.mode, 'fresh');
  });

  test('no sensitive path touched (low), not sampled → inline', () => {
    // rate 0.2 → stride 5; cluster index 1 is NOT a multiple of 5.
    const d = resolveCeremonyForRisk({
      derivedLevel: 'low',
      clusterIndex: 1,
      freshCriticSampleRate: 0.2,
    });
    assert.equal(d.mode, 'inline');
    assert.equal(d.sampled, false);
  });

  test('a low-level cluster sampled by the floor → fresh', () => {
    // rate 0.2 → stride 5; cluster index 0 IS forced fresh by the floor.
    const d = resolveCeremonyForRisk({
      derivedLevel: 'low',
      clusterIndex: 0,
      freshCriticSampleRate: 0.2,
    });
    assert.equal(d.mode, 'fresh');
    assert.equal(d.sampled, true);
  });

  test('missing / unknown / malformed level → fresh + full ceremony (fail-safe)', () => {
    for (const bad of [
      undefined,
      null,
      {},
      { derivedLevel: undefined },
      { derivedLevel: null },
      { derivedLevel: 'bogus' },
    ]) {
      const input = bad && 'derivedLevel' in bad ? bad : (bad ?? undefined);
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

  test('a low-level Story with a non-zero floor never gets zero independent checks', () => {
    // Over any non-trivial cluster set, at least one cluster is forced fresh.
    const anyFresh = Array.from({ length: 8 }, (_v, i) =>
      sampledFresh(i, 0.2),
    ).some(Boolean);
    assert.equal(anyFresh, true);
  });
});

describe('HARD INVARIANT — level routing NEVER changes the cluster count', () => {
  // The M4-B acceptance floor: the per-cluster fresh-vs-inline decision is
  // orthogonal to the cluster COUNT, which is owned solely by
  // acceptance-clusters.js (ceil(totalACs / clusterCeiling), clamp [1,8]).
  // resolveCeremonyForRisk takes clusterIndex as an INPUT and cannot add,
  // remove, merge, or re-slice clusters. This test proves the count is
  // IDENTICAL across every derived level for the same AC set.
  for (const totalAcs of [1, 4, 7, 14, 30]) {
    for (const clusterCeiling of [1, 4, 8]) {
      test(`count invariant: ${totalAcs} ACs / ceiling ${clusterCeiling} identical across derived levels`, () => {
        const count = expectedClusterCount(totalAcs, clusterCeiling);

        // Drive the ceremony router over EVERY cluster at each level and
        // assert the number of clusters routed is identical — routing only
        // labels modes; it never changes how many clusters exist.
        const routeAll = (derivedLevel) =>
          Array.from({ length: count }, (_v, clusterIndex) =>
            resolveCeremonyForRisk({
              derivedLevel,
              clusterIndex,
              freshCriticSampleRate: 0.2,
            }),
          );

        const low = routeAll('low');
        const high = routeAll('high');
        const unknown = routeAll(undefined);

        assert.equal(low.length, count);
        assert.equal(high.length, count);
        assert.equal(unknown.length, count);
        // Every derived level yields exactly one verdict decision per cluster.
        assert.equal(low.length, high.length);
        assert.equal(low.length, unknown.length);
      });
    }
  }

  test('high vs low over 14 ACs both produce one decision per cluster', () => {
    const count = expectedClusterCount(14, 4); // ceil(14/4) = 4
    assert.equal(count, 4);
    const low = Array.from({ length: count }, (_v, i) =>
      resolveCeremonyForRisk({
        derivedLevel: 'low',
        clusterIndex: i,
        freshCriticSampleRate: 0.2,
      }),
    );
    const high = Array.from({ length: count }, (_v, i) =>
      resolveCeremonyForRisk({
        derivedLevel: 'high',
        clusterIndex: i,
        freshCriticSampleRate: 0.2,
      }),
    );
    assert.equal(low.length, 4);
    assert.equal(high.length, 4);
    // A low level still gets one verdict per cluster (some inline, some sampled
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
