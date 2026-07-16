/**
 * `delivery.quality` accessor (Epic #1720 Story #1737 — uniform gate shape).
 *
 * The quality block under `delivery.quality.*` is now organised as a
 * `gates.<tier>` object where every tier (lint, coverage, crap,
 * maintainability, mutation, lighthouse, bundle-size) shares the same
 * four-field base:
 *
 *   - `enabled`      — when `false`, the checker exits 0 with a skip line.
 *   - `baselinePath` — repo-root-relative path to the gate's baseline file.
 *   - `tolerance`    — `{ kind: 'absolute' | 'percent', value: number }`.
 *   - `floors`       — workspace-keyed `{ "*": { ... } }` floor object.
 *
 * Story #1737 changes (vs the Story #1739 mechanical relocation):
 *
 *   - `gateScoping` is the single source of truth for diff scope / ref.
 *     The duplicate `defaultScope` / `diffRef` keys on crap and
 *     maintainability are gone — resolvers carry the scope through from
 *     the lifted block.
 *   - Scalar `tolerance` values became `{ kind, value }` objects.
 *   - `coveragePath` moved from `gates.crap` to `gates.coverage`. CRAP
 *     reads from the coverage gate instead of carrying its own.
 *   - Flat `qualityFloors.*` shape is gone — every gate carries its own
 *     workspace-keyed `floors` object.
 *
 * The resolver returns a flattened bag with the legacy field names
 * (`crap.tolerance` as a number, `crap.targetDirs`, `maintainability.targetDirs`,
 * `crap.coveragePath`, etc.) so existing call sites stay untouched.
 * The translation from gate shape → legacy bag happens here, in one
 * place.
 */

import { Logger } from '../Logger.js';
import { resolveListValue } from './shared.js';

const DEFAULT_GATE_SCOPING = Object.freeze({ scope: 'diff', diffRef: 'main' });

/**
 * Default object-shape tolerance for each gate. Values match the historical
 * scalar defaults so a consumer that omits `tolerance` keeps the prior
 * gate behaviour.
 */
const DEFAULT_CRAP_TOLERANCE = Object.freeze({ kind: 'absolute', value: 0.05 });
const DEFAULT_MI_TOLERANCE = Object.freeze({ kind: 'absolute', value: 0.5 });

/**
 * Default floors per gate. Workspace-keyed so a single-workspace consumer
 * reads `floors["*"]` and a monorepo consumer can override per-workspace.
 *
 * Story #2125: these defaults are now injected by `resolveQuality` into
 * the resolved `gates.<kind>.floors` block when the consumer omits the
 * `'*'` workspace key, so `.agentrc.json` can carry `floors: {}` (or
 * omit the gate entirely) and still get framework-default enforcement
 * from the unified `check-baselines.js` dispatcher.
 */
const DEFAULT_COVERAGE_FLOORS = Object.freeze({
  '*': Object.freeze({ lines: 90, branches: 85, functions: 90 }),
});
const DEFAULT_CRAP_FLOORS = Object.freeze({
  '*': Object.freeze({ max: 30, p95: 20, methodsAbove20: 50 }),
});
/**
 * Story #2193 — maintainability rollups expose the `min` / `p50` / `p95`
 * axes (see `.agents/schemas/baselines/maintainability.schema.json`). The
 * default floor therefore targets `min`, not the row-axis `maintainability`
 * name. The pre-#2193 default keyed on `maintainability` silently no-oped
 * inside `check-baselines.js#compareToFloor` because the rollup never
 * exposed that axis.
 */
const DEFAULT_MI_FLOORS = Object.freeze({
  '*': Object.freeze({ min: 70 }),
});

