/**
 * Flat `{ crap, maintainability }` view over each gate's `baselinePath`;
 * `refreshCommand` is always `null`, kept for shape stability.
 */

export const BASELINES_DEFAULTS = Object.freeze({
  crap: Object.freeze({ path: 'baselines/crap.json', refreshCommand: null }),
  maintainability: Object.freeze({
    path: 'baselines/maintainability.json',
    refreshCommand: null,
  }),
});

/**
 * @param {object | null | undefined} config
 * @returns {{ crap: { path: string, refreshCommand: null }, maintainability: { path: string, refreshCommand: null } }}
 */
export function getBaselines(config) {
  const gates = config?.delivery?.quality?.gates ?? {};
  const merge = (key) => {
    const fallback = BASELINES_DEFAULTS[key];
    const path = gates[key]?.baselinePath ?? fallback.path;
    return { path, refreshCommand: null };
  };
  return {
    crap: merge('crap'),
    maintainability: merge('maintainability'),
  };
}
