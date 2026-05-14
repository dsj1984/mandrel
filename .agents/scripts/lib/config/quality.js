/**
 * `delivery.quality` accessor (Epic #1720 Story #1739 — top-level reshape).
 *
 * The quality block mechanically relocates from `agentSettings.quality.*` to
 * `delivery.quality.*`. Story 1 preserves the **internal** shape of the
 * block — the uniform per-gate `gates.<tier>` restructure happens in Story
 * 2. Story 1's only internal changes are:
 *
 *   - `prGate` and `mergeMethods` move out to `github.*` (see
 *     `lib/config/github.js`).
 *   - `c1Exemption` and `halsteadTolerance` are dropped from the schema —
 *     the resolver simply ignores them if a legacy config carries them
 *     (the schema rejects them up front).
 *   - `defaultScope` / `diffRef` live on both `crap` and `maintainability`
 *     during the Story 1 transition. Story 2 lifts them to a shared
 *     `delivery.quality.gateScoping` block; this resolver pre-reads the
 *     shared block when present so Story 2 can land it without breaking
 *     existing call sites.
 */

import { Logger } from '../Logger.js';
import { resolveBaselines } from './baselines.js';
import { resolveListValue } from './shared.js';

/** Framework defaults for `delivery.quality.crap`. */
export const MAINTAINABILITY_CRAP_DEFAULTS = Object.freeze({
  enabled: true,
  targetDirs: Object.freeze(['src']),
  newMethodCeiling: 30,
  coveragePath: 'coverage/coverage-final.json',
  tolerance: 0.05,
  requireCoverage: true,
  friction: Object.freeze({ markerKey: 'crap-baseline-regression' }),
  refreshTag: 'baseline-refresh:',
  defaultScope: 'diff',
  diffRef: 'main',
});

const MAINTAINABILITY_CRAP_KEYS = new Set(
  Object.keys(MAINTAINABILITY_CRAP_DEFAULTS),
);

export function resolveMaintainabilityCrap(userCrap, gateScoping) {
  const defaults = MAINTAINABILITY_CRAP_DEFAULTS;
  const scopingDefaults = {
    defaultScope: gateScoping?.scope ?? defaults.defaultScope,
    diffRef: gateScoping?.diffRef ?? defaults.diffRef,
  };
  if (userCrap == null || typeof userCrap !== 'object') {
    return {
      enabled: defaults.enabled,
      targetDirs: [...defaults.targetDirs],
      newMethodCeiling: defaults.newMethodCeiling,
      coveragePath: defaults.coveragePath,
      tolerance: defaults.tolerance,
      requireCoverage: defaults.requireCoverage,
      friction: { ...defaults.friction },
      refreshTag: defaults.refreshTag,
      defaultScope: scopingDefaults.defaultScope,
      diffRef: scopingDefaults.diffRef,
    };
  }

  for (const key of Object.keys(userCrap)) {
    if (!MAINTAINABILITY_CRAP_KEYS.has(key)) {
      Logger.warn(`[config] Unknown key 'quality.crap.${key}' — ignoring.`);
    }
  }

  return {
    enabled: userCrap.enabled ?? defaults.enabled,
    targetDirs: resolveListValue(defaults.targetDirs, userCrap.targetDirs),
    newMethodCeiling: userCrap.newMethodCeiling ?? defaults.newMethodCeiling,
    coveragePath: userCrap.coveragePath ?? defaults.coveragePath,
    tolerance: userCrap.tolerance ?? defaults.tolerance,
    requireCoverage: userCrap.requireCoverage ?? defaults.requireCoverage,
    friction: { ...defaults.friction, ...(userCrap.friction ?? {}) },
    refreshTag: userCrap.refreshTag ?? defaults.refreshTag,
    defaultScope:
      userCrap.defaultScope === 'full' || userCrap.defaultScope === 'diff'
        ? userCrap.defaultScope
        : scopingDefaults.defaultScope,
    diffRef:
      typeof userCrap.diffRef === 'string' && userCrap.diffRef.length > 0
        ? userCrap.diffRef
        : scopingDefaults.diffRef,
  };
}

/** Framework defaults for `delivery.quality.maintainability`. */
export const MAINTAINABILITY_QUALITY_DEFAULTS = Object.freeze({
  targetDirs: Object.freeze([]),
  defaultScope: 'diff',
  diffRef: 'main',
});

export function resolveMaintainabilityQuality(userBlock, gateScoping) {
  const defaults = MAINTAINABILITY_QUALITY_DEFAULTS;
  const scopingDefaults = {
    defaultScope: gateScoping?.scope ?? defaults.defaultScope,
    diffRef: gateScoping?.diffRef ?? defaults.diffRef,
  };
  if (userBlock == null || typeof userBlock !== 'object') {
    return {
      targetDirs: [...defaults.targetDirs],
      defaultScope: scopingDefaults.defaultScope,
      diffRef: scopingDefaults.diffRef,
    };
  }
  const out = {
    targetDirs: resolveListValue(defaults.targetDirs, userBlock.targetDirs),
    defaultScope:
      userBlock.defaultScope === 'full' || userBlock.defaultScope === 'diff'
        ? userBlock.defaultScope
        : scopingDefaults.defaultScope,
    diffRef:
      typeof userBlock.diffRef === 'string' && userBlock.diffRef.length > 0
        ? userBlock.diffRef
        : scopingDefaults.diffRef,
  };
  if (typeof userBlock.tolerance === 'number') {
    out.tolerance = userBlock.tolerance;
  }
  return out;
}

