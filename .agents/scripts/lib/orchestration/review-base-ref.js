/**
 * The base ref a Story-scope review measures against: `origin/<base>`, the ref
 * base-sync merged — never the bare name, whose stale local ref would score
 * others' landed commits as this Story's. Resolved once and threaded to every
 * review arm. Unresolvable fails safe: a degradation record, no findings.
 */

import { gitSpawn } from '../git-utils.js';
import { degradationEnvelope } from './review-providers/degraded-gates.js';

/**
 * `main` → `origin/main`; already-qualified input passes through.
 *
 * @param {unknown} baseBranch
 * @returns {string|null} the remote-tracking ref, or `null` when unnameable.
 */
export function remoteBaseRef(baseBranch) {
  const base = typeof baseBranch === 'string' ? baseBranch.trim() : '';
  if (base.length === 0) return null;
  return base.startsWith('origin/') ? base : `origin/${base}`;
}

/**
 * Verified present in this clone; no local-ref fallback.
 *
 * @param {{
 *   baseBranch: string,
 *   cwd?: string,
 *   gitSpawnFn?: typeof gitSpawn,
 * }} args
 * @returns {{ ref: string|null, resolved: boolean, remoteRef: string|null }}
 */
export function resolveSharedBaseRef({
  baseBranch,
  cwd = process.cwd(),
  gitSpawnFn = gitSpawn,
} = {}) {
  const remoteRef = remoteBaseRef(baseBranch);
  if (remoteRef === null) {
    return { ref: null, resolved: false, remoteRef: null };
  }
  try {
    const probe = gitSpawnFn(
      cwd,
      'rev-parse',
      '--verify',
      '--quiet',
      `${remoteRef}^{commit}`,
    );
    if (probe?.status === 0) {
      return { ref: remoteRef, resolved: true, remoteRef };
    }
  } catch {
    // A spawn failure means the same as a missing ref.
  }
  return { ref: null, resolved: false, remoteRef };
}

/**
 * A completed-review-shaped envelope whose `degraded` flag keeps "no findings"
 * from reading as "clean". Reported, not blocking.
 *
 * @param {{
 *   storyId: number|string,
 *   baseBranch: string,
 *   remoteRef: string|null,
 *   progress: (tag: string, msg: string) => void,
 *   progressTag?: string,
 * }} args
 * @returns {object}
 */
export function unresolvedBaseReviewOutcome({
  storyId,
  baseBranch,
  remoteRef,
  progress,
  progressTag = 'REVIEW',
}) {
  const surface = remoteRef ?? `origin/${baseBranch}`;
  progress(
    progressTag,
    `⚠️ Story-scope review for Story #${storyId} did not run: cannot resolve ` +
      `${surface}, the base ref base-sync merges from. Diffing the local ` +
      `${baseBranch} instead would score commits this Story never made, so no ` +
      'findings are raised. Fetch the base ref (or re-run without ' +
      '--skip-sync) to restore the review.',
  );
  return {
    halted: false,
    skipped: true,
    severity: { critical: 0, high: 0, medium: 0, suggestion: 0 },
    posted: false,
    postedCommentId: null,
    ...degradationEnvelope([
      {
        tool: 'story-scope-review',
        gate: 'base-ref-resolution',
        surface,
        reason: 'remote-base-ref-unresolved',
      },
    ]),
    crossRefPosted: false,
  };
}
