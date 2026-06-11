/**
 * lib/orchestration/story-reachability.js — Story `depends_on` graph walk.
 *
 * Houses the transitive-predecessor closure over the story-level
 * `depends_on` graph. Extracted from `./ticket-validator-conflicts.js`
 * under Story #3995 to break the `file-assumptions.js ↔
 * ticket-validator-conflicts.js` import cycle: both the conflict gate and
 * the wave-aware file-assumption gate need this graph traversal, so
 * pulling it down into a dependency-free leaf lets both import it from
 * below rather than from each other.
 *
 * This is a pure graph utility — no I/O, no policy. Its behaviour is
 * unchanged from the original `computeStoryReachability`.
 */

/**
 * Compute transitive predecessor sets over the story-level `depends_on`
 * graph. The returned map is `Map<storySlug, Set<storySlug>>`, where the
 * set contains every story reachable by following `depends_on` edges from
 * the key (i.e. every story the key transitively depends on).
 *
 * BFS, no cycles assumed — callers must run `assertAcyclic` first.
 *
 * Exported so both the conflict gate (`ticket-validator-conflicts.js`)
 * and the wave-aware file-assumption gate (`file-assumptions.js`) can
 * reuse the same transitive-predecessor walk rather than re-deriving the
 * `depends_on` closure.
 */
export function computeStoryReachability(stories) {
  const reach = new Map();
  for (const story of stories) reach.set(story.slug, new Set());
  for (const story of stories) {
    const visited = reach.get(story.slug);
    const stack = [...(story.depends_on ?? [])];
    while (stack.length > 0) {
      const next = stack.pop();
      if (!reach.has(next)) continue;
      if (visited.has(next)) continue;
      visited.add(next);
      const nextStory = stories.find((s) => s.slug === next);
      if (nextStory && Array.isArray(nextStory.depends_on)) {
        for (const dep of nextStory.depends_on) stack.push(dep);
      }
    }
  }
  return reach;
}
