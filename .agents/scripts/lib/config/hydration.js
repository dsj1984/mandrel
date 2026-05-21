/**
 * `delivery.hydration` — context hydrator settings (Epic #2648).
 *
 * The envelope-first pipeline is the only supported output shape. This
 * resolver only carries the `fullSkillBodies` opt-in; the historical
 * `outputMode` toggle and the parallel legacy engine were removed under
 * Story #2864 per the hard-cutover policy.
 */

export const HYDRATION_DEFAULTS = Object.freeze({
  fullSkillBodies: false,
});

/**
 * @param {object|undefined} delivery
 * @returns {{ fullSkillBodies: boolean }}
 */
export function resolveHydration(delivery) {
  const user =
    delivery?.hydration && typeof delivery.hydration === 'object'
      ? delivery.hydration
      : {};
  return {
    fullSkillBodies: user.fullSkillBodies ?? HYDRATION_DEFAULTS.fullSkillBodies,
  };
}

/**
 * @param {object | null | undefined} config
 * @returns {ReturnType<typeof resolveHydration>}
 */
export function getHydration(config) {
  return resolveHydration(config?.delivery ?? config);
}
