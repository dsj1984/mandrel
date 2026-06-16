/**
 * `delivery.quality.baselines` accessor (Epic #1720 Story #1737 — per-gate
 * baselines). Every gate now carries its own `baselinePath` under
 * `delivery.quality.gates.<tier>.baselinePath`. This module preserves the
 * historical `{ lint, crap, maintainability }` envelope so existing call
 * sites that read `getBaselines(config).lint.path` keep working.
 * `refreshCommand` is no longer carried per-baseline — it stays in the
 * envelope as `null` for shape stability.
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
 * flat envelope. Accepts the full resolved config — the canonical
 * `delivery.quality.gates` path is the single supported shape.
 *
 * @param {object | null | undefined} config
 * @returns {{ lint: { path: string, refreshCommand: null }, crap: { path: string, refreshCommand: null }, maintainability: { path: string, refreshCommand: null } }}
 */
export function getBaselines(config) {
  const gates = config?.delivery?.quality?.gates ?? {};
  const merge = (key) => {
    const fallback = BASELINES_DEFAULTS[key];
    const path = gates[key]?.baselinePath ?? fallback.path;
    return { path, refreshCommand: null };
  };
  return {
    lint: merge('lint'),
    crap: merge('crap'),
    maintainability: merge('maintainability'),
  };
}
