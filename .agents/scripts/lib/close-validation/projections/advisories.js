// .agents/scripts/lib/close-validation/projections/advisories.js
/**
 * The projection layer's single call site, run once after the gate chain
 * passes; owns every per-kind concern. Advisory only — nothing here can fail
 * a close (`check-baselines` is the gate); a throw becomes a logged skip.
 */

import path from 'node:path';
import { getQuality } from '../../config/quality.js';
import {
  createCrapScorer,
  formatCrapProjection,
  projectCrapBreaches,
} from './crap.js';
import {
  formatMaintainabilityProjection,
  projectMaintainabilityRegressions,
} from './maintainability.js';

const DEFAULT_BASELINE_PATHS = Object.freeze({
  maintainability: 'baselines/maintainability.json',
  crap: 'baselines/crap.json',
});

/**
 * @param {string} kind
 * @param {object} gate resolved `delivery.quality.gates.<kind>` block
 * @param {string} cwd
 * @returns {string}
 */
function resolveBaselinePath(kind, gate, cwd) {
  const rel =
    typeof gate?.baselinePath === 'string' && gate.baselinePath.length > 0
      ? gate.baselinePath
      : DEFAULT_BASELINE_PATHS[kind];
  return path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);
}

/**
 * An absent gate block means defaults, which enable it.
 *
 * @param {object|undefined} gate
 * @returns {boolean}
 */
function isEnabled(gate) {
  return gate?.enabled !== false;
}

/**
 * `null` when the projection threw.
 *
 * @param {{ kind: string, log: (m: string) => void, run: () => Promise<object>|object, format: (r: object) => string|null }} opts
 * @returns {Promise<object|null>}
 */
async function runOne({ kind, log, run, format }) {
  let result;
  try {
    result = await run();
  } catch (err) {
    log(
      `[close-validation]   ⚠ ${kind} projection skipped (errored): ${err?.message ?? err}`,
    );
    return null;
  }
  if (result?.skipped) {
    log(
      `[close-validation] ⏭ ${kind} projection skipped (${result.skipped}${
        result.detail ? `: ${result.detail}` : ''
      })`,
    );
    return result;
  }
  const advisory = format(result);
  if (advisory) log(advisory);
  return result;
}

/**
 * @param {{
 *   cwd: string,
 *   baseBranch: string,
 *   storyBranch: string,
 *   config?: object,
 *   quality?: object,
 *   log?: (m: string) => void,
 *   projectMaintainability?: typeof projectMaintainabilityRegressions,
 *   formatMaintainability?: typeof formatMaintainabilityProjection,
 *   projectCrap?: typeof projectCrapBreaches,
 *   formatCrap?: typeof formatCrapProjection,
 * }} opts
 * @returns {Promise<{ maintainability: object|null, crap: object|null }>}
 */
export async function runProjectionAdvisories({
  cwd,
  baseBranch,
  storyBranch,
  config,
  quality,
  log = () => {},
  projectMaintainability = projectMaintainabilityRegressions,
  formatMaintainability = formatMaintainabilityProjection,
  projectCrap = projectCrapBreaches,
  formatCrap = formatCrapProjection,
} = {}) {
  const out = { maintainability: null, crap: null };
  let gates;
  try {
    gates = quality ?? getQuality(config) ?? {};
  } catch {
    gates = {};
  }

  const miGate = gates.maintainability;
  if (isEnabled(miGate)) {
    out.maintainability = await runOne({
      kind: 'maintainability',
      log,
      format: formatMaintainability,
      run: () =>
        projectMaintainability({
          cwd,
          baseBranch,
          storyBranch,
          baselinePath: resolveBaselinePath('maintainability', miGate, cwd),
        }),
    });
  } else {
    log('[close-validation] ⏭ maintainability projection skipped (disabled)');
  }

  const crapGate = gates.crap;
  if (isEnabled(crapGate)) {
    out.crap = await runOne({
      kind: 'crap',
      log,
      format: formatCrap,
      run: () =>
        projectCrap({
          cwd,
          baseBranch,
          storyBranch,
          baselinePath: resolveBaselinePath('crap', crapGate, cwd),
          newMethodCeiling: crapGate?.newMethodCeiling,
          scoreFiles: createCrapScorer({
            cwd,
            targetDirs: crapGate?.targetDirs,
            ignoreGlobs: crapGate?.ignoreGlobs,
            requireCoverage: crapGate?.requireCoverage,
            coveragePath: crapGate?.coveragePath,
          }),
        }),
    });
  } else {
    log('[close-validation] ⏭ crap projection skipped (disabled)');
  }

  return out;
}
