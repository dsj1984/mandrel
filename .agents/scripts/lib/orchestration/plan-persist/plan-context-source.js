/**
 * plan-context-source.js — locate and read the `plan-context.js` envelope so
 * persist can derive the `/plan --tickets` source ids from the run that
 * actually fetched them (Story #4554).
 *
 * This lives beside the persist ops rather than inside `plan-persist.js` so
 * the discovery + failure policy is directly testable: the CLI is a thin
 * `parseArgs` shell, and the interesting behaviour here is exactly the part
 * that decides whether a `--tickets` run can quietly lose its source set.
 *
 * @module lib/orchestration/plan-persist/plan-context-source
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Logger } from '../../Logger.js';

/**
 * Filename the `/plan` interrogate step writes its envelope to inside
 * `--plan-dir` (`plan-context.js --out <plan-dir>/plan-context.json`).
 */
export const PLAN_CONTEXT_FILENAME = 'plan-context.json';

/**
 * Decide where to look for the envelope.
 *
 * An explicit `--plan-context` path wins; otherwise the conventional file
 * inside `--plan-dir`. With neither, there is nothing to read — the caller
 * gets `null` and must warn (see `loadPlanContextEnvelope`).
 *
 * @param {string|null|undefined} explicitPath `--plan-context`.
 * @param {string|null|undefined} planDir `--plan-dir`.
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

/**
 * The advice printed whenever persist has no envelope to derive ids from.
 * Single-homed so the two no-envelope paths cannot drift apart.
 */
const CAPTURE_HINT =
  'Re-run step 1 with `node .agents/scripts/plan-context.js … --out ' +
  '<plan-dir>/plan-context.json` and pass --plan-dir, or pass ' +
  '--source-tickets explicitly.';

/**
 * Read the `plan-context.js` envelope.
 *
 * Failure policy — the point is that a `--tickets` run can never *quietly*
 * lose its source set, so every no-envelope path is audible:
 *
 * - **No path at all** (neither `--plan-dir` nor `--plan-context`): warn.
 *   Persist cannot tell a legitimate `--seed` run from a `--tickets` run
 *   whose envelope was never captured, so it says so rather than returning a
 *   silent `null`.
 * - **Explicit `--plan-context` missing**: throw. The operator named a file
 *   and meant it.
 * - **Auto-discovered file simply absent**: warn and degrade to
 *   `--source-tickets`. A `--seed` run legitimately has no envelope, so
 *   absence alone is not fatal.
 * - **Present but unparseable**: throw either way. A corrupt envelope is not
 *   the same as no envelope, and reading it as "no source tickets" is exactly
 *   the vacuous pass this module exists to prevent.
 *
 * @param {{ path: string, explicit: boolean }|null} planContext
 * @returns {Promise<object|null>} Parsed envelope, or null when absent.
 */
export async function loadPlanContextEnvelope(planContext) {
  if (!planContext) {
    Logger.warn(
      '[plan-persist] no --plan-dir or --plan-context given, so no ' +
        'plan-context envelope was read. If this was a `/plan --tickets` ' +
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
