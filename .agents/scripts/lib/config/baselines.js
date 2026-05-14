/**
 * `delivery.quality.baselines` accessor (Epic #1720 Story #1739 — top-level
 * reshape; the block relocated from `agentSettings.quality.baselines.*`).
 */

export const BASELINES_DEFAULTS = Object.freeze({
  lint: Object.freeze({ path: 'baselines/lint.json', refreshCommand: null }),
  crap: Object.freeze({ path: 'baselines/crap.json', refreshCommand: null }),
  maintainability: Object.freeze({
    path: 'baselines/maintainability.json',
    refreshCommand: null,
  }),
});

/**
 * Read the grouped `delivery.quality.baselines` block, applying framework
 * defaults for any baseline (or any field within a baseline) the operator
 * omitted. Accepts the full resolved config or any unwrapped variant.
 *
 * @param {object | null | undefined} config
 * @returns {{ lint: { path: string, refreshCommand: string|null }, crap: { path: string, refreshCommand: string|null }, maintainability: { path: string, refreshCommand: string|null } }}
 */
export function getBaselines(config) {
  const baselines =
    config?.delivery?.quality?.baselines ??
    config?.quality?.baselines ??
    config?.agentSettings?.quality?.baselines ??
    {};
  const merge = (key) => {
    const fallback = BASELINES_DEFAULTS[key];
    const user = baselines[key] ?? {};
    return {
      path: user.path ?? fallback.path,
      refreshCommand:
        user.refreshCommand === undefined
          ? fallback.refreshCommand
          : user.refreshCommand,
    };
  };
  return {
    lint: merge('lint'),
    crap: merge('crap'),
    maintainability: merge('maintainability'),
  };
}

/**
 * Merge the user-supplied `quality.baselines` block with framework defaults.
 *
 * @param {object|undefined} userBlock
 */
export function resolveBaselines(userBlock) {
  return getBaselines({ quality: { baselines: userBlock ?? {} } });
}