/** Framework defaults for the CRAP gate (post-1737 uniform shape). */
export const CRAP_GATE_DEFAULTS = Object.freeze({
  enabled: true,
  baselinePath: 'baselines/crap.json',
  tolerance: DEFAULT_CRAP_TOLERANCE,
  floors: DEFAULT_CRAP_FLOORS,
  targetDirs: Object.freeze(['src']),
  newMethodCeiling: 30,
  requireCoverage: true,
  friction: Object.freeze({ markerKey: 'crap-baseline-regression' }),
  refreshTag: 'baseline-refresh:',
  // Story #2165 — bounded timeout (ms) for `npm run crap:update` spawned by
  // the baseline-attribution refresh path. Defaults to 60 s; mirrors
  // `gates.coverage.timeoutMs` (Story #2142) for shape and SIGKILL → 124
  // semantics.
  refreshTimeoutMs: 60_000,
  ignoreGlobs: Object.freeze([]),
});

/** Framework defaults for the coverage gate. */
export const COVERAGE_GATE_DEFAULTS = Object.freeze({
  enabled: true,
  baselinePath: 'baselines/coverage.json',
  tolerance: Object.freeze({ kind: 'absolute', value: 0 }),
  floors: DEFAULT_COVERAGE_FLOORS,
  coveragePath: 'coverage/coverage-final.json',
  // Story #2136 — 10 minute wall clock on `npm run test:coverage`. Trips
  // `runCapture` to return exit 124 (GNU `timeout` convention) so the
  // close-validation caller can branch on hang-vs-failure.
  timeoutMs: 600_000,
});

/** Framework defaults for the maintainability gate. */
export const MAINTAINABILITY_GATE_DEFAULTS = Object.freeze({
  enabled: true,
  baselinePath: 'baselines/maintainability.json',
  tolerance: DEFAULT_MI_TOLERANCE,
  floors: DEFAULT_MI_FLOORS,
  targetDirs: Object.freeze([]),
  // Story #2165 — bounded timeout (ms) for `npm run maintainability:update`
  // spawned by the baseline-attribution refresh path. Defaults to 60 s.
  refreshTimeoutMs: 60_000,
  ignoreGlobs: Object.freeze([]),
});

/**
 * Story #2165 — framework defaults for the close-time `npx biome format
 * --write` autofix spawn. The SIGKILL → exit 124 mapping mirrors
 * `gates.coverage.timeoutMs` (Story #2142).
 */
const FORMAT_AUTOFIX_DEFAULTS = Object.freeze({
  timeoutMs: 60_000,
});

const CRAP_GATE_KEYS = new Set([
  'enabled',
  'baselinePath',
  'tolerance',
  'floors',
  'targetDirs',
  'newMethodCeiling',
  'requireCoverage',
  'friction',
  'refreshTag',
  'refreshTimeoutMs',
  'ignoreGlobs',
]);

const COVERAGE_GATE_KEYS = new Set([
  'enabled',
  'baselinePath',
  'tolerance',
  'floors',
  'coveragePath',
  'timeoutMs',
]);

const MI_GATE_KEYS = new Set([
  'enabled',
  'baselinePath',
  'tolerance',
  'floors',
  'targetDirs',
  'refreshTimeoutMs',
  'ignoreGlobs',
]);

/**
 * Pure helper: coerce the object-shape tolerance to its scalar `value`
 * for call sites that still expect a plain number. Returns the default
 * scalar when the tolerance object is malformed.
 *
 * @param {{ kind?: string, value?: number } | undefined} tolerance
 * @param {number} fallback scalar tolerance
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
 * Resolve the CRAP gate. Accepts both the new `gates.crap.*` shape and
 * the resolved `coverage` gate (for the `coveragePath` cross-read). The
 * lifted `gateScoping` carries the diff scope and ref.
 *
 * @param {object | undefined} userCrap raw `delivery.quality.gates.crap`
 * @param {{ scope: string, diffRef: string }} gateScoping resolved scoping
 * @param {{ coveragePath: string }} coverageGate resolved coverage gate
 * @returns {object} flattened legacy-bag view that existing callers read
 */
