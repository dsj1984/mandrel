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
 * lets the per-feature / per-story / per-task guard cascade live behind
 * a single private predicate (`validateSpecShape`) so the orchestrator
 * function's CRAP score drops below 12.
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
 *   - `'features'` → the spec-level `features` array
 *   - `'stories'`  → a feature's `stories` array
 *   - `'story'`    → a single Story object (must be a non-null object)
 *   - `'tasks'`    → a story's `tasks` array
 *   - `'task'`     → a single Task object (must be a non-null object)
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
    case 'features':
    case 'stories':
    case 'tasks':
      return Array.isArray(value);
    case 'story':
    case 'task':
      return value !== null && typeof value === 'object';
    default:
      return false;
  }
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
  const state = opts.state ?? null;
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

  const epicId =
    spec?.epic && typeof spec.epic.id === 'number' ? spec.epic.id : null;
  const epicTitle =
    spec?.epic && typeof spec.epic.title === 'string' ? spec.epic.title : '';

  const features = validateSpecShape('features', spec?.features)
    ? spec.features
    : [];

  // Project each spec Story into a storyManifest entry. Tasks within a
  // Story carry their slug-derived id + the spec-author title as the
  // task slug so the rendered `- [ ] #id — slug` line is stable across
  // re-incarnations (no GH issue number drift bleeds through into the
  // diff). Per-Story `earliestWave` mirrors `story.wave` directly —
  // spec waves are authoritative; the dependency analyzer is bypassed.
  const storyManifest = [];
  let totalTasks = 0;
  let doneTasks = 0;
  const waveSet = new Set();

  for (const feature of features) {
    const stories = validateSpecShape('stories', feature?.stories)
      ? feature.stories
      : [];
    for (const story of stories) {
      if (!validateSpecShape('story', story)) continue;
      const storyTasks = validateSpecShape('tasks', story.tasks)
        ? story.tasks
        : [];
      const tasks = [];
      for (const t of storyTasks) {
        if (!validateSpecShape('task', t)) continue;
        const status = resolveStatus(t.slug);
        if (status === AGENT_LABELS.DONE) doneTasks++;
        totalTasks++;
        tasks.push({
          taskId: resolveId(t.slug),
          taskSlug: t.slug ?? '',
          status,
          dependencies: [], // Tasks have no dependsOn surface in the spec.
        });
      }

      const wave = Number.isInteger(story.wave) ? story.wave : -1;
      if (wave >= 0) waveSet.add(wave);

      storyManifest.push({
        storyId: resolveId(story.slug),
        storyTitle: story.title ?? '',
        storySlug: story.slug ?? '',
        type: 'story',
        branchName:
          typeof resolveId(story.slug) === 'number'
            ? `story-${resolveId(story.slug)}`
            : `story-${story.slug}`,
        earliestWave: wave,
        tasks,
      });
    }
  }

  const progressPercent =
    totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

  return {
    schemaVersion: '1.0.0',
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    epicId,
    epicTitle,
    executor: opts.executor ?? 'spec',
    dryRun: opts.dryRun ?? false,
    summary: {
      totalTasks,
      doneTasks,
      progressPercent,
      totalWaves: waveSet.size,
      dispatched: 0,
    },
    waves: [],
    storyManifest,
    dispatched: [],
    agentTelemetry: opts.agentTelemetry ?? null,
  };
}

// Test-only: surface the private predicate so the sibling unit test can
// exercise each branch without going through the full builder. Export
// stays underscored to signal "internal" to production callers.
export const __testables = { validateSpecShape };
