/**
 * Three-layer Task sizing model — soft heuristics, hard structural ceilings,
 * and the mandatory `sizingProfile` declaration on wide Tasks. Co-located
 * with `ticket-validator.js`, but kept as its own module so the validator's
 * primary file stays under the maintainability ceiling. The validator
 * imports `computeSizingFindings` and `renderHardFindingError` and stitches
 * the result onto its return value as `findings` / `errors`.
 *
 * Keep `DEFAULT_TASK_SIZING` + the `sizingProfile` enum in lockstep with
 * `.agents/schemas/agentrc.schema.json` (`$defs.taskSizing`) and the JS
 * mirror in `.agents/scripts/lib/config-settings-schema.js`.
 */

export const DEFAULT_TASK_SIZING = Object.freeze({
  maxAcceptance: 6,
  maxChanges: 8,
  softFileCount: 3,
  softAcceptanceCount: 4,
});

export const SIZING_PROFILE_VALUES = Object.freeze([
  'mechanical-sweep',
  'atomic-rewrite',
  'scaffolding',
]);

/**
 * Heuristic Story-width soft cap. The Tech Spec's prompt biasing line —
 * "Stories typically ≤5 Tasks, otherwise split" — is advisory only and has
 * no configurable knob in `agentSettings.planning.taskSizing`. The
 * validator emits a `soft-story-width` finding when a Story carries more
 * child Tasks than this constant so operators see the same heuristic the
 * decomposer prompt enforces.
 */
const SOFT_STORY_TASK_COUNT = 5;

/**
 * Extract the path-shaped head from a single `changes` bullet. Conventional
 * shape is `"<path>: <verb> <object>"`; we slice on the first colon and
 * return the head when it contains a slash or dot, otherwise `null`.
 */
function extractChangeBulletPath(bullet) {
  if (typeof bullet !== 'string') return null;
  const colonIdx = bullet.indexOf(':');
  if (colonIdx <= 0) return null;
  const head = bullet.slice(0, colonIdx).trim();
  if (!/[\\/.]/.test(head)) return null;
  return head;
}

/**
 * Distinct fileCount for a Task — number of unique path-shaped heads found
 * across `task.body.changes` bullets. A 50-site mechanical rename with one
 * sweep bullet has `fileCount === 1`; a Task with five distinct
 * `path/to/file.js: ...` bullets has `fileCount === 5`.
 */
function computeTaskFileCount(task) {
  const body = task.body;
  if (!body || typeof body !== 'object') return 0;
  const changes = Array.isArray(body.changes) ? body.changes : [];
  const paths = new Set();
  for (const bullet of changes) {
    const path = extractChangeBulletPath(bullet);
    if (path) paths.add(path);
  }
  return paths.size;
}

function makeOversized(slug, field, observed, ceiling) {
  return {
    kind: 'oversized-task',
    severity: 'hard',
    ticketSlug: slug,
    field,
    observed,
    ceiling,
  };
}

function makeSoftWidth(slug, field, observed, soft) {
  return {
    kind: 'soft-task-width',
    severity: 'soft',
    ticketSlug: slug,
    field,
    observed,
    soft,
  };
}

/**
 * Compute the hard + soft sizing findings for a single Task across all
 * three layers (acceptance ceiling, changes ceiling, sizingProfile
 * requirement on wide Tasks).
 */
function computeTaskSizingFindings(task, sizing) {
  const out = [];
  const body = task.body && typeof task.body === 'object' ? task.body : null;
  const acceptance = Array.isArray(body?.acceptance) ? body.acceptance : [];
  const changes = Array.isArray(body?.changes) ? body.changes : [];

  if (acceptance.length > sizing.maxAcceptance) {
    out.push(
      makeOversized(
        task.slug,
        'acceptance',
        acceptance.length,
        sizing.maxAcceptance,
      ),
    );
  } else if (acceptance.length > sizing.softAcceptanceCount) {
    out.push(
      makeSoftWidth(
        task.slug,
        'acceptance',
        acceptance.length,
        sizing.softAcceptanceCount,
      ),
    );
  }

  if (changes.length > sizing.maxChanges) {
    out.push(
      makeOversized(task.slug, 'changes', changes.length, sizing.maxChanges),
    );
  }

  const fileCount = computeTaskFileCount(task);
  if (fileCount > sizing.softFileCount) {
    const profile = body?.sizingProfile;
    if (!profile || !SIZING_PROFILE_VALUES.includes(profile)) {
      out.push({
        kind: 'missing-sizing-profile',
        severity: 'hard',
        ticketSlug: task.slug,
        fileCount,
        softFileCount: sizing.softFileCount,
      });
    } else {
      out.push(
        makeSoftWidth(task.slug, 'fileCount', fileCount, sizing.softFileCount),
      );
    }
  }

  return out;
}

function computeStorySizingFindings(stories, taskCountByStory) {
  const out = [];
  for (const story of stories) {
    const taskCount = taskCountByStory.get(story.slug) ?? 0;
    if (taskCount > SOFT_STORY_TASK_COUNT) {
      out.push({
        kind: 'soft-story-width',
        severity: 'soft',
        storySlug: story.slug,
        taskCount,
        soft: SOFT_STORY_TASK_COUNT,
      });
    }
  }
  return out;
}

/**
 * Compute the full structured findings array for a normalized ticket
 * hierarchy. The validator stitches this onto its return value as
 * `findings`; the AC-visible `errors[]` channel is the rendered
 * subset where `severity === 'hard'`.
 *
 * @param {{ tasks: object[], stories: object[], taskCountByStory: Map<string, number>, sizing?: object }} input
 * @returns {object[]}
 */
export function computeSizingFindings({
  tasks,
  stories,
  taskCountByStory,
  sizing,
}) {
  const merged = { ...DEFAULT_TASK_SIZING, ...(sizing ?? {}) };
  const findings = [];
  for (const task of tasks) {
    findings.push(...computeTaskSizingFindings(task, merged));
  }
  findings.push(...computeStorySizingFindings(stories, taskCountByStory));
  return findings;
}

/**
 * Render a structured hard finding as a human-readable error message.
 */
export function renderHardFindingError(finding) {
  if (finding.kind === 'oversized-task') {
    return `Task "${finding.ticketSlug}" exceeds the ${finding.field} ceiling: observed ${finding.observed}, max ${finding.ceiling}.`;
  }
  if (finding.kind === 'missing-sizing-profile') {
    const allowed = SIZING_PROFILE_VALUES.join(' | ');
    return `Task "${finding.ticketSlug}" touches ${finding.fileCount} files (> softFileCount ${finding.softFileCount}) and must declare body.sizingProfile (one of: ${allowed}).`;
  }
  return `Task "${finding.ticketSlug}" tripped hard finding ${finding.kind}.`;
}
