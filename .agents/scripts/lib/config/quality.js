/**
 * `delivery.quality` resolver. Every `gates.<tier>` shares `enabled`,
 * `baselinePath`, `tolerance` (`{ kind, value }`) and workspace-keyed
 * `floors`; the resolver flattens them into the legacy bag callers read
 * (scalar `tolerance`, `crap.coveragePath` cross-read from the coverage gate).
 */

import { Logger } from '../Logger.js';
import { resolveListValue } from './shared.js';

const GATE_SCOPING = Object.freeze({ scope: 'diff', diffRef: 'main' });

/** Commit-subject substring acknowledging a deliberate baseline refresh. */
const BASELINE_REFRESH_TAG = 'baseline-refresh:';

const DEFAULT_CRAP_TOLERANCE = Object.freeze({ kind: 'absolute', value: 0.05 });
const DEFAULT_MI_TOLERANCE = Object.freeze({ kind: 'absolute', value: 0.5 });

/** Injected when a declared gate omits a workspace key (usually `'*'`). */
const DEFAULT_COVERAGE_FLOORS = Object.freeze({
  '*': Object.freeze({ lines: 90, branches: 85, functions: 90 }),
});
const DEFAULT_CRAP_FLOORS = Object.freeze({
  '*': Object.freeze({ max: 30, p95: 20, methodsAbove20: 50 }),
});
/**
 * Keyed on the rollup's `min` axis; a `maintainability` key silently
 * no-ops because the rollup never exposes it.
 */
const DEFAULT_MI_FLOORS = Object.freeze({
  '*': Object.freeze({ min: 70 }),
});

/**
 * `skipWhenUnchanged` (on: gate-neutral) skips capture when nothing under
 * `crap.targetDirs` changed vs `baseRef`. `baselineJoin` (off: it loosens the
 * gate) resolves untouched files from committed baseline rows. The two must
 * stay independent. `baseRef: null` defers to the caller's ref resolution.
 */
const DEFAULT_INCREMENTAL_COVERAGE = Object.freeze({
  skipWhenUnchanged: true,
  baselineJoin: false,
  baseRef: null,
});

export const CRAP_GATE_DEFAULTS = Object.freeze({
  enabled: true,
  baselinePath: 'baselines/crap.json',
  tolerance: DEFAULT_CRAP_TOLERANCE,
  floors: DEFAULT_CRAP_FLOORS,
  targetDirs: Object.freeze(['src']),
  newMethodCeiling: 30,
  requireCoverage: true,
  refreshTag: BASELINE_REFRESH_TAG,
  ignoreGlobs: Object.freeze([]),
  // Fail-closed floor on the coverage join (over files that have coverage):
  // a broken join is silent, so the updater refuses to persist below it.
  // Healthy runs resolve ~98%; a coordinate mismatch resolves 4–6%.
  minMethodResolutionRate: 0.75,
  incrementalCoverage: DEFAULT_INCREMENTAL_COVERAGE,
});

export const COVERAGE_GATE_DEFAULTS = Object.freeze({
  enabled: true,
  baselinePath: 'baselines/coverage.json',
  tolerance: Object.freeze({ kind: 'absolute', value: 0 }),
  floors: DEFAULT_COVERAGE_FLOORS,
  coveragePath: 'coverage/coverage-final.json',
  // `affected` runs the consumer's `test:coverage:affected` instead.
  captureScope: 'full',
  // On expiry `runCapture` exits 124 so callers can tell a hang from a failure.
  timeoutMs: 600_000,
});

export const MAINTAINABILITY_GATE_DEFAULTS = Object.freeze({
  enabled: true,
  baselinePath: 'baselines/maintainability.json',
  tolerance: DEFAULT_MI_TOLERANCE,
  floors: DEFAULT_MI_FLOORS,
  targetDirs: Object.freeze([]),
  // Same tag as CRAP so one refresh commit acknowledges both gates.
  refreshTag: BASELINE_REFRESH_TAG,
  ignoreGlobs: Object.freeze([]),
  minMethodResolutionRate: 0.75,
});