/**
 * Framework defaults for `delivery.quality.codingGuardrails`. The legacy
 * field name `miDropRefactor` was renamed to `miDropMustRefactor` in
 * Story 1 to avoid semantic collision with `autoRefresh.miDropCap`.
 */
export const CODING_GUARDRAILS_DEFAULTS = Object.freeze({
  cyclomaticFlag: 8,
  cyclomaticMustFix: 12,
  miDropMustRefactor: 1.5,
  requireSiblingTest: false,
});

const CODING_GUARDRAILS_KEYS = new Set(Object.keys(CODING_GUARDRAILS_DEFAULTS));

export function resolveCodingGuardrails(userBlock) {
  const defaults = CODING_GUARDRAILS_DEFAULTS;
  if (userBlock == null || typeof userBlock !== 'object') {
    return { ...defaults };
  }
  for (const key of Object.keys(userBlock)) {
    if (!CODING_GUARDRAILS_KEYS.has(key)) {
      Logger.warn(
        `[config] Unknown key 'quality.codingGuardrails.${key}' — ignoring.`,
      );
    }
  }
  return {
    cyclomaticFlag: userBlock.cyclomaticFlag ?? defaults.cyclomaticFlag,
    cyclomaticMustFix:
      userBlock.cyclomaticMustFix ?? defaults.cyclomaticMustFix,
    miDropMustRefactor:
      userBlock.miDropMustRefactor ?? defaults.miDropMustRefactor,
    requireSiblingTest:
      typeof userBlock.requireSiblingTest === 'boolean'
        ? userBlock.requireSiblingTest
        : defaults.requireSiblingTest,
  };
}

export const AUTO_REFRESH_DEFAULTS = Object.freeze({
  enabled: true,
  miDropCap: 1.5,
  crapJumpCap: 5,
  scope: 'diff',
});

const AUTO_REFRESH_KEYS = new Set(Object.keys(AUTO_REFRESH_DEFAULTS));

export function resolveAutoRefresh(userBlock) {
  const defaults = AUTO_REFRESH_DEFAULTS;
  if (userBlock == null || typeof userBlock !== 'object') {
    return {
      enabled: defaults.enabled,
      miDropCap: defaults.miDropCap,
      crapJumpCap: defaults.crapJumpCap,
      scope: defaults.scope,
    };
  }

  for (const key of Object.keys(userBlock)) {
    if (!AUTO_REFRESH_KEYS.has(key)) {
      Logger.warn(
        `[config] Unknown key 'quality.autoRefresh.${key}' — ignoring.`,
      );
    }
  }

  return {
    enabled:
      typeof userBlock.enabled === 'boolean'
        ? userBlock.enabled
        : defaults.enabled,
    miDropCap:
      typeof userBlock.miDropCap === 'number' &&
      Number.isFinite(userBlock.miDropCap) &&
      userBlock.miDropCap >= 0
        ? userBlock.miDropCap
        : defaults.miDropCap,
    crapJumpCap:
      typeof userBlock.crapJumpCap === 'number' &&
      Number.isFinite(userBlock.crapJumpCap) &&
      userBlock.crapJumpCap >= 0
        ? userBlock.crapJumpCap
        : defaults.crapJumpCap,
    scope:
      userBlock.scope === 'diff' || userBlock.scope === 'full'
        ? userBlock.scope
        : defaults.scope,
  };
}

/**
 * Merge the entire `delivery.quality` block with framework defaults.
 *
 * @param {object|undefined} userQuality
 * @returns {{
 *   maintainability: ReturnType<typeof resolveMaintainabilityQuality>,
 *   crap: ReturnType<typeof resolveMaintainabilityCrap>,
 *   baselines: object,
 *   codingGuardrails: ReturnType<typeof resolveCodingGuardrails>,
 *   autoRefresh: ReturnType<typeof resolveAutoRefresh>,
 *   gateScoping: { scope: string, diffRef: string },
 * }}
 */
export function resolveQuality(userQuality) {
  const block =
    userQuality && typeof userQuality === 'object' ? userQuality : {};
  const gateScoping = {
    scope: block.gateScoping?.scope ?? 'diff',
    diffRef: block.gateScoping?.diffRef ?? 'main',
  };
  return {
    maintainability: resolveMaintainabilityQuality(block.maintainability, {
      scope: gateScoping.scope,
      diffRef: gateScoping.diffRef,
    }),
    crap: resolveMaintainabilityCrap(block.crap, {
      scope: gateScoping.scope,
      diffRef: gateScoping.diffRef,
    }),
    baselines: resolveBaselines(block.baselines),
    codingGuardrails: resolveCodingGuardrails(block.codingGuardrails),
    autoRefresh: resolveAutoRefresh(block.autoRefresh),
    gateScoping,
  };
}

/**
 * Read the merged `delivery.quality` block. Accepts the full resolved
 * config or any unwrapped variant (`{ delivery }`, `{ quality }`, or — for
 * legacy compatibility — `{ agentSettings: { quality } }`).
 *
 * @param {object | null | undefined} config
 * @returns {ReturnType<typeof resolveQuality>}
 */
export function getQuality(config) {
  const userQuality =
    config?.delivery?.quality ??
    config?.quality ??
    config?.agentSettings?.quality ??
    undefined;
  return resolveQuality(userQuality);
}
