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
  return { ok: true, applied: true, skipped: false, behind: plan.behind };
}
