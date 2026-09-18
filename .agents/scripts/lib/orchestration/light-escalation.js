/**
 * lib/orchestration/light-escalation.js — what the light path does when it
 * refuses a scope (verdicts live in `light-suitability`): recycle the
 * receipt through `/mandrel-plan <id>` (which supersedes it) rather than
 * orphaning it, record the refusal as friction so ceilings can be
 * recalibrated from evidence, and publish the refused branch so cleanup
 * cannot delete the only copy. The receipt is created before the backstop
 * because its id drives the lease, branch, labels and commit subjects.
 * Telemetry failure never changes a verdict.
 *
 * @module lib/orchestration/light-escalation
 */

import { getStoryBranch, gitSpawn } from '../git-utils.js';
import {
  emitRuntimeFriction,
  lightScopeRejectedCategory,
  RUNTIME_FRICTION_CATEGORIES,
} from '../observability/runtime-friction.js';
import { LIGHT_REFUSAL_CLASSES } from './light-suitability.js';

/**
 * @param {number} storyId
 * @returns {string}
 */
function buildRecycleCommand(storyId) {
  return `/mandrel-plan ${storyId}`;
}

/**
 * Uncommitted work is not a scope refusal: re-run the backstop after
 * committing rather than recycling a fine receipt.
 *
 * @param {number} storyId
 * @returns {string}
 */
function buildRerunBackstopCommand(storyId) {
  return `node .agents/scripts/deliver-light.js --backstop --story ${storyId}`;
}

/**
 * `--amends` (with or without a leading `#`) as an issue number, else `null`. The only
 * Story a gate-stage refusal can be attributed to (no receipt exists yet);
 * never fabricate one.
 *
 * @param {unknown} amends
 * @returns {number|null}
 */
function normalizeAmendsId(amends) {
  const match = /^#?(\d+)$/.exec(String(amends ?? '').trim());
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * @param {{
 *   gate: object,
 *   amends?: unknown,
 *   recordFrictionFn?: typeof recordScopeFriction,
 * }} args
 * @returns {Promise<boolean>}
 */
export async function recordGateRefusal({
  gate,
  amends,
  emitFn,
  recordFrictionFn = recordScopeFriction,
} = {}) {
  return recordFrictionFn({
    emitFn,
    storyId: normalizeAmendsId(amends),
    surface: 'suitability-gate',
    reasons: gate?.outcome?.reasons ?? [],
    details: {
      action: gate?.action ?? null,
      code: gate?.suitability?.shape?.code ?? null,
    },
  });
}

/**
 * Record a blocked backstop as friction and return the next command.
 *
 * @param {{
 *   storyId: number,
 *   result: object,
 *   preservation?: ReturnType<typeof preserveRefusedWork>,
 *   recordFrictionFn?: typeof recordScopeFriction,
 * }} args
 * @returns {Promise<string>} The recycle command.
 */
export async function handleBlockedBackstop({
  storyId,
  result,
  preservation,
  emitFn,
  recordFrictionFn = recordScopeFriction,
} = {}) {
  const refusalClass = result?.refusalClass ?? null;
  await recordFrictionFn({
    emitFn,
    storyId,
    surface: 'diff-backstop',
    category: lightScopeRejectedCategory(refusalClass),
    reasons: result?.reasons ?? [],
    details: {
      fileCount: result?.fileCount ?? null,
      implFiles: result?.magnitude?.implFiles ?? null,
      implLines: result?.magnitude?.implLines ?? null,
      ceilings: result?.ceilings ?? null,
      classes: result?.classes ?? [],
      // Unpreserved work is a worse event; the roll-up must tell them apart.
      preserved: preservation?.preserved ?? null,
      refusalClass,
    },
  });
  return refusalClass === LIGHT_REFUSAL_CLASSES.UNCOMMITTED_WORK
    ? buildRerunBackstopCommand(storyId)
    : buildRecycleCommand(storyId);
}

/**
 * Push a refused run's branch to `origin` (no PR, no merge): a branch with
 * no remote ref is what cleanup sweeps treat as disposable. Total and
 * idempotent; a push failure is reported, never thrown.
 *
 * @param {{
 *   storyId: number,
 *   cwd?: string,
 *   gitFn?: typeof gitSpawn,
 * }} args
 * @returns {{
 *   preserved: boolean,
 *   branch: string,
 *   remoteRef: string|null,
 *   detail: string,
 * }}
 */
export function preserveRefusedWork({
  storyId,
  cwd = process.cwd(),
  gitFn = gitSpawn,
} = {}) {
  const branch = getStoryBranch(storyId);
  const unpreserved = (detail) => ({
    preserved: false,
    branch,
    remoteRef: null,
    detail,
  });
  let result;
  try {
    result = gitFn(cwd, 'push', '--set-upstream', 'origin', branch);
  } catch (err) {
    return unpreserved(
      `could not publish ${branch}: ${err?.message ?? err} — the finished work is LOCAL ONLY; push it before any branch cleanup runs`,
    );
  }
  if (result?.status !== 0) {
    return unpreserved(
      `could not publish ${branch}: ${result?.stderr || 'git push failed'} — the finished work is LOCAL ONLY; push it before any branch cleanup runs`,
    );
  }
  return {
    preserved: true,
    branch,
    remoteRef: `origin/${branch}`,
    detail: `refused work preserved on origin/${branch} — the branch is no longer the only copy, and no PR was opened`,
  };
}

/**
 * Never throws; `false` when the signals surface is unavailable.
 *
 * @param {{
 *   storyId?: number|null,
 *   surface: string,
 *   category?: string,
 *   reasons?: string[],
 *   details?: object,
 *   emitFn?: typeof emitRuntimeFriction,
 * }} args `category` defaults to the unclassified bucket (gate refusals
 *   precede any diff).
 * @returns {Promise<boolean>}
 */
async function recordScopeFriction({
  storyId,
  surface,
  category = RUNTIME_FRICTION_CATEGORIES.LIGHT_SCOPE_REJECTED,
  reasons = [],
  details = {},
  emitFn,
} = {}) {
  const emit = emitFn ?? emitRuntimeFriction;
  try {
    return await emit({
      storyId,
      category,
      tool: 'deliver-light',
      details: { surface, reasons, ...details },
    });
  } catch {
    return false;
  }
}
