/**
 * Merged-branch sweep over the `git-cleanup` phases, plus the `story-*` boot
 * preset. A candidate is protected when its HEAD differs from the PR's, its
 * worktree is dirty, or its Story is not terminal. Lock contention skips.
 * Errors land in the envelope; callers MUST NOT propagate them.
 */

import {
  buildGlobFilter,
  executeCleanup as defaultExecuteCleanup,
  executeFastForward as defaultExecuteFastForward,
  planCleanup as defaultPlanCleanup,
  planFastForward as defaultPlanFastForward,
} from '../clean-git.js';
import { evaluateProtection as defaultEvaluateProtection } from './single-story-sweep/protection.js';
import { acquireSweepLock as defaultAcquireSweepLock } from './single-story-sweep/sweep-lock.js';

const STORY_BRANCH_INCLUDE = 'story-*';

/**
 * @param {{
 *   cwd: string,
 *   baseBranch: string,
 *   include?: string[],
 *   exclude?: string[],
 *   fastForward?: boolean,
 *   logger?: { info?: (m: string) => void, warn?: (m: string) => void },
 *   logTag?: string,
 *   planCleanupFn?: typeof defaultPlanCleanup,
 *   executeCleanupFn?: typeof defaultExecuteCleanup,
 *   planFastForwardFn?: typeof defaultPlanFastForward,
 *   executeFastForwardFn?: typeof defaultExecuteFastForward,
 *   protectionFn?: typeof defaultEvaluateProtection,
 *   protectionCtx?: object,
 *   acquireLockFn?: typeof defaultAcquireSweepLock,
 *   lockPath?: string|null,
 *   lockTimeoutMs?: number,
 * }} args
 * @returns {Promise<{
 *   ok: boolean,
 *   skipped: boolean,
 *   candidates: number,
 *   localDeleted: number,
 *   remoteDeleted: number,
 *   reaped: string[],
 *   protected: Array<{ branch: string, reason: string, worktreePath?: string|null }>,
 *   contentMerged: Array<{ branch: string, worktreePath: string|null }>,
 *   failures: Array<{ branch: string|null, scope: string, stderr?: string }>,
 *   fastForward?: object,
 *   error?: string,
 *   reason?: string,
 * }>}
 */
export async function sweepMergedBranches({
  cwd,
  baseBranch,
  include = ['*'],
  exclude = [],
  fastForward = false,
  logger = {},
  logTag = '[sweep]',
  planCleanupFn = defaultPlanCleanup,
  executeCleanupFn = defaultExecuteCleanup,
  planFastForwardFn = defaultPlanFastForward,
  executeFastForwardFn = defaultExecuteFastForward,
  protectionFn = defaultEvaluateProtection,
  protectionCtx = null,
  acquireLockFn = defaultAcquireSweepLock,
  lockPath = null,
  lockTimeoutMs = 60_000,
} = {}) {
  const log = {
    info: typeof logger.info === 'function' ? logger.info : () => {},
    warn: typeof logger.warn === 'function' ? logger.warn : () => {},
  };

  if (typeof cwd !== 'string' || cwd.length === 0) {
    return zeroResult({ error: 'cwd is required' });
  }
  if (typeof baseBranch !== 'string' || baseBranch.length === 0) {
    return zeroResult({ error: 'baseBranch is required' });
  }

  // No lockPath → no lock. Contention returns a skipped result.
  let releaseLock = () => {};
  if (lockPath) {
    const lockResult = acquireLockFn({ lockPath, timeoutMs: lockTimeoutMs });
    if (!lockResult.acquired) {
      log.warn(
        `${logTag} lock not acquired (${lockResult.reason}${
          lockResult.detail ? `: ${lockResult.detail}` : ''
        }); skipping sweep.`,
      );
      return {
        ok: true,
        skipped: true,
        reason: `lock-${lockResult.reason}`,
        candidates: 0,
        localDeleted: 0,
        remoteDeleted: 0,
        reaped: [],
        protected: [],
        contentMerged: [],
        failures: [],
      };
    }
    releaseLock = lockResult.release;
  }

  try {
    const reap = await runSweepUnderLock({
      cwd,
      baseBranch,
      include,
      exclude,
      log,
      logTag,
      planCleanupFn,
      executeCleanupFn,
      protectionFn,
      protectionCtx,
    });
    if (!fastForward) return reap;
    const ff = runFastForwardStep({
      cwd,
      baseBranch,
      log,
      logTag,
      planFastForwardFn,
      executeFastForwardFn,
    });
    return { ...reap, fastForward: ff };
  } finally {
    try {
      releaseLock();
    } catch {
      // Lock release is best-effort.
    }
  }
}

