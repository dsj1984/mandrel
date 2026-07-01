/**
 * env-overrides.js — pure resolvers for the per-kind baseline env overrides.
 *
 * Hoisted from `check-crap.js` and `check-maintainability.js` (Story #1981,
 * Task #1989) so the env-precedence behavior — config → env → default,
 * malformed values warn-and-fall-through — lives in a lib module the
 * per-kind callers (and tests) can share without spawning a CLI.
 *
 * No I/O. No side effects beyond logger warnings.
 */

import { Logger } from '../Logger.js';

// Framework default MI tolerance. Raised from 0.001 to 0.5 because real-world
// noise (Node-version churn, escomplex internal updates, typhonjs-escomplex
// rounding) routinely drifts +/- 0.05 to 0.3 on otherwise-unchanged files —
// well below the threshold of "actually less maintainable." A 0.5 floor
// stops the pre-push hook from auto-ratcheting the baseline on noise.
export const MI_DEFAULT_TOLERANCE = 0.5;

/**
 * Pure helper: resolve the effective CRAP config by layering env-var
 * overrides on top of the resolved `.agentrc.json` values. Exported so
 * tests can assert the precedence + malformed-value behavior without
 * spawning the CLI.
 *
 * @param {{ newMethodCeiling?: unknown, tolerance?: unknown, refreshTag?: unknown }} crapConfig
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ newMethodCeiling: number, tolerance: number, refreshTag: string, overrides: string[] }}
 */
export function resolveCrapEnvOverrides(crapConfig, env) {
  const overrides = [];
  let newMethodCeiling = Number.isFinite(crapConfig?.newMethodCeiling)
    ? crapConfig.newMethodCeiling
    : 30;
  // Default 0.05 (raised from 0.001 in 5.36.1). CRAP scores are
  // `c² · (1 − cov)³ + c`, so a sub-percent per-method coverage rounding
  // shift across CI environments — same code, different escomplex /
  // coverage build — moves the score by ~0.01 on its own. A 0.001
  // tolerance flagged that as a regression; real regressions cross
  // whole-integer thresholds (e.g. 8 → 12) and clear 0.05 trivially.
  let tolerance = Number.isFinite(crapConfig?.tolerance)
    ? crapConfig.tolerance
    : 0.05;
  let refreshTag =
    typeof crapConfig?.refreshTag === 'string' && crapConfig.refreshTag.length
      ? crapConfig.refreshTag
      : 'baseline-refresh:';

  const rawCeiling = env?.CRAP_NEW_METHOD_CEILING;
  if (rawCeiling !== undefined && rawCeiling !== '') {
    const parsed = Number(rawCeiling);
    if (Number.isFinite(parsed) && parsed >= 0) {
      newMethodCeiling = parsed;
      overrides.push(`newMethodCeiling=${parsed} (CRAP_NEW_METHOD_CEILING)`);
    } else {
      Logger.warn(
        `[CRAP] ⚠ ignoring malformed CRAP_NEW_METHOD_CEILING=${rawCeiling}; keeping config value ${newMethodCeiling}`,
      );
    }
  }

  const rawTolerance = env?.CRAP_TOLERANCE;
  if (rawTolerance !== undefined && rawTolerance !== '') {
    const parsed = Number(rawTolerance);
    if (Number.isFinite(parsed) && parsed >= 0) {
      tolerance = parsed;
      overrides.push(`tolerance=${parsed} (CRAP_TOLERANCE)`);
    } else {
      Logger.warn(
        `[CRAP] ⚠ ignoring malformed CRAP_TOLERANCE=${rawTolerance}; keeping config value ${tolerance}`,
      );
    }
  }

  const rawRefreshTag = env?.CRAP_REFRESH_TAG;
  if (typeof rawRefreshTag === 'string' && rawRefreshTag.length > 0) {
    refreshTag = rawRefreshTag;
    overrides.push(`refreshTag=${rawRefreshTag} (CRAP_REFRESH_TAG)`);
  }

  return { newMethodCeiling, tolerance, refreshTag, overrides };
}

/**
 * Pure helper: resolve the one-shot bundle-size refresh/acknowledge flag
 * (Story #151). Unlike `coverage` / `crap` / `maintainability`, the
 * bundle-size gate has no scorer of its own — the measured sizes come from
 * a build step the operator already runs, not a source-tree rescan — so
 * there is no `refreshBaseline({ kind: 'bundle-size', ... })` path to
 * regenerate a "corrected" baseline. Instead, `BUNDLE_SIZE_REFRESH=1`
 * (mirroring `CRAP_TOLERANCE`'s env-override precedent) tells
 * `check-baselines --gate bundle-size` to treat this run's head
 * measurements as the newly acknowledged baseline: head-vs-base
 * regressions are demoted to `unchanged` for this invocation only. Floors
 * still apply — an acknowledged PR can still fail on an absolute budget
 * breach, only the ratchet-vs-`origin/main` comparison is suspended.
 *
 * The flag is **not persisted** anywhere (no config write, no committed
 * tag): the very next `check-baselines` invocation without the env var —
 * i.e. the next PR — reverts to full strict enforcement automatically, so
 * there is no lingering loosened tolerance to remember to reset (AC-3).
 *
 * Accepted truthy values: `1`, `true` (case-insensitive). Anything else
 * (including unset/empty) resolves to `acknowledged: false`.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ acknowledged: boolean, overrides: string[] }}
 */
export function resolveBundleSizeEnvOverrides(env) {
  const raw = env?.BUNDLE_SIZE_REFRESH;
  const acknowledged =
    typeof raw === 'string' && /^(1|true)$/i.test(raw.trim());
  const overrides = acknowledged
    ? [`acknowledged=true (BUNDLE_SIZE_REFRESH=${raw})`]
    : [];
  return { acknowledged, overrides };
}

/**
 * Pure helper: resolve the effective MI tolerance by layering precedence:
 *   1. `CRAP_TOLERANCE` env-var (CI override — the baseline-refresh-
 *      guardrail uses this to force base-branch values on both gates).
 *   2. `delivery.quality.gates.maintainability.tolerance` from the config.
 *   3. `MI_DEFAULT_TOLERANCE` (0.5).
 *
 * Malformed env values warn and fall through to the next layer — a typo
 * in CI must never silently relax the gate, but it also must not skip the
 * configured project value.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ tolerance?: number }} [maintainabilityConfig]
 * @returns {{ tolerance: number, overrides: string[] }}
 */
export function resolveMaintainabilityEnvOverrides(env, maintainabilityConfig) {
  const overrides = [];
  let tolerance = MI_DEFAULT_TOLERANCE;
  // Layer 2: config value (lower precedence than env, higher than default).
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
  // Layer 1: env override (highest precedence).
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
