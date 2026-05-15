import fs from 'node:fs';
import path from 'node:path';

/**
 * Shared floor-comparison policy for the three quality gates
 * (coverage / maintainability / CRAP). Extracted in Story #1602
 * (Task #1623) so the three checkers (`check-coverage-baseline.js`,
 * `check-maintainability.js`, `check-crap.js`) share one truth for
 * "absolute floor" semantics rather than each re-implementing the
 * comparison.
 *
 * Defaults (Phase 1 targets, set after the s9 baseline reset):
 *   - coverage axes (lines, branches, functions): 90 / 85 / 90 (percent, ≥)
 *   - maintainability index:                       70                (≥)
 *   - CRAP score per method:                       20                (≤)
 *
 * Configurable via `.agentrc.json → delivery.quality.gates.<tier>.floors`.
 * Story #1737 migrated the legacy flat `qualityFloors.*` shape to
 * per-gate workspace-keyed floors objects:
 *
 *     "delivery": {
 *       "quality": {
 *         "gates": {
 *           "coverage": {
 *             "floors": { "*": { "lines": 90, "branches": 85, "functions": 90 } }
 *           },
 *           "maintainability": { "floors": { "*": { "maintainability": 70 } } },
 *           "crap":            { "floors": { "*": { "crap": 20 } } }
 *         }
 *       }
 *     }
 *
 * The `"*"` key is the catch-all default; real workspace names handle
 * monorepo consumers. Unknown axes inside any workspace-keyed bag raise
 * a validation error — silent typos must never relax the gate. The flat
 * `qualityFloors.*` shape is rejected by the AJV schema and is no longer
 * recognised by this loader.
 */

/** @typedef {{lines: number, branches: number, functions: number}} CoverageFloor */
/** @typedef {{coverage: CoverageFloor, maintainability: number, crap: number}} FloorConfig */

export const DEFAULT_FLOORS = Object.freeze({
  coverage: Object.freeze({ lines: 90, branches: 85, functions: 90 }),
  maintainability: 70,
  crap: 20,
});

const KNOWN_COVERAGE_AXES = new Set(['lines', 'branches', 'functions']);
const KNOWN_AXES = new Set(['coverage', 'maintainability', 'crap']);

/**
 * Load + validate the per-gate floors blocks from `.agentrc.json` (or
 * another config path). Returns a fully-populated config; missing fields
 * fall back to the documented defaults. Unknown workspace-axis names
 * throw a validation error.
 *
 * @param {string} [agentrcPath] absolute or cwd-relative path; defaults to
 *   `<cwd>/.agentrc.json`
 * @param {{ workspace?: string }} [opts]
 *   `workspace` selects which workspace key inside `floors` to read.
 *   Defaults to `"*"` (the catch-all). Falls through to `"*"` when the
 *   requested workspace is not declared.
 * @returns {FloorConfig}
 */
export function loadFloorConfig(agentrcPath, opts = {}) {
  const workspace = typeof opts?.workspace === 'string' ? opts.workspace : '*';
  const target = resolveAgentrcPath(agentrcPath);
  const raw = readAgentrcOrNull(target);
  if (raw === null) return cloneDefaults();
  const parsed = parseAgentrcJson(target, raw);
  const gates =
    parsed?.delivery?.quality?.gates ??
    parsed?.agentSettings?.quality?.gates ??
    null;
  if (gates === null || typeof gates !== 'object') return cloneDefaults();
  const out = cloneDefaults();
  applyGateFloors(out, 'coverage', gates.coverage?.floors, workspace);
  applyGateFloors(
    out,
    'maintainability',
    gates.maintainability?.floors,
    workspace,
  );
  applyGateFloors(out, 'crap', gates.crap?.floors, workspace);
  return out;
}

function resolveAgentrcPath(agentrcPath) {
  if (typeof agentrcPath !== 'string' || agentrcPath.length === 0) {
    return path.resolve(process.cwd(), '.agentrc.json');
  }
  return path.isAbsolute(agentrcPath)
    ? agentrcPath
    : path.resolve(process.cwd(), agentrcPath);
}

