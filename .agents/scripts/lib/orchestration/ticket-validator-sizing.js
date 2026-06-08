/**
 * Story sizing model — a small flat set of knobs plus the optional `wide`
 * declaration that lifts the hard file-width rejection. Co-located with
 * `ticket-validator.js`, but kept as its own module so the validator's
 * primary file stays under the maintainability ceiling. The validator
 * imports `computeSizingFindings` and `renderHardFindingError` and stitches
 * the result onto its return value as `findings` / `errors`.
 *
 * `DEFAULT_TASK_SIZING` is the **single source of truth** for the sizing
 * thresholds. The decomposer prompt template
 * (`.agents/scripts/lib/templates/decomposer-prompts.js`) and the authoring
 * SKILL (`.agents/skills/core/epic-plan-decompose-author/SKILL.md`) reference
 * these numbers rather than restating divergent ones — the prompt generates
 * its threshold sentence from this constant so the two surfaces cannot drift.
 * Keep it in lockstep with `.agents/schemas/agentrc.schema.json`
 * (`$defs.taskSizing`) and the JS mirror in
 * `.agents/scripts/lib/config-settings-schema.js`.
 *
 * Sizing model (Story #3760 — profile-matrix collapse):
 *   - Flat knobs: `softFiles` (~5), `hardFiles` (~15), `maxAcceptance` (~8),
 *     `softAcceptanceCount` (~6). No per-profile ceiling map, no parallel
 *     `testSurface` axis.
 *   - The four-profile `sizingProfile` enum is replaced by a single optional
 *     `wide` declaration carrying a one-line human-readable reason. Declaring
 *     `wide` with a reason lifts the `hardFiles` rejection; no Story is
 *     rejected for width when `wide` is declared.
 *   - Cohesion is the primary heuristic (one Story = one coherent change with
 *     one reason to exist); the numeric ceilings are a backstop. See the
 *     decomposer prompt and authoring SKILL.
 */

export const DEFAULT_TASK_SIZING = Object.freeze({
  // Typical-Story warning thresholds (soft — emit advisory findings).
  softFiles: 5,
  softAcceptanceCount: 6,
  // Hard ceilings (rejection unless lifted).
  hardFiles: 15,
  maxAcceptance: 8,
});

/**
 * Returns true when a `changes[]` entry is a glob pattern. Handles both the
 * canonical PathEntry object form `{ path, assumption }` and legacy strings.
 */
function isGlobBullet(bullet) {
  const s = bullet?.path ?? bullet;
  return typeof s === 'string' && s.includes('*');
}

/**
 * Extract the path-shaped head from a single `changes` entry. Handles the
 * canonical PathEntry object form (path used directly) and the legacy
 * `"<path>: <verb>"` string form (slices on the first colon).
 */
function extractChangeBulletPath(bullet) {
  const s = typeof bullet === 'string' ? bullet : (bullet?.path ?? null);
  if (!s) return null;
  const colonIdx = s.indexOf(':');
  if (colonIdx <= 0) return /[\\/.]/.test(s) ? s.trim() : null;
  const head = s.slice(0, colonIdx).trim();
  return /[\\/.]/.test(head) ? head : null;
}

/**
 * Analyse the `changes[]` array and return:
 *   - `fileCount` — number of unique non-glob path-shaped heads
 *   - `hasGlobs`  — true when at least one bullet is a glob pattern
 *
 * Handles both the canonical PathEntry object form `{ path, assumption }` and
 * the legacy string form via the underlying helpers.
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
 * Returns true when the Story declares itself `wide` with a non-empty reason.
 * A `wide` declaration lifts the `hardFiles` rejection: a legitimately broad
 * change states why it is broad rather than being silently capped. The
 * reason is the only payload — there is no longer a profile enum to match.
 */
function isDeclaredWide(wide) {
  return (
    wide !== null &&
    typeof wide === 'object' &&
    typeof wide.reason === 'string' &&
    wide.reason.trim().length > 0
  );
}