const CRAP_GATE_KEYS = new Set([
  'enabled',
  'baselinePath',
  'tolerance',
  'floors',
  'targetDirs',
  'newMethodCeiling',
  'requireCoverage',
  'ignoreGlobs',
  'minMethodResolutionRate',
  'incrementalCoverage',
]);

const COVERAGE_GATE_KEYS = new Set([
  'enabled',
  'baselinePath',
  'tolerance',
  'floors',
  'coveragePath',
  'captureScope',
]);

const MI_GATE_KEYS = new Set([
  'enabled',
  'baselinePath',
  'tolerance',
  'floors',
  'targetDirs',
  'ignoreGlobs',
]);

/**
 * @param {{ kind?: string, value?: number } | undefined} tolerance
 * @param {number} fallback
 * @returns {number}
 */
function toleranceScalar(tolerance, fallback) {
  if (
    tolerance &&
    typeof tolerance === 'object' &&
    Number.isFinite(tolerance.value) &&
    tolerance.value >= 0
  ) {
    return tolerance.value;
  }
  return fallback;
}

function warnUnknownKeys(userBlock, knownKeys, blockLabel) {
  for (const key of Object.keys(userBlock)) {
    if (!knownKeys.has(key)) {
      Logger.warn(`[config] Unknown key '${blockLabel}.${key}' — ignoring.`);
    }
  }
}

/**
 * Out-of-range or non-finite falls back: a `NaN` floor would never fire.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function resolveResolutionRate(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < 0 || value > 1) return fallback;
  return value;
}

/**
 * @param {{ skipWhenUnchanged?: boolean, baselineJoin?: boolean, baseRef?: string } | undefined} user
 * @param {{ skipWhenUnchanged: boolean, baselineJoin: boolean, baseRef: string | null }} defaults
 * @returns {{ skipWhenUnchanged: boolean, baselineJoin: boolean, baseRef: string | null }}
 */
function resolveIncrementalCoverage(user, defaults) {
  if (user == null || typeof user !== 'object') return { ...defaults };
  const pick = (explicit, fallback) =>
    typeof explicit === 'boolean' ? explicit : fallback;
  return {
    skipWhenUnchanged: pick(user.skipWhenUnchanged, defaults.skipWhenUnchanged),
    baselineJoin: pick(user.baselineJoin, defaults.baselineJoin),
    baseRef:
      typeof user.baseRef === 'string' && user.baseRef.length > 0
        ? user.baseRef
        : defaults.baseRef,
  };
}

/**
 * @param {object | undefined} userCrap
 * @param {{ coveragePath: string }} coverageGate
 * @returns {object}
 */
export function resolveMaintainabilityCrap(userCrap, coverageGate) {
  const defaults = CRAP_GATE_DEFAULTS;
  const coverage = coverageGate ?? COVERAGE_GATE_DEFAULTS;
  const fixed = {
    refreshTag: defaults.refreshTag,
    defaultScope: GATE_SCOPING.scope,
    diffRef: GATE_SCOPING.diffRef,
  };
  if (userCrap == null || typeof userCrap !== 'object') {
    return {
      enabled: defaults.enabled,
      targetDirs: [...defaults.targetDirs],
      newMethodCeiling: defaults.newMethodCeiling,
      coveragePath: coverage.coveragePath,
      tolerance: toleranceScalar(
        defaults.tolerance,
        DEFAULT_CRAP_TOLERANCE.value,
      ),
      requireCoverage: defaults.requireCoverage,
      minMethodResolutionRate: defaults.minMethodResolutionRate,
      ignoreGlobs: [...defaults.ignoreGlobs],
      incrementalCoverage: { ...defaults.incrementalCoverage },
      ...fixed,
    };
  }

  warnUnknownKeys(userCrap, CRAP_GATE_KEYS, 'quality.gates.crap');

  return {
    enabled: userCrap.enabled ?? defaults.enabled,
    targetDirs: resolveListValue(defaults.targetDirs, userCrap.targetDirs),
    newMethodCeiling: userCrap.newMethodCeiling ?? defaults.newMethodCeiling,
    coveragePath: coverage.coveragePath,
    tolerance: toleranceScalar(
      userCrap.tolerance,
      toleranceScalar(defaults.tolerance, DEFAULT_CRAP_TOLERANCE.value),
    ),
    requireCoverage: userCrap.requireCoverage ?? defaults.requireCoverage,
    minMethodResolutionRate: resolveResolutionRate(
      userCrap.minMethodResolutionRate,
      defaults.minMethodResolutionRate,
    ),
    ignoreGlobs: Array.isArray(userCrap.ignoreGlobs)
      ? userCrap.ignoreGlobs.slice()
      : [...defaults.ignoreGlobs],
    incrementalCoverage: resolveIncrementalCoverage(
      userCrap.incrementalCoverage,
      defaults.incrementalCoverage,
    ),
    ...fixed,
  };
}