function readAgentrcOrNull(target) {
  try {
    return fs.readFileSync(target, 'utf8');
  } catch {
    return null;
  }
}

function parseAgentrcJson(target, raw) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `qualityFloors: failed to parse ${target}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Pull the workspace-specific floor bag for a single gate. Story #1737
 * mandates the workspace-keyed shape: `floors: { "*": { ... } }`.
 * Returns the entry under `workspace`, falling back to the catch-all
 * `"*"` when the requested workspace is not declared.
 */
function selectWorkspaceFloors(floors, workspace) {
  if (floors === undefined || floors === null) return null;
  if (typeof floors !== 'object' || Array.isArray(floors)) {
    throw new Error(
      `qualityFloors: expected an object at gates.<tier>.floors, got ${Array.isArray(floors) ? 'array' : typeof floors}`,
    );
  }
  // Reject the legacy flat shape (e.g. floors: { lines: 90 }) — every
  // value at the top level MUST be a workspace bag (an object).
  for (const key of Object.keys(floors)) {
    if (typeof floors[key] !== 'object' || floors[key] === null) {
      throw new Error(
        `qualityFloors: workspace key "${key}" must point to an object of floor values, got ${typeof floors[key]}`,
      );
    }
  }
  return floors[workspace] ?? floors['*'] ?? null;
}

function applyGateFloors(out, tier, floors, workspace) {
  const bag = selectWorkspaceFloors(floors, workspace);
  if (bag === null) return;
  if (tier === 'coverage') {
    applyCoverageBag(out.coverage, bag);
    return;
  }
  applyScalarBag(out, tier, bag);
}

function applyCoverageBag(target, bag) {
  for (const key of Object.keys(bag)) {
    if (!KNOWN_COVERAGE_AXES.has(key)) {
      throw new Error(
        `qualityFloors.coverage: unknown axis "${key}"; expected one of ${[...KNOWN_COVERAGE_AXES].join(', ')}`,
      );
    }
    const v = bag[key];
    if (!Number.isFinite(v) || v < 0 || v > 100) {
      throw new Error(
        `qualityFloors.coverage.${key}: expected a number in [0, 100], got ${JSON.stringify(v)}`,
      );
    }
    target[key] = v;
  }
}

function applyScalarBag(out, tier, bag) {
  // The maintainability / crap bags carry a single named axis matching
  // the tier name (`{ maintainability: 70 }` / `{ crap: 20 }`). Treat
  // any other key as an unknown axis to keep the legacy validation
  // contract — typos must never silently relax the gate.
  for (const key of Object.keys(bag)) {
    if (key !== tier) {
      throw new Error(
        `qualityFloors: unknown axis "${tier}.${key}"; expected "${tier}"`,
      );
    }
    const v = bag[key];
    if (tier === 'maintainability') {
      if (!Number.isFinite(v) || v < 0 || v > 100) {
        throw new Error(
          `qualityFloors.maintainability: expected a number in [0, 100], got ${JSON.stringify(v)}`,
        );
      }
    } else if (tier === 'crap') {
      if (!Number.isFinite(v) || v < 0) {
        throw new Error(
          `qualityFloors.crap: expected a non-negative number, got ${JSON.stringify(v)}`,
        );
      }
    }
    out[tier] = v;
  }
}

function cloneDefaults() {
  return {
    coverage: { ...DEFAULT_FLOORS.coverage },
    maintainability: DEFAULT_FLOORS.maintainability,
    crap: DEFAULT_FLOORS.crap,
  };
}

/**
 * Compare a list of records against the floor policy for the given scope.
 *
 * Record shapes (caller-supplied; only the fields named below are read):
 *   - scope === 'coverage':
 *       { file: string, lines: number, branches: number, functions: number }
 *     Each percent is compared against the corresponding floor; a single
 *     record may contribute one violation per failing axis.
 *
 *   - scope === 'maintainability':
 *       { file: string, mi: number }
 *     Violates when `mi < floors.maintainability`.
 *
 *   - scope === 'crap':
 *       { file: string, method?: string, score: number }
 *     Violates when `score > floors.crap`.
 *
 * Never throws — malformed records (missing numeric fields, NaN, etc.) are
 * routed to `violations[]` with `reason: 'invalid-record'` so the caller
 * fails loud at the gate rather than silently passing.
 *
 * @param {Array<object>} records
 * @param {FloorConfig} floors
 * @param {'coverage'|'maintainability'|'crap'} scope
 * @returns {{violations: Array<object>, passed: Array<object>}}
 */
const SCOPE_HANDLERS = {
  coverage: applyCoverageFloor,
  maintainability: applyMaintainabilityFloor,
  crap: applyCrapCeiling,
};

export function applyFloorPolicy(records, floors, scope) {
  const guard = guardInputs(records, floors, scope);
  if (guard) return guard;
  const handler = SCOPE_HANDLERS[scope];
  return handler(records, floors);
}

function guardInputs(records, floors, scope) {
  if (!Array.isArray(records)) {
    return wrapSingle({
      scope,
      reason: 'invalid-records',
      message: `applyFloorPolicy: records must be an array, got ${typeof records}`,
    });
  }
  if (!floors || typeof floors !== 'object') {
    return wrapSingle({
      scope,
      reason: 'invalid-floors',
      message: 'applyFloorPolicy: floors config missing or not an object',
    });
  }
  if (!SCOPE_HANDLERS[scope]) {
    return wrapSingle({
      scope,
      reason: 'invalid-scope',
      message: `applyFloorPolicy: unknown scope "${scope}"; expected one of ${[...KNOWN_AXES].join(', ')}`,
    });
  }
  return null;
}

function wrapSingle(violation) {
  return { violations: [violation], passed: [] };
}

function applyCoverageFloor(records, floors) {
  const violations = [];
  const passed = [];
  for (const rec of records) {
    // Story #1895: canonical envelope rows use `path`; legacy gate records
    // still use `file`. Accept either so a migrating consumer can hand us
    // raw envelope rows without re-keying.
    const file = rec?.file ?? rec?.path ?? '<unknown>';
    const recViolations = checkCoverageRecord(rec, floors.coverage, file);
    if (recViolations.length === 0) passed.push({ scope: 'coverage', file });
    else violations.push(...recViolations);
  }
  return { violations, passed };
}

function checkCoverageRecord(rec, coverageFloors, file) {
  const out = [];
  for (const axis of KNOWN_COVERAGE_AXES) {
    const observed = rec?.[axis];
    const floor = coverageFloors?.[axis];
    if (!Number.isFinite(observed)) {
      // Missing axis (e.g. re-export-only file with no functions) passes a
      // floor of 0 — there's nothing to score, and the floor is the minimum
      // acceptable value. Only flag as invalid when the floor demands content.
      if (Number.isFinite(floor) && floor === 0) continue;
      out.push({
        scope: 'coverage',
        axis,
        file,
        reason: 'invalid-record',
        message: `coverage record for ${file} is missing numeric ${axis}`,
      });
      continue;
    }
    if (!Number.isFinite(floor)) {
      out.push({
        scope: 'coverage',
        axis,
        file,
        reason: 'invalid-floors',
        message: `floors.coverage.${axis} is not a finite number`,
      });
      continue;
    }
    if (observed < floor) {
      out.push({
        scope: 'coverage',
        axis,
        file,
        observed,
        floor,
        reason: 'below-floor',
      });
    }
  }
  return out;
}

function applyMaintainabilityFloor(records, floors) {
  const floor = floors.maintainability;
  if (!Number.isFinite(floor)) {
    return wrapSingle({
      scope: 'maintainability',
      reason: 'invalid-floors',
      message: 'floors.maintainability is not a finite number',
    });
  }
  const violations = [];
  const passed = [];
  for (const rec of records) {
    // Story #1895: canonical envelope rows use `path`; legacy gate records
    // still use `file`. Accept either so a migrating consumer can hand us
    // raw envelope rows without re-keying.
    const file = rec?.file ?? rec?.path ?? '<unknown>';
    const observed = rec?.mi;
    if (!Number.isFinite(observed)) {
      violations.push({
        scope: 'maintainability',
        file,
        reason: 'invalid-record',
        message: `maintainability record for ${file} is missing numeric mi`,
      });
      continue;
    }
    if (observed < floor) {
      violations.push({
        scope: 'maintainability',
        file,
        observed,
        floor,
        reason: 'below-floor',
      });
    } else {
      passed.push({ scope: 'maintainability', file, observed });
    }
  }
  return { violations, passed };
}

function applyCrapCeiling(records, floors) {
  const floor = floors.crap;
  if (!Number.isFinite(floor)) {
    return wrapSingle({
      scope: 'crap',
      reason: 'invalid-floors',
      message: 'floors.crap is not a finite number',
    });
  }
  const violations = [];
  const passed = [];
  for (const rec of records) {
    // Story #1895: canonical envelope rows use `path`; legacy gate records
    // still use `file`. Accept either so a migrating consumer can hand us
    // raw envelope rows without re-keying.
    const file = rec?.file ?? rec?.path ?? '<unknown>';
    const method = rec?.method;
    const observed = rec?.score;
    if (!Number.isFinite(observed)) {
      violations.push({
        scope: 'crap',
        file,
        method,
        reason: 'invalid-record',
        message: `crap record for ${file}${method ? `:${method}` : ''} is missing numeric score`,
      });
      continue;
    }
    if (observed > floor) {
      violations.push({
        scope: 'crap',
        file,
        method,
        observed,
        floor,
        reason: 'above-ceiling',
      });
    } else {
      passed.push({ scope: 'crap', file, method, observed });
    }
  }
  return { violations, passed };
}

/**
 * Pure: parse the `--floor` flag from argv. The flag is opt-out — present
 * absent means the floor gate runs. `--floor=off` / `--floor=false` / `--no-floor`
 * disable it (escape hatch for baseline-update runs and curated bypasses).
 *
 * @param {string[]} [argv]
 * @returns {boolean} true when the floor gate should run, false to skip
 */
export function parseFloorFlag(argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--no-floor') return false;
    if (a === '--floor=off' || a === '--floor=false') return false;
    if (a === '--floor=on' || a === '--floor=true') return true;
    if (a === '--floor') {
      const next = argv[i + 1];
      if (next === 'off' || next === 'false') return false;
      if (next === 'on' || next === 'true') return true;
      // Bare `--floor` means "explicitly on" (no-op vs default but harmless).
      return true;
    }
  }
  return true;
}

/**
 * Format a single violation as a human-readable one-liner. Used by the
 * three checker CLIs so their failure output reads the same way.
 *
 * @param {object} v violation record from applyFloorPolicy
 * @returns {string}
 */
export function formatViolation(v) {
  if (!v || typeof v !== 'object') return String(v);
  if (v.reason === 'below-floor' && v.scope === 'coverage') {
    return `${v.file}: ${v.axis} ${v.observed.toFixed(2)}% < floor ${v.floor}%`;
  }
  if (v.reason === 'below-floor' && v.scope === 'maintainability') {
    return `${v.file}: MI ${v.observed.toFixed(2)} < floor ${v.floor}`;
  }
  if (v.reason === 'above-ceiling' && v.scope === 'crap') {
    return `${v.file}${v.method ? `:${v.method}` : ''}: CRAP ${v.observed.toFixed(2)} > ceiling ${v.floor}`;
  }
  return v.message ?? JSON.stringify(v);
}
