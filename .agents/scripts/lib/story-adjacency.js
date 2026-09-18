/**
 * The single Story-records → `Map<storyId, number[]>` adjacency builder for
 * the `lib/Graph.js` kernel. Dependency sources must match planning
 * (`manifest-builder.js`) so scheduling never disagrees: body `blocked by` /
 * `depends on` refs, unioned with a `dependencies` / `dependsOn` array.
 *
 * @module lib/story-adjacency
 */

import { parseBlockedBy } from './dependency-parser.js';

/**
 * Self-edges and non-integer ids are always dropped.
 *
 * @param {Array<{id?: number|string, number?: number, body?: string,
 *   dependencies?: Array<number|string>, dependsOn?: Array<number|string>}>} stories
 * @param {object} [opts]
 * @param {boolean} [opts.dropForeign=false] Default keeps edges to ids absent
 *   from the input (treated as not-yet-done, withholding the dependent);
 *   `true` drops them so the DAG is closed over the supplied set.
 * @returns {Map<number, number[]>}
 */
export function buildStoryAdjacency(stories, { dropForeign = false } = {}) {
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
