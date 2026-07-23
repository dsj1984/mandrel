/**
 * lib/orchestration/ceremony-routing.js — ceremony-profile + derived-level
 * acceptance ceremony resolver.
 *
 * The sibling of `review-depth.js#resolveDepth`: it folds the operator ceremony
 * profile and the **derived** change level into a per-cluster ceremony decision
 * for the single-delivery acceptance critic — **fresh-context spawn** vs the
 * contract-identical **inline** critic. It does NOT invent a new risk score and
 * it does NOT own clustering.
 *
 * ## One derived source, two decisions (Story #4542)
 *
 * `derivedLevel` comes from `review-depth.js#deriveChangeLevel` — the same call
 * that feeds review depth — so both ceremony decisions read one observable
 * signal: does the change set touch a sensitive path registered in
 * `audit-rules.json`? Previously this consumed the planner's own risk verdict,
 * which meant a confident all-low self-assertion bought *less* independent
 * checking than authoring nothing at all. A derived level cannot be talked down.
 *
 * ## Ceremony profiles (`delivery.routing.ceremonyProfile`)
 *
 *   - `minimal`  — always `inline` (skip fresh critic + sampling floor).
 *                  Use for tiny N=1 Stories the operator trusts.
 *   - `standard` — level-routed (default). Low → inline (+ sampling floor);
 *                  high → fresh.
 *   - `strict`   — always `fresh` regardless of the derived level.
 *
 * ## The load-bearing invariant (M4-B acceptance floor — DO NOT VIOLATE)
 *
 * Risk-routing chooses fresh-vs-inline **PER CLUSTER**. It NEVER changes the
 * cluster COUNT. The cluster count is `ceil(totalACs / clusterCeiling)` with
 * the non-disableable `[1, 8]` clamp, owned entirely by
 * `acceptance-clusters.js` and untouched here. A low-risk Story still gets one
 * verdict per cluster — just possibly authored inline instead of by a fresh
 * sub-agent. This module takes the cluster index as an INPUT and returns a
 * decision for that one cluster; it has no way to add or remove clusters.
 *
 * ## One verdict-owner per cluster (Story #4723)
 *
 * The resolved decision names the cluster's **single verdict owner** via
 * `verdictOwner`: `'fresh-critic'` when the mode is `fresh`,
 * `'inline-self-eval'` when the mode is `inline`. Exactly one pass authors
 * the cluster's verdict — the fresh maker-blind critic OR the
 * contract-identical inline self-eval, never both, and never an additional
 * pre-pass self-assessment before the owner runs. `acceptance-eval.js` is
 * the deterministic SCORER of that one authored verdict (schema validation,
 * round cap, proceed/redraft/block) — it is not a third pass over the
 * criteria. This removes a redundant pass only; it never removes a
 * cluster's verdict (the M4-B floor above holds).
 *
 * ## Tier rules (per cluster, `standard` profile)
 *
 *   - `high` level       → `fresh`   (a sensitive path was touched — a
 *                                     fresh-context maker-blind spawn).
 *   - `low` level        → `inline`  (the contract-identical inline critic),
 *                                     UNLESS the maker-checker sampling floor
 *                                     selects this cluster → `fresh`.
 *   - missing / unknown  → `fresh`   (fail-safe: the diff could not be
 *                                     enumerated, so there is no evidence the
 *                                     change is unremarkable; treat it as
 *                                     needing the full fresh-context ceremony,
 *                                     exactly as `resolveDepth` degrades to
 *                                     `standard` on the same signal).
 *
 * ## Maker-checker sampling floor
 *
 * Even at a `low` derived level under `standard`, a fraction of clusters
 * (`freshCriticSampleRate`, default 0.2) is forced `fresh` so a low level never
 * means zero independent checking. The selection is **deterministic** in the
 * cluster index (a fixed stride), so it is stable across re-runs and —
 * critically — never changes the cluster count: it only re-labels which of
 * the fixed set of clusters run fresh. Profiles `minimal` and `strict`
 * ignore the sampling floor.
 *
 * Pure and total: inputs in, decision out. No I/O, no throws. `null` /
 * `undefined` / malformed inputs degrade to `fresh` + `full` ceremony.
 *
 * @typedef {'fresh'|'inline'} CeremonyMode
 * @typedef {'fresh-critic'|'inline-self-eval'} VerdictOwner
 * @typedef {import('./review-depth.js').ChangeLevel} ChangeLevel
 * @typedef {'minimal'|'standard'|'strict'} CeremonyProfile
 */