/**
 * Boot preset: `story-*` only, current Story branch excluded, no
 * fast-forward (the boot caller does that separately).
 *
 * @param {{
 *   cwd: string,
 *   baseBranch: string,
 *   currentStoryBranch: string,
 *   logger?: { info?: (m: string) => void, warn?: (m: string) => void },
 *   planCleanupFn?: typeof defaultPlanCleanup,
 *   executeCleanupFn?: typeof defaultExecuteCleanup,
 *   protectionFn?: typeof defaultEvaluateProtection,
 *   protectionCtx?: object,
 *   acquireLockFn?: typeof defaultAcquireSweepLock,
 *   lockPath?: string|null,
 *   lockTimeoutMs?: number,
 * }} args
 * @returns {Promise<object>} the {@link sweepMergedBranches} envelope.
 */
export function sweepMergedStoryBranches(args = {}) {
  const { currentStoryBranch } = args;
  const exclude =
    typeof currentStoryBranch === 'string' && currentStoryBranch.length > 0
      ? [currentStoryBranch]
      : [];
  return sweepMergedBranches({
    ...args,
    include: [STORY_BRANCH_INCLUDE],
    exclude,
    fastForward: false,
    logTag: '[single-story-sweep]',
  });
}

/**
 * Content-merged candidates are report-only: content equivalence is weaker
 * than a merged PR or ancestry, so only an operator-confirmed `/clean-git`
 * may reap them.
 */
function partitionContentMerged(candidates) {
  const contentMerged = [];
  const reapCandidates = [];
  for (const candidate of candidates) {
    if (candidate.detectedBy === 'content-merged') {
      contentMerged.push({
        branch: candidate.branch,
        worktreePath: candidate.worktreePath ?? null,
      });
    } else {
      reapCandidates.push(candidate);
    }
  }
  return { contentMerged, reapCandidates };
}

async function runSweepUnderLock({
  cwd,
  baseBranch,
  include,
  exclude,
  log,
  logTag,
  planCleanupFn,
  executeCleanupFn,
  protectionFn,
  protectionCtx,
}) {
  const filter = buildGlobFilter({ include, exclude });

  let plan;
  try {
    plan = planCleanupFn({ cwd, baseBranch, filter });
  } catch (err) {
    const msg = err?.message ?? String(err);
    log.warn(`${logTag} plan failed: ${msg}`);
    return zeroResult({ error: `plan: ${msg}` });
  }

  const { contentMerged, reapCandidates } = partitionContentMerged(
    plan.candidates,
  );
  if (contentMerged.length > 0) {
    log.info(
      `${logTag} ${contentMerged.length} content-merged branch(es) detected (report-only, not reaped): ${contentMerged
        .map((c) => c.branch)
        .join(', ')}.`,
    );
  }

  if (reapCandidates.length === 0) {
    log.info(`${logTag} no merged branches to reap.`);
    return {
      ok: true,
      skipped: false,
      candidates: 0,
      localDeleted: 0,
      remoteDeleted: 0,
      reaped: [],
      protected: [],
      contentMerged,
      failures: [],
    };
  }

  const { reapable, protectedList } = await partitionCandidates({
    candidates: reapCandidates,
    protectionFn,
    protectionCtx,
    log,
    logTag,
  });

  if (reapable.length === 0) {
    log.info(
      `${logTag} all ${reapCandidates.length} candidate(s) protected; no reap.`,
    );
    return {
      ok: true,
      skipped: false,
      candidates: reapCandidates.length,
      localDeleted: 0,
      remoteDeleted: 0,
      reaped: [],
      protected: protectedList,
      contentMerged,
      failures: [],
    };
  }

  return executeReap({
    reapable,
    protectedList,
    contentMerged,
    candidateCount: reapCandidates.length,
    cwd,
    executeCleanupFn,
    log,
    logTag,
  });
}

