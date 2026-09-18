/**
 * `delivery.quality` accessor (Epic #1720 Story #1737 — uniform gate shape).
 *
 * The quality block under `delivery.quality.*` is now organised as a
 * `gates.<tier>` object where every tier (coverage, crap, maintainability,
 * mutation, bundle-size, duplication) shares the same four-field base:
 *
 *   - `enabled`      — when `false`, the checker exits 0 with a skip line.
 *   - `baselinePath` — repo-root-relative path to the gate's baseline file.
 *   - `tolerance`    — `{ kind: 'absolute' | 'percent', value: number }`.
 *   - `floors`       — workspace-keyed `{ "*": { ... } }` floor object.
 *
 * Story #1737 changes (vs the Story #1739 mechanical relocation):
 *
 *   - Diff scope / ref is one fixed constant (`GATE_SCOPING`, Story #5382
 *     folded the never-set `gateScoping` config block into it) — resolvers
 *     carry it through to crap and maintainability.
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

/**
 * Story #5382 — the tuning constants below replaced `.agentrc` keys no
 * surveyed config ever set (`gateScoping.*`, the crap/MI refresh tag,
 * `coverage.timeoutMs`, the `codingGuardrails` and
 * `autoRefresh` tuning, `baselineEpsilon.*`). Each is the value the key's
 * default always resolved to, so behaviour is unchanged;
 * `lib/migrations/steps/strip-removed-agentrc-keys.js` strips a leftover key
 * from a consumer config and names the constant that replaced it. The crap/MI
 * `refreshTimeoutMs` and `crap.friction.markerKey` keys had no reader at all
 * and were dropped outright.
 */
const GATE_SCOPING = Object.freeze({ scope: 'diff', diffRef: 'main' });

/** Commit-subject substring acknowledging a deliberate baseline refresh. */
const BASELINE_REFRESH_TAG = 'baseline-refresh:';

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

/**
 * Story #4981 / #5065 / #5173 — the two independent full-suite economies.
 *
 * `skipWhenUnchanged` decides *whether* to capture: no changed file under
 * `crap.targetDirs` versus `baseRef` means no capture at all. It is on by
 * default because it is gate-semantics-neutral — the gates score exactly what
 * they scored before, since nothing they score moved.
 *
 * `baselineJoin` lets the CRAP join resolve a method in an untouched file
 * from its committed baseline row instead of requiring fresh coverage for it.
 * That *loosens* the gate, so it stays off by default. Bundling the two under
 * one `enabled` switch is precisely what forced the earlier default flip to
 * be reverted (Story #5173).
 *
 * Neither switch shortens the capture run — a capture that does happen is the
 * ordinary full `npm run test:coverage` (Story #5065). `baseRef: null` means
 * "use the caller's own ref resolution" (the gate's `--ref` flag / `main`)
 * rather than a second, possibly-conflicting default.
 */