/**
 * Map a resolved ceremony mode to the cluster's single verdict owner
 * (Story #4723). Total: any non-`fresh` value maps to the inline
 * self-eval owner, mirroring how the mode itself degrades.
 *
 * @param {CeremonyMode} mode
 * @returns {VerdictOwner}
 */
export function verdictOwnerForMode(mode) {
  return mode === 'fresh' ? 'fresh-critic' : 'inline-self-eval';
}

/** @type {readonly CeremonyProfile[]} */
export const CEREMONY_PROFILES = Object.freeze([
  'minimal',
  'standard',
  'strict',
]);

/**
 * Normalize an operator/config ceremony profile. Unknown values degrade to
 * `standard` (fail toward the documented default, not toward less ceremony).
 *
 * @param {unknown} value
 * @returns {CeremonyProfile}
 */
export function normalizeCeremonyProfile(value) {
  if (value === 'minimal' || value === 'standard' || value === 'strict') {
    return value;
  }
  return 'standard';
}

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
 * Resolve the acceptance ceremony for one cluster from the ceremony profile,
 * the derived change level, and the maker-checker sampling floor. See the
 * module header for the tier rules and the untouchable cluster-count invariant.
 *
 * @param {{
 *   derivedLevel?: (ChangeLevel|string|null|undefined),
 *   clusterIndex?: (number|null|undefined),
 *   freshCriticSampleRate?: (number|null|undefined),
 *   ceremonyProfile?: (CeremonyProfile|string|null|undefined),
 * }} [input]
 * @returns {{
 *   mode: CeremonyMode,
 *   reason: string,
 *   sampled: boolean,
 *   profile: CeremonyProfile,
 *   verdictOwner: VerdictOwner,
 * }}
 */
export function resolveCeremonyForRisk(input = {}) {
  const decision = resolveCeremonyDecision(input);
  return { ...decision, verdictOwner: verdictOwnerForMode(decision.mode) };
}

/**
 * Internal mode/reason resolution — the tier rules and sampling floor.
 * `resolveCeremonyForRisk` decorates the result with the single
 * `verdictOwner` derived from the mode (Story #4723).
 *
 * @param {Parameters<typeof resolveCeremonyForRisk>[0]} [input]
 * @returns {{
 *   mode: CeremonyMode,
 *   reason: string,
 *   sampled: boolean,
 *   profile: CeremonyProfile,
 * }}
 */
function resolveCeremonyDecision(input = {}) {
  const derivedLevel =
    input && typeof input === 'object' ? input.derivedLevel : undefined;
  const clusterIndex =
    input && typeof input === 'object' ? input.clusterIndex : undefined;
  const rate =
    input && typeof input === 'object'
      ? input.freshCriticSampleRate
      : undefined;
  const profile = normalizeCeremonyProfile(
    input && typeof input === 'object' ? input.ceremonyProfile : undefined,
  );

  if (profile === 'minimal') {
    return {
      mode: 'inline',
      reason: 'ceremonyProfile=minimal: inline critic (no fresh spawn)',
      sampled: false,
      profile,
    };
  }
  if (profile === 'strict') {
    return {
      mode: 'fresh',
      reason: 'ceremonyProfile=strict: fresh-context critic',
      sampled: false,
      profile,
    };
  }

  if (derivedLevel === 'high') {
    return {
      mode: 'fresh',
      reason: 'sensitive path touched: fresh-context critic',
      sampled: false,
      profile,
    };
  }
  if (derivedLevel === 'low') {
    if (sampledFresh(clusterIndex, rate)) {
      return {
        mode: 'fresh',
        reason:
          'low-level cluster forced fresh by the maker-checker sampling floor',
        sampled: true,
        profile,
      };
    }
    return {
      mode: 'inline',
      reason: 'no sensitive path touched: contract-identical inline critic',
      sampled: false,
      profile,
    };
  }
  // Missing / unknown / malformed level → fail-safe fresh + full ceremony,
  // matching how resolveDepth degrades to `standard` on the same signal.
  return {
    mode: 'fresh',
    reason:
      'change level underivable: fail-safe fresh-context critic + full ceremony',
    sampled: false,
    profile,
  };
}
