/**
 * Three-layer Story sizing model — soft heuristics, hard structural ceilings,
 * and the optional `sizingProfile` declaration on wide Stories. Co-located
 * with `ticket-validator.js`, but kept as its own module so the validator's
 * primary file stays under the maintainability ceiling. The validator
 * imports `computeSizingFindings` and `renderHardFindingError` and stitches
 * the result onto its return value as `findings` / `errors`.
 *
 * Keep `DEFAULT_TASK_SIZING` + the `sizingProfile` enum in lockstep with
 * `.agents/schemas/agentrc.schema.json` (`$defs.taskSizing`) and the JS
 * mirror in `.agents/scripts/lib/config-settings-schema.js`.
 *
 * Recalibrations (Story #3231, Epic #3211 Feature 5):
 *   - Recal A: Per-profile change ceilings replace global `maxChanges: 8`.
 *   - Recal B: Default `maxAcceptance` raised from 6 to 8.
 *   - Recal C: `sizingProfile` is recommended-always; no hard step-function.
 *   - Recal D: Inert `SOFT_STORY_TASK_COUNT` / `computeStorySizingFindings`
 *              removed — taskCountByStory is always empty in 3-tier.
 *   - Gap 4:   Glob `changes[]` entries count as `unknown-width`.
 */

export const DEFAULT_TASK_SIZING = Object.freeze({
  maxAcceptance: 8,
  softAcceptanceCount: 6,
  softFileCount: 3,
  profileCeilings: Object.freeze({
    'mechanical-sweep': Object.freeze({ soft: 25, hard: 60 }),
    scaffolding: Object.freeze({ soft: 8, hard: 15 }),
    'atomic-rewrite': Object.freeze({ soft: 2, hard: 4 }),
    '': Object.freeze({ soft: 3, hard: 6 }),
  }),
});

export const SIZING_PROFILE_VALUES = Object.freeze([
  'mechanical-sweep',
  'atomic-rewrite',
  'scaffolding',
]);

/**
 * Returns true when a `changes[]` bullet contains a glob wildcard character
 * (`*` or `**`). Glob entries contribute `unknown-width` to the sizing pass
 * instead of counting as a distinct file path (Gap 4, Story #3231).
 */
function isGlobBullet(bullet) {
  if (typeof bullet !== 'string') return false;
  return bullet.includes('*');
}

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
 * Analyse the `changes[]` array and return:
 *   - `fileCount` — number of unique non-glob path-shaped heads
 *   - `hasGlobs`  — true when at least one bullet is a glob pattern
 *
 * A Story whose changes include a glob is classified as `unknown-width` for
 * the profile-ceiling gate. The `fileCount` still counts explicit paths so
 * the `softFileCount` hint fires on mixed Stories.
 */
