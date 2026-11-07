/**
 * The base ref a Story-scope review measures against: `origin/<base>`, the ref
 * base-sync merged — never the bare name, whose stale local ref would score
 * others' landed commits as this Story's. Resolved once and threaded to every
 * review arm. Unresolvable fails safe: a `verdict-missing` degradation, no
 * findings, and a halt under `delivery.codeReview.onNoVerdict: "block"`.
 */

import { remoteBaseRef as sharedRemoteBaseRef } from '../changed-files.js';
import { gitSpawn } from '../git-utils.js';
import {
  degradationEnvelope,
  resolveNoVerdictHalt,
} from './review-providers/degraded-gates.js';

/**
 * Re-export of the shared spelling in `changed-files.js`, kept for review
 * importers.
 *
 * @param {unknown} baseBranch
 * @returns {string|null}
 */
export function remoteBaseRef(baseBranch) {
  return sharedRemoteBaseRef(baseBranch);
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

/** @param {string} surface */
function unresolvedBaseDegradations(surface) {
  return [
    {
      tool: 'story-scope-review',
      gate: 'base-ref-resolution',
      surface,
      kind: 'verdict-missing',
      reason: 'remote-base-ref-unresolved',
    },
  ];
}

/** A halt under `onNoVerdict: "block"`, else none. */
function haltFields(args) {
  const halt = resolveNoVerdictHalt(args);
  return {
    halted: halt !== null,
    haltCause: halt?.haltCause ?? null,
    blockerReason: halt?.blockerReason ?? null,
  };
}

/**
 * A completed-review-shaped envelope whose `degraded` flag keeps "no findings"
 * from reading as "clean". Reported, or halting under `onNoVerdict: "block"`.
 *
 * @param {{
 *   storyId: number|string,
 *   baseBranch: string,
 *   remoteRef: string|null,
 *   progress: (tag: string, msg: string) => void,
 *   progressTag?: string,
 *   onNoVerdict?: string,
 * }} args
 * @returns {object}
 */
export function unresolvedBaseReviewOutcome({
  storyId,
  baseBranch,
  remoteRef,
  progress,
  progressTag = 'REVIEW',
  onNoVerdict,
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
  const degradations = unresolvedBaseDegradations(surface);
  return {
    ...haltFields({ degradations, onNoVerdict, storyId }),
    skipped: true,
    severity: { critical: 0, high: 0, medium: 0, suggestion: 0 },
    posted: false,
    postedCommentId: null,
    ...degradationEnvelope(degradations),
    crossRefPosted: false,
  };
}