const DEFAULT_INCREMENTAL_COVERAGE = Object.freeze({
  skipWhenUnchanged: true,
  baselineJoin: false,
  baseRef: null,
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
  refreshTag: BASELINE_REFRESH_TAG,
  ignoreGlobs: Object.freeze([]),
  // Story #4775 — fail-closed floor on the per-method coverage JOIN. The
  // fraction of methods that must resolve a coverage entry, counted only over
  // files that HAVE one, before `update-crap-baseline.js` will persist. A
  // broken join is silent by construction (unresolved methods are simply
  // absent from the baseline), so the updater refuses rather than writing a
  // thin baseline and logging it as success. 0.75 sits far above a healthy
  // run (a repo with fresh coverage resolves ~98%) and far below the 4–6%
  // signature of a coordinate-system mismatch.
  minMethodResolutionRate: 0.75,
  incrementalCoverage: DEFAULT_INCREMENTAL_COVERAGE,
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
  // Story #4731 — the commit-subject substring that acknowledges a deliberate
  // maintainability baseline refresh in the compared range. Mirrors the CRAP
  // gate's `refreshTag`; the evaluate phase demotes head-vs-base regressions
  // (floors still enforced) when a range commit carrying this tag touches the
  // baseline file. Kept identical to the CRAP default so one refresh commit
  // can acknowledge both gates.
  refreshTag: BASELINE_REFRESH_TAG,
  ignoreGlobs: Object.freeze([]),
  // Story #4775 — fail-closed floor on the per-method coverage JOIN. The
  // fraction of methods that must resolve a coverage entry, counted only over
  // files that HAVE one, before `update-crap-baseline.js` will persist. A
  // broken join is silent by construction (unresolved methods are simply
  // absent from the baseline), so the updater refuses rather than writing a
  // thin baseline and logging it as success. 0.75 sits far above a healthy
  // run (a repo with fresh coverage resolves ~98%) and far below the 4–6%
  // signature of a coordinate-system mismatch.
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
 * fixed `GATE_SCOPING` carries the diff scope and ref.
 *
 * @param {object | undefined} userCrap raw `delivery.quality.gates.crap`
 * @param {{ coveragePath: string }} coverageGate resolved coverage gate
 * @returns {object} flattened legacy-bag view that existing callers read
 */
/**
 * Clamp a user-supplied method-resolution floor into `[0, 1]`. A
 * non-numeric, non-finite, or out-of-range value falls back to the framework
 * default rather than silently disabling the guard (a floor of `NaN` would
 * compare false against every rate and never fire).
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
 * Resolve `gates.crap.incrementalCoverage` (Story #4981, split by #5173).
 *
 * Each explicit switch overrides its framework default (`skipWhenUnchanged:
 * true`, `baselineJoin: false`); a malformed or absent user block resolves to
 * the defaults, so a consumer that never sets the key inherits the saving
 * without the loosening. The deprecated `enabled` alias that set both was
 * removed in Story #5382.
 *
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

/**
 * Resolve the maintainability gate. Returns the legacy-bag shape with
 * `targetDirs` + a scalar `tolerance` (when set) + the fixed scoping.
 */
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

/** Resolve the coverage gate. Owns `coveragePath` and the fixed `timeoutMs`. */
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
    timeoutMs: defaults.timeoutMs,
  };
}

/**
 * Authoring-time cyclomatic advisory thresholds (Story #5382 folded the
 * never-set `delivery.quality.codingGuardrails` block into this constant).
 * `cyclomaticFlag` is the advisory knob `quality-preview.js` reports over-flag
 * methods against without failing on them; the ratchet ceiling is fixed in
 * `lib/cyclomatic-ceiling.js#CYCLOMATIC_CEILING`. `requireSiblingTest` stays
 * off: nothing enforces a colocated test.
 */
export const CODING_GUARDRAILS = Object.freeze({
  cyclomaticFlag: 8,
  requireSiblingTest: false,
});

/**
 * Baseline-attribution auto-refresh. Only `enabled` is an operator switch;
 * the jump cap and the rescore scope are fixed (Story #5382).
 */
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

/**
 * Resolve the merged baselines block. Baselines now live alongside their
 * gates (`gates.<tier>.baselinePath`); this helper preserves the
 * historical flat `baselines.{crap, maintainability}` shape so
 * existing readers (`getBaselines(config)` in `config-resolver.js`)
 * stay untouched. Each entry is synthesised from the resolved gate's
 * `baselinePath`.
 */
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
 * Merge the entire `delivery.quality` block with framework defaults.
 *
 * Returns the historical flattened bag (so the existing call sites that
 * read `q.crap.coveragePath`, `q.maintainability.targetDirs`, etc. keep
 * working) plus the new `gates` resolved object.
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
 * Per-kind baseline epsilon (Story #1964 — s-stability-epsilon). The writer
 * folds sub-epsilon row deltas back to the prior bytes so env variance never
 * rewrites the on-disk baseline. MI 0.5, CRAP 0.5, coverage 0.1, mutation
 * 0.5, bundle-size 1024 (bytes), duplication 0.5 (percentage points). Fixed
 * constants since Story #5382 folded the never-set
 * `delivery.quality.baselineEpsilon` block.
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
 * One kind's baseline epsilon. Throws when the kind is unknown.
 *
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
