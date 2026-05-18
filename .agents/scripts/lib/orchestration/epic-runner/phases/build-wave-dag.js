/**
 * Build the wave DAG from the Epic's child Stories.
 *
 * `getSubTickets` returns every descendant (Features, PRDs, Tech Specs,
 * Stories, Tasks) via native sub-issues + body reverse-lookup. The
 * epic-runner only dispatches Stories, so we filter by `type::story`
 * before building the DAG. Throws if there are no Stories.
 */

import { parseBlockedBy } from '../../../dependency-parser.js';
import { computeWaves } from '../../../Graph.js';
import { TYPE_LABELS } from '../../../label-constants.js';
import { WaveScheduler } from '../wave-scheduler.js';

export async function runBuildWaveDagPhase(ctx, collaborators, state) {
  const { epicId, provider } = ctx;
  const bus = collaborators?.bus ?? null;
  if (bus) {
    await bus.emit('epic.plan.start', { epicId });
  }
  const descendants = await provider.getSubTickets(epicId);
  const stories = (descendants ?? []).filter((t) =>
    (t.labels ?? []).includes(TYPE_LABELS.STORY),
  );
  if (!stories.length) {
    throw new Error(`Epic #${epicId} has no child stories to dispatch.`);
  }
  const { adjacency, taskMap } = buildStoryDag(stories);
  const waves = computeWaves(adjacency, taskMap);
  const scheduler = new WaveScheduler(waves);
  if (bus) {
    // epic.plan.end carries the computed waves as the array-of-arrays
    // shape declared by the schema. Each inner array is the storyIds
    // dispatched together in that wave. `computeWaves` may return
    // entries that are objects (when fed `taskMap`); we normalize to a
    // simple numeric matrix here so the payload validates and replays
    // off the ledger without coupling readers to internal types.
    await bus.emit('epic.plan.end', {
      waves: normalizeWavesForEmit(waves),
    });
  }
  return { ...state, stories, waves, scheduler };
}

/**
 * Normalize the runner's wave representation into the
 * `Array<Array<integer>>` shape declared by
 * `.agents/schemas/lifecycle/epic.plan.end.schema.json`. `computeWaves`
 * returns waves of `taskMap` entries (objects with `id`); the ledger
 * needs only the IDs. Defensive number coercion mirrors the same id
 * extraction used in `buildStoryDag` above so emit and DAG stay
 * structurally aligned.
 */
function normalizeWavesForEmit(waves) {
  if (!Array.isArray(waves)) return [];
  return waves.map((wave) => {
    if (!Array.isArray(wave)) return [];
    return wave
      .map((entry) => {
        if (entry == null) return null;
        if (typeof entry === 'number') return entry;
        const id = entry.id ?? entry.number ?? entry.storyId;
        return id == null ? null : Number(id);
      })
      .filter((n) => Number.isInteger(n) && n > 0);
  });
}

/**
 * Convert an ordered list of story tickets into the adjacency/taskMap shape
 * that `Graph.computeWaves()` expects.
 *
 * Dependency source order (must match manifest-builder.js so dispatch manifest
 * and runtime wave scheduling never disagree):
 *   1. Canonical: `blocked by #NNN` / `depends on #NNN` parsed from the story
 *      ticket body via `parseBlockedBy` (same parser the dispatcher uses).
 *   2. Fallback: explicit `dependencies` array on the provider-returned story
 *      object (present in fixture / test payloads; optional in live GitHub
 *      payloads).
 * Only edges to other stories in this Epic are retained — foreign IDs are
 * dropped so the DAG stays closed over the scheduled set.
 */
function buildStoryDag(stories) {
  const adjacency = new Map();
  const taskMap = new Map();
  const storyIds = new Set(stories.map((s) => Number(s.id ?? s.number)));
  for (const s of stories) {
    const id = Number(s.id ?? s.number);
    const fromBody = parseBlockedBy(s.body ?? '');
    const fromField = Array.isArray(s.dependencies)
      ? s.dependencies.map(Number)
      : [];
    const merged = [...new Set([...fromBody, ...fromField])]
      .map(Number)
      .filter((dep) => dep !== id && storyIds.has(dep));
    adjacency.set(id, merged);
    taskMap.set(id, { ...s, id });
  }
  return { adjacency, taskMap };
}
