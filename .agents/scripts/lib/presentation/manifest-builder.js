/**
 * manifest-builder.js
 *
 * Pure projection: builds a manifest-shaped object from a structural spec
 * (the `.agents/epics/<epic-id>.yaml` shape returned by
 * `lib/spec/loader.js#loadSpec`) plus a state mapping (the sibling
 * `<epic-id>.state.json` shape returned by `loadState`).
 *
 * Extracted from `manifest-formatter.js` (Story #1849 Task #1869). The
 * shape projection used to be inlined in the formatter; pulling it out
 * isolates the spec → manifest projection from the Markdown renderer and
 * lets the per-story guard cascade live behind a single
 * private predicate (`validateSpecShape`) so the orchestrator function's
 * CRAP score drops below 12.
 *
 * Story #3413 (2-tier cutover, final): the residual per-Task projection
 * (the Task projector, the per-Story Task array, and the Task-count
 * rollup) has been deleted. The walker (`projectStories`) counts
 * Stories directly, and `summary` carries Story-tier counts only
 * (`totalStories` / `doneStories` / `progressPercent`), matching the
 * canonical producer in `lib/orchestration/manifest-builder.js`.
 *
 * Story-level status surfaces on each `storyEntry.status` so downstream
 * renderers read the Story's own `agent::*` label directly — the
 * "Stories are first-class lifecycle units" invariant.
 *
 * No fs / network access; pure transform. Caller supplies `state` from
 * `lib/spec/loader.js#loadState`.
 */

import { AGENT_LABELS } from '../label-constants.js';

/**
 * Private: validate the per-level shape of a spec node before we project
 * it into the manifest. Centralising the guards keeps
 * `buildManifestFromSpec` linear instead of branching at every level — the
 * function reads as a straight projection and the predicate carries the
 * "is this thing iterable / object-shaped?" decisions.
 *
 * `level` describes which spec node we are validating:
 *   - `'stories'`  → the spec-level `stories` array
 *   - `'story'`    → a single Story object (must be a non-null object)
 *
 * Returns `true` when the node satisfies the shape contract for that
 * level, `false` otherwise. The caller substitutes an empty array (for
 * iterable levels) or skips the node (for object levels) on `false`.
 *
 * @param {string} level
 * @param {unknown} value
 * @returns {boolean}
 */
function validateSpecShape(level, value) {
  switch (level) {
    case 'stories':
      return Array.isArray(value);
    case 'story':
      return value !== null && typeof value === 'object';
    default:
      return false;
  }
}

/**
 * Private factory: build the slug→id and slug→status resolvers from a
 * state mapping. Returning the two closures from one factory keeps the
 * branching that interprets the optional `state.mapping` shape out of
 * `buildManifestFromSpec`'s body.
 *
 * Per Tech Spec #1483, agent::* status labels do not live in the spec.
 * `resolveStatus` reads `state.mapping[slug].lastObservedAgentState` when
 * present and falls back to `agent::ready` for un-mapped Stories.
 * `resolveId` falls back to a deterministic `slug:<slug>` sentinel so
 * the renderer never sees a null id.
 *
 * @param {{ mapping?: Record<string, { issueNumber?: number|null, lastObservedAgentState?: string|null }> }|null} state
 * @returns {{ resolveId: (slug: string) => number|string, resolveStatus: (slug: string) => string }}
 */
function buildResolvers(state) {
  const mapping =
    state && typeof state.mapping === 'object' && state.mapping !== null
      ? state.mapping
      : {};

  const resolveId = (slug) => {
    const entry = mapping[slug];
    const id =
      entry && typeof entry.issueNumber === 'number' ? entry.issueNumber : null;
    return id ?? `slug:${slug}`;
  };
  const resolveStatus = (slug) => {
    const entry = mapping[slug];
    return entry && typeof entry.lastObservedAgentState === 'string'
      ? entry.lastObservedAgentState
      : 'agent::ready';
  };
  return { resolveId, resolveStatus };
}

/**
 * Private: project a single spec Story into a manifest Story entry. The
 * Story's status is resolved directly from the Story-level label
 * (`state.mapping[slug].lastObservedAgentState`) and surfaces on
 * `storyEntry.status` — Stories carry their own lifecycle state and are
 * leaves with no child tickets. Caller
 * filters non-object stories with `validateSpecShape('story', ...)`
 * before invoking.
 *
 * @param {object} story
 * @param {{ resolveId: Function, resolveStatus: Function }} resolvers
 * @returns {{ storyEntry: object, wave: number }}
 */
