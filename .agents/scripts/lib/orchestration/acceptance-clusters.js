/**
 * acceptance-clusters.js — Epic #4475 (M4-B), design §S2a.
 *
 * The **acceptance-dilution guard** for single delivery. In the fan-out
 * shape, each Story ran its own fresh-context acceptance self-eval critic, so
 * a 14-AC Epic decomposed into 4 Stories got ~4 independent critic passes for
 * free. Single delivery collapses the whole Epic into ONE guarded session — if
 * we ran a single critic over all 14 ACs it would degrade to two redraft
 * rounds scoring everything at once (the exact "acceptance dilution" risk the
 * adopted design calls out as blocking).
 *
 * This module restores the distributed coverage: the Epic's
 * `## Acceptance Table` AC ids are split into clusters of at most
 * `clusterCeiling` (config `delivery.acceptanceEval.clusterCeiling`, default 4,
 * hard-clamped to `[1, 8]`), and the executor spawns ONE maker-blind
 * fresh-context `Agent` critic per cluster. The cluster count is therefore
 * `ceil(totalACs / clusterCeiling)` — a deterministic fan-out width the
 * consuming executor and its isolation test both key off.
 *
 * Pure and total — inputs in, clusters out. No I/O, no throws on malformed
 * input (a non-array / empty AC set yields zero clusters — the executor then
 * has nothing to critique, which the front gate already forecloses by refusing
 * `acceptance::n-a`).
 */

import { getAcceptanceEval } from '../config/acceptance-eval.js';

/**
 * @typedef {object} AcceptanceCluster
 * @property {number} clusterIndex  Zero-based position in the fan-out.
 * @property {string} clusterId     Stable id (`ac-cluster-<n>`, 1-based).
 * @property {string[]} acIds       The AC ids this critic scores (≤ ceiling).
 */

/**
 * Split an ordered list of AC ids into fresh-context critic clusters of at
 * most `ceiling` ids each. The count is exactly `ceil(acIds.length / ceiling)`
 * — the load-bearing fan-out-width invariant the isolation test pins.
 *
 * The input order is preserved (the executor orders ACs by their associated
 * Delivery-Slicing slice before calling this, so same-slice ACs land adjacent
 * and tend to share a cluster), but ordering is a nicety — the count guarantee
 * is what forecloses dilution.
 *
 * @param {string[]} acIds       Ordered AC ids (e.g. `['AC-1', 'AC-2', …]`).
 * @param {number} [ceiling=4]   Max ACs per cluster. A non-positive / non-
 *                               integer ceiling degrades to 1 (one AC per
 *                               cluster — the maximally-distributed, never-
 *                               collapsed fan-out).
 * @returns {AcceptanceCluster[]} `ceil(n / ceiling)` clusters; `[]` when there
 *   are no AC ids.
 */
export function clusterAcceptanceCriteria(acIds, ceiling = 4) {
  const ids = Array.isArray(acIds)
    ? acIds.filter((id) => typeof id === 'string' && id.length > 0)
    : [];
  if (ids.length === 0) return [];

  const size =
    typeof ceiling === 'number' && Number.isInteger(ceiling) && ceiling >= 1
      ? ceiling
      : 1;

  const clusters = [];
  for (let start = 0; start < ids.length; start += size) {
    const clusterIndex = clusters.length;
    clusters.push({
      clusterIndex,
      clusterId: `ac-cluster-${clusterIndex + 1}`,
      acIds: ids.slice(start, start + size),
    });
  }
  return clusters;
}

/**
 * The expected fan-out width for `total` ACs at `ceiling` — the number of
 * independent maker-blind critic passes the single-delivery executor spawns.
 * Exported so the executor (and its isolation test) can assert the number of
 * `Agent` critic spawns equals this without re-deriving the ceil math.
 *
 * @param {number} total    Total AC count.
 * @param {number} ceiling  Max ACs per cluster (≥ 1; degrades to 1 otherwise).
 * @returns {number} `ceil(total / ceiling)`; `0` when `total <= 0`.
 */
export function expectedClusterCount(total, ceiling) {
  const n = Number.isInteger(total) && total > 0 ? total : 0;
  if (n === 0) return 0;
  const size =
    typeof ceiling === 'number' && Number.isInteger(ceiling) && ceiling >= 1
      ? ceiling
      : 1;
  return Math.ceil(n / size);
}

/**
 * Convenience wrapper: resolve the effective `clusterCeiling` from config
 * (applying the framework default + the undisableable `[1, 8]` clamp) and
 * cluster `acIds` with it. The single home the executor's `slice-phase`
 * substrate and any future CLI use so the clamp is applied once.
 *
 * @param {string[]} acIds
 * @param {object | null | undefined} config  Resolved `.agentrc.json`.
 * @returns {{ clusters: AcceptanceCluster[], clusterCeiling: number, totalAcs: number }}
 */
export function clusterAcceptanceForConfig(acIds, config) {
  const { clusterCeiling } = getAcceptanceEval(config);
  const clusters = clusterAcceptanceCriteria(acIds, clusterCeiling);
  const ids = Array.isArray(acIds) ? acIds.filter(Boolean) : [];
  return { clusters, clusterCeiling, totalAcs: ids.length };
}
