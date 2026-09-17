/**
 * lib/orchestration/ceremony-routing.js — ceremony-profile acceptance
 * ceremony resolver.
 *
 * The sibling of `review-depth.js#resolveDepth`: it folds the operator
 * ceremony profile into a per-Story ceremony decision for the acceptance
 * verdict — **fresh-context spawn** vs the contract-identical **inline**
 * self-eval. It does NOT invent a risk score, and it no longer routes off
 * anything the diff says.
 *
 * ## The profile is the whole decision (Story #5343)
 *
 *   - `minimal`  — `inline`.
 *   - `standard` — `inline` (the **default**).
 *   - `strict`   — `fresh`.
 *
 * A frontier-model worker scoring its own `acceptance[]` items against the
 * `verify[]` output it just produced is the default the delivery diet settled
 * on: the fresh critic's isolation bought a second full-context boot per
 * Story and, measured across the run, changed no verdict the inline pass did
 * not already reach. `strict` keeps the fresh-context critic for
 * high-assurance surfaces, and is the one profile that spawns one.
 *
 * **`derivedLevel` no longer routes.** It is still accepted (and still
 * derived, and still printed by `ceremony-derive.js`) because **review
 * depth** reads the same signal — `review-depth.js#resolveDepth` continues to
 * resolve `deep` for any sensitive class, and that is untouched. What changed
 * is only which of the two decisions the level feeds: review depth, not the
 * verdict owner. An unenumerable diff is therefore no longer a fail-safe
 * escalation here; it escalates review depth instead, where the evidence it
 * withholds actually matters.
 *
 * ## One verdict-owner per Story (Story #4723, narrowed by #5343)
 *
 * The resolved decision names the Story's **single verdict owner** via
 * `verdictOwner`: `'fresh-critic'` when the mode is `fresh`,
 * `'inline-self-eval'` when the mode is `inline`. Exactly one pass authors
 * the Story's verdict — the fresh maker-blind critic OR the
 * contract-identical inline self-eval, never both, and never an additional
 * pre-pass self-assessment before the owner runs. `acceptance-eval.js` is
 * the deterministic SCORER of that one authored verdict (schema validation,
 * round cap, proceed/redraft/block) — it is not a third pass over the
 * criteria. The verdict is **one file per Story**, scored in one gate call;
 * the cluster protocol that used to split it was retired with #5343.
 *
 * Pure and total: inputs in, decision out. No I/O, no throws. `null` /
 * `undefined` / malformed inputs degrade to the default profile.
 *
 * @typedef {'fresh'|'inline'} CeremonyMode
 * @typedef {'fresh-critic'|'inline-self-eval'} VerdictOwner
 * @typedef {import('./review-depth.js').ChangeLevel} ChangeLevel
 * @typedef {(typeof CEREMONY_PROFILES)[number]} CeremonyProfile
 */

/**
 * Map a resolved ceremony mode to the Story's single verdict owner
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
 * The one routing table: profile → mode + the reason the decision carries.
 * `strict` is the only profile that spawns a fresh critic.
 *
 * @type {Readonly<Record<CeremonyProfile, { mode: CeremonyMode, reason: string }>>}
 */
const PROFILE_DECISIONS = Object.freeze({
  minimal: {
    mode: 'inline',
    reason: 'ceremonyProfile=minimal: inline self-eval (no fresh spawn)',
  },
  standard: {
    mode: 'inline',
    reason:
      'ceremonyProfile=standard: inline self-eval authors the Story verdict',
  },
  strict: {
    mode: 'fresh',
    reason: 'ceremonyProfile=strict: fresh-context critic',
  },
});

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
 * Resolve the acceptance ceremony for one Story from the ceremony profile.
 * See the module header for the profile table and why the derived level no
 * longer routes it.
 *
 * @param {{
 *   derivedLevel?: (ChangeLevel|string|null|undefined),
 *   clusterIndex?: (number|null|undefined),
 *   ceremonyProfile?: (CeremonyProfile|string|null|undefined),
 * }} [input] `derivedLevel` and `clusterIndex` are accepted for call-site
 *   compatibility only — neither changes the outcome (Story #5343).
 * @returns {{
 *   mode: CeremonyMode,
 *   reason: string,
 *   profile: CeremonyProfile,
 *   verdictOwner: VerdictOwner,
 * }}
 */
export function resolveCeremonyForRisk(input = {}) {
  // Optional chaining rather than a typeof guard: `normalizeCeremonyProfile`
  // is already total over anything that is not one of the three names, so a
  // non-object input degrades to `standard` through the same door.
  const profile = normalizeCeremonyProfile(input?.ceremonyProfile);
  const { mode, reason } = PROFILE_DECISIONS[profile];
  return { mode, reason, profile, verdictOwner: verdictOwnerForMode(mode) };
}