function analyseChanges(changes) {
  const paths = new Set();
  let hasGlobs = false;
  for (const bullet of changes) {
    if (isGlobBullet(bullet)) {
      hasGlobs = true;
      continue;
    }
    const path = extractChangeBulletPath(bullet);
    if (path) paths.add(path);
  }
  return { fileCount: paths.size, hasGlobs };
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
 * Resolve the per-profile change ceilings for the given `sizingProfile`.
 * Falls back to the no-profile defaults when the profile is absent or
 * unknown. Operator overrides in `sizing.profileCeilings` take precedence.
 */
function resolveCeilings(sizingProfile, sizing) {
  const profileCeilings =
    sizing.profileCeilings ?? DEFAULT_TASK_SIZING.profileCeilings;
  const key =
    sizingProfile && SIZING_PROFILE_VALUES.includes(sizingProfile)
      ? sizingProfile
      : '';
  return profileCeilings[key] ?? { soft: 3, hard: 6 };
}

/**
 * Compute the hard + soft sizing findings for a single Story (or Task in
 * 4-tier mode) across all layers: acceptance ceiling, per-profile changes
 * ceiling, sizingProfile hint, glob-awareness.
 *
 * Recal C: `sizingProfile` is now recommended-always, not required above
 * the soft gate. A Story with >softFileCount files and no profile emits an
 * informational `missing-sizing-profile-hint` finding instead of the
 * former hard `missing-sizing-profile` rejection.
 */
function computeTaskSizingFindings(task, sizing) {
  const out = [];
  const body = task.body && typeof task.body === 'object' ? task.body : null;
  const acceptance = Array.isArray(body?.acceptance) ? body.acceptance : [];
  const changes = Array.isArray(body?.changes) ? body.changes : [];
  const sizingProfile = body?.sizingProfile ?? null;

  // Acceptance ceiling (Recal B: default raised from 6 to 8).
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

  // Per-profile change ceilings (Recal A) + glob-awareness (Gap 4).
  const { fileCount, hasGlobs } = analyseChanges(changes);

  if (hasGlobs) {
    // Glob entries mark unknown-width — emit an informational finding when
    // the Story lacks a declared sizingProfile so the decomposer can signal
    // the profile requirement to the planner.
    if (!sizingProfile || !SIZING_PROFILE_VALUES.includes(sizingProfile)) {
      out.push({
        kind: 'glob-without-sizing-profile',
        severity: 'soft',
        ticketSlug: task.slug,
      });
    }
    // Unknown-width Stories skip the numeric ceiling check; returning early
    // preserves the softFileCount hint path below only for explicit paths.
  } else {
    // Non-glob path: apply per-profile ceiling (Recal A).
    const ceilings = resolveCeilings(sizingProfile, sizing);
    if (changes.length > ceilings.hard) {
      out.push(
        makeOversized(task.slug, 'changes', changes.length, ceilings.hard),
      );
    } else if (changes.length > ceilings.soft) {
      out.push(
        makeSoftWidth(task.slug, 'changes', changes.length, ceilings.soft),
      );
    }
  }

  // SizingProfile hint on wide Stories (Recal C: informational only).
  if (
    fileCount > sizing.softFileCount &&
    (!sizingProfile || !SIZING_PROFILE_VALUES.includes(sizingProfile))
  ) {
    out.push({
      kind: 'missing-sizing-profile-hint',
      severity: 'soft',
      ticketSlug: task.slug,
      fileCount,
      softFileCount: sizing.softFileCount,
    });
  } else if (
    fileCount > sizing.softFileCount &&
    sizingProfile &&
    SIZING_PROFILE_VALUES.includes(sizingProfile)
  ) {
    out.push(
      makeSoftWidth(task.slug, 'fileCount', fileCount, sizing.softFileCount),
    );
  }

  return out;
}

/**
 * Compute the full structured findings array for a normalized ticket
 * hierarchy. The validator stitches this onto its return value as
 * `findings`; the AC-visible `errors[]` channel is the rendered
 * subset where `severity === 'hard'`.
 *
 * Note: `stories` and `taskCountByStory` parameters are accepted for
 * API-compatibility with the 4-tier code path in `ticket-validator.js`
 * (`assertEveryStoryHasTasks` / `countTasksByStory` plumbing remains
 * intact per Epic #3211 Non-Goals). In 3-tier, `taskCountByStory` is
 * always empty so the Story-width check that used `SOFT_STORY_TASK_COUNT`
 * has been removed (Recal D).
 *
 * @param {{ tasks: object[], stories: object[], taskCountByStory: Map<string, number>, sizing?: object }} input
 * @returns {object[]}
 */
export function computeSizingFindings({
  tasks,
  stories: _stories,
  taskCountByStory: _taskCountByStory,
  sizing,
}) {
  const merged = { ...DEFAULT_TASK_SIZING, ...(sizing ?? {}) };
  const findings = [];
  for (const task of tasks) {
    findings.push(...computeTaskSizingFindings(task, merged));
  }
  return findings;
}

/**
 * Render a structured hard finding as a human-readable error message.
 */
export function renderHardFindingError(finding) {
  if (finding.kind === 'oversized-task') {
    return `Task "${finding.ticketSlug}" exceeds the ${finding.field} ceiling: observed ${finding.observed}, max ${finding.ceiling}.`;
  }
  return `Task "${finding.ticketSlug}" tripped hard finding ${finding.kind}.`;
}