export function resolveMaintainabilityCrap(
  userCrap,
  gateScoping,
  coverageGate,
) {
  const defaults = CRAP_GATE_DEFAULTS;
  const scoping = {
    defaultScope: gateScoping?.scope ?? DEFAULT_GATE_SCOPING.scope,
    diffRef: gateScoping?.diffRef ?? DEFAULT_GATE_SCOPING.diffRef,
  };
  const coverage = coverageGate ?? COVERAGE_GATE_DEFAULTS;
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
      friction: { ...defaults.friction },
      refreshTag: defaults.refreshTag,
      refreshTimeoutMs: defaults.refreshTimeoutMs,
      ignoreGlobs: [...defaults.ignoreGlobs],
      defaultScope: scoping.defaultScope,
      diffRef: scoping.diffRef,
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
    friction: { ...defaults.friction, ...(userCrap.friction ?? {}) },
    refreshTag: userCrap.refreshTag ?? defaults.refreshTag,
    refreshTimeoutMs: resolvePositiveIntegerMs(
      userCrap.refreshTimeoutMs,
      defaults.refreshTimeoutMs,
    ),
    ignoreGlobs: Array.isArray(userCrap.ignoreGlobs)
      ? userCrap.ignoreGlobs.slice()
      : [...defaults.ignoreGlobs],
    defaultScope: scoping.defaultScope,
    diffRef: scoping.diffRef,
  };
}

/**
 * Resolve the maintainability gate. Returns the legacy-bag shape with
 * `targetDirs` + a scalar `tolerance` (when set) + scoping inherited
 * from `gateScoping`.
 */
function resolveMaintainabilityQuality(userBlock, gateScoping) {
  const defaults = MAINTAINABILITY_GATE_DEFAULTS;
  const scoping = {
    defaultScope: gateScoping?.scope ?? DEFAULT_GATE_SCOPING.scope,
    diffRef: gateScoping?.diffRef ?? DEFAULT_GATE_SCOPING.diffRef,
  };
  if (userBlock == null || typeof userBlock !== 'object') {
    return {
      targetDirs: [...defaults.targetDirs],
      refreshTimeoutMs: defaults.refreshTimeoutMs,
      ignoreGlobs: [...defaults.ignoreGlobs],
      defaultScope: scoping.defaultScope,
      diffRef: scoping.diffRef,
    };
  }
  warnUnknownKeys(userBlock, MI_GATE_KEYS, 'quality.gates.maintainability');
  const out = {
    targetDirs: resolveListValue(defaults.targetDirs, userBlock.targetDirs),
    refreshTimeoutMs: resolvePositiveIntegerMs(
      userBlock.refreshTimeoutMs,
      defaults.refreshTimeoutMs,
    ),
    ignoreGlobs: Array.isArray(userBlock.ignoreGlobs)
      ? userBlock.ignoreGlobs.slice()
      : [...defaults.ignoreGlobs],
    defaultScope: scoping.defaultScope,
    diffRef: scoping.diffRef,
  };
  if (userBlock.tolerance !== undefined) {
    out.tolerance = toleranceScalar(
      userBlock.tolerance,
      toleranceScalar(defaults.tolerance, DEFAULT_MI_TOLERANCE.value),
    );
  }
  return out;
}

/**
 * Story #2165 — accept a user-supplied positive-integer ms budget, falling
 * back to `defaultMs` when the value is missing, non-integer, or non-positive.
 * Mirrors the inlined guard in `resolveCoverageGate`.
 *
 * @param {*} value
 * @param {number} defaultMs
 * @returns {number}
 */
function resolvePositiveIntegerMs(value, defaultMs) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  return defaultMs;
}

/**
 * Story #2165 — resolve `delivery.quality.formatAutofix`. Owns the bounded
 * timeout for the close-time `npx biome format --write` spawn.
 *
 * @param {object | undefined} userBlock
 * @returns {{ timeoutMs: number }}
 */
