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
});

/**
 * @param {unknown} value
 * @returns {'minimal'|'standard'|'strict'}
 */
function normalizeCeremonyProfile(value) {
  if (value === 'minimal' || value === 'standard' || value === 'strict') {
    return value;
  }
  return DELIVERY_ROUTING_DEFAULTS.ceremonyProfile;
}

/**
 * Accepts the full config, the `delivery` bag, or the `routing` bag.
 *
 * @param {object | null | undefined} config
 * @returns {{
 *   roleScopedAgents: boolean,
 *   ceremonyProfile: 'minimal'|'standard'|'strict',
 *   closeAndLand: boolean,
 * }}
 */
export function getDeliveryRouting(config) {
  const routing = config?.delivery?.routing ?? config?.routing ?? config ?? {};
  return {
    roleScopedAgents:
      typeof routing.roleScopedAgents === 'boolean'
        ? routing.roleScopedAgents
        : DELIVERY_ROUTING_DEFAULTS.roleScopedAgents,
    ceremonyProfile: normalizeCeremonyProfile(routing.ceremonyProfile),
    closeAndLand:
      typeof routing.closeAndLand === 'boolean'
        ? routing.closeAndLand
        : DELIVERY_ROUTING_DEFAULTS.closeAndLand,
  };
}
