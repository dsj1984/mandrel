/**
 * single-story-sweep.js — Sweep merged `story-*` branches at init.
 *
 * Wraps `git-cleanup-branches.js` with a fixed policy tuned for the
 * `/single-story-deliver` boot path:
 *
 *   - Scope: `story-*` only (never touches `epic/*`, `story/<id>/*`, etc.).
 *   - Mode:  --execute --remote (delete local + origin + prune trackers).
 *   - Skip:  the current run's `storyBranch` is always excluded, even if a
 *            stale PR for the same id were already merged.
 *   - Protection (Story #2011): each candidate is filtered through
 *            `evaluateProtection` before reaching `executeCleanup`. A
 *            candidate is protected (not reaped) when its branch HEAD
 *            differs from the PR's `headRefOid` (unpushed work), when
 *            its worktree has uncommitted edits, or when the parent
 *            Story ticket is not in a terminal state. Protected
 *            candidates surface in the result envelope under
 *            `protected` so the operator can see what was skipped.
 *   - Concurrency (Story #2011): the sweep acquires a process-scoped
 *            lockfile around plan + execute. On lock contention the
 *            sweep is skipped (init continues — same contract as a
 *            plan failure).
 *   - Errors are caught and surfaced in the envelope. The caller MUST NOT
 *            propagate sweep failures — story init proceeds either way.
 *
 * Re-exports the same `planCleanup` / `executeCleanup` injection seams so
 * tests can stub git/`gh` without touching the CLI.
 */

import {
  buildGlobFilter,
  executeCleanup as defaultExecuteCleanup,
  planCleanup as defaultPlanCleanup,
} from '../git-cleanup.js';
import { evaluateProtection as defaultEvaluateProtection } from './single-story-sweep/protection.js';
import { acquireSweepLock as defaultAcquireSweepLock } from './single-story-sweep/sweep-lock.js';

const STORY_BRANCH_INCLUDE = 'story-*';

/**
 * Sweep merged `story-*` branches in `cwd`.
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
 * @returns {Promise<{
 *   ok: boolean,
 *   skipped: boolean,
 *   candidates: number,
 *   localDeleted: number,
 *   remoteDeleted: number,
 *   protected: Array<{ branch: string, reason: string, worktreePath?: string|null }>,
 *   failures: Array<{ branch: string|null, scope: string, stderr?: string }>,
 *   error?: string,
 *   reason?: string,
 * }>}
 */
export async function sweepMergedStoryBranches({
  cwd,
  baseBranch,
  currentStoryBranch,
  logger = {},
  planCleanupFn = defaultPlanCleanup,
  executeCleanupFn = defaultExecuteCleanup,
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

  // Optional lock acquisition. Skip silently when no lockPath is
  // supplied (e.g. unit tests, callers that opt out). Contention is
  // non-fatal — return a skipped result and let init continue.
  let releaseLock = () => {};
  if (lockPath) {
    const lockResult = acquireLockFn({
      lockPath,
      timeoutMs: lockTimeoutMs,
    });
    if (!lockResult.acquired) {
      log.warn(
        `[single-story-sweep] lock not acquired (${lockResult.reason}${
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
        protected: [],
        failures: [],
      };
    }
    releaseLock = lockResult.release;
  }

  try {
    return await runSweepUnderLock({
      cwd,
      baseBranch,
      currentStoryBranch,
      log,
      planCleanupFn,
      executeCleanupFn,
      protectionFn,
      protectionCtx,
    });
  } finally {
    try {
      releaseLock();
    } catch {
      // Lock release is best-effort.
    }
  }
}

/**
 * Inner: the plan + protect + execute pipeline. Kept separate so the
 * outer `sweepMergedStoryBranches` can stay focused on the lock
 * acquire/release wrapper.
 */
async function runSweepUnderLock({
  cwd,
  baseBranch,
  currentStoryBranch,
  log,
  planCleanupFn,
  executeCleanupFn,
  protectionFn,
  protectionCtx,
}) {
  const exclude =
    typeof currentStoryBranch === 'string' && currentStoryBranch.length > 0
      ? [currentStoryBranch]
      : [];
  const filter = buildGlobFilter({
    include: [STORY_BRANCH_INCLUDE],
    exclude,
  });

  let plan;
  try {
    plan = planCleanupFn({ cwd, baseBranch, filter });
  } catch (err) {
    const msg = err?.message ?? String(err);
    log.warn(`[single-story-sweep] plan failed: ${msg}`);
    return zeroResult({ error: `plan: ${msg}` });
  }

  if (plan.candidates.length === 0) {
    log.info('[single-story-sweep] no merged story branches to reap.');
    return {
      ok: true,
      skipped: false,
      candidates: 0,
      localDeleted: 0,
      remoteDeleted: 0,
      protected: [],
      failures: [],
    };
  }

  const { reapable, protectedList } = await partitionCandidates({
    candidates: plan.candidates,
    protectionFn,
    protectionCtx,
    log,
  });

  if (reapable.length === 0) {
    log.info(
      `[single-story-sweep] all ${plan.candidates.length} candidate(s) protected; no reap.`,
    );
    return {
      ok: true,
      skipped: false,
      candidates: plan.candidates.length,
      localDeleted: 0,
      remoteDeleted: 0,
      protected: protectedList,
      failures: [],
    };
  }

  let result;
  try {
    result = executeCleanupFn({
      candidates: reapable,
      cwd,
      remote: true,
    });
  } catch (err) {
    const msg = err?.message ?? String(err);
    log.warn(`[single-story-sweep] execute failed: ${msg}`);
    return {
      ok: false,
      skipped: false,
      candidates: plan.candidates.length,
      localDeleted: 0,
      remoteDeleted: 0,
      protected: protectedList,
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
      `[single-story-sweep] reaped ${summary}${reapedBranches ? ` [${reapedBranches}]` : ''}.`,
    );
  } else {
    log.warn(
      `[single-story-sweep] reaped ${summary} with ${result.failures.length} failure(s) — init continues.`,
    );
  }

  return {
    ok: result.ok,
    skipped: false,
    candidates: plan.candidates.length,
    localDeleted,
    remoteDeleted,
    protected: protectedList,
    failures: result.failures,
  };
}

/**
 * Iterate plan candidates and split them into `reapable` (safe to pass
 * to executeCleanup) and `protectedList` (skipped, with a reason).
 *
 * Protection failures are treated as protected — never reap a candidate
 * whose state we cannot verify. The reason string travels into the
 * result envelope and the log line for postmortem clarity.
 *
 * When no `protectionCtx` is supplied (legacy callers, unit tests),
 * the protection check is bypassed entirely and every candidate is
 * reapable. The CLI surface in `single-story-init.js` always supplies
 * a ctx, so this fallback never fires in production.
 */
async function partitionCandidates({
  candidates,
  protectionFn,
  protectionCtx,
  log,
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
      log.warn(`[single-story-sweep] protected ${candidate.branch}: ${reason}`);
      protectedList.push({
        branch: candidate.branch,
        reason,
        worktreePath: candidate.worktreePath ?? null,
      });
      continue;
    }
    if (verdict?.protected) {
      log.info(
        `[single-story-sweep] protected ${candidate.branch}: ${verdict.reason}`,
      );
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
    protected: [],
    failures: [],
    error,
  };
}
