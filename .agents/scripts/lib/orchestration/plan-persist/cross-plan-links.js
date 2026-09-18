/**
 * A plan's references to live tracker state (`--epic <id>`, `#<id>`
 * blockers), verified together before the first create, dry run included —
 * cheap to fix then, costly after.
 *
 * @module lib/orchestration/plan-persist/cross-plan-links
 */

import { adoptContainerEpic, resolveAdoptionTarget } from './epic-adoption.js';
import { createContainerEpic } from './epic-ops.js';
import { assertExternalDependenciesResolvable } from './external-deps.js';

/**
 * @param {{
 *   provider: object,
 *   stories: Array<{ slug: string, depends_on?: string[] }>,
 *   epicId: number|null,
 * }} args
 * @returns {Promise<{ id: number, title: string, body: string }|null>}
 * @throws {Error} When a `#<id>` blocker or the named Epic cannot be used.
 */
export async function resolveCrossPlanLinks({ provider, stories, epicId }) {
  await assertExternalDependenciesResolvable({ provider, stories });
  return resolveAdoptionTarget({ provider, epicId });
}

/**
 * Adopt the resolved target, else create. The two paths have opposite
 * failure postures, so the choice lives here, not at the call site.
 *
 * @param {{
 *   provider: object,
 *   adoptionTarget: { id: number, title: string, body: string }|null,
 *   epic: { title: string, goal: string }|null,
 *   created: Array<{ id: number }>,
 *   opts?: { dryRun?: boolean },
 * }} args
 * @returns {Promise<object|null>}
 */
export async function resolveContainerEpic({
  provider,
  adoptionTarget,
  epic,
  created,
  opts = {},
}) {
  if (adoptionTarget) {
    return adoptContainerEpic({
      provider,
      target: adoptionTarget,
      created,
      opts,
    });
  }
  return createContainerEpic({ provider, epic, created, opts });
}
