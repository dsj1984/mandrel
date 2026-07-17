/**
 * phases/local-lens-review.js — the Story-scope local-lens pass.
 *
 * Extracted from `phases/code-review.js` (Story #4603) so the review spine and
 * the lens pass each carry one reason to change. The spine
 * (`runStoryReviewCore`) owns the single per-close-run diff enumeration and the
 * `runCodeReview` invocation; this module owns lens selection + materialization.
 *
 * Shift-left tier (Epic #4405): local concerns are cheap to decide on a single
 * Story's diff, so the maker-blind Story-scope review runs its matched local
 * lenses here, inside the story-close subprocess, rather than paying a deeper
 * pass at Epic close.
 */

import {
  runAuditSuite,
  selectLocalLenses,
} from '../../../audit-suite/index.js';
import { gitSpawn } from '../../../git-utils.js';
import { computeChangeSet } from '../../change-set.js';

/**
 * The review depth the Story-scope local-lens pass runs at. Fixed for this
 * tier — it is not risk-scaled like the code-review pillar depth.
 *
 * Module-local: it is an implementation detail of {@link runLocalLensReview}
 * (it rides out on the returned envelope's `depth` field), not a public seam.
 * Tests assert the observable `'light'` on that envelope rather than importing
 * the constant, so it stays off the public surface (Story #4603).
 */
const STORY_SCOPE_LENS_DEPTH = 'light';

/**
 * Enumerate the files changed in the `baseRef...headRef` diff. Thin adapter over
 * the shared {@link computeChangeSet} enumerator (Story #4593) that flattens its
 * `files: string[]|null` envelope to this phase's historical `[]`-on-failure
 * contract: the lens roster treats "nothing changed" and "diff unknown"
 * identically, because an unknown diff matches no `filePatterns` and therefore
 * adds no lens work either way.
 *
 * Best-effort and total — never throws, mirroring the advisory posture of the
 * surrounding review phase. Retained as the self-enumeration fallback for
 * {@link runLocalLensReview} when no change set is injected.
 *
 * @param {{
 *   baseRef: string,
 *   headRef: string,
 *   gitSpawnFn?: import('../../change-set.js').GitSpawnFn,
 * }} args
 * Module-local (Story #4603): a private fallback of {@link runLocalLensReview},
 * exercised through that public entry point rather than imported directly, so it
 * adds no public export a production path fails to reach.
 *
 * @returns {string[]} Changed file paths, or `[]` on any failure.
 */
function enumerateChangedFiles({ baseRef, headRef, gitSpawnFn = gitSpawn }) {
  return computeChangeSet({ baseRef, headRef, gitSpawnFn }).files ?? [];
}

/**
 * Resolve the change set the lens roster reads, honouring all THREE injection
 * states (Story #4603 — the fix for #4593's single-enumeration leak).
 *
 * The distinction between `null` and `undefined` is load-bearing and mirrors
 * the sibling contract in `orchestration/code-review.js#resolveInjectedChangedFiles`:
 *
 *   - **array**     — the caller's change set; use it verbatim.
 *   - **`null`**    — the caller (`runStoryReviewCore`) already tried and the
 *                     diff is unenumerable. Re-running git here would only fail
 *                     again, so degrade straight to the fail-safe empty roster.
 *   - **`undefined`** — nobody enumerated (standalone callers), so the shared
 *                     enumerator runs as the fallback.
 *
 * The prior `Array.isArray()` discriminator collapsed `null` and `undefined`
 * into one branch and re-spawned git on the unenumerable path, contradicting the
 * spine's documented "the one enumeration per close run" invariant.
 *
 * Module-local (Story #4603): a private detail of {@link runLocalLensReview}.
 * The three-state contract is asserted through that public entry point (does an
 * injected `null` re-spawn git? does `undefined` self-enumerate?), so it needs
 * no public export — keeping the fix from re-introducing the very kind of
 * production-dead public symbol this Story's ratchet root-cause is about.
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
 * Run the Story-scope local-lens pass: select the LOCAL-tier lenses whose
 * `filePatterns` match the actual Story diff (`baseRef...headRef`) and
 * materialize their lens-prompt bodies at `light` depth. Called only from
 * `runStoryReviewCore`, never in the delivering child's (maker's) context, so a
 * maker never grades its own work.
 *
 * A diff that matches no local lens adds **no** lens work: the roster is empty
 * and `runAuditSuite` is never invoked. Best-effort and total — a git or
 * materialization failure degrades to `{ skipped: true, lenses: [] }` and is
 * logged via `progress`, matching the advisory posture the review phase already
 * takes for provider/transport failures.
 *
 * Story #4593 — `changedFiles` is injected by `runStoryReviewCore`, which
 * computes the change set once per close run and hands the same list to this
 * pass and to `runCodeReview`. Self-enumeration is the **fallback only**, kept
 * for standalone callers that supply no list; see {@link resolveLensChangeSet}
 * for the three-state contract.
 *
 * @param {{
 *   baseRef: string,
 *   headRef: string,
 *   changedFiles?: string[]|null,
 *   progress: (tag: string, msg: string) => void,
 *   progressTag?: string,
 *   gitSpawnFn?: import('../../change-set.js').GitSpawnFn,
 *   selectLocalLensesFn?: typeof selectLocalLenses,
 *   runAuditSuiteFn?: typeof runAuditSuite,
 * }} args
 * @returns {Promise<{
 *   depth: 'light',
 *   lenses: string[],
 *   skipped: boolean,
 *   materialized: object|null,
 * }>}
 */
export async function runLocalLensReview({
  baseRef,
  headRef,
  changedFiles: injectedChangedFiles,
  progress,
  progressTag = 'CODE-REVIEW',
  gitSpawnFn = gitSpawn,
  selectLocalLensesFn = selectLocalLenses,
  runAuditSuiteFn = runAuditSuite,
}) {
  const empty = {
    depth: STORY_SCOPE_LENS_DEPTH,
    lenses: [],
    skipped: true,
    materialized: null,
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
    const materialized = await runAuditSuiteFn({ auditWorkflows: lenses });
    progress(
      progressTag,
      `Ran ${lenses.length} local lens(es) at ${STORY_SCOPE_LENS_DEPTH} depth: ${lenses.join(', ')}.`,
    );
    return {
      depth: STORY_SCOPE_LENS_DEPTH,
      lenses,
      skipped: false,
      materialized,
    };
  } catch (err) {
    // The lens pass is advisory: a git or materialization failure must not
    // fail the close. Log and degrade to a skipped envelope.
    progress(
      progressTag,
      `⚠️ local lens pass failed (continuing without it): ${err?.message ?? err}`,
    );
    return empty;
  }
}
