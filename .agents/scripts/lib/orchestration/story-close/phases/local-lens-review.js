/**
 * phases/local-lens-review.js — the Story-scope local-lens pass: selects the
 * local lenses matching the Story diff and materializes their prompts. The
 * review spine (`runStoryReviewCore`) owns diff enumeration and code review.
 */

import {
  evaluateLensDiffFloor,
  runAuditSuite,
  selectLocalLenses,
} from '../../../audit-suite/index.js';
import { gitSpawn } from '../../../git-utils.js';
import {
  emitRuntimeFriction,
  RUNTIME_FRICTION_CATEGORIES,
} from '../../../observability/runtime-friction.js';
import { computeChangeSet } from '../../change-set.js';

/** Fixed for this tier; not risk-scaled. */
const STORY_SCOPE_LENS_DEPTH = 'light';

/**
 * Roster of materialized lens-prompt artifacts the host MUST walk — the
 * default review provider never reads them, so without this they are inert.
 *
 * @param {object|null} materialized the `runAuditSuite` result envelope.
 * @returns {string|null} the roster block, or `null` when there is nothing to walk.
 */
function renderLensArtifactRoster(materialized) {
  const paths = (materialized?.workflows ?? [])
    .map((w) => w?.artifactPath)
    .filter((p) => typeof p === 'string' && p.length > 0);
  if (paths.length === 0) return null;
  return [
    `Lens prompts materialized (host MUST read/walk each against the Story diff):`,
    ...paths.map((p) => `  - ${p}`),
  ].join('\n');
}

/**
 * Built-in substitution keys, so no per-lens declaration is needed.
 *
 * @param {{ changedFiles: string[], storyId?: number|string|null }} args
 * @returns {Record<string, string>}
 */
function buildLensSubstitutions({ changedFiles, storyId }) {
  const substitutions = { changedFiles: changedFiles.join('\n') };
  if (storyId != null && `${storyId}`.length > 0) {
    substitutions.ticketId = String(storyId);
  }
  return substitutions;
}

/**
 * Never throws: an unknown diff returns `[]`, which matches no lens, same as
 * an empty one.
 *
 * @param {{
 *   baseRef: string,
 *   headRef: string,
 *   gitSpawnFn?: import('../../change-set.js').GitSpawnFn,
 * }} args
 * @returns {string[]} Changed file paths, or `[]` on any failure.
 */
function enumerateChangedFiles({ baseRef, headRef, gitSpawnFn = gitSpawn }) {
  return computeChangeSet({ baseRef, headRef, gitSpawnFn }).files ?? [];
}

/**
 * Three-state injection: an array is used verbatim; `null` means the spine
 * already failed to enumerate, so don't re-spawn git; `undefined` means
 * nobody enumerated, so self-enumerate.
 *
 * @param {{
 *   changedFiles: string[]|null|undefined,
 *   baseRef: string,
 *   headRef: string,
 *   gitSpawnFn?: import('../../change-set.js').GitSpawnFn,
 * }} args
 * @returns {string[]}
 */
function resolveLensChangeSet({
  changedFiles,
  baseRef,
  headRef,
  gitSpawnFn = gitSpawn,
}) {
  if (changedFiles === undefined) {
    return enumerateChangedFiles({ baseRef, headRef, gitSpawnFn });
  }
  return changedFiles ?? [];
}

/**
 * Run the maker-blind Story-scope lens pass (called only from
 * `runStoryReviewCore`). No matching lens → no lens work. A diff below the
 * lens diff-floor with no sensitive-path hits records the roster but skips
 * materialization; an unknown line count fails open. Advisory: any failure
 * degrades to a skipped envelope plus a friction signal.
 *
 * @param {{
 *   baseRef: string,
 *   headRef: string,
 *   changedFiles?: string[]|null,
 *   changedLineCount?: number|null,
 *   lensDiffFloor?: number,
 *   storyId?: number|string|null,
 *   artifactPrefix?: string,
 *   progress: (tag: string, msg: string) => void,
 *   progressTag?: string,
 *   gitSpawnFn?: import('../../change-set.js').GitSpawnFn,
 *   selectLocalLensesFn?: typeof selectLocalLenses,
 *   runAuditSuiteFn?: typeof runAuditSuite,
 *   evaluateLensDiffFloorFn?: typeof evaluateLensDiffFloor,
 *   emitToolDegradationFn?: typeof emitRuntimeFriction,
 * }} args
 * @returns {Promise<{
 *   depth: 'light',
 *   lenses: string[],
 *   skipped: boolean,
 *   floorSkip: object|null,
 *   materialized: object|null,
 *   artifactPaths: string[],
 * }>}
 */
