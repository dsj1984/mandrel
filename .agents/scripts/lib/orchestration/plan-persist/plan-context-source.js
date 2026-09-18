/**
 * Locate and read the `plan-context.js` envelope, from which persist derives
 * the `--tickets` source ids.
 *
 * @module lib/orchestration/plan-persist/plan-context-source
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Logger } from '../../Logger.js';

export const PLAN_CONTEXT_FILENAME = 'plan-context.json';

/**
 * An explicit `--plan-context` wins over the file inside `--plan-dir`.
 *
 * @param {string|null|undefined} explicitPath
 * @param {string|null|undefined} planDir
 * @returns {{ path: string, explicit: boolean }|null}
 */
export function resolvePlanContextPath(explicitPath, planDir) {
  if (explicitPath) {
    return { path: path.resolve(explicitPath), explicit: true };
  }
  if (planDir) {
    return {
      path: path.join(path.resolve(planDir), PLAN_CONTEXT_FILENAME),
      explicit: false,
    };
  }
  return null;
}

const CAPTURE_HINT =
  'Re-run step 1 with `node .agents/scripts/plan-context.js … --out ' +
  '<plan-dir>/plan-context.json` and pass --plan-dir, or pass ' +
  '--source-tickets explicitly.';

/**
 * A `--tickets` run must never quietly lose its source set: no path or an
 * absent auto-discovered file warns (a `--seed` run legitimately has none);
 * a missing explicit file or an unparseable envelope throws.
 *
 * @param {{ path: string, explicit: boolean }|null} planContext
 * @returns {Promise<object|null>}
 */
export async function loadPlanContextEnvelope(planContext) {
  if (!planContext) {
    Logger.warn(
      '[plan-persist] no --plan-dir or --plan-context given, so no ' +
        'plan-context envelope was read. If this was a `/mandrel-plan --tickets` ' +
        'run, its source tickets can only come from --source-tickets and ' +
        `will NOT be closed otherwise. ${CAPTURE_HINT}`,
    );
    return null;
  }

  let raw;
  try {
    raw = await readFile(planContext.path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT' && !planContext.explicit) {
      Logger.warn(
        `[plan-persist] no plan-context envelope at ${planContext.path} — ` +
          'source tickets can only come from --source-tickets. ' +
          CAPTURE_HINT,
      );
      return null;
    }
    throw new Error(
      `Cannot read plan-context envelope ${planContext.path}: ${err.message}`,
    );
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse plan-context envelope "${planContext.path}" as JSON: ` +
        `${err.message}. ${CAPTURE_HINT}`,
    );
  }
}