function projectStory(story, resolvers) {
  const wave = Number.isInteger(story.wave) ? story.wave : -1;
  const storyId = resolvers.resolveId(story.slug);
  const status = resolvers.resolveStatus(story.slug);
  const storyEntry = {
    storyId,
    storyTitle: story.title ?? '',
    storySlug: story.slug ?? '',
    type: 'story',
    branchName:
      typeof storyId === 'number' ? `story-${storyId}` : `story-${story.slug}`,
    earliestWave: wave,
    status,
  };
  return { storyEntry, wave };
}

/**
 * Private: walk every Story in a spec and collect the per-story
 * projections + Story-tier roll-up counters. Keeps the loop machinery
 * out of `buildManifestFromSpec` so the entry point reads as a straight
 * assembly of the result envelope.
 *
 * Under the 2-tier hierarchy (Story #4041) Stories are direct Epic
 * children and leaves, so the rollup counts Stories directly:
 * `totalStories` is every projected Story and `doneStories` is the
 * subset carrying `agent::done`.
 *
 * @param {object[]} stories
 * @param {{ resolveId: Function, resolveStatus: Function }} resolvers
 * @returns {{
 *   storyManifest: object[],
 *   totalStories: number,
 *   doneStories: number,
 *   waveSet: Set<number>,
 * }}
 */
function projectStories(stories, resolvers) {
  const storyManifest = [];
  let totalStories = 0;
  let doneStories = 0;
  const waveSet = new Set();
  for (const story of stories) {
    if (!validateSpecShape('story', story)) continue;
    const { storyEntry, wave } = projectStory(story, resolvers);
    storyManifest.push(storyEntry);
    totalStories++;
    if (storyEntry.status === AGENT_LABELS.DONE) doneStories++;
    if (wave >= 0) waveSet.add(wave);
  }
  return { storyManifest, totalStories, doneStories, waveSet };
}

/**
 * Build a manifest-shaped object from a spec entry. Mirrors the contract
 * produced by `lib/orchestration/manifest-builder.js#buildManifest` so
 * `formatManifestMarkdown` (the renderer that backs `fromManifest`)
 * accepts it without modification.
 *
 * Slug→issue-number resolution prefers `state.mapping[slug].issueNumber`
 * when present and falls back to a deterministic `slug:<slug>` sentinel
 * so the renderer never sees a null id. Status labels prefer
 * `state.mapping[slug].lastObservedAgentState` and fall back to
 * `agent::ready` per Tech Spec #1483.
 *
 * Pure — does not touch fs or the network. Caller supplies `state` from
 * `lib/spec/loader.js#loadState`.
 *
 * @param {object} spec — parsed epic-spec (see `lib/spec/loader.js`).
 * @param {{
 *   state?: { mapping?: Record<string, { issueNumber?: number|null, lastObservedAgentState?: string|null }> },
 *   generatedAt?: string,
 *   executor?: string,
 *   dryRun?: boolean,
 *   agentTelemetry?: object|null,
 * }} [opts]
 * @returns {object} manifest object matching the shape `formatManifestMarkdown` consumes.
 */
export function buildManifestFromSpec(spec, opts = {}) {
  const resolvers = buildResolvers(opts.state ?? null);
  const epicId =
    spec?.epic && typeof spec.epic.id === 'number' ? spec.epic.id : null;
  const epicTitle =
    spec?.epic && typeof spec.epic.title === 'string' ? spec.epic.title : '';
  const stories = validateSpecShape('stories', spec?.stories)
    ? spec.stories
    : [];

  const { storyManifest, totalStories, doneStories, waveSet } = projectStories(
    stories,
    resolvers,
  );

  const progressPercent =
    totalStories > 0 ? Math.round((doneStories / totalStories) * 100) : 0;

  return {
    schemaVersion: '1.0.0',
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    epicId,
    epicTitle,
    executor: opts.executor ?? 'spec',
    dryRun: opts.dryRun ?? false,
    summary: {
      totalStories,
      doneStories,
      progressPercent,
      totalWaves: waveSet.size,
      dispatched: 0,
    },
    waves: [],
    storyManifest,
    dispatched: [],
    agentTelemetry: opts.agentTelemetry ?? null,
    // Cross-Story conflict findings forwarded by the validator (Story
    // #2296). The formatter only emits the hazards block when this key
    // is *defined* — undefined means the caller didn't compute findings
    // for this manifest (e.g. live progress reporter ticks), so the
    // section is suppressed rather than showing a misleading "no
    // hazards" line.
    concurrencyFindings: opts.concurrencyFindings,
  };
}

// Test-only: surface the private predicate so the sibling unit test can
// exercise each branch without going through the full builder. Export
// stays underscored to signal "internal" to production callers.
export const __testables = { validateSpecShape };
