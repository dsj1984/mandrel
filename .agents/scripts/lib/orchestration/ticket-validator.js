import { detectCycle } from '../Graph.js';

/**
 * Validates the generated ticket hierarchy and handles lifting cross-story dependencies.
 *
 * @param {object[]} tickets - Array of ticket objects parsed from LLM output.
 * @returns {object[]} Validated tickets with normalized dependencies.
 */
export function validateAndNormalizeTickets(tickets) {
  const ticketBySlug = new Map();
  const features = [];
  const stories = [];
  const tasks = [];
  const slugAdjacency = new Map();

  for (const t of tickets) {
    if (t.slug) {
      if (ticketBySlug.has(t.slug)) {
        throw new Error(
          `Cross-Validation Failed: Duplicate slug "${t.slug}" — slugs must be unique across the backlog. Colliding titles: "${ticketBySlug.get(t.slug).title}" and "${t.title}".`,
        );
      }
      ticketBySlug.set(t.slug, t);
    }
    slugAdjacency.set(t.slug, t.depends_on ?? []);
    if (t.type === 'feature') features.push(t);
    else if (t.type === 'story') stories.push(t);
    else if (t.type === 'task') tasks.push(t);
  }

  if (features.length === 0)
    throw new Error(
      'Cross-Validation Failed: Backlog must contain at least one Feature.',
    );
  if (stories.length === 0)
    throw new Error(
      'Cross-Validation Failed: Backlog must contain at least one Story.',
    );
  if (tasks.length === 0)
    throw new Error(
      'Cross-Validation Failed: Backlog must contain at least one Task.',
    );

  // Validate hierarchy
  for (const story of stories) {
    if (!story.parent_slug)
      throw new Error(
        `Cross-Validation Failed: Story "${story.title}" must have a parent_slug.`,
      );
    const parent = ticketBySlug.get(story.parent_slug);
    if (!parent || parent.type !== 'feature')
      throw new Error(
        `Cross-Validation Failed: Story "${story.title}" parent must be a Feature.`,
      );
  }

  for (const task of tasks) {
    if (!task.parent_slug)
      throw new Error(
        `Cross-Validation Failed: Task "${task.title}" must have a parent_slug.`,
      );
    const parent = ticketBySlug.get(task.parent_slug);
    if (!parent || parent.type !== 'story') {
      throw new Error(
        `Cross-Validation Failed: Task "${task.title}" parent must be a Story.`,
      );
    }
  }

  // Every Story must have at least one child Task. A story with zero tasks is
  // a truncated/malformed LLM output that cannot be dispatched or executed,
  // and historically leaked through to GitHub as an empty container issue.
  const taskCountByStory = new Map();
  for (const task of tasks) {
    taskCountByStory.set(
      task.parent_slug,
      (taskCountByStory.get(task.parent_slug) ?? 0) + 1,
    );
  }
  const emptyStories = stories.filter(
    (s) => (taskCountByStory.get(s.slug) ?? 0) === 0,
  );
  if (emptyStories.length > 0) {
    const list = emptyStories.map((s) => `"${s.title}" (${s.slug})`).join(', ');
    throw new Error(
      `Cross-Validation Failed: ${emptyStories.length} Story/Stories have no child Tasks: ${list}. Every Story must decompose into at least one Task.`,
    );
  }

  // ── Unknown-slug dependency check ──────────────────────────────────────
  // Any `depends_on` that references a slug not present in `ticketBySlug` is
  // a malformed LLM output — the ticket would be created on GitHub with a
  // silently-dropped dependency, breaking the DAG. Fail here so the operator
  // (or the LLM's self-correction loop) sees the typo before anything hits
  // the provider. Covers all ticket types, not just tasks.
  const unknownDeps = [];
  for (const t of tickets) {
    for (const depSlug of t.depends_on ?? []) {
      if (!ticketBySlug.has(depSlug)) {
        unknownDeps.push({ slug: t.slug, title: t.title, dep: depSlug });
      }
    }
  }
  if (unknownDeps.length > 0) {
    const list = unknownDeps
      .map((u) => `"${u.title}" (${u.slug}) → "${u.dep}"`)
      .join(', ');
    throw new Error(
      `Cross-Validation Failed: ${unknownDeps.length} depends_on reference(s) use unknown slugs: ${list}. Every slug in depends_on must match a slug present in the backlog.`,
    );
  }

  // ── Cross-story task dependency validation ─────────────────────────────
  // Tasks must only depend on other tasks within the same story.
  // If a cross-story task dep is found, auto-lift it to a story-level dep.
  const crossStoryLifted = [];
  for (const task of tasks) {
    if (!task.depends_on || task.depends_on.length === 0) continue;
    const taskStory = task.parent_slug;

    const keptDeps = [];
    for (const depSlug of task.depends_on) {
      const depTicket = ticketBySlug.get(depSlug);
      if (!depTicket) {
        // Unreachable — unknown slugs are filtered out above. Defensive
        // no-op so cycle detection below sees only known slugs.
        continue;
      }

      // Only check task→task cross-story deps
      if (depTicket.type !== 'task') {
        keptDeps.push(depSlug);
        continue;
      }

      const depStory = depTicket.parent_slug;
      if (depStory !== taskStory) {
        // Cross-story task dep found — lift to story-level
        const myStory = ticketBySlug.get(taskStory);
        if (myStory) {
          if (!myStory.depends_on) myStory.depends_on = [];
          if (!myStory.depends_on.includes(depStory)) {
            myStory.depends_on.push(depStory);
            // Update slugAdjacency
            const deps = slugAdjacency.get(taskStory) ?? [];
            if (!deps.includes(depStory)) {
              deps.push(depStory);
              slugAdjacency.set(taskStory, deps);
            }

            crossStoryLifted.push({
              task: task.slug,
              dep: depSlug,
              fromStory: taskStory,
              toStory: depStory,
            });
          }
        }
        // Remove the cross-story task dep (don't keep it)
      } else {
        keptDeps.push(depSlug);
      }
    }
    task.depends_on = keptDeps;
    slugAdjacency.set(task.slug, keptDeps);
  }

  if (crossStoryLifted.length > 0) {
    console.warn(
      `[Decomposer] ⚠️  Lifted ${crossStoryLifted.length} cross-story task dep(s) to story-level:`,
    );
    for (const lift of crossStoryLifted) {
      console.warn(
        `  Task "${lift.task}" → dep "${lift.dep}" lifted to Story "${lift.fromStory}" → Story "${lift.toStory}"`,
      );
    }
  }

  // Acyclic dependency check
  const cycle = detectCycle(slugAdjacency);
  if (cycle) {
    throw new Error(
      `Cross-Validation Failed: Circular dependency detected: ${cycle.join(' → ')}.`,
    );
  }

  return tickets;
}
