/**
 * `delivery.routing`: spawn boot context and ceremony profile. Only `strict`
 * spawns a fresh-context critic; `minimal`/`standard` use the inline
 * self-eval. `roleScopedAgents: false` falls every converted spawn back to
 * `general-purpose` with the full closure — a revert that drops no gate.
 */

export const DELIVERY_ROUTING_DEFAULTS = Object.freeze({
  roleScopedAgents: true,
  /** @type {'minimal'|'standard'|'strict'} */
  ceremonyProfile: 'standard',
  /** Land through merge in one close; opt out with `--no-wait-merge`. */
  closeAndLand: true,
  /** Retitle the host session with a state glyph (`session-title.js`). */
  sessionTitles: true,
});

const CEREMONY_PROFILES = ['minimal', 'standard', 'strict'];

/**
 * @param {unknown} value
 * @returns {'minimal'|'standard'|'strict'}
 */
function normalizeCeremonyProfile(value) {
  return CEREMONY_PROFILES.includes(value)
    ? value
    : DELIVERY_ROUTING_DEFAULTS.ceremonyProfile;
}

/**
 * Accepts the full config, the `delivery` bag, or the `routing` bag.
 *
 * @param {object | null | undefined} config
 * @returns {{
 *   roleScopedAgents: boolean,
 *   ceremonyProfile: 'minimal'|'standard'|'strict',
 *   closeAndLand: boolean,
 *   sessionTitles: boolean,
 * }}
 */
export function getDeliveryRouting(config) {
  const routing = config?.delivery?.routing ?? config?.routing ?? config ?? {};
  const flag = (key) =>
    typeof routing[key] === 'boolean'
      ? routing[key]
      : DELIVERY_ROUTING_DEFAULTS[key];
  return {
    roleScopedAgents: flag('roleScopedAgents'),
    ceremonyProfile: normalizeCeremonyProfile(routing.ceremonyProfile),
    closeAndLand: flag('closeAndLand'),
    sessionTitles: flag('sessionTitles'),
  };
}