export async function runLocalLensReview({
  baseRef,
  headRef,
  changedFiles: injectedChangedFiles,
  changedLineCount = null,
  lensDiffFloor,
  storyId,
  artifactPrefix,
  progress,
  progressTag = 'CODE-REVIEW',
  gitSpawnFn = gitSpawn,
  selectLocalLensesFn = selectLocalLenses,
  runAuditSuiteFn = runAuditSuite,
  evaluateLensDiffFloorFn = evaluateLensDiffFloor,
  emitToolDegradationFn = emitRuntimeFriction,
}) {
  const empty = {
    depth: STORY_SCOPE_LENS_DEPTH,
    lenses: [],
    skipped: true,
    floorSkip: null,
    materialized: null,
    artifactPaths: [],
  };
  try {
    const changedFiles = resolveLensChangeSet({
      changedFiles: injectedChangedFiles,
      baseRef,
      headRef,
      gitSpawnFn,
    });
    const lenses = selectLocalLensesFn({ changedFiles });
    if (lenses.length === 0) {
      progress(
        progressTag,
        'No local lens matched the Story diff — skipping the lens pass.',
      );
      return empty;
    }

    // After selection so a floor-skip still records which lenses it skipped.
    const floorVerdict = evaluateLensDiffFloorFn({
      changedFiles,
      changedLineCount,
      floor: lensDiffFloor,
    });
    if (floorVerdict.skip) {
      progress(
        progressTag,
        `Lens diff-floor: ${floorVerdict.changedLineCount} changed line(s) < ` +
          `floor ${floorVerdict.floor} with zero sensitive-path hits — ` +
          `skipping materialization of ${lenses.join(', ')}.`,
      );
      return {
        depth: STORY_SCOPE_LENS_DEPTH,
        lenses,
        skipped: true,
        floorSkip: floorVerdict,
        materialized: null,
        artifactPaths: [],
      };
    }
    // Story-scoped names so concurrent closes can't clobber each other.
    const effectivePrefix =
      artifactPrefix ?? (storyId != null ? `story-${storyId}` : 'story-scope');
    const materialized = await runAuditSuiteFn({
      auditWorkflows: lenses,
      substitutions: buildLensSubstitutions({ changedFiles, storyId }),
      artifactPrefix: effectivePrefix,
    });
    progress(
      progressTag,
      `Ran ${lenses.length} local lens(es) at ${STORY_SCOPE_LENS_DEPTH} depth: ${lenses.join(', ')}.`,
    );
    const roster = renderLensArtifactRoster(materialized);
    if (roster) progress(progressTag, roster);
    const artifactPaths = (materialized?.workflows ?? [])
      .map((w) => w?.artifactPath)
      .filter((p) => typeof p === 'string' && p.length > 0);
    return {
      depth: STORY_SCOPE_LENS_DEPTH,
      lenses,
      skipped: false,
      floorSkip: floorVerdict,
      materialized,
      artifactPaths,
    };
  } catch (err) {
    // Degradations are operational signals (friction), not findings.
    progress(
      progressTag,
      `⚠️ local lens pass failed (continuing without it): ${err?.message ?? err}`,
    );
    try {
      await emitToolDegradationFn({
        storyId,
        category: RUNTIME_FRICTION_CATEGORIES.TOOL_DEGRADED,
        tool: 'local-lens-review',
        details: {
          surface: 'lens-materialization',
          reason: String(err?.message ?? err).slice(0, 500),
        },
      });
    } catch {
      // Observability must never fail the close.
    }
    return empty;
  }
}
