/**
 * `agentSettings.quality` accessor (Epic #730 Story 6; relocated under
 * lib/config/ in Epic #773 Story 6). Composes the per-sub-block resolvers
 * (maintainability scan, CRAP, prGate, baselines) so consumers can read every
 * grouped field without re-running merge logic at the call site.
 */

import { Logger } from '../Logger.js';
import { resolveBaselines } from './baselines.js';
import { resolveListValue } from './shared.js';
/** Framework defaults for `agentSettings.quality.crap` (lifted out of the
 * legacy `agentSettings.maintainability.crap` nest in Epic #730 Story 6).
 * Applied via {@link resolveQuality} so a consumer repo that omits the block
 * (or any key within it) still gets sane defaults. Exported for tests and
 * for consumers that want to introspect the canonical shape. */
export const MAINTAINABILITY_CRAP_DEFAULTS = Object.freeze({
  enabled: true,
  targetDirs: Object.freeze(['src']),
  newMethodCeiling: 30,
  coveragePath: 'coverage/coverage-final.json',
  // Raised from 0.001 in 5.36.1 — see check-crap.js:resolveCrapEnvOverrides
  // for the rationale (CRAP scores are c²·(1−cov)³ + c, so cross-environment
  // coverage rounding alone produces ~0.01 drift on a clean rebuild; 0.001
  // flagged that as a regression). 0.05 absorbs the rounding without
  // missing real regressions, which cross whole-integer thresholds.
  tolerance: 0.05,
  requireCoverage: true,
  friction: Object.freeze({ markerKey: 'crap-baseline-regression' }),
  refreshTag: 'baseline-refresh:',
});

/** Recognized keys for `quality.crap` (post-Story-6). Used by the resolver
 * to warn (not fail) on unknown keys per AC19. */
const MAINTAINABILITY_CRAP_KEYS = new Set(
  Object.keys(MAINTAINABILITY_CRAP_DEFAULTS),
);

/**
 * Merge a user-supplied `quality.crap` block with framework defaults.
 * Scalar keys replace; `targetDirs` supports the list-extender shape; unknown
 * keys emit a `Logger.warn` but do not fail resolution (AC19).
 *
 * @param {object|undefined} userCrap
 * @returns {object}
 */
export function resolveMaintainabilityCrap(userCrap) {
  const defaults = MAINTAINABILITY_CRAP_DEFAULTS;
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
  };
}

/**
 * Framework defaults for `agentSettings.quality.maintainability` — the per-file
 * MI targeting block. Empty `targetDirs` means "no MI scan unless the operator
 * declares targets". Lifted out of the old flat-key default in Story 6.
 *
 * Story #1394 (Epic #1386): `defaultScope` flips to `"diff"` so the MI gate
 * scopes by changed files by default. `diffRef` defaults to `"main"` so the
 * scoped diff resolves against the repo's primary integration branch unless
 * the project overrides it (e.g. monorepos with a different baseBranch).
 */
export const MAINTAINABILITY_QUALITY_DEFAULTS = Object.freeze({
  targetDirs: Object.freeze([]),
  defaultScope: 'diff',
  diffRef: 'main',
});

/**
 * Merge a user-supplied `quality.maintainability` block with framework
 * defaults. The grouped block carries `targetDirs` (per-file scan roots),
 * `tolerance` (resolved by `check-maintainability.js`'s env-override helper),
 * and — added in Story #1394 — `defaultScope` + `diffRef` which drive the
 * diff-scoped gate default.
 *
 * @param {object|undefined} userBlock
 * @returns {{ targetDirs: string[], defaultScope: string, diffRef: string, tolerance?: number }}
 */
