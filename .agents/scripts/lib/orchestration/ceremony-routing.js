/**
 * lib/orchestration/ceremony-routing.js — risk-routed acceptance ceremony
 * resolver (Epic #4478, M7-B, Part 2).
 *
 * The sibling of `review-depth.js` (risk → review depth) and
 * `audit-lens-routing.js#resolveAuditLenses` (risk → audit lens): it folds the
 * planner-judged risk envelope into a per-cluster ceremony decision for the
 * single-delivery acceptance critic — **fresh-context spawn** vs the
 * contract-identical **inline** critic. It does NOT invent a new risk score
 * and it does NOT own clustering.
 *
 * ## The load-bearing invariant (M4-B acceptance floor — DO NOT VIOLATE)
 *
 * Risk-routing chooses fresh-vs-inline **PER CLUSTER**. It NEVER changes the
 * cluster COUNT. The cluster count is `ceil(totalACs / clusterCeiling)` with
 * the non-disableable `[1, 8]` clamp, owned entirely by
 * `acceptance-clusters.js` and untouched here. A low-risk Epic still gets one
 * verdict per cluster — just possibly authored inline instead of by a fresh
 * sub-agent. This module takes the cluster index as an INPUT and returns a
 * decision for that one cluster; it has no way to add or remove clusters.
 *
 * ## Tier rules (per cluster)
 *
 *   - `high` risk        → `fresh`   (a fresh-context maker-blind spawn).
 *   - `medium` risk      → `fresh`   (fail toward more ceremony, never less —
 *                                     matches `review-depth`'s fail-to-middle).
 *   - `low` risk         → `inline`  (the contract-identical inline critic),
 *                                     UNLESS the maker-checker sampling floor
 *                                     selects this cluster → `fresh`.
 *   - missing / unknown  → `fresh`   (fail-safe: an Epic that skipped `/plan`
 *                                     has no risk verdict; treat it as needing
 *                                     the full fresh-context ceremony, exactly
 *                                     as `review-depth` degrades to `standard`
 *                                     and `deriveRiskEnvelope` degrades to
 *                                     review-required).
 *
 * ## Maker-checker sampling floor
 *
 * Even at `low` risk, a fraction of clusters (`freshCriticSampleRate`, default
 * 0.2) is forced `fresh` so low risk never means zero independent checking. The
 * selection is **deterministic** in the cluster index (a fixed stride), so it
 * is stable across re-runs and — critically — never changes the cluster count:
 * it only re-labels which of the fixed set of clusters run fresh.
 *
 * Pure and total: inputs in, decision out. No I/O, no throws. `null` /
 * `undefined` / malformed inputs degrade to `fresh` + `full` ceremony.
 *
 * @typedef {'fresh'|'inline'} CeremonyMode
 * @typedef {'low'|'medium'|'high'} RiskLevel
 */

/**
 * Decide whether the sampling floor forces this low-risk cluster fresh.
 *
 * Deterministic in the cluster index: with rate `r` (0 < r ≤ 1) the stride is
 * `round(1 / r)` and every `stride`-th cluster (0-based indices 0, stride,
 * 2·stride, …) is forced fresh, yielding ≈`r` of clusters fresh. `r <= 0`
 * disables the floor (no cluster forced); `r >= 1` forces every cluster.
 *
 * @param {number} clusterIndex  Zero-based cluster position (from the fixed
 *   `ceil(totalACs / clusterCeiling)` fan-out — an INPUT, never mutated here).
 * @param {number} rate          Sampling rate, already clamped into [0, 1] by
 *   `getDeliveryRouting`.
 * @returns {boolean} `true` when the floor forces this cluster fresh.
 */
export function sampledFresh(clusterIndex, rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    return false;
  }
  if (rate >= 1) return true;
  const idx =
    typeof clusterIndex === 'number' &&
    Number.isInteger(clusterIndex) &&
    clusterIndex >= 0
      ? clusterIndex
      : 0;
  const stride = Math.max(1, Math.round(1 / rate));
  return idx % stride === 0;
}

/**
 * Resolve the acceptance ceremony for one cluster from the judged risk level
 * and the maker-checker sampling floor. See the module header for the tier
 * rules and the untouchable cluster-count invariant.
 *
 * @param {{
 *   overallLevel?: (RiskLevel|string|null|undefined),
 *   clusterIndex?: (number|null|undefined),
 *   freshCriticSampleRate?: (number|null|undefined),
 * }} [input]
 * @returns {{ mode: CeremonyMode, reason: string, sampled: boolean }}
 */
export function resolveCeremonyForRisk(input = {}) {
  const overallLevel =
    input && typeof input === 'object' ? input.overallLevel : undefined;
  const clusterIndex =
    input && typeof input === 'object' ? input.clusterIndex : undefined;
  const rate =
    input && typeof input === 'object'
      ? input.freshCriticSampleRate
      : undefined;

  if (overallLevel === 'high') {
    return {
      mode: 'fresh',
      reason: 'high-risk: fresh-context critic',
      sampled: false,
    };
  }
  if (overallLevel === 'medium') {
    return {
      mode: 'fresh',
      reason: 'medium-risk: fresh-context critic (fail toward more ceremony)',
      sampled: false,
    };
  }
  if (overallLevel === 'low') {
    if (sampledFresh(clusterIndex, rate)) {
      return {
        mode: 'fresh',
        reason:
          'low-risk cluster forced fresh by the maker-checker sampling floor',
        sampled: true,
      };
    }
    return {
      mode: 'inline',
      reason: 'low-risk: contract-identical inline critic',
      sampled: false,
    };
  }
  // Missing / unknown / malformed risk → fail-safe fresh + full ceremony,
  // matching how review-depth.js and deriveRiskEnvelope degrade on an
  // unjudged Epic.
  return {
    mode: 'fresh',
    reason:
      'risk absent/unknown: fail-safe fresh-context critic + full ceremony',
    sampled: false,
  };
}
