/**
 * fast-forward.js — fast-forward-main phase of git-cleanup (Story #2466).
 *
 * Owns `planFastForward(ctx)` and `executeFastForward(ctx)`. Extracted
 * verbatim from `git-cleanup.js`.
 *
 * @module lib/orchestration/git-cleanup/phases/fast-forward
 */

import { Logger } from '../../../Logger.js';
import {
  canFastForward,
  checkoutBranch,
  currentBranch,
  fetchRef,
  isWorkingTreeClean,
  mergeFastForward,
} from './git-probes.js';

const TAG = '[git-cleanup]';

/**
 * Pure-ish: plan the fast-forward-main phase. Inspects the working tree
 * and the local-vs-remote ref relationship to decide whether a fast-
 * forward is even possible.
 */
export function planFastForward(ctx) {
  const {
    cwd,
    baseBranch,
    remoteName = 'origin',
    isCleanFn = isWorkingTreeClean,
    currentBranchFn = currentBranch,
    fetchFn = fetchRef,
    canFastForwardFn = canFastForward,
  } = ctx;
  if (!isCleanFn(cwd)) return { runnable: false, reason: 'dirty-tree' };
  const fetchRes = fetchFn(cwd, remoteName, baseBranch);
  if (!fetchRes.ok) {
    return { runnable: false, reason: 'fetch-failed', stderr: fetchRes.stderr };
  }
  const cur = currentBranchFn(cwd);
  const ff = canFastForwardFn(cwd, baseBranch, remoteName);
  if (!ff.ok) {
    return {
      runnable: false,
      reason: ff.reason ?? 'not-fast-forward',
      currentBranch: cur,
    };
  }
  if (ff.behind === 0) {
    return {
      runnable: false,
      reason: 'already-up-to-date',
      behind: 0,
      currentBranch: cur,
    };
  }
  return { runnable: true, behind: ff.behind, currentBranch: cur };
}

/**
 * Return HEAD to the branch it started on.
 *
 * {@link maybeCheckout} moves the checkout to `baseBranch` so `merge
 * --ff-only` has somewhere to land. Leaving it there silently relocates the
 * operator: this phase runs from the MAIN checkout — which may be parked on
 * unrelated work — and the close tail can reach it long after the operator
 * walked away (a belated `single-story-confirm-merge --wait`, for instance).
 * Fast-forwarding the base branch is the contract every delivering flow owes
 * the checkout; moving someone off the branch they were using is not, and it
 * is the kind of surprise that gets subsequent work committed to the wrong
 * branch.
 *
 * Best-effort: a failed restore warns and never fails the phase — the
 * fast-forward already succeeded, and `planFastForward` refuses on a dirty
 * tree, so nothing uncommitted is ever at risk here.
 */
function restoreBranchIfMoved({ plan, baseBranch, cwd, checkoutFn, logger }) {
  const original = plan.currentBranch;
  if (!original || original === baseBranch) return;
  const co = checkoutFn(cwd, original);
  if (!co.ok) {
    logger.warn?.(
      `${TAG} ⚠️ checkout left on ${baseBranch}: restoring ${original} failed: ${co.stderr}`,
    );
    return;
  }
  logger.info?.(`${TAG} ↩️  restored checkout to ${original}`);
}

function maybeCheckout({ plan, baseBranch, cwd, checkoutFn, logger }) {
  if (!plan.currentBranch || plan.currentBranch === baseBranch) {
    return { ok: true };
  }
  const co = checkoutFn(cwd, baseBranch);
  if (!co.ok) {
    logger.warn?.(`${TAG} ❌ checkout ${baseBranch} failed: ${co.stderr}`);
    return {
      ok: false,
      applied: false,
      skipped: false,
      reason: 'checkout-failed',
      stderr: co.stderr,
    };
  }
  return { ok: true };
}

/** Execute the fast-forward-main phase. */
export function executeFastForward(ctx) {
  const {
    cwd,
    baseBranch,
    remoteName = 'origin',
    plan,
    checkoutFn = checkoutBranch,
    mergeFn = mergeFastForward,
    logger = Logger,
  } = ctx;
  if (!plan.runnable) {
    logger.info?.(
      `${TAG} ⏭️  fast-forward ${baseBranch} skipped: ${plan.reason ?? 'unknown'}`,
    );
    return {
      ok: true,
      applied: false,
      skipped: true,
      reason: plan.reason,
      behind: plan.behind,
    };
  }
  const co = maybeCheckout({ plan, baseBranch, cwd, checkoutFn, logger });
  if (!co.ok) return co;
  const ref = `${remoteName}/${baseBranch}`;
  const mergeRes = mergeFn(cwd, ref);
  if (!mergeRes.ok) {
    logger.warn?.(
      `${TAG} ❌ merge --ff-only ${ref} failed: ${mergeRes.stderr}`,
    );
    // We already moved HEAD to run the merge; put it back even on the
    // failure path rather than stranding the operator on the base branch.
    restoreBranchIfMoved({ plan, baseBranch, cwd, checkoutFn, logger });
    return {
      ok: false,
      applied: false,
      skipped: false,
      reason: 'merge-failed',
      stderr: mergeRes.stderr,
    };
  }
  logger.info?.(
    `${TAG} ✅ fast-forwarded ${baseBranch} by ${plan.behind} commit(s)`,
  );
  restoreBranchIfMoved({ plan, baseBranch, cwd, checkoutFn, logger });
  return { ok: true, applied: true, skipped: false, behind: plan.behind };
}
