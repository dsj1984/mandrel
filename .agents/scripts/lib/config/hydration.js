/**
 * `delivery.hydration` — context hydrator output mode (Epic #2648).
 *
 * `outputMode` selects envelope-first vs one-release legacy prose. The
 * `prose-legacy` value and `context-hydration-engine.legacy.js` are removed
 * together in the cutover PR after one release — no indefinite shim layer.
 */

export const HYDRATION_DEFAULTS = Object.freeze({
  outputMode: 'envelope',
  fullSkillBodies: false,
});

/**
 * @param {object|undefined} delivery
 * @returns {{ outputMode: 'envelope' | 'prose-legacy', fullSkillBodies: boolean }}
 */
export function resolveHydration(delivery) {
  const user =
    delivery?.hydration && typeof delivery.hydration === 'object'
      ? delivery.hydration
      : {};
  return {
    outputMode: user.outputMode ?? HYDRATION_DEFAULTS.outputMode,
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
