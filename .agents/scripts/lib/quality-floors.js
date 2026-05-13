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
 * Configurable via `.agentrc.json → agentSettings.quality.qualityFloors`:
 *
 *     {
 *       "coverage": { "lines": 90, "branches": 85, "functions": 90 },
 *       "maintainability": 70,
 *       "crap": 20
 *     }
 *
 * Unknown axes inside the `qualityFloors` block raise a validation error —
 * silent typos must never relax the gate.
 */

/** @typedef {{lines: number, branches: number, functions: number}} CoverageFloor */
/** @typedef {{coverage: CoverageFloor, maintainability: number, crap: number}} FloorConfig */

export const DEFAULT_FLOORS = Object.freeze({
  coverage: Object.freeze({ lines: 90, branches: 85, functions: 90 }),
  maintainability: 70,
  crap: 20,
});

const KNOWN_AXES = new Set(['coverage', 'maintainability', 'crap']);
const KNOWN_COVERAGE_AXES = new Set(['lines', 'branches', 'functions']);

/**
 * Load + validate the qualityFloors block from `.agentrc.json` (or another
 * config path). Returns a fully-populated config; missing fields fall back
 * to the documented defaults. Unknown axes throw a validation error.
 *
 * @param {string} [agentrcPath] absolute or cwd-relative path; defaults to
 *   `<cwd>/.agentrc.json`
 * @returns {FloorConfig}
 */
export function loadFloorConfig(agentrcPath) {
  const target =
    typeof agentrcPath === 'string' && agentrcPath.length > 0
      ? path.isAbsolute(agentrcPath)
        ? agentrcPath
        : path.resolve(process.cwd(), agentrcPath)
      : path.resolve(process.cwd(), '.agentrc.json');

  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch {
    // No config / unreadable → defaults. Deep-clone the frozen defaults so
    // callers can mutate without surprising sibling callers.
    return cloneDefaults();
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `qualityFloors: failed to parse ${target}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const block = parsed?.agentSettings?.quality?.qualityFloors;
  if (block === undefined || block === null) {
    return cloneDefaults();
  }
  if (typeof block !== 'object' || Array.isArray(block)) {
    throw new Error(
      `qualityFloors: expected an object at agentSettings.quality.qualityFloors, got ${Array.isArray(block) ? 'array' : typeof block}`,
    );
  }

  // Reject unknown axes (top-level).
  for (const key of Object.keys(block)) {
    if (!KNOWN_AXES.has(key)) {
      throw new Error(
        `qualityFloors: unknown axis "${key}"; expected one of ${[...KNOWN_AXES].join(', ')}`,
      );
    }
  }

  const out = cloneDefaults();

  if (block.coverage !== undefined) {
    if (
      typeof block.coverage !== 'object' ||
      block.coverage === null ||
      Array.isArray(block.coverage)
    ) {
      throw new Error(
        'qualityFloors.coverage: expected an object with numeric lines/branches/functions',
      );
    }
    for (const key of Object.keys(block.coverage)) {
      if (!KNOWN_COVERAGE_AXES.has(key)) {
        throw new Error(
          `qualityFloors.coverage: unknown axis "${key}"; expected one of ${[...KNOWN_COVERAGE_AXES].join(', ')}`,
        );
      }
      const v = block.coverage[key];
      if (!Number.isFinite(v) || v < 0 || v > 100) {
        throw new Error(
          `qualityFloors.coverage.${key}: expected a number in [0, 100], got ${JSON.stringify(v)}`,
        );
      }
      out.coverage[key] = v;
    }
  }

  if (block.maintainability !== undefined) {
    const v = block.maintainability;
    if (!Number.isFinite(v) || v < 0 || v > 100) {
      throw new Error(
        `qualityFloors.maintainability: expected a number in [0, 100], got ${JSON.stringify(v)}`,
      );
    }
    out.maintainability = v;
  }

  if (block.crap !== undefined) {
    const v = block.crap;
    if (!Number.isFinite(v) || v < 0) {
      throw new Error(
        `qualityFloors.crap: expected a non-negative number, got ${JSON.stringify(v)}`,
      );
    }
    out.crap = v;
  }

  return out;
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
export function applyFloorPolicy(records, floors, scope) {
  const violations = [];
  const passed = [];

  if (!Array.isArray(records)) {
    violations.push({
      scope,
      reason: 'invalid-records',
      message: `applyFloorPolicy: records must be an array, got ${typeof records}`,
    });
    return { violations, passed };
  }

  if (!floors || typeof floors !== 'object') {
    violations.push({
      scope,
      reason: 'invalid-floors',
      message: 'applyFloorPolicy: floors config missing or not an object',
    });
    return { violations, passed };
  }

  switch (scope) {
    case 'coverage':
      for (const rec of records) {
        const file = rec?.file ?? '<unknown>';
        let recordFailed = false;
        for (const axis of KNOWN_COVERAGE_AXES) {
          const observed = rec?.[axis];
          const floor = floors.coverage?.[axis];
          if (!Number.isFinite(observed)) {
            violations.push({
              scope,
              axis,
              file,
              reason: 'invalid-record',
              message: `coverage record for ${file} is missing numeric ${axis}`,
            });
            recordFailed = true;
            continue;
          }
          if (!Number.isFinite(floor)) {
            violations.push({
              scope,
              axis,
              file,
              reason: 'invalid-floors',
              message: `floors.coverage.${axis} is not a finite number`,
            });
            recordFailed = true;
            continue;
          }
          if (observed < floor) {
            violations.push({
              scope,
              axis,
              file,
              observed,
              floor,
              reason: 'below-floor',
            });
            recordFailed = true;
          }
        }
        if (!recordFailed) {
          passed.push({ scope, file });
        }
      }
      break;

    case 'maintainability': {
      const floor = floors.maintainability;
      if (!Number.isFinite(floor)) {
        violations.push({
          scope,
          reason: 'invalid-floors',
          message: 'floors.maintainability is not a finite number',
        });
        return { violations, passed };
      }
      for (const rec of records) {
        const file = rec?.file ?? '<unknown>';
        const observed = rec?.mi;
        if (!Number.isFinite(observed)) {
          violations.push({
            scope,
            file,
            reason: 'invalid-record',
            message: `maintainability record for ${file} is missing numeric mi`,
          });
          continue;
        }
        if (observed < floor) {
          violations.push({
            scope,
            file,
            observed,
            floor,
            reason: 'below-floor',
          });
        } else {
          passed.push({ scope, file, observed });
        }
      }
      break;
    }

    case 'crap': {
      const floor = floors.crap;
      if (!Number.isFinite(floor)) {
        violations.push({
          scope,
          reason: 'invalid-floors',
          message: 'floors.crap is not a finite number',
        });
        return { violations, passed };
      }
      for (const rec of records) {
        const file = rec?.file ?? '<unknown>';
        const method = rec?.method;
        const observed = rec?.score;
        if (!Number.isFinite(observed)) {
          violations.push({
            scope,
            file,
            method,
            reason: 'invalid-record',
            message: `crap record for ${file}${method ? `:${method}` : ''} is missing numeric score`,
          });
          continue;
        }
        if (observed > floor) {
          violations.push({
            scope,
            file,
            method,
            observed,
            floor,
            reason: 'above-ceiling',
          });
        } else {
          passed.push({ scope, file, method, observed });
        }
      }
      break;
    }

    default:
      violations.push({
        scope,
        reason: 'invalid-scope',
        message: `applyFloorPolicy: unknown scope "${scope}"; expected one of ${[...KNOWN_AXES].join(', ')}`,
      });
  }

  return { violations, passed };
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
