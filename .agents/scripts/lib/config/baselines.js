/**
 * `delivery.quality.baselines` accessor.
 *
 * Story #1737 collapsed the old standalone `delivery.quality.baselines.*`
 * block — every gate now carries its own `baselinePath` under
 * `delivery.quality.gates.<tier>.baselinePath`. This module preserves the
 * historical `{ lint, crap, maintainability }` envelope so existing call
 * sites that read `getBaselines(config).lint.path` keep working; the
 * envelope is synthesised from the per-gate `baselinePath` values.
 *
 * `refreshCommand` is no longer carried per-baseline (the schema dropped
 * the field along with the standalone block) — it returns `null` so the
 * historical envelope shape stays stable.
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
 * Read the per-gate baseline paths and surface them under the historical
 * flat envelope. Accepts the full resolved config or any unwrapped
 * variant; `agentSettings` is honoured for the legacy shim path.
 *
 * @param {object | null | undefined} config
 * @returns {{ lint: { path: string, refreshCommand: null }, crap: { path: string, refreshCommand: null }, maintainability: { path: string, refreshCommand: null } }}
 */
export function getBaselines(config) {
  const gates =
    config?.delivery?.quality?.gates ??
    config?.quality?.gates ??
    config?.agentSettings?.quality?.gates ??
    {};
  const pick = (key) => ({
    path: gates?.[key]?.baselinePath ?? BASELINES_DEFAULTS[key].path,
    refreshCommand: null,
  });
  return {
    lint: pick('lint'),
    crap: pick('crap'),
    maintainability: pick('maintainability'),
  };
}

/**
 * Merge the user-supplied `quality.baselines` block with framework defaults.
 * Story #1737 retired the standalone block in favour of per-gate
 * `baselinePath` declarations; this helper now treats `userBlock` as a
 * `{ lint, crap, maintainability }` shape and projects each entry's `path`
 * onto a synthetic `gates.<tier>.baselinePath` so the envelope shape is
 * preserved for tests that exercised the legacy entry point.
 *
 * @param {object | undefined} userBlock
 */
export function resolveBaselines(userBlock) {
  const block = userBlock && typeof userBlock === 'object' ? userBlock : {};
  const gates = {};
  for (const tier of ['lint', 'crap', 'maintainability']) {
    const entry = block[tier];
    if (entry && typeof entry === 'object' && typeof entry.path === 'string') {
      gates[tier] = { baselinePath: entry.path };
    }
  }
  return getBaselines({ quality: { gates } });
}
