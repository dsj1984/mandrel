/**
 * v2 run-epilogue scaffold — the per-run closeout ceremony (inert).
 *
 * Under the v2 collapse (`docs/roadmap.md` § v2.0.0), per-Story ceremony (gates
 * + risk-routed review/critics/audit) is the common case. The epic-only
 * ceremonies — a cross-Story audit sweep over the combined diff, the retro +
 * friction roll-up, and a sibling-coherence check — attach to the **run**, not
 * each Story, and fire **once** after the last Story of a multi-Story run
 * lands. The trigger is a `/deliver --run <planRunId>` epilogue (design
 * decision Q1): no new watchdog, the deliver invocation that sequenced the run
 * owns the closeout.
 *
 * This module is the **inert scaffold**: a pure planner that enumerates the
 * epilogue steps for a run. It performs no side effects and executes nothing —
 * Stage 4 wires the descriptor list into `/deliver`'s epilogue and turns each
 * descriptor into an action. A single-Story run has **no run scope**: the
 * Story's own close is the end, so the epilogue is not applicable.
 */

/**
 * Canonical epilogue step kinds, in execution order.
 * @type {readonly ['audit-sweep', 'retro-rollup', 'sibling-coherence']}
 */
export const RUN_EPILOGUE_STEP_KINDS = Object.freeze([
  'audit-sweep',
  'retro-rollup',
  'sibling-coherence',
]);

/**
 * @typedef {object} RunEpilogueStep
 * @property {'audit-sweep'|'retro-rollup'|'sibling-coherence'} kind
 * @property {string} description Human-readable summary of the step.
 * @property {string[]} stories  The run's Story ids this step operates over.
 */

/**
 * @typedef {object} RunEpiloguePlan
 * @property {boolean} applicable Whether a run-scoped epilogue applies (N>1).
 * @property {string|null} planRunId The run this plan closes out.
 * @property {string[]} stories  The run's Story ids (deduped, in order).
 * @property {RunEpilogueStep[]} steps The ordered epilogue steps (empty when not applicable).
 * @property {string} [reason]   Why the epilogue is not applicable, when it isn't.
 */

/**
 * @param {string|number|{ id?: string|number, slug?: string }} entry
 * @returns {string|null}
 */
function normalizeStoryId(entry) {
  if (typeof entry === 'string') return entry.trim() || null;
  if (typeof entry === 'number' && Number.isInteger(entry)) {
    return String(entry);
  }
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.id === 'string' || Number.isInteger(entry.id)) {
    return String(entry.id).trim() || null;
  }
  return typeof entry.slug === 'string' ? entry.slug.trim() || null : null;
}

/**
 * Normalize the `stories` input to an ordered, deduped list of non-empty ids.
 *
 * @param {Array<string|number|{ id?: string|number, slug?: string }>} stories
 * @returns {string[]}
 */
function normalizeStoryIds(stories) {
  const list = Array.isArray(stories) ? stories : [];
  const seen = new Set();
  const ids = [];
  for (const entry of list) {
    const id = normalizeStoryId(entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Plan the per-run epilogue ceremony for a completed run. Pure and inert — it
 * enumerates steps, it does not run them.
 *
 * @param {object} args
 * @param {string} args.planRunId The plan-run id grouping the Stories.
 * @param {Array<string|number|{ id?: string|number, slug?: string }>} args.stories
 *   The run's Stories (ids, slugs, or objects carrying either).
 * @returns {RunEpiloguePlan}
 */
export function planRunEpilogue({ planRunId, stories } = {}) {
  const ids = normalizeStoryIds(stories);
  const runId =
    typeof planRunId === 'string' && planRunId.trim() !== ''
      ? planRunId.trim()
      : null;

  // A single-Story run (or none) has no run scope — the Story's own close is
  // the end. This is the common case under the default-single split policy.
  if (ids.length <= 1) {
    return {
      applicable: false,
      planRunId: runId,
      stories: ids,
      steps: [],
      reason:
        ids.length === 0
          ? 'no Stories in run'
          : 'single-Story run — per-Story close is the end; no run-scoped epilogue',
    };
  }

  if (runId === null) {
    return {
      applicable: false,
      planRunId: null,
      stories: ids,
      steps: [],
      reason: 'multi-Story run requires a planRunId to anchor the epilogue',
    };
  }

  const steps = [
    {
      kind: 'audit-sweep',
      description: `Cross-Story audit sweep over the combined diff of run ${runId}`,
      stories: ids,
    },
    {
      kind: 'retro-rollup',
      description: `Retro + friction roll-up for run ${runId}`,
      stories: ids,
    },
    {
      kind: 'sibling-coherence',
      description: `Sibling-coherence check across the ${ids.length} Story specs of run ${runId}`,
      stories: ids,
    },
  ];

  return { applicable: true, planRunId: runId, stories: ids, steps };
}
