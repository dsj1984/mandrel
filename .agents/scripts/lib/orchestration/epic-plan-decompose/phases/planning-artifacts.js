/**
 * planning-artifacts.js — Phase 1 of the epic-plan-decompose pipeline
 * (Story #2466). Owns the `## Planning Artifacts` body shim and the
 * cross-Story conflict-policy resolver.
 *
 * Extracted verbatim from `epic-plan-decompose.js` so the named exports
 * the existing unit tests import (`ensurePlanningArtifacts`) keep their
 * public surface byte-identical.
 *
 * @module lib/orchestration/epic-plan-decompose/phases/planning-artifacts
 */

import { resolveListValue } from '../../../config/shared.js';
import { DEFAULT_REGISTRY_PATTERNS } from '../../ticket-validator-conflicts.js';

/**
 * Ensure the supplied Epic body carries a `## Planning Artifacts` section.
 * Idempotent — when the section already exists the body is returned
 * verbatim; when it's missing and `linkedIssues` carries resolved ids
 * the section is appended exactly once using the canonical
 * `- [ ] PRD: #N` / `Tech Spec: #N` / `Acceptance Spec: #N` lines that
 * `issue-link-parser.js` recognises (so cascade-close still resolves the
 * linked tickets).
 *
 * Story #2283.
 *
 * @param {string} body
 * @param {{ prd: number|null, techSpec: number|null, acceptanceSpec: number|null } | undefined | null} linkedIssues
 * @returns {string}
 */
export function ensurePlanningArtifacts(body, linkedIssues) {
  const safeBody = typeof body === 'string' ? body : '';
  if (safeBody.includes('## Planning Artifacts')) return safeBody;
  if (!linkedIssues) return safeBody;
  const lines = [];
  if (Number.isInteger(linkedIssues.prd)) {
    lines.push(`- [ ] PRD: #${linkedIssues.prd}`);
  }
  if (Number.isInteger(linkedIssues.techSpec)) {
    lines.push(`- [ ] Tech Spec: #${linkedIssues.techSpec}`);
  }
  if (Number.isInteger(linkedIssues.acceptanceSpec)) {
    lines.push(`- [ ] Acceptance Spec: #${linkedIssues.acceptanceSpec}`);
  }
  if (lines.length === 0) return safeBody;
  return `${safeBody}\n\n## Planning Artifacts\n${lines.join('\n')}\n`;
}

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
