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
 *   - `minimal`  — always `inline` (no fresh critic spawn).
 *                  Use for tiny N=1 Stories the operator trusts.
 *   - `standard` — level-routed (default). Low → inline; high or
 *                  underivable → fresh.
 *   - `strict`   — always `fresh` regardless of the derived level.
 *
 * ## The load-bearing invariant (M4-B acceptance floor — DO NOT VIOLATE)
 *
 * Risk-routing chooses fresh-vs-inline **PER CLUSTER**. It NEVER changes the
 * cluster COUNT — the caller owns clustering and hands this module a cluster
 * index. A low-risk Story still gets one verdict per cluster — just possibly
 * authored inline instead of by a fresh sub-agent. This module takes the
 * cluster index as an INPUT and returns a decision for that one cluster; it
 * has no way to add or remove clusters.
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
 *   - `low` level        → `inline`  (the contract-identical inline critic).
 *   - missing / unknown  → `fresh`   (fail-safe: the diff could not be
 *                                     enumerated, so there is no evidence the
 *                                     change is unremarkable; treat it as
 *                                     needing the full fresh-context ceremony,
 *                                     exactly as `resolveDepth` degrades to
 *                                     `standard` on the same signal).
 *
 * ## No sampling floor (Story #5313)
 *
 * The maker-checker sampling floor (`delivery.routing.freshCriticSampleRate`,
 * `sampledFresh`) bounded independent checking by a cluster-index stride —
 * a count, not a risk signal — and was retired with the delivery diet. The
 * standard profile now routes purely off the derived level, so the decision
 * carries no `sampled` field and `clusterIndex` is accepted only for call-site
 * compatibility (it never changes the outcome).
 *
 * Pure and total: inputs in, decision out. No I/O, no throws. `null` /
 * `undefined` / malformed inputs degrade to `fresh` + `full` ceremony.
 *
 * @typedef {'fresh'|'inline'} CeremonyMode
 * @typedef {'fresh-critic'|'inline-self-eval'} VerdictOwner
 * @typedef {import('./review-depth.js').ChangeLevel} ChangeLevel
 * @typedef {(typeof CEREMONY_PROFILES)[number]} CeremonyProfile
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

/**
 * The ceremony-profile vocabulary — the **single** place the three profile
 * names are written. `normalizeCeremonyProfile` is its reader and the
 * `CeremonyProfile` typedef is derived from it, so adding a profile is a
 * one-line change here (Story #4926).
 *
 * @type {readonly ['minimal', 'standard', 'strict']}
 */
const CEREMONY_PROFILES = Object.freeze(['minimal', 'standard', 'strict']);

/** The profile an absent or unrecognized value degrades to. */
const DEFAULT_CEREMONY_PROFILE = 'standard';

/**
 * Normalize an operator/config ceremony profile. Unknown values degrade to
 * `standard` (fail toward the documented default, not toward less ceremony).
 *
 * @param {unknown} value
 * @returns {CeremonyProfile}
 */
function normalizeCeremonyProfile(value) {
  return CEREMONY_PROFILES.includes(/** @type {CeremonyProfile} */ (value))
    ? /** @type {CeremonyProfile} */ (value)
    : DEFAULT_CEREMONY_PROFILE;
}

/**
 * Resolve the acceptance ceremony for one cluster from the ceremony profile
 * and the derived change level. See the module header for the tier rules and
 * the untouchable cluster-count invariant.
 *
 * @param {{
 *   derivedLevel?: (ChangeLevel|string|null|undefined),
 *   clusterIndex?: (number|null|undefined),
 *   ceremonyProfile?: (CeremonyProfile|string|null|undefined),
 * }} [input] `clusterIndex` is accepted for call-site compatibility only
 *   (Story #5313 retired the sampling floor that read it).
 * @returns {{
 *   mode: CeremonyMode,
 *   reason: string,
 *   profile: CeremonyProfile,
 *   verdictOwner: VerdictOwner,
 * }}
 */
export function resolveCeremonyForRisk(input = {}) {
  const decision = resolveCeremonyDecision(input);
  return { ...decision, verdictOwner: verdictOwnerForMode(decision.mode) };
}

/**
 * Internal mode/reason resolution — the tier rules. `resolveCeremonyForRisk`
 * decorates the result with the single `verdictOwner` derived from the mode
 * (Story #4723).
 *
 * @param {Parameters<typeof resolveCeremonyForRisk>[0]} [input]
 * @returns {{
 *   mode: CeremonyMode,
 *   reason: string,
 *   profile: CeremonyProfile,
 * }}
 */
function resolveCeremonyDecision(input = {}) {
  const derivedLevel =
    input && typeof input === 'object' ? input.derivedLevel : undefined;
  const profile = normalizeCeremonyProfile(
    input && typeof input === 'object' ? input.ceremonyProfile : undefined,
  );

  if (profile === 'minimal') {
    return {
      mode: 'inline',
      reason: 'ceremonyProfile=minimal: inline critic (no fresh spawn)',
      profile,
    };
  }
  if (profile === 'strict') {
    return {
      mode: 'fresh',
      reason: 'ceremonyProfile=strict: fresh-context critic',
      profile,
    };
  }

  if (derivedLevel === 'high') {
    return {
      mode: 'fresh',
      reason: 'sensitive path touched: fresh-context critic',
      profile,
    };
  }
  if (derivedLevel === 'low') {
    return {
      mode: 'inline',
      reason: 'no sensitive path touched: contract-identical inline critic',
      profile,
    };
  }
  // Missing / unknown / malformed level → fail-safe fresh + full ceremony,
  // matching how resolveDepth degrades to `standard` on the same signal.
  return {
    mode: 'fresh',
    reason:
      'change level underivable: fail-safe fresh-context critic + full ceremony',
    profile,
  };
}
