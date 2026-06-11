/**
 * lib/story-adjacency.js — the single story-level adjacency builder.
 *
 * All three wave-computation wrappers bottom out in the shared
 * `lib/Graph.js` kernel (`detectCycle` / `assignLayers` /
 * `computeWaves`), but each historically re-implemented the step that
 * turns a list of Story records into the `Map<storyId, number[]>`
 * adjacency the kernel consumes. This module is now the one home for
 * that step; the consumers are:
 *
 *   - `lib/orchestration/epic-runner/phases/build-wave-dag.js`
 *     (`buildStoryDag` → `computeWaves`)
 *   - `lib/orchestration/dispatch-pipeline.js`
 *     (`buildStoryDispatchGraph` → `computeStoryWaves`)
 *   - `stories-wave-tick.js` (`buildAdjacency` → `assignLayers`)
 *
 * Dependency source order (must stay aligned with manifest-builder.js so
 * the dispatch manifest and runtime wave scheduling never disagree):
 *   1. Canonical: `blocked by #NNN` / `depends on #NNN` parsed from the
 *      Story body via `parseBlockedBy` (the same parser the dispatcher
 *      uses).
 *   2. Fallback: an explicit `dependencies` (ticket shape) or
 *      `dependsOn` (operator-DAG shape) array on the Story record.
 *
 * @module lib/story-adjacency
 */

import { parseBlockedBy } from './dependency-parser.js';

/**
 * Build a story-level adjacency map (`Map<storyId, dependencyIds[]>`)
 * from an ordered list of Story records.
 *
 * Each record contributes one adjacency entry keyed by
 * `Number(record.id ?? record.number)`. Dependencies are the deduped
 * union of body-parsed `blocked by` references and the record's
 * explicit `dependencies` / `dependsOn` array, with self-edges and
 * non-integer ids always dropped.
 *
 * @param {Array<{id?: number|string, number?: number, body?: string,
 *   dependencies?: Array<number|string>, dependsOn?: Array<number|string>}>} stories
 *   Story records (live ticket payloads, fixture tickets, or operator
 *   DAG nodes).
 * @param {object} [opts]
 * @param {boolean} [opts.dropForeign=true] When true (the default,
 *   matching the Epic-scoped wrappers), edges pointing at ids outside
 *   the supplied story set are dropped so the DAG stays closed over the
 *   scheduled set. `stories-wave-tick.js` passes `false` to preserve its
 *   historical operator-DAG contract, where a dependency on an id absent
 *   from the input still deepens the dependent's layer.
 * @returns {Map<number, number[]>}
 */
export function buildStoryAdjacency(stories, { dropForeign = true } = {}) {
  const records = Array.isArray(stories) ? stories : [];
  const storyIds = new Set(records.map((s) => Number(s?.id ?? s?.number)));
  const adjacency = new Map();
  for (const s of records) {
    const id = Number(s?.id ?? s?.number);
    const fromBody = parseBlockedBy(s?.body ?? '');
    const fromField = Array.isArray(s?.dependencies)
      ? s.dependencies.map(Number)
      : Array.isArray(s?.dependsOn)
        ? s.dependsOn.map(Number)
        : [];
    const merged = [...new Set([...fromBody, ...fromField])]
      .map(Number)
      .filter(
        (dep) =>
          Number.isInteger(dep) &&
          dep !== id &&
          (!dropForeign || storyIds.has(dep)),
      );
    adjacency.set(id, merged);
  }
  return adjacency;
}
