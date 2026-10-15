/**
 * Pure resolvers for per-kind baseline env overrides: config → env → default,
 * with malformed env values warning and falling through.
 */

import { Logger } from '../Logger.js';

// Escomplex/Node churn drifts MI by ±0.05–0.3 on unchanged files; 0.5 keeps
// the pre-push hook from ratcheting on noise.
const MI_DEFAULT_TOLERANCE = 0.5;

/**
 * A non-negative numeric env override of `key`, or `current` (with a warning)
 * when the value is malformed. An unset or empty var keeps `current` silently.
 *
 * @param {{ env: NodeJS.ProcessEnv, varName: string, key: string, current: number, overrides: string[] }} opts
 * @returns {number}
 */
function readNonNegativeEnv({ env, varName, key, current, overrides }) {
  const raw = env?.[varName];
  if (raw === undefined || raw === '') return current;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 0) {
    overrides.push(`${key}=${parsed} (${varName})`);
    return parsed;
  }
  Logger.warn(
    `[CRAP] ⚠ ignoring malformed ${varName}=${raw}; keeping config value ${current}`,
  );
  return current;
}

const finiteOr = (value, fallback) =>
  Number.isFinite(value) ? value : fallback;

/**
 * @param {{ newMethodCeiling?: unknown, tolerance?: unknown, refreshTag?: unknown }} crapConfig
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ newMethodCeiling: number, tolerance: number, refreshTag: string, overrides: string[] }}
 */
export function resolveCrapEnvOverrides(crapConfig, env) {
  const overrides = [];
  const newMethodCeiling = readNonNegativeEnv({
    env,
    varName: 'CRAP_NEW_METHOD_CEILING',
    key: 'newMethodCeiling',
    current: finiteOr(crapConfig?.newMethodCeiling, 30),
    overrides,
  });
  // Coverage rounding across CI environments shifts a CRAP score by ~0.01;
  // real regressions cross whole integers and clear 0.05 trivially.
  const tolerance = readNonNegativeEnv({
    env,
    varName: 'CRAP_TOLERANCE',
    key: 'tolerance',
    current: finiteOr(crapConfig?.tolerance, 0.05),
    overrides,
  });
  const rawRefreshTag = env?.CRAP_REFRESH_TAG;
  let refreshTag =
    typeof crapConfig?.refreshTag === 'string' && crapConfig.refreshTag.length
      ? crapConfig.refreshTag
      : 'baseline-refresh:';
  if (typeof rawRefreshTag === 'string' && rawRefreshTag.length > 0) {
    refreshTag = rawRefreshTag;
    overrides.push(`refreshTag=${rawRefreshTag} (CRAP_REFRESH_TAG)`);
  }

  return { newMethodCeiling, tolerance, refreshTag, overrides };
}

/**
 * `bundle-size` → `BUNDLE_SIZE_REFRESH`.
 *
 * @param {string} kind
 * @returns {string|null} null when `kind` is not a usable kind name
 */
function kindRefreshEnvVar(kind) {
  if (typeof kind !== 'string' || kind.length === 0) return null;
  return `${kind.toUpperCase().replace(/-/g, '_')}_REFRESH`;
}

/**
 * `<KIND>_REFRESH=1|true` demotes this run's regressions to `unchanged`
 * (floors still apply), so a full-scope re-measure is not blocked. Never
 * persisted.
 *
 * @param {string} kind
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ acknowledged: boolean, overrides: string[] }}
 */
export function resolveKindRefreshOverrides(kind, env) {
  const varName = kindRefreshEnvVar(kind);
  if (!varName) return { acknowledged: false, overrides: [] };
  const raw = env?.[varName];
  const acknowledged =
    typeof raw === 'string' && /^(1|true)$/i.test(raw.trim());
  const overrides = acknowledged
    ? [`acknowledged=true (${varName}=${raw})`]
    : [];
  return { acknowledged, overrides };
}

/**
 * `CRAP_TOLERANCE` env (CI forces base values on both gates) → configured
 * tolerance → 0.5. A malformed env value warns and keeps the config value.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ tolerance?: number }} [maintainabilityConfig]
 * @returns {{ tolerance: number, overrides: string[] }}
 */
export function resolveMaintainabilityEnvOverrides(env, maintainabilityConfig) {
  const overrides = [];
  let tolerance = MI_DEFAULT_TOLERANCE;
  const configured = maintainabilityConfig?.tolerance;
  if (
    typeof configured === 'number' &&
    Number.isFinite(configured) &&
    configured >= 0
  ) {
    tolerance = configured;
    overrides.push(
      `tolerance=${configured} (quality.maintainability.tolerance)`,
    );
  }
  const raw = env?.CRAP_TOLERANCE;
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      tolerance = parsed;
      overrides.push(`tolerance=${parsed} (CRAP_TOLERANCE)`);
    } else {
      Logger.warn(
        `[Maintainability] ⚠ ignoring malformed CRAP_TOLERANCE=${raw}; keeping ${tolerance}`,
      );
    }
  }
  return { tolerance, overrides };
}