const FORMAT_AUTOFIX_KEYS = new Set(['timeoutMs']);

function resolveFormatAutofix(userBlock) {
  const defaults = FORMAT_AUTOFIX_DEFAULTS;
  if (userBlock == null || typeof userBlock !== 'object') {
    return { timeoutMs: defaults.timeoutMs };
  }
  warnUnknownKeys(userBlock, FORMAT_AUTOFIX_KEYS, 'quality.formatAutofix');
  return {
    timeoutMs: resolvePositiveIntegerMs(
      userBlock.timeoutMs,
      defaults.timeoutMs,
    ),
  };
}

/** Resolve the coverage gate. Owns `coveragePath` and `timeoutMs`. */
function resolveCoverageGate(userBlock) {
  const defaults = COVERAGE_GATE_DEFAULTS;
  if (userBlock == null || typeof userBlock !== 'object') {
    return {
      enabled: defaults.enabled,
      baselinePath: defaults.baselinePath,
      coveragePath: defaults.coveragePath,
      tolerance: toleranceScalar(defaults.tolerance, 0),
      timeoutMs: defaults.timeoutMs,
    };
  }
  warnUnknownKeys(userBlock, COVERAGE_GATE_KEYS, 'quality.gates.coverage');
  return {
    enabled: userBlock.enabled ?? defaults.enabled,
    baselinePath: userBlock.baselinePath ?? defaults.baselinePath,
    coveragePath: userBlock.coveragePath ?? defaults.coveragePath,
    tolerance: toleranceScalar(
      userBlock.tolerance,
      toleranceScalar(defaults.tolerance, 0),
    ),
    timeoutMs:
      typeof userBlock.timeoutMs === 'number' &&
      Number.isInteger(userBlock.timeoutMs) &&
      userBlock.timeoutMs > 0
        ? userBlock.timeoutMs
        : defaults.timeoutMs,
  };
}

/**
 * Framework defaults for `delivery.quality.codingGuardrails`.
 *
 * `miDropMustRefactor` was retired in Story #4531: schema-validated,
 * defaulted, and resolved, but never consumed — the gate it named
 * (`quality-preview.js`'s `computeExitCode`) short-circuits on `miExit`
 * (derived from the already-consumed `gates.maintainability.tolerance`)
 * before this value is ever read. `maintainability.tolerance` is the one
 * documented MI-drop control now; see `lib/migrations/index.js` for the
 * consumer-config migration that strips a leftover key on upgrade.
 */
export const CODING_GUARDRAILS_DEFAULTS = Object.freeze({
  cyclomaticFlag: 8,
  cyclomaticMustFix: 12,
  requireSiblingTest: false,
});

const CODING_GUARDRAILS_KEYS = new Set(Object.keys(CODING_GUARDRAILS_DEFAULTS));

export function resolveCodingGuardrails(userBlock) {
  const defaults = CODING_GUARDRAILS_DEFAULTS;
  if (userBlock == null || typeof userBlock !== 'object') {
    return { ...defaults };
  }
  warnUnknownKeys(
    userBlock,
    CODING_GUARDRAILS_KEYS,
    'quality.codingGuardrails',
  );
  return {
    cyclomaticFlag: userBlock.cyclomaticFlag ?? defaults.cyclomaticFlag,
    cyclomaticMustFix:
      userBlock.cyclomaticMustFix ?? defaults.cyclomaticMustFix,
    requireSiblingTest:
      typeof userBlock.requireSiblingTest === 'boolean'
        ? userBlock.requireSiblingTest
        : defaults.requireSiblingTest,
  };
}

// autoRefresh.miDropCap was retired alongside codingGuardrails.
// miDropMustRefactor in Story #4531 — same unconsumed-knob shape, same fix.
const AUTO_REFRESH_DEFAULTS = Object.freeze({
  enabled: true,
  crapJumpCap: 5,
  scope: 'diff',
});

