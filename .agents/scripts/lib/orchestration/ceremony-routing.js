/**
 * lib/orchestration/ceremony-routing.js — the acceptance verdict owner from
 * the ceremony profile alone: `strict` → fresh critic, else inline self-eval.
 * The change level is deliberately not an input (it feeds review depth).
 * Exactly one pass authors the verdict. Pure and total.
 *
 * @typedef {'fresh'|'inline'} CeremonyMode
 * @typedef {'fresh-critic'|'inline-self-eval'} VerdictOwner
 * @typedef {(typeof CEREMONY_PROFILES)[number]} CeremonyProfile
 */

/**
 * @param {CeremonyMode} mode
 * @returns {VerdictOwner}
 */
export function verdictOwnerForMode(mode) {
  return mode === 'fresh' ? 'fresh-critic' : 'inline-self-eval';
}

/** @type {readonly ['minimal', 'standard', 'strict']} */
const CEREMONY_PROFILES = Object.freeze(['minimal', 'standard', 'strict']);

const DEFAULT_CEREMONY_PROFILE = 'standard';

/**
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
 * @param {unknown} value
 * @returns {CeremonyProfile}
 */
function normalizeCeremonyProfile(value) {
  return CEREMONY_PROFILES.includes(/** @type {CeremonyProfile} */ (value))
    ? /** @type {CeremonyProfile} */ (value)
    : DEFAULT_CEREMONY_PROFILE;
}

/**
 * @param {{
 *   ceremonyProfile?: (CeremonyProfile|string|null|undefined),
 * }} [input]
 * @returns {{
 *   mode: CeremonyMode,
 *   reason: string,
 *   profile: CeremonyProfile,
 *   verdictOwner: VerdictOwner,
 * }}
 */
export function resolveCeremonyForRisk(input = {}) {
  const profile = normalizeCeremonyProfile(input?.ceremonyProfile);
  const { mode, reason } = PROFILE_DECISIONS[profile];
  return { mode, reason, profile, verdictOwner: verdictOwnerForMode(mode) };
}