/**
 * Compute the hard + soft sizing findings for a single Story. Layers:
 *   - acceptance ceiling (`maxAcceptance`) + soft warn (`softAcceptanceCount`)
 *   - file-width ceiling (`hardFiles`) + soft warn (`softFiles`)
 *   - the optional `wide` declaration, which lifts the hard file ceiling
 *   - glob-awareness (glob entries are unknown-width; numeric ceiling skipped)
 *
 * Cohesion is the primary authoring heuristic (see the decomposer prompt and
 * SKILL); these numeric findings are the backstop. A wide Story declares
 * `wide` with a reason instead of being rejected for width.
 */
function computeStorySizingFindings(story, sizing) {
  const out = [];
  const body = story.body && typeof story.body === 'object' ? story.body : null;
  const acceptance = Array.isArray(body?.acceptance) ? body.acceptance : [];
  const changes = Array.isArray(body?.changes) ? body.changes : [];
  const declaredWide = isDeclaredWide(body?.wide ?? null);

  // Acceptance ceiling + soft warn.
  if (acceptance.length > sizing.maxAcceptance) {
    out.push(
      makeOversized(
        story.slug,
        'acceptance',
        acceptance.length,
        sizing.maxAcceptance,
      ),
    );
  } else if (acceptance.length > sizing.softAcceptanceCount) {
    out.push(
      makeSoftWidth(
        story.slug,
        'acceptance',
        acceptance.length,
        sizing.softAcceptanceCount,
      ),
    );
  }

  const { fileCount, hasGlobs } = analyseChanges(changes);

  // Glob entries mark the Story as unknown-width: a glob cannot be bounded by
  // the numeric ceiling, so skip it. A non-wide Story carrying globs gets an
  // informational nudge to either narrow the change or declare `wide`.
  if (hasGlobs) {
    if (!declaredWide) {
      out.push({
        kind: 'wide-undeclared',
        severity: 'soft',
        ticketSlug: story.slug,
        reason: 'glob-changes',
      });
    }
    return out;
  }

  // File-width: a single ceiling. `wide` (with a reason) lifts the hard cap.
  if (fileCount > sizing.hardFiles && !declaredWide) {
    out.push(
      makeOversized(story.slug, 'fileCount', fileCount, sizing.hardFiles),
    );
  } else if (fileCount > sizing.softFiles) {
    if (declaredWide) {
      // Declared-wide Stories still surface the width as advisory signal.
      out.push(
        makeSoftWidth(story.slug, 'fileCount', fileCount, sizing.softFiles),
      );
    } else {
      // Wide footprint with no `wide` declaration: informational nudge to
      // either merge the Story down (cohesion) or declare `wide` with a reason.
      out.push({
        kind: 'wide-undeclared',
        severity: 'soft',
        ticketSlug: story.slug,
        fileCount,
        softFiles: sizing.softFiles,
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
 * 3-tier (Epic #3238): each Story is its own implementation unit and
 * carries the `body` (acceptance / changes / wide) that the sizing layers
 * score. There is no Task tier, so findings are computed directly over
 * `stories`.
 *
 * @param {{ stories: object[], sizing?: object }} input
 * @returns {object[]}
 */
export function computeSizingFindings({ stories, sizing }) {
  const merged = { ...DEFAULT_TASK_SIZING, ...(sizing ?? {}) };
  const findings = [];
  for (const story of stories ?? []) {
    findings.push(...computeStorySizingFindings(story, merged));
  }
  return findings;
}

/**
 * Render a structured hard finding as a human-readable error message.
 */
export function renderHardFindingError(finding) {
  if (finding.kind === 'oversized-task') {
    return `Task "${finding.ticketSlug}" exceeds the ${finding.field} ceiling: observed ${finding.observed}, max ${finding.ceiling}. Merge the Story down to one cohesive change, or declare \`wide\` with a one-line reason.`;
  }
  return `Task "${finding.ticketSlug}" tripped hard finding ${finding.kind}.`;
}
