/**
 * planning-artifacts.js — Phase 1 of the epic-plan-decompose pipeline
 * (Story #2466). Owns the cross-Story conflict-policy resolver.
 *
 * Story #4324 retired the `## Planning Artifacts` body shim
 * (`ensurePlanningArtifacts`) with the context-ticket classes — the Epic
 * body now carries the planning content itself as managed sections.
 *
 * @module lib/orchestration/epic-plan-decompose/phases/planning-artifacts
 */

import { resolveListValue } from '../../../config/shared.js';
import { DEFAULT_REGISTRY_PATTERNS } from '../../ticket-validator-conflicts.js';

/**
 * Resolve the cross-Story conflict-finding policy from `_config.planning`.
 * Both flags default to `false` so existing repos keep the advisory-only
 * behaviour; setting either to `true` upgrades the matching finding class
 * to `'hard'`, which routes it through the validator's `errors[]` channel
 * and (when called inside the bounded decompose loop) triggers a re-prompt.
 */
export function resolveConflictPolicy(cfg) {
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