function resolveMaintainabilityQuality(userBlock) {
  const defaults = MAINTAINABILITY_GATE_DEFAULTS;
  const fixed = {
    refreshTag: defaults.refreshTag,
    defaultScope: GATE_SCOPING.scope,
    diffRef: GATE_SCOPING.diffRef,
  };
  if (userBlock == null || typeof userBlock !== 'object') {
    return {
      targetDirs: [...defaults.targetDirs],
      ignoreGlobs: [...defaults.ignoreGlobs],
      ...fixed,
    };
  }
  warnUnknownKeys(userBlock, MI_GATE_KEYS, 'quality.gates.maintainability');
  const out = {
    targetDirs: resolveListValue(defaults.targetDirs, userBlock.targetDirs),
    ignoreGlobs: Array.isArray(userBlock.ignoreGlobs)
      ? userBlock.ignoreGlobs.slice()
      : [...defaults.ignoreGlobs],
    ...fixed,
  };
  if (userBlock.tolerance !== undefined) {
    out.tolerance = toleranceScalar(
      userBlock.tolerance,
      toleranceScalar(defaults.tolerance, DEFAULT_MI_TOLERANCE.value),
    );
  }
  return out;
}

function resolveCoverageGate(userBlock) {
  const defaults = COVERAGE_GATE_DEFAULTS;
  if (userBlock == null || typeof userBlock !== 'object') {
    return {
      enabled: defaults.enabled,
      baselinePath: defaults.baselinePath,
      coveragePath: defaults.coveragePath,
      captureScope: defaults.captureScope,
      tolerance: toleranceScalar(defaults.tolerance, 0),
      timeoutMs: defaults.timeoutMs,
    };
  }
  warnUnknownKeys(userBlock, COVERAGE_GATE_KEYS, 'quality.gates.coverage');
  return {
    enabled: userBlock.enabled ?? defaults.enabled,
    baselinePath: userBlock.baselinePath ?? defaults.baselinePath,
    coveragePath: userBlock.coveragePath ?? defaults.coveragePath,
    captureScope: userBlock.captureScope ?? defaults.captureScope,
    tolerance: toleranceScalar(
      userBlock.tolerance,
      toleranceScalar(defaults.tolerance, 0),
    ),
    timeoutMs: defaults.timeoutMs,
  };
}

/**
 * `cyclomaticFlag` is advisory only (`quality-preview.js`); the ratchet
 * ceiling lives in `lib/cyclomatic-ceiling.js`.
 */
export const CODING_GUARDRAILS = Object.freeze({
  cyclomaticFlag: 8,
  requireSiblingTest: false,
});

/** Only `enabled` is an operator switch. */
const AUTO_REFRESH_DEFAULTS = Object.freeze({
  enabled: true,
  crapJumpCap: 5,
  scope: 'diff',
});

function resolveAutoRefresh(userBlock) {
  return {
    ...AUTO_REFRESH_DEFAULTS,
    enabled:
      typeof userBlock?.enabled === 'boolean'
        ? userBlock.enabled
        : AUTO_REFRESH_DEFAULTS.enabled,
  };
}

