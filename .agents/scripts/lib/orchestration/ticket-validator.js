import { ValidationError } from '../errors/index.js';
import { detectCycle } from '../Graph.js';
import { gitSpawn } from '../git-utils.js';

import { Logger } from '../Logger.js';
import { validateTaskFileAssumptions } from './file-assumptions.js';
import {
  computeConflictFindings,
  renderHardConflictError,
} from './ticket-validator-conflicts.js';
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
 * Collect every code-asset path a Task declares it will *create or modify*
 * via its `body.changes` array. These paths are net-new (or about to be
 * touched) from the planner's perspective, so the freshness gate must
 * accept them even when they're absent from `baseBranchRef`.
 *
 * Only `body.changes` is consulted — `body.goal`, `body.acceptance`, and
 * `body.verify` are deliberately excluded so the gate continues to flag a
 * planner that hallucinates a fictitious file in narrative copy without
 * declaring it in the changes contract.
 */
function collectTaskChangesPaths(task) {
  const paths = new Set();
  const body = task.body;
  if (body === null || typeof body !== 'object') return paths;
  if (!Array.isArray(body.changes)) return paths;
  for (const item of body.changes) {
    collectPathsFromText(String(item ?? ''), paths);
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
  // Union every Task's `body.changes` paths into an expected-new set. Any
  // path the planner has declared in `changes` is considered intentional
  // (net-new or about-to-be-modified) and the git probe is skipped for it
  // — otherwise the freshness gate would reject the very test/source file
  // a Task is meant to create, even when the Task is well-formed.
  const expectedNewPaths = new Set();
  for (const task of tasks) {
    for (const path of collectTaskChangesPaths(task)) {
      expectedNewPaths.add(path);
    }
  }
  const misses = [];
  // Cache per-path probe results — sibling Tasks frequently cite the same
  // helper module; avoid re-spawning git for each repeat.
  const probeCache = new Map();
  for (const task of tasks) {
    const refs = collectTaskPathReferences(task);
    for (const path of refs) {
      if (expectedNewPaths.has(path)) continue;
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
  const lines = misses.map((m) => renderMissLine(m)).join('\n');
  throw new ValidationError(
    `Cross-Validation Failed: ${misses.length} Task reference(s) name files that do not exist at ${baseBranchRef}:\n${lines}\n\nEither declare the path in body.changes (signals net-new) or correct the reference.`,
    { misses, baseBranchRef },
  );
}

/**
 * Allowed leading Conventional-Commits types. Mirrors the `changelog-sections`
 * keys in `release-please-config.json` and the `type-enum` list in
 * `commitlint.config.js`. When a planner LLM prescribes a commit subject in a
 * Task acceptance item via the "Commit subject begins with '<prefix>:'" form,
 * the captured prefix must reduce to one of these types (optionally followed
 * by a `(scope)` qualifier) — anything else fails commitlint locally and
 * release-please's changelog parser on `main`, so the decompose is rejected
 * before the Story branch is ever cut.
 *
 * Epic #2501 introduced this guard after the legacy `baseline-refresh`
 * leading-token prescription created a wave of commit-msg hook failures
 * across story-deliver sub-agents. See
 * `.agents/skills/core/baseline-refresh/SKILL.md` for the canonical refresh
 * shape (Conventional-Commits subject + `baseline-refresh: true` body
 * trailer).
 */
const ALLOWED_COMMIT_TYPES = new Set([
  'feat',
  'fix',
  'chore',
  'refactor',
  'perf',
  'docs',
  'style',
  'test',
  'build',
  'ci',
  'revert',
]);

/**
 * Regex matching the canonical "Commit subject begins with '<prefix>:'"
 * prescription shape the planner emits in `body.acceptance[]` entries.
 * The leading quote is captured loosely (single, double, or backtick) so the
 * three quoting styles the decomposer LLM has historically emitted all
 * match. The captured group is the prefix token *without* the trailing
 * colon — callers normalize by stripping an optional `(scope)` qualifier
 * before comparing against the allowed-types set.
 */
const SUBJECT_PREFIX_RE = /Commit subject begins with ['"`]([^'"`]+):['"`]/g;

/**
 * Scan every Task's `body.acceptance[]` for "Commit subject begins with
 * '<prefix>:'" prescriptions and reject the decompose when any captured
 * prefix is not a valid Conventional-Commits type.
 *
 * A captured prefix of the form `chore(baselines)` is accepted — the
 * leading `chore` is in the allowed-types set, and the `(scope)` qualifier
 * is the standard Conventional-Commits scope shape. A captured prefix of
 * the form `baseline-refresh` is rejected because no Conventional-Commits
 * type starts with that token.
 *
 * Only `body.acceptance[]` is scanned; `body.goal` / `body.verify` /
 * `body.changes` are not commit-subject prescriptions by convention and
 * scanning them would surface false positives from prose that happens to
 * quote a forbidden prefix while explaining why it's forbidden.
 *
 * @param {object}   opts
 * @param {object[]} opts.tickets - Validated ticket hierarchy.
 * @throws {ValidationError} when one or more Task acceptance items
 *   prescribe a forbidden subject prefix. The error carries
 *   `code: 'forbidden-subject-prefix'` and a `violations[]` payload
 *   listing each `{ slug, prefix, line }` so the decompose loop can
 *   surface the exact offending text to the operator.
 */
export function validateAcceptanceSubjectPrefix({ tickets }) {
  const violations = [];
  const tasks = (tickets ?? []).filter((t) => t.type === 'task');
  for (const task of tasks) {
    const body = task.body;
    if (body === null || typeof body !== 'object') continue;
    if (!Array.isArray(body.acceptance)) continue;
    for (const item of body.acceptance) {
      const line = String(item ?? '');
      // Reset the global regex between iterations.
      SUBJECT_PREFIX_RE.lastIndex = 0;
      let match = SUBJECT_PREFIX_RE.exec(line);
      while (match !== null) {
        const rawPrefix = match[1];
        // Strip an optional `(scope)` qualifier — `chore(baselines)` reduces
        // to `chore` for the allowed-types check.
        const type = rawPrefix.replace(/\(.*\)$/, '').trim();
        if (!ALLOWED_COMMIT_TYPES.has(type)) {
          violations.push({
            slug: task.slug ?? '<unknown>',
            prefix: rawPrefix,
            line,
          });
        }
        match = SUBJECT_PREFIX_RE.exec(line);
      }
    }
  }
  if (violations.length === 0) return;
  const allowed = [...ALLOWED_COMMIT_TYPES].join('|');
  const lines = violations
    .map(
      (v) =>
        `  - "${v.slug}" → forbidden subject prefix "${v.prefix}:" in acceptance item: ${v.line}`,
    )
    .join('\n');
  const err = new ValidationError(
    `Cross-Validation Failed: ${violations.length} Task acceptance item(s) prescribe a non-Conventional-Commits subject prefix:\n${lines}\n\nAllowed leading types: ${allowed}. Use a Conventional-Commits subject (e.g. "chore(baselines): refresh ...") and a body trailer (e.g. "baseline-refresh: true") for machine-readable markers. See Epic #2501.`,
    { violations },
  );
  err.code = 'forbidden-subject-prefix';
  throw err;
}

/**
 * Render one missing-path line with a remediation hint pointing at the
 * task's `body.changes`. For `tests/**` paths we suggest the explicit
 * "add the test file" verb; for everything else we emit a generic hint
 * since the planner knows whether the path is net-new or a typo.
 */
function renderMissLine({ slug, path }) {
  const verb = path.startsWith('tests/') ? 'add test file' : 'create';
  return `  - "${slug}" → ${path}\n      hint: if net-new, add '${path}: ${verb}' to body.changes; otherwise fix the typo or stale reference against current main.`;
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
 * @param {object}                     [opts.conflictPolicy] - Severity controls for cross-Story conflict findings.
 * @param {boolean}                    [opts.conflictPolicy.failOnSharedEditors=false]          - Upgrade `shared-editor` findings to `hard`.
 * @param {boolean}                    [opts.conflictPolicy.requireExplicitCrossStoryDeps=false] - Upgrade `implicit-cross-story-dep` findings to `hard`.
 * @returns {object[] & { findings: object[], errors: string[] }} Validated tickets with normalized dependencies and attached sizing + conflict findings.
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

  // Reject any Task acceptance item that prescribes a non-Conventional-Commits
  // subject prefix (e.g. legacy "Commit subject begins with 'baseline-refresh:'"
  // from pre-Epic-#2501 planner output). Runs before the freshness gate so
  // the failure mode is reported up-front rather than after a git probe.
  validateAcceptanceSubjectPrefix({ tickets });

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

  // Story #2636 — Phase 8 path-assumption gate. Cross-check every Task's
  // declared `{ path, assumption }` against the actual state of the base
  // branch and batch the mismatches per-Task into the validator's errors
  // envelope. Skipped when the caller omits `baseBranchRef` so legacy
  // unit tests keep their semantics; production call-sites always pass
  // it.
  let assumptionErrors = [];
  if (opts.baseBranchRef) {
    const assumptionReport = validateTaskFileAssumptions({
      tickets,
      baseBranchRef: opts.baseBranchRef,
      gitRunner: opts.gitRunner,
      cwd: opts.cwd,
    });
    for (const warning of assumptionReport.warnings) {
      Logger.warn(`[ticket-validator] assumption-deprecation: ${warning}`);
    }
    assumptionErrors = assumptionReport.errors;
  }

  const sizingFindings = computeSizingFindings({
    tasks,
    stories,
    taskCountByStory,
    sizing: opts.taskSizing,
  });
  // Cross-Story path-conflict pass runs after Task→Story dep lifting so it
  // observes the final story-level depends_on graph. Findings are appended
  // to the same `findings` array consumed by the decompose-loop's hard-
  // finding gate; severity is controlled by `opts.conflictPolicy`.
  const conflictFindings = computeConflictFindings({
    tasks,
    stories,
    policy: opts.conflictPolicy,
  });
  const findings = [...sizingFindings, ...conflictFindings];
  const errors = findings
    .filter((f) => f.severity === 'hard')
    .map((f) => {
      if (f.kind === 'shared-editor' || f.kind === 'implicit-cross-story-dep') {
        return renderHardConflictError(f);
      }
      return renderHardFindingError(f);
    });
  // Append per-Task path-assumption mismatches (Story #2636) to the
  // hard-error list. The decompose loop already gates on
  // `errors.length > 0` to trigger a re-prompt, so the new check
  // participates in the same loop without bespoke wiring.
  for (const e of assumptionErrors) {
    errors.push(`File assumption mismatch: ${e}`);
  }

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
