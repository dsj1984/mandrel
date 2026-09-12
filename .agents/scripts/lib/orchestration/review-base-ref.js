/**
 * lib/orchestration/review-base-ref.js — the base ref a Story-scope review is
 * allowed to measure against (Story #5325).
 *
 * ## The defect this closes
 *
 * A close runs base-sync and the Story-scope review against what everyone
 * called "the base branch" — but the two meant different refs. Base-sync
 * fetches and merges `origin/<base>`; the review passed the **bare** branch
 * name, which git resolves to the LOCAL `refs/heads/<base>`, i.e. to whatever
 * that ref last fast-forwarded to. On a checkout whose local base is behind
 * its remote, the review's `<base>...<head>` diff therefore contains every
 * commit the local ref is missing — other people's landed work, scored as if
 * this Story had written it. Those findings gate the land, and the operator's
 * only exit is a `review-block-overridden` on blockers that were never real.
 *
 * ## Contract
 *
 * One resolution, at the review phase boundary, threaded into the change-set
 * enumeration, the provider review and the local lens pass — so both arms of
 * the review agree about what changed and neither can inherit local drift.
 *
 * Resolution **fails safe rather than falling back**. Base-sync normally
 * guarantees the remote ref is present, but a `--skip-sync` close or a
 * remote-less checkout can reach the review with no `origin/<base>` at all.
 * Reviewing the local ref anyway is the defect, so an unresolvable base
 * produces a degradation record — carried on the review's existing
 * `degraded` / `degradations[]` envelope — and no findings whatsoever.
 */

import { gitSpawn } from '../git-utils.js';
import { degradationEnvelope } from './review-providers/degraded-gates.js';

/**
 * The remote-tracking spelling of a base branch — `main` → `origin/main`.
 * Already-qualified input passes through, so a caller naming `origin/main`
 * is not double-prefixed.
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
 * Resolve the base ref base-sync merged from, **verified present** in this
 * clone. See the module header for why there is no local-ref fallback.
 *
 * @param {{
 *   baseBranch: string,
 *   cwd?: string,
 *   gitSpawnFn?: typeof gitSpawn,
 * }} args
 * @returns {{ ref: string|null, resolved: boolean, remoteRef: string|null }}
 *   `ref` is non-null only when `resolved`; `remoteRef` is the ref that was
 *   probed, for the caller's degradation surface.
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
    // A spawn failure and a missing ref are the same answer here: the shared
    // base cannot be vouched for.
  }
  return { ref: null, resolved: false, remoteRef };
}

/**
 * The review outcome for a close that cannot establish the shared base.
 *
 * Shaped as the same envelope a completed review returns — an all-zero
 * severity tally, nothing posted, and the `degraded` / `degradations[]` pair
 * the close and the rendered comment already read — so the surfaces reading
 * it cannot mistake "no findings" for "reviewed and clean". Reported, not
 * blocking, matching the posture of every other degraded review gate.
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
