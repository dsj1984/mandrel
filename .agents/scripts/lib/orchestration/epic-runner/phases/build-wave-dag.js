/**
 * Build the wave DAG from the Epic's open child Stories.
 *
 * `getSubTickets` returns the **direct** children of a parent ticket via
 * native sub-issues + checklist links + body reverse-lookup. The
 * canonical 2-tier hierarchy is Epic → Story, so the Epic's direct
 * `type::story` children are the complete Story set.
 *
 * We additionally filter out closed Stories — `getSubTickets`'s reverse-
 * reference search can surface closed-as-obsolete tickets whose body
 * still names the Epic (e.g. a Story replaced during a planning
 * iteration). Dispatching against those would silently fan a sub-agent
 * out at pre-replan work.
 *
 * Throws if no open Stories are found.
 */

import { computeWaves } from '../../../Graph.js';
import { TYPE_LABELS } from '../../../label-constants.js';
import { buildStoryAdjacency } from '../../../story-adjacency.js';
import { WaveScheduler } from '../wave-scheduler.js';

/**
 * Collect the Epic's direct `type::story` children and return the open
 * ones, deduped by id.
 *
 * Exported so `snapshot.js#discoverStoryIds` and `epic-deliver-preflight`
 * can share the same enumeration contract — the snapshot.end payload,
 * preflight Story count, and wave DAG input set must never disagree.
 */
export async function discoverOpenStories({ epicId, provider }) {
  const descendants = (await provider.getSubTickets(epicId)) ?? [];
  const seen = new Set();
  const stories = [];
  for (const t of descendants) {
    const labels = t.labels ?? [];
    if (!labels.includes(TYPE_LABELS.STORY)) continue;
    const rawState = t.state ?? 'open';
    const norm = typeof rawState === 'string' ? rawState.toLowerCase() : 'open';
    if (norm !== 'open') continue;
    const id = t.id ?? t.number;
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    stories.push(t);
  }
  return stories;
}

export async function runBuildWaveDagPhase(ctx, collaborators, state) {
  const { epicId, provider } = ctx;
  const bus = collaborators?.bus ?? null;
  if (bus) {
    await bus.emit('epic.plan.start', { epicId });
  }
  const stories = await discoverOpenStories({ epicId, provider });
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
 * The adjacency comes from the shared story-level builder
 * (`lib/story-adjacency.js#buildStoryAdjacency`), which owns the
 * dependency-source ordering contract (body `blocked by` references via
 * `parseBlockedBy`, then explicit `dependencies[]`) and drops foreign
 * edges so the DAG stays closed over the scheduled set.
 */
function buildStoryDag(stories) {
  const adjacency = buildStoryAdjacency(stories);
  const taskMap = new Map();
  for (const s of stories) {
    const id = Number(s.id ?? s.number);
    taskMap.set(id, { ...s, id });
  }
  return { adjacency, taskMap };
}