const AUTO_REFRESH_KEYS = new Set(Object.keys(AUTO_REFRESH_DEFAULTS));

function resolveAutoRefresh(userBlock) {
  const defaults = AUTO_REFRESH_DEFAULTS;
  if (userBlock == null || typeof userBlock !== 'object') {
    return {
      enabled: defaults.enabled,
      crapJumpCap: defaults.crapJumpCap,
      scope: defaults.scope,
    };
  }

  warnUnknownKeys(userBlock, AUTO_REFRESH_KEYS, 'quality.autoRefresh');

  return {
    enabled:
      typeof userBlock.enabled === 'boolean'
        ? userBlock.enabled
        : defaults.enabled,
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
 * Resolve the merged baselines block. Baselines now live alongside their
 * gates (`gates.<tier>.baselinePath`); this helper preserves the
 * historical flat `baselines.{lint, crap, maintainability}` shape so
 * existing readers (`getBaselines(config)` in `config-resolver.js`)
 * stay untouched. Each entry is synthesised from the resolved gate's
 * `baselinePath`.
 */
function resolveBaselinesFromGates(gates) {
  return {
    lint: { path: gates?.lint?.baselinePath ?? 'baselines/lint.json' },
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
 * Merge the entire `delivery.quality` block with framework defaults.
 *
 * Returns the historical flattened bag (so the existing call sites that
 * read `q.crap.coveragePath`, `q.maintainability.targetDirs`, etc. keep
 * working) plus the new `gates` resolved object and `gateScoping`.
 *
 * @param {object|undefined} userQuality
 */
/**
 * Story #2125: merge a consumer-supplied `floors` bag with the framework
 * default for that gate. Defaults supply any workspace key the consumer
 * didn't provide — most commonly the catch-all `'*'`. Consumer entries
 * always win over defaults at the workspace-key level.
 *
 * Returns a fresh plain object so downstream mutations can't poison the
 * frozen module-level defaults.
 *
 * @param {object | undefined | null} userFloors raw `gates.<kind>.floors`
 * @param {object} defaults frozen framework default (e.g. `DEFAULT_COVERAGE_FLOORS`)
 * @returns {object} merged workspace-keyed floors
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
 * Build the resolved `gates` object that `resolveQuality` returns. For
 * each kind the consumer declared that has a framework-default floor
 * (coverage, crap, maintainability), the resolved block carries `floors`
 * merged with the kind's default — so `check-baselines.js` sees the
 * framework default at runtime even when `.agentrc.json` omits the
 * `floors` key.
 *
 * Kinds the consumer did NOT declare are passed through untouched —
 * `check-baselines.js` skips kinds whose gate block is absent, and this
 * function preserves that contract (synthesising a default block here
 * would silently enable gates the consumer never asked for).
 *
 * Other keys on a declared gate block (e.g. `enabled`, `targetDirs`,
 * `baselinePath`) are preserved as the consumer supplied them; this
 * function only injects the floors layer.
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

export function resolveQuality(userQuality) {
  const block =
    userQuality && typeof userQuality === 'object' ? userQuality : {};
  const gates =
    block.gates && typeof block.gates === 'object' ? block.gates : {};
  const gateScoping = {
    scope: block.gateScoping?.scope ?? DEFAULT_GATE_SCOPING.scope,
    diffRef: block.gateScoping?.diffRef ?? DEFAULT_GATE_SCOPING.diffRef,
  };
  const coverage = resolveCoverageGate(gates.coverage);
  const resolvedGates = resolveGatesWithFloors(gates);
  return {
    maintainability: resolveMaintainabilityQuality(
      gates.maintainability,
      gateScoping,
    ),
    crap: resolveMaintainabilityCrap(gates.crap, gateScoping, coverage),
    coverage,
    baselines: resolveBaselinesFromGates(gates),
    codingGuardrails: resolveCodingGuardrails(block.codingGuardrails),
    autoRefresh: resolveAutoRefresh(block.autoRefresh),
    baselineEpsilon: resolveBaselineEpsilon(block.baselineEpsilon),
    // Story #2165 — `delivery.quality.formatAutofix.timeoutMs` for the
    // close-time `npx biome format --write` spawn.
    formatAutofix: resolveFormatAutofix(block.formatAutofix),
    gateScoping,
    gates: resolvedGates,
  };
}

/**
 * Framework defaults for `delivery.quality.baselineEpsilon` (Story #1964 —
 * s-stability-epsilon). The writer folds sub-epsilon row deltas back to
 * the prior bytes so env variance never rewrites the on-disk baseline.
 *
 * Defaults match the AC: MI 0.5, CRAP 0.5, coverage 0.1, mutation 0.5,
 * lint 0 (counts are integer), lighthouse 1, bundle-size 1024 (bytes),
 * duplication 0.5 (percentage points, Story #3664).
 */
export const BASELINE_EPSILON_DEFAULTS = Object.freeze({
  maintainability: 0.5,
  crap: 0.5,
  coverage: 0.1,
  mutation: 0.5,
  lint: 0,
  lighthouse: 1,
  'bundle-size': 1024,
  duplication: 0.5,
});

const BASELINE_EPSILON_KINDS = new Set(Object.keys(BASELINE_EPSILON_DEFAULTS));

/**
 * Resolve the merged `delivery.quality.baselineEpsilon` block. Returns a
 * frozen per-kind map keyed by the same kind names used by the per-kind
 * modules. Unknown keys raise a warning. Negative or non-numeric overrides
 * throw an `EXIT_CONFIG`-style error so a misconfigured project halts at
 * startup rather than silently dropping the override.
 *
 * @param {object | undefined} userBlock
 * @returns {{ [kind: string]: number }}
 */
function assertEpsilonValue(kind, v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    const err = new Error(
      `[config] quality.baselineEpsilon.${kind} must be a non-negative finite number (got ${JSON.stringify(v)})`,
    );
    err.code = 'EXIT_CONFIG';
    err.exitCode = 3;
    throw err;
  }
}

export function resolveBaselineEpsilon(userBlock) {
  if (userBlock == null || typeof userBlock !== 'object') {
    return { ...BASELINE_EPSILON_DEFAULTS };
  }
  warnUnknownKeys(userBlock, BASELINE_EPSILON_KINDS, 'quality.baselineEpsilon');
  const out = { ...BASELINE_EPSILON_DEFAULTS };
  for (const kind of BASELINE_EPSILON_KINDS) {
    if (!Object.hasOwn(userBlock, kind)) continue;
    assertEpsilonValue(kind, userBlock[kind]);
    out[kind] = userBlock[kind];
  }
  return out;
}

/**
 * Convenience accessor: resolve a single kind's epsilon from a config
 * (project override or framework default). Returns the framework default
 * when the user block is absent or omits the kind. Throws when the kind
 * is unknown.
 *
 * @param {string} kind
 * @param {object | null | undefined} config full resolved config OR
 *   a `{ delivery: { quality: ... } }` / `{ quality: ... }` shape.
 * @returns {number}
 */
export function getBaselineEpsilon(kind, config) {
  if (!BASELINE_EPSILON_KINDS.has(kind)) {
    throw new Error(`[config] getBaselineEpsilon: unknown kind '${kind}'`);
  }
  const userBlock = config?.delivery?.quality?.baselineEpsilon;
  const resolved = resolveBaselineEpsilon(userBlock);
  return resolved[kind];
}

/**
 * Read the merged `delivery.quality` block. Accepts the full resolved
 * config — the canonical `delivery.quality` path is the single supported
 * shape.
 *
 * @param {object | null | undefined} config
 * @returns {ReturnType<typeof resolveQuality>}
 */
export function getQuality(config) {
  return resolveQuality(config?.delivery?.quality);
}