export function resolveMaintainabilityQuality(userBlock) {
  const defaults = MAINTAINABILITY_QUALITY_DEFAULTS;
  if (userBlock == null || typeof userBlock !== 'object') {
    return {
      targetDirs: [...defaults.targetDirs],
      defaultScope: defaults.defaultScope,
      diffRef: defaults.diffRef,
    };
  }
  const out = {
    targetDirs: resolveListValue(defaults.targetDirs, userBlock.targetDirs),
    defaultScope:
      userBlock.defaultScope === 'full' || userBlock.defaultScope === 'diff'
        ? userBlock.defaultScope
        : defaults.defaultScope,
    diffRef:
      typeof userBlock.diffRef === 'string' && userBlock.diffRef.length > 0
        ? userBlock.diffRef
        : defaults.diffRef,
  };
  // `tolerance` flows through because `check-maintainability.js` reads it
  // off the resolved block via `resolveMaintainabilityEnvOverrides`. We do
  // not default-fill it here — the env-override helper carries the framework
  // default (0.5) directly so the precedence layering stays in one place.
  if (typeof userBlock.tolerance === 'number') {
    out.tolerance = userBlock.tolerance;
  }
  return out;
}

/**
 * Framework defaults for `agentSettings.quality.prGate`. `checks` defaults to
 * an empty array so `git-pr-quality-gate.js` falls back to its hardcoded
 * DEFAULT_CHECKS trio (lint / format:check / test) when the operator hasn't
 * customised the suite. `enforceBranchProtection` defaults to `true` —
 * `/agents-bootstrap-github` (Epic #1142 Story #1157) writes the
 * `prGate.checks` names into GitHub's branch-protection rule on `main`
 * unless this flag is explicitly disabled.
 */
export const PR_GATE_DEFAULTS = Object.freeze({
  checks: Object.freeze([]),
  enforceBranchProtection: true,
});

/**
 * Merge the user-supplied `quality.prGate` block with framework defaults.
 *
 * @param {object|undefined} userBlock
 * @returns {{ checks: object[], enforceBranchProtection: boolean }}
 */
export function resolvePrGate(userBlock) {
  if (userBlock == null || typeof userBlock !== 'object') {
    return {
      checks: [...PR_GATE_DEFAULTS.checks],
      enforceBranchProtection: PR_GATE_DEFAULTS.enforceBranchProtection,
    };
  }
  return {
    checks: Array.isArray(userBlock.checks)
      ? [...userBlock.checks]
      : [...PR_GATE_DEFAULTS.checks],
    enforceBranchProtection:
      typeof userBlock.enforceBranchProtection === 'boolean'
        ? userBlock.enforceBranchProtection
        : PR_GATE_DEFAULTS.enforceBranchProtection,
  };
}

/**
 * Merge the entire `agentSettings.quality` block with framework defaults
 * (Epic #730 Story 6). Composes the per-sub-block resolvers so consumers can
 * read every grouped field — `targetDirs`, `crap.*`, `prGate.checks`,
 * `baselines.<kind>.path` — without re-running merge logic at the call site.
 *
 * @param {object|undefined} userQuality
 * @returns {{
 *   maintainability: { targetDirs: string[] },
 *   crap: object,
 *   prGate: { checks: string[] },
 *   baselines: { lint: object, crap: object, maintainability: object }
 * }}
 */
export function resolveQuality(userQuality) {
  const block =
    userQuality && typeof userQuality === 'object' ? userQuality : {};
  return {
    maintainability: resolveMaintainabilityQuality(block.maintainability),
    crap: resolveMaintainabilityCrap(block.crap),
    prGate: resolvePrGate(block.prGate),
    baselines: resolveBaselines(block.baselines),
  };
}

/**
 * Read the merged `agentSettings.quality` block. Accepts either the full
 * resolved config (`{ agentSettings, ... }`) or the bare `agentSettings` bag.
 *
 * @param {{ agentSettings?: { quality?: object } } | object | null | undefined} config
 * @returns {ReturnType<typeof resolveQuality>}
 */
export function getQuality(config) {
  const userQuality =
    config?.agentSettings?.quality ?? config?.quality ?? undefined;
  return resolveQuality(userQuality);
}
