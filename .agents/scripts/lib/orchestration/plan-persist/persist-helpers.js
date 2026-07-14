/**
 * persist-helpers.js — pure helper surface for the flat Story `/plan` persist.
 *
 * Exports:
 *   - `validateTickets(tickets, config)` — runs the cross-link, model-capacity,
 *     freshness, and task-body validators in one pass. Capacity settings are
 *     explicit inputs so the validator and decomposer share one live delivery
 *     envelope instead of silently falling back to framework defaults.
 *   - `makeDefaultFanOutCounter({ baseBranchRef, cwd })` — production
 *     fan-out probe used by the conflict policy.
 *
 * @module lib/orchestration/plan-persist/persist-helpers
 */

import { resolveListValue } from '../../config/shared.js';
import { gitSpawn } from '../../git-utils.js';
import { validateTaskBodies } from '../task-body-validator.js';
import { validateAndNormalizeTickets } from '../ticket-validator.js';
import { DEFAULT_REGISTRY_PATTERNS } from '../ticket-validator-conflicts.js';

/**
 * Default fan-out counter — counts distinct files at `baseBranchRef` that
 * reference the basename (without extension) of the deleted path. Uses
 * `git grep -l` for a streaming-friendly probe; an empty grep returns
 * exit code 1 which we map to a count of 0.
 *
 * Story #2962. Injected via opts in tests; this default runs in production.
 */
export function makeDefaultFanOutCounter({ baseBranchRef, cwd }) {
  return ({ path }) => {
    const lastSlash = path.lastIndexOf('/');
    const base = lastSlash === -1 ? path : path.slice(lastSlash + 1);
    const dotIdx = base.lastIndexOf('.');
    const stem = dotIdx > 0 ? base.slice(0, dotIdx) : base;
    if (stem.length < 3) return 0;
    const result = gitSpawn(
      cwd ?? process.cwd(),
      'grep',
      '-l',
      '--fixed-strings',
      stem,
      baseBranchRef,
    );
    if (result.status !== 0) return 0;
    const lines = result.stdout.split('\n').filter((l) => l.trim().length > 0);
    // Exclude the deleted file itself from the call-site count.
    return lines.filter((l) => !l.endsWith(`:${path}`)).length;
  };
}

/**
 * Resolve the cross-Story conflict-finding policy from `_config.planning`.
 */
function resolveConflictPolicy(cfg) {
  const planning = cfg?.planning;
  const policy = {
    failOnSharedEditors: planning?.failOnSharedEditors === true,
    requireExplicitCrossStoryDeps:
      planning?.requireExplicitCrossStoryDeps === true,
    failOnRegistryConflicts: planning?.failOnRegistryConflicts === true,
    failOnLargeFanOut: planning?.failOnLargeFanOut === true,
  };
  if (Number.isFinite(planning?.largeFanOutThreshold)) {
    policy.largeFanOutThreshold = planning.largeFanOutThreshold;
  }
  if (planning?.crossCuttingRegistries !== undefined) {
    policy.registries = resolveListValue(
      DEFAULT_REGISTRY_PATTERNS,
      planning.crossCuttingRegistries,
    );
  }
  return policy;
}

export function validateTickets(tickets, config, opts = {}) {
  const baseBranchRef = config?.baseBranch ?? 'main';
  const conflictPolicy = resolveConflictPolicy(config);
  if (typeof opts.fanOutCounter === 'function') {
    conflictPolicy.fanOutCounter = opts.fanOutCounter;
  } else {
    conflictPolicy.fanOutCounter = makeDefaultFanOutCounter({
      baseBranchRef,
      cwd: opts.cwd,
    });
  }
  const validated = validateAndNormalizeTickets(tickets, {
    baseBranchRef,
    conflictPolicy,
    modelCapacity: opts.modelCapacity,
    maxTokenBudget: opts.maxTokenBudget,
    // Thread the repo cwd into the AC-freshness / file-assumption git
    // probes (#4474 PR7) — without it they silently ran against
    // process.cwd(), which is only the repo root by coincidence.
    cwd: opts.cwd,
  });
  validateTaskBodies(validated);
  return validated;
}