function executeReap({
  reapable,
  protectedList,
  contentMerged,
  candidateCount,
  cwd,
  executeCleanupFn,
  log,
  logTag,
}) {
  let result;
  try {
    result = executeCleanupFn({ candidates: reapable, cwd, remote: true });
  } catch (err) {
    const msg = err?.message ?? String(err);
    log.warn(`${logTag} execute failed: ${msg}`);
    return {
      ok: false,
      skipped: false,
      candidates: candidateCount,
      localDeleted: 0,
      remoteDeleted: 0,
      reaped: [],
      protected: protectedList,
      contentMerged,
      failures: [{ branch: null, scope: 'execute', stderr: msg }],
      error: `execute: ${msg}`,
    };
  }

  const localDeleted = result.local.filter((r) => r.ok).length;
  const remoteDeleted = result.remote.filter((r) => r.ok).length;
  const reapedBranches = reapable.map((c) => c.branch).join(', ');
  const protectedSummary =
    protectedList.length > 0
      ? `; protected ${protectedList.length} (${protectedList
          .map((p) => `${p.branch} → ${p.reason}`)
          .join(', ')})`
      : '';
  const summary = `${localDeleted} local + ${remoteDeleted} remote${protectedSummary}`;
  if (result.ok) {
    log.info(
      `${logTag} reaped ${summary}${reapedBranches ? ` [${reapedBranches}]` : ''}.`,
    );
  } else {
    log.warn(
      `${logTag} reaped ${summary} with ${result.failures.length} failure(s) — host continues.`,
    );
  }

  return {
    ok: result.ok,
    skipped: false,
    candidates: candidateCount,
    localDeleted,
    remoteDeleted,
    // Confirmed merges: temp-retention's catch-up purges on these names.
    reaped: reapable.map((c) => c.branch),
    protected: protectedList,
    contentMerged,
    failures: result.failures,
  };
}

/** Best-effort base fast-forward; never throws, never fails the sweep. */
function runFastForwardStep({
  cwd,
  baseBranch,
  log,
  logTag,
  planFastForwardFn,
  executeFastForwardFn,
}) {
  try {
    const plan = planFastForwardFn({ cwd, baseBranch });
    const ff = executeFastForwardFn({
      cwd,
      baseBranch,
      plan,
      logger: {
        info: (m) => log.info(m.replace(/^\[git-cleanup\]\s*/, `${logTag} `)),
        warn: (m) => log.warn(m.replace(/^\[git-cleanup\]\s*/, `${logTag} `)),
      },
    });
    return {
      ok: ff.ok !== false,
      applied: !!ff.applied,
      skipped: !!ff.skipped,
      behind: ff.behind ?? null,
      reason: ff.reason ?? null,
    };
  } catch (err) {
    const msg = err?.message ?? String(err);
    log.warn(`${logTag} fast-forward failed: ${msg}`);
    return { ok: false, applied: false, skipped: false, error: msg };
  }
}

/**
 * A protection-eval error counts as protected: never reap what cannot be
 * verified. No `protectionCtx` (tests only) bypasses protection.
 */
async function partitionCandidates({
  candidates,
  protectionFn,
  protectionCtx,
  log,
  logTag,
}) {
  const reapable = [];
  const protectedList = [];
  for (const candidate of candidates) {
    if (!protectionCtx) {
      reapable.push(candidate);
      continue;
    }
    let verdict;
    try {
      verdict = await protectionFn({ candidate, ctx: protectionCtx });
    } catch (err) {
      const reason = `protection-eval-error: ${err?.message ?? err}`;
      log.warn(`${logTag} protected ${candidate.branch}: ${reason}`);
      protectedList.push({
        branch: candidate.branch,
        reason,
        worktreePath: candidate.worktreePath ?? null,
      });
      continue;
    }
    if (verdict?.protected) {
      log.info(`${logTag} protected ${candidate.branch}: ${verdict.reason}`);
      protectedList.push({
        branch: candidate.branch,
        reason: verdict.reason ?? 'unknown',
        worktreePath: candidate.worktreePath ?? null,
      });
      continue;
    }
    reapable.push(candidate);
  }
  return { reapable, protectedList };
}

function zeroResult({ error }) {
  return {
    ok: false,
    skipped: true,
    candidates: 0,
    localDeleted: 0,
    remoteDeleted: 0,
    reaped: [],
    protected: [],
    contentMerged: [],
    failures: [],
    error,
  };
}
