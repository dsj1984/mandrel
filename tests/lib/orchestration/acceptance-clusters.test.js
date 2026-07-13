// tests/lib/orchestration/acceptance-clusters.test.js
//
// Unit tier (Epic #4475, M4-B): the acceptance-dilution guard. The
// single-delivery executor spawns ONE fresh-context maker-blind critic per AC
// cluster, and the fan-out width MUST be exactly `ceil(totalACs / ceiling)` —
// the direct guard against the "one critic scores all ACs at once" collapse
// the design forecloses. These tests pin that count invariant across sizes and
// ceilings, the ordering-preservation, and the config-clamped wrapper.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  clusterAcceptanceCriteria,
  clusterAcceptanceForConfig,
  expectedClusterCount,
} from '../../../.agents/scripts/lib/orchestration/acceptance-clusters.js';

/** Build `['AC-1', …, 'AC-n']`. */
function acs(n) {
  return Array.from({ length: n }, (_, i) => `AC-${i + 1}`);
}

describe('clusterAcceptanceCriteria — count invariant (fan-out width)', () => {
  it('produces exactly ceil(totalACs / ceiling) clusters', () => {
    // The load-bearing table: (total, ceiling) → expected cluster count.
    const cases = [
      [1, 4, 1],
      [4, 4, 1],
      [5, 4, 2],
      [8, 4, 2],
      [9, 4, 3],
      [14, 4, 4], // the cohort's 14-AC / 4-Story case → 4 critics, restored.
      [14, 3, 5],
      [7, 2, 4],
      [10, 1, 10], // ceiling 1 → maximally distributed (one AC per critic).
    ];
    for (const [total, ceiling, expected] of cases) {
      const clusters = clusterAcceptanceCriteria(acs(total), ceiling);
      assert.equal(
        clusters.length,
        expected,
        `${total} ACs @ ceiling ${ceiling} → ${expected} clusters`,
      );
      assert.equal(clusters.length, Math.ceil(total / ceiling));
      assert.equal(clusters.length, expectedClusterCount(total, ceiling));
    }
  });

  it('caps every cluster at the ceiling and preserves input order', () => {
    const clusters = clusterAcceptanceCriteria(acs(9), 4);
    assert.deepEqual(
      clusters.map((c) => c.acIds),
      [
        ['AC-1', 'AC-2', 'AC-3', 'AC-4'],
        ['AC-5', 'AC-6', 'AC-7', 'AC-8'],
        ['AC-9'],
      ],
    );
    // Stable, 1-based cluster ids + zero-based index.
    assert.deepEqual(
      clusters.map((c) => c.clusterId),
      ['ac-cluster-1', 'ac-cluster-2', 'ac-cluster-3'],
    );
    assert.deepEqual(
      clusters.map((c) => c.clusterIndex),
      [0, 1, 2],
    );
    // Every AC appears exactly once, order preserved.
    assert.deepEqual(
      clusters.flatMap((c) => c.acIds),
      acs(9),
    );
  });

  it('never collapses to a single critic for a large AC set at a sane ceiling', () => {
    // The dilution the guard forecloses: 14 ACs must NOT become 1 critic.
    const clusters = clusterAcceptanceCriteria(acs(14), 4);
    assert.ok(clusters.length > 1, 'must fan out, not collapse to one critic');
  });

  it('degrades a non-positive / non-integer ceiling to 1 (never collapse)', () => {
    for (const bad of [0, -3, 1.5, Number.NaN, 'x', null]) {
      const clusters = clusterAcceptanceCriteria(acs(3), bad);
      assert.equal(clusters.length, 3, `ceiling ${String(bad)} → one per AC`);
    }
  });

  it('an omitted ceiling uses the default of 4', () => {
    assert.equal(clusterAcceptanceCriteria(acs(9)).length, 3); // ceil(9/4)
  });

  it('returns no clusters for an empty / malformed AC set (never throws)', () => {
    assert.deepEqual(clusterAcceptanceCriteria([], 4), []);
    assert.deepEqual(clusterAcceptanceCriteria(null, 4), []);
    assert.deepEqual(clusterAcceptanceCriteria(undefined, 4), []);
    assert.deepEqual(clusterAcceptanceCriteria(['', null, 'AC-1'], 4), [
      { clusterIndex: 0, clusterId: 'ac-cluster-1', acIds: ['AC-1'] },
    ]);
  });
});

describe('expectedClusterCount', () => {
  it('is ceil(total / ceiling), 0 for empty', () => {
    assert.equal(expectedClusterCount(0, 4), 0);
    assert.equal(expectedClusterCount(-1, 4), 0);
    assert.equal(expectedClusterCount(4, 4), 1);
    assert.equal(expectedClusterCount(5, 4), 2);
    assert.equal(expectedClusterCount(14, 4), 4);
    assert.equal(expectedClusterCount(3, 0), 3); // ceiling degrades to 1
  });
});

describe('clusterAcceptanceForConfig — config-clamped wrapper', () => {
  it('applies the default ceiling (4) when unconfigured', () => {
    const { clusters, clusterCeiling, totalAcs } = clusterAcceptanceForConfig(
      acs(9),
      {},
    );
    assert.equal(clusterCeiling, 4);
    assert.equal(totalAcs, 9);
    assert.equal(clusters.length, 3);
  });

  it('honours an in-range operator override', () => {
    const { clusters, clusterCeiling } = clusterAcceptanceForConfig(acs(9), {
      delivery: { acceptanceEval: { clusterCeiling: 3 } },
    });
    assert.equal(clusterCeiling, 3);
    assert.equal(clusters.length, 3); // ceil(9/3)
  });

  it('clamps a pathological ceiling so the fan-out cannot collapse', () => {
    // clusterCeiling: 999 would collapse 14 ACs to one critic — the clamp to
    // 8 keeps at least ceil(14/8) = 2 independent passes.
    const { clusters, clusterCeiling } = clusterAcceptanceForConfig(acs(14), {
      delivery: { acceptanceEval: { clusterCeiling: 999 } },
    });
    assert.equal(clusterCeiling, 8);
    assert.equal(clusters.length, 2);
  });
});