/** Flat `baselines.{crap, maintainability}` view over each gate's `baselinePath`. */
function resolveBaselinesFromGates(gates) {
  return {
    crap: {
      path: gates?.crap?.baselinePath ?? CRAP_GATE_DEFAULTS.baselinePath,
    },
    maintainability: {
      path:
        gates?.maintainability?.baselinePath ??
        MAINTAINABILITY_GATE_DEFAULTS.baselinePath,
    },
  };
}

/**
 * Consumer entries win per workspace key. Returns a fresh object so callers
 * cannot mutate the frozen defaults.
 *
 * @param {object | undefined | null} userFloors
 * @param {object} defaults
 * @returns {object}
 */
function mergeFloorsWithDefaults(userFloors, defaults) {
  const defaultsCopy = {};
  for (const [workspace, axes] of Object.entries(defaults)) {
    defaultsCopy[workspace] = { ...axes };
  }
  if (userFloors == null || typeof userFloors !== 'object') {
    return defaultsCopy;
  }
  for (const [workspace, axes] of Object.entries(userFloors)) {
    if (axes != null && typeof axes === 'object') {
      defaultsCopy[workspace] = { ...axes };
    }
  }
  return defaultsCopy;
}

const FLOOR_DEFAULTS_BY_KIND = Object.freeze({
  coverage: DEFAULT_COVERAGE_FLOORS,
  crap: DEFAULT_CRAP_FLOORS,
  maintainability: DEFAULT_MI_FLOORS,
});

/**
 * Injects default floors into declared gates only; synthesising a block for
 * an undeclared kind would silently enable a gate the consumer never asked for.
 */
function resolveGatesWithFloors(gates) {
  const out = { ...gates };
  for (const [kind, defaults] of Object.entries(FLOOR_DEFAULTS_BY_KIND)) {
    if (!Object.hasOwn(gates, kind)) continue;
    const block = gates[kind];
    if (block == null || typeof block !== 'object') continue;
    out[kind] = {
      ...block,
      floors: mergeFloorsWithDefaults(block.floors, defaults),
    };
  }
  return out;
}

/**
 * @param {object|undefined} userQuality
 */
export function resolveQuality(userQuality) {
  const block =
    userQuality && typeof userQuality === 'object' ? userQuality : {};
  const gates =
    block.gates && typeof block.gates === 'object' ? block.gates : {};
  const coverage = resolveCoverageGate(gates.coverage);
  const resolvedGates = resolveGatesWithFloors(gates);
  return {
    maintainability: resolveMaintainabilityQuality(gates.maintainability),
    crap: resolveMaintainabilityCrap(gates.crap, coverage),
    coverage,
    baselines: resolveBaselinesFromGates(gates),
    codingGuardrails: { ...CODING_GUARDRAILS },
    autoRefresh: resolveAutoRefresh(block.autoRefresh),
    baselineEpsilon: { ...BASELINE_EPSILON },
    gates: resolvedGates,
  };
}

/**
 * The writer folds sub-epsilon row deltas back to the prior bytes so env
 * variance never rewrites a baseline. bundle-size is bytes.
 */
const BASELINE_EPSILON = Object.freeze({
  maintainability: 0.5,
  crap: 0.5,
  coverage: 0.1,
  mutation: 0.5,
  'bundle-size': 1024,
  duplication: 0.5,
});

/**
 * @param {string} kind
 * @returns {number}
 */
export function getBaselineEpsilon(kind) {
  if (!Object.hasOwn(BASELINE_EPSILON, kind)) {
    throw new Error(`[config] getBaselineEpsilon: unknown kind '${kind}'`);
  }
  return BASELINE_EPSILON[kind];
}

/**
 * @param {object | null | undefined} config
 * @returns {ReturnType<typeof resolveQuality>}
 */
export function getQuality(config) {
  return resolveQuality(config?.delivery?.quality);
}
