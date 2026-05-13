import { ValidationError } from '../errors/index.js';
import { detectCycle } from '../Graph.js';
import { gitSpawn } from '../git-utils.js';

import { Logger } from '../Logger.js';
import {
  computeSizingFindings,
  DEFAULT_TASK_SIZING,
  renderHardFindingError,
  SIZING_PROFILE_VALUES,
} from './ticket-validator-sizing.js';

// Re-exported for callers that want the constants without reaching into the
// sizing helper module directly.
export { DEFAULT_TASK_SIZING, SIZING_PROFILE_VALUES };

/**
 * Regex matching code-asset paths the freshness gate cares about. The three
 * roots — `.agents/scripts`, `lib`, and `tests` — cover the executable surface
 * the decomposer's tasks legitimately reference. Anchoring on the leading dot
 * for `.agents` and a word boundary for `lib`/`tests` keeps URLs, image paths,
 * and unrelated prose ("library", "testimonial", "established") from being
 * scanned as fictitious file references.
 *
 * The regex is intentionally global + multi-match per body string so a single
 * Task naming several files surfaces every miss in one error.
 */
const FRESHNESS_PATH_RE =
  /(?:^|[\s`([<])(\.agents\/scripts|lib|tests)\/[\w./-]+\.js\b/g;

function collectPathsFromText(text, paths) {
  if (!text || typeof text !== 'string') return;
  // Reset lastIndex on the shared regex literal between calls.
  FRESHNESS_PATH_RE.lastIndex = 0;
  let match = FRESHNESS_PATH_RE.exec(text);
  while (match !== null) {
    // Capture group 1 is the root; full match index 0 includes the leading
    // delimiter — slice it off so the path is a clean repo-relative reference.
    const captured = match[0];
    const rootStart = captured.indexOf(match[1]);
    paths.add(captured.slice(rootStart));
    match = FRESHNESS_PATH_RE.exec(text);
  }
}

function collectTaskPathReferences(task) {
  const paths = new Set();
  const body = task.body;
  if (typeof body === 'string') {
    collectPathsFromText(body, paths);
  } else if (body !== null && typeof body === 'object') {
    if (typeof body.goal === 'string') collectPathsFromText(body.goal, paths);
    for (const arr of [body.changes, body.acceptance, body.verify]) {
      if (!Array.isArray(arr)) continue;
      for (const item of arr) collectPathsFromText(String(item ?? ''), paths);
    }
  }
  // Some planner shapes carry a top-level `acceptance` array even on string
  // bodies — scan it defensively.
  if (Array.isArray(task.acceptance)) {
    for (const item of task.acceptance) {
      collectPathsFromText(String(item ?? ''), paths);
    }
  }
  return paths;
}

/**
 * Default git probe: returns true when `path` exists at `ref` in the cwd repo.
 * Uses `git cat-file -e <ref>:<path>` which is the standard low-cost existence
 * check (no blob materialisation, no tree walk in node).
 *
 * Callers may inject their own runner with the same `(ref, path) => boolean`
 * signature for unit tests.
 */
function defaultGitRunner({ baseBranchRef, path, cwd }) {
  const result = gitSpawn(
    cwd ?? process.cwd(),
    'cat-file',
    '-e',
    `${baseBranchRef}:${path}`,
  );
  return result.status === 0;
}

/**
 * Verify that every code-asset path referenced by a Task body or AC exists at
 * `baseBranchRef`. A missing path means the planner LLM hallucinated (or the
 * path was deleted between planning and decomposition) — refuse to decompose
 * because the resulting Task would be unimplementable as written.
 *
 * Only Tasks are scanned; Features and Stories carry narrative copy, not
 * implementation paths, and their bodies routinely reference docs/templates
 * the freshness regex would (correctly) ignore.
 *
 * @param {object}   opts
 * @param {object[]} opts.tickets         - Validated ticket hierarchy.
 * @param {string}   opts.baseBranchRef   - Ref to probe (e.g. 'main' or 'origin/main').
 * @param {Function} [opts.gitRunner]     - Probe override (testing seam).
 * @param {string}   [opts.cwd]           - Repo cwd (forwarded to default runner).
 * @throws {ValidationError} when one or more Task references are stale.
 */
export function validateAcFreshness({
  tickets,
  baseBranchRef,
  gitRunner = defaultGitRunner,
  cwd,
}) {
  if (!baseBranchRef || typeof baseBranchRef !== 'string') {
    throw new ValidationError(
      'validateAcFreshness: baseBranchRef is required.',
    );
  }
  const tasks = (tickets ?? []).filter((t) => t.type === 'task');
  const misses = [];
  // Cache per-path probe results — sibling Tasks frequently cite the same
  // helper module; avoid re-spawning git for each repeat.
  const probeCache = new Map();
  for (const task of tasks) {
    const refs = collectTaskPathReferences(task);
    for (const path of refs) {
      let exists = probeCache.get(path);
      if (exists === undefined) {
        exists = gitRunner({ baseBranchRef, path, cwd });
        probeCache.set(path, exists);
      }
      if (!exists) {
        misses.push({ slug: task.slug ?? '<unknown>', path });
      }
    }
  }
  if (misses.length === 0) return;
  const lines = misses.map((m) => `  - "${m.slug}" → ${m.path}`).join('\n');
  throw new ValidationError(
    `Cross-Validation Failed: ${misses.length} Task reference(s) name files that do not exist at ${baseBranchRef}:\n${lines}\n\nThe planner is referencing stale paths — re-author the affected Task(s) against the current base-branch tree.`,
    { misses, baseBranchRef },
  );
}

/**
 * Validates the generated ticket hierarchy and handles lifting cross-story dependencies.
 *
 * The returned tickets array carries two extra non-array properties:
 *   - `findings` — structured sizing findings (hard + soft) keyed by the
 *     three-layer sizing model. The bounded re-decomposition loop in
 *     `epic-plan-decompose` reads `findings.filter(f => f.severity === 'hard')`
 *     to decide whether to re-prompt.
 *   - `errors`   — human-readable strings, one per hard finding. Non-empty
 *     `errors[]` is the AC-visible "block normalization" signal; the legacy
 *     hierarchy/cycle/freshness checks continue to throw, so callers that
 *     only inspect the array shape are unaffected when no sizing
 *     violations occur.
 *
 * @param {object[]}                   tickets             - Array of ticket objects parsed from LLM output.
 * @param {object}                     [opts]
 * @param {string}                     [opts.baseBranchRef] - When set, runs `validateAcFreshness` against this ref.
 * @param {Function}                   [opts.gitRunner]     - Optional git probe override.
 * @param {string}                     [opts.cwd]           - Repo cwd (forwarded to the freshness gate).
 * @param {object}                     [opts.taskSizing]    - Override the three-layer sizing thresholds. Defaults to `DEFAULT_TASK_SIZING`.
 * @returns {object[] & { findings: object[], errors: string[] }} Validated tickets with normalized dependencies and attached sizing findings.
 */
/**
 * Internal helpers extracted from `validateAndNormalizeTickets` so each
 * stage can be unit-tested in isolation and the orchestration method stays
 * at a low cyclomatic complexity. Exported via the `_internal` bundle at
 * the bottom of the module for tests; production callers should keep
 * using `validateAndNormalizeTickets`.
 */

function indexTicketsBySlug(tickets) {
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
  return { ticketBySlug, features, stories, tasks, slugAdjacency };
}

function assertEachTypePresent({ features, stories, tasks }) {
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
}

function assertHierarchy({ stories, tasks, ticketBySlug }) {
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
}

function countTasksByStory(tasks) {
  const taskCountByStory = new Map();
  for (const task of tasks) {
    taskCountByStory.set(
      task.parent_slug,
      (taskCountByStory.get(task.parent_slug) ?? 0) + 1,
    );
  }
  return taskCountByStory;
}

function assertEveryStoryHasTasks({ stories, taskCountByStory }) {
  const emptyStories = stories.filter(
    (s) => (taskCountByStory.get(s.slug) ?? 0) === 0,
  );
  if (emptyStories.length === 0) return;
  const list = emptyStories.map((s) => `"${s.title}" (${s.slug})`).join(', ');
  throw new Error(
    `Cross-Validation Failed: ${emptyStories.length} Story/Stories have no child Tasks: ${list}. Every Story must decompose into at least one Task.`,
  );
}

function assertNoUnknownDeps({ tickets, ticketBySlug }) {
  const unknownDeps = [];
  for (const t of tickets) {
    for (const depSlug of t.depends_on ?? []) {
      if (!ticketBySlug.has(depSlug)) {
        unknownDeps.push({ slug: t.slug, title: t.title, dep: depSlug });
      }
    }
  }
  if (unknownDeps.length === 0) return;
  const list = unknownDeps
    .map((u) => `"${u.title}" (${u.slug}) → "${u.dep}"`)
    .join(', ');
  throw new Error(
    `Cross-Validation Failed: ${unknownDeps.length} depends_on reference(s) use unknown slugs: ${list}. Every slug in depends_on must match a slug present in the backlog.`,
  );
}

function liftDepToStory({ task, depTicket, ticketBySlug, slugAdjacency }) {
  const depStory = depTicket.parent_slug;
  const taskStory = task.parent_slug;
  const myStory = ticketBySlug.get(taskStory);
  if (!myStory) return null;
  if (!myStory.depends_on) myStory.depends_on = [];
  if (myStory.depends_on.includes(depStory)) return null;
  myStory.depends_on.push(depStory);
  const deps = slugAdjacency.get(taskStory) ?? [];
  if (!deps.includes(depStory)) {
    deps.push(depStory);
    slugAdjacency.set(taskStory, deps);
  }
  return { fromStory: taskStory, toStory: depStory };
}

function processCrossStoryTaskDeps({ tasks, ticketBySlug, slugAdjacency }) {
  const crossStoryLifted = [];
  for (const task of tasks) {
    if (!task.depends_on || task.depends_on.length === 0) continue;
    const keptDeps = [];
    for (const depSlug of task.depends_on) {
      const depTicket = ticketBySlug.get(depSlug);
      if (!depTicket) {
        // Unreachable — unknown slugs are filtered out above. Defensive
        // no-op so cycle detection below sees only known slugs.
        continue;
      }
      if (depTicket.type !== 'task') {
        keptDeps.push(depSlug);
        continue;
      }
      if (depTicket.parent_slug === task.parent_slug) {
        keptDeps.push(depSlug);
        continue;
      }
      const lift = liftDepToStory({
        task,
        depTicket,
        ticketBySlug,
        slugAdjacency,
      });
      if (lift) {
        crossStoryLifted.push({ task: task.slug, dep: depSlug, ...lift });
      }
    }
    task.depends_on = keptDeps;
    slugAdjacency.set(task.slug, keptDeps);
  }
  return crossStoryLifted;
}

function logLiftedDeps(crossStoryLifted) {
  if (crossStoryLifted.length === 0) return;
  Logger.warn(
    `[Decomposer] ⚠️  Lifted ${crossStoryLifted.length} cross-story task dep(s) to story-level:`,
  );
  for (const lift of crossStoryLifted) {
    Logger.warn(
      `  Task "${lift.task}" → dep "${lift.dep}" lifted to Story "${lift.fromStory}" → Story "${lift.toStory}"`,
    );
  }
}

function assertAcyclic(slugAdjacency) {
  const cycle = detectCycle(slugAdjacency);
  if (cycle) {
    throw new Error(
      `Cross-Validation Failed: Circular dependency detected: ${cycle.join(' → ')}.`,
    );
  }
}

function attachFindingsAndErrors(tickets, findings, errors) {
  Object.defineProperty(tickets, 'findings', {
    value: findings,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(tickets, 'errors', {
    value: errors,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

export function validateAndNormalizeTickets(tickets, opts = {}) {
  const { ticketBySlug, features, stories, tasks, slugAdjacency } =
    indexTicketsBySlug(tickets);

  assertEachTypePresent({ features, stories, tasks });
  assertHierarchy({ stories, tasks, ticketBySlug });

  const taskCountByStory = countTasksByStory(tasks);
  assertEveryStoryHasTasks({ stories, taskCountByStory });
  assertNoUnknownDeps({ tickets, ticketBySlug });

  const crossStoryLifted = processCrossStoryTaskDeps({
    tasks,
    ticketBySlug,
    slugAdjacency,
  });
  logLiftedDeps(crossStoryLifted);

  assertAcyclic(slugAdjacency);

  // Refuse to decompose when any Task body or AC names a code-asset path
  // missing from the Epic's base branch tree. Skipped when the caller
  // omits `baseBranchRef` so legacy unit tests keep their existing
  // semantics; production call-sites always pass it.
  if (opts.baseBranchRef) {
    validateAcFreshness({
      tickets,
      baseBranchRef: opts.baseBranchRef,
      gitRunner: opts.gitRunner,
      cwd: opts.cwd,
    });
  }

  const findings = computeSizingFindings({
    tasks,
    stories,
    taskCountByStory,
    sizing: opts.taskSizing,
  });
  const errors = findings
    .filter((f) => f.severity === 'hard')
    .map(renderHardFindingError);

  attachFindingsAndErrors(tickets, findings, errors);
  return tickets;
}

// Internal helpers exposed for unit tests; not part of the public surface.
export const _internal = {
  indexTicketsBySlug,
  assertEachTypePresent,
  assertHierarchy,
  countTasksByStory,
  assertEveryStoryHasTasks,
  assertNoUnknownDeps,
  liftDepToStory,
  processCrossStoryTaskDeps,
  assertAcyclic,
  attachFindingsAndErrors,
};
