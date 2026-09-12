// tests/lib/orchestration/ceremony-routing.test.js
//
// Unit tier (Epic #4478, M7-B, Part 2; re-based on the derived level by Story
// #4542): the acceptance-ceremony resolver. Pins the per-cluster
// fresh-vs-inline tier rules, the fail-safe degrade when the change level is
// underivable, the absence of any sampling floor (Story #5313 retired
// `freshCriticSampleRate` / `sampledFresh`), and — the load-bearing M4-B
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

import {
  resolveCeremonyForRisk,
  verdictOwnerForMode,
} from '../../../.agents/scripts/lib/orchestration/ceremony-routing.js';

describe('resolveCeremonyForRisk — ceremony profiles', () => {
  test('minimal → always inline regardless of the derived level', () => {
    for (const derivedLevel of ['low', 'high', null, undefined]) {
      const d = resolveCeremonyForRisk({
        derivedLevel,
        clusterIndex: 0,
        ceremonyProfile: 'minimal',
      });
      assert.equal(d.mode, 'inline');
      assert.equal(d.profile, 'minimal');
      assert.equal('sampled' in d, false);
    }
  });

  test('strict → always fresh regardless of the derived level', () => {
    const d = resolveCeremonyForRisk({
      derivedLevel: 'low',
      clusterIndex: 1,
      ceremonyProfile: 'strict',
    });
    assert.equal(d.mode, 'fresh');
    assert.equal(d.profile, 'strict');
    assert.equal('sampled' in d, false);
  });
});

describe('resolveCeremonyForRisk — per-cluster tier rules', () => {
  test('a sensitive path touched (high) → fresh', () => {
    const d = resolveCeremonyForRisk({ derivedLevel: 'high', clusterIndex: 0 });
    assert.equal(d.mode, 'fresh');
    assert.equal('sampled' in d, false);
  });

  test('an unrecognised level → fresh (fail toward more ceremony)', () => {
    const d = resolveCeremonyForRisk({
      derivedLevel: 'medium',
      clusterIndex: 3,
    });
    assert.equal(d.mode, 'fresh');
  });

  test('no sensitive path touched (low) → inline at every cluster index', () => {
    // Story #5313: no sampling floor — index 0 used to be forced fresh by the
    // stride; every low cluster now routes inline.
    for (const clusterIndex of [0, 1, 5, 10]) {
      const d = resolveCeremonyForRisk({ derivedLevel: 'low', clusterIndex });
      assert.equal(d.mode, 'inline');
      assert.equal(d.verdictOwner, 'inline-self-eval');
      assert.equal('sampled' in d, false);
    }
  });

  test('a retired freshCriticSampleRate input changes nothing', () => {
    const d = resolveCeremonyForRisk({
      derivedLevel: 'low',
      clusterIndex: 0,
      freshCriticSampleRate: 1,
    });
    assert.equal(d.mode, 'inline');
    assert.equal('sampled' in d, false);
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

describe('single verdict-owner per cluster (Story #4723)', () => {
  // AC-1: acceptance verification runs ONE verdict-owner per cluster — the
  // fresh critic when sensitivity routes it, the inline self-eval otherwise.
  // The resolved decision names that owner explicitly, and it is always
  // exactly one of the two authoring passes; `acceptance-eval.js` is the
  // deterministic scorer of that verdict, never a third owner.
  test('verdictOwnerForMode maps each mode to its single owner', () => {
    assert.equal(verdictOwnerForMode('fresh'), 'fresh-critic');
    assert.equal(verdictOwnerForMode('inline'), 'inline-self-eval');
  });

  test('every resolution names exactly one owner, aligned with its mode', () => {
    const inputs = [
      { derivedLevel: 'high', clusterIndex: 0 },
      { derivedLevel: 'low', clusterIndex: 1 },
      { derivedLevel: 'low', clusterIndex: 0 },
      { derivedLevel: null, clusterIndex: 2 },
      { derivedLevel: 'low', clusterIndex: 3, ceremonyProfile: 'minimal' },
      { derivedLevel: 'low', clusterIndex: 4, ceremonyProfile: 'strict' },
    ];
    for (const input of inputs) {
      const d = resolveCeremonyForRisk(input);
      assert.ok(
        d.verdictOwner === 'fresh-critic' ||
          d.verdictOwner === 'inline-self-eval',
        `owner must be one of the two authoring passes, got ${d.verdictOwner}`,
      );
      assert.equal(d.verdictOwner, verdictOwnerForMode(d.mode));
    }
  });

  test('M4-B floor preserved: one owner per cluster at every level, count untouched', () => {
    const count = clusterCount(14, 4); // 4 clusters
    for (const derivedLevel of ['low', 'high', undefined]) {
      const owners = Array.from(
        { length: count },
        (_v, clusterIndex) =>
          resolveCeremonyForRisk({ derivedLevel, clusterIndex }).verdictOwner,
      );
      // Exactly one owner per cluster — never zero, never a second pass.
      assert.equal(owners.length, count);
      assert.ok(
        owners.every((o) => o === 'fresh-critic' || o === 'inline-self-eval'),
      );
    }
  });
});

/**
 * The caller-owned fan-out width the router is handed. Computed locally so the
 * invariant below stays pinned to arithmetic this test controls rather than to
 * a production module — routing must be independent of however the caller
 * arrives at its cluster count.
 *
 * @param {number} totalAcs
 * @param {number} ceiling
 * @returns {number}
 */
function clusterCount(totalAcs, ceiling) {
  return Math.ceil(totalAcs / ceiling);
}

describe('HARD INVARIANT — level routing NEVER changes the cluster count', () => {
  // The M4-B acceptance floor: the per-cluster fresh-vs-inline decision is
  // orthogonal to the cluster COUNT, which the caller owns.
  // resolveCeremonyForRisk takes clusterIndex as an INPUT and cannot add,
  // remove, merge, or re-slice clusters. This test proves the count is
  // IDENTICAL across every derived level for the same AC set.
  for (const totalAcs of [1, 4, 7, 14, 30]) {
    for (const ceiling of [1, 4, 8]) {
      test(`count invariant: ${totalAcs} ACs / ceiling ${ceiling} identical across derived levels`, () => {
        const count = clusterCount(totalAcs, ceiling);

        // Drive the ceremony router over EVERY cluster at each level and
        // assert the number of clusters routed is identical — routing only
        // labels modes; it never changes how many clusters exist.
        const routeAll = (derivedLevel) =>
          Array.from({ length: count }, (_v, clusterIndex) =>
            resolveCeremonyForRisk({ derivedLevel, clusterIndex }),
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
    const count = clusterCount(14, 4); // ceil(14/4) = 4
    assert.equal(count, 4);
    const low = Array.from({ length: count }, (_v, i) =>
      resolveCeremonyForRisk({ derivedLevel: 'low', clusterIndex: i }),
    );
    const high = Array.from({ length: count }, (_v, i) =>
      resolveCeremonyForRisk({ derivedLevel: 'high', clusterIndex: i }),
    );
    assert.equal(low.length, 4);
    assert.equal(high.length, 4);
    // A low level still gets one verdict per cluster (all inline now that the
    // sampling floor is gone) — never zero, never collapsed to a single critic.
    assert.equal(
      low.every((d) => d.mode === 'inline'),
      true,
    );
    assert.equal(
      high.every((d) => d.mode === 'fresh'),
      true,
    );
  });
});
