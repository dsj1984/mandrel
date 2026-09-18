/**
 * Dependency-free leaf (breaks a conflicts ↔ file-assumptions import cycle).
 */

/**
 * `Map<storySlug, Set<storySlug>>` of every Story each key transitively
 * depends on. Assumes an acyclic graph — run `assertAcyclic` first.
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
