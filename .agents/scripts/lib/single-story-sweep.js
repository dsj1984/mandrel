/**
 * single-story-sweep.js — the scope-agnostic merged-branch sweep engine
 * plus the `story-*` boot-sweep preset.
 *
 * `sweepMergedBranches` is the single reap engine every boot cleanup
 * path routes through. It sits directly over the `git-cleanup` phase
 * library (`planCleanup` / `executeCleanup` / `executeFastForward` /
 * `buildGlobFilter`) and the shared `evaluateProtection` guard set, so
 * no reap path re-implements the `git branch -D` / `git merge --ff-only`
 * primitives:
 *
 *   - Scope: caller-supplied `include` / `exclude` globs (via
 *            `buildGlobFilter`). The story preset pins `story-*`.
 *   - Reap:  merged local branches whose PR HEAD SHA equals the merged
 *            `headRefOid`, deleted local + origin with tracking-ref
 *            prune (`executeCleanup` in `--remote` mode).
 *   - Protection (Story #2011): each candidate is filtered through
 *            `evaluateProtection` before reaching `executeCleanup`. A
 *            candidate is protected (not reaped) when its branch HEAD
 *            differs from the PR's `headRefOid` (unpushed work), when
 *            its worktree has uncommitted edits, or when the parent
 *            Story ticket is not in a terminal state. Protected
 *            candidates surface under `protected`.
 *   - Fast-forward (opt-in via `fastForward: true`): fast-forward the
 *            base branch through `executeFastForward` after the reap.
 *            Best-effort — a failed fast-forward never fails the sweep.
 *   - Concurrency (Story #2011): the sweep acquires a process-scoped
 *            lockfile around plan + execute. On lock contention the
 *            sweep is skipped (the host continues — same contract as a
 *            plan failure).
 *   - Content-merged (Story #4396, report-only): a plan candidate the
 *            `git-cleanup` planner classified `detectedBy: 'content-merged'`
 *            (Story #4395's `git merge-tree --write-tree` content-equivalence
 *            probe) is a **weaker** signal than a merged PR or git ancestry —
 *            no CI/GitHub merge check ever validated its exact diff. This
 *            engine never reaps on that signal alone: content-merged
 *            candidates are pulled out of the plan before protection +
 *            execute and surfaced under `contentMerged` in the envelope so
 *            the operator can route them to `/git-cleanup` for a confirmed,
 *            eyeballed reap.
 *   - Never touches the stash stack.
 *   - Errors are caught and surfaced in the envelope. Callers MUST NOT
 *            propagate sweep failures — the host proceeds either way.
 *
 * `sweepMergedStoryBranches` is a thin preset over the engine tuned for
 * the boot path (`include: story-*`, `exclude: <current story branch>`,
 * `fastForward: false`). Its exported name, signature, and result
 * envelope are unchanged from the pre-engine implementation.
 *
 * Re-exports the same `planCleanup` / `executeCleanup` injection seams so
 * tests can stub git/`gh` without touching the CLI.
 */

import {
  buildGlobFilter,
  executeCleanup as defaultExecuteCleanup,
  executeFastForward as defaultExecuteFastForward,
  planCleanup as defaultPlanCleanup,
  planFastForward as defaultPlanFastForward,
} from '../git-cleanup.js';
import { evaluateProtection as defaultEvaluateProtection } from './single-story-sweep/protection.js';
import { acquireSweepLock as defaultAcquireSweepLock } from './single-story-sweep/sweep-lock.js';

const STORY_BRANCH_INCLUDE = 'story-*';

/**
 * Scope-agnostic merged-branch sweep engine.
 *
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

  // Optional lock acquisition. Skip silently when no lockPath is
  // supplied (e.g. unit tests, callers that opt out). Contention is
  // non-fatal — return a skipped result and let the host continue.
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
 * Sweep merged `story-*` branches in `cwd`. Preset over
 * {@link sweepMergedBranches} for the boot path: it pins the `story-*`
 * include glob, excludes the current run's `currentStoryBranch`, and
 * keeps `fastForward` off (the boot caller fast-forwards the base branch
 * separately). Exported name, signature, and result-envelope shape are
 * unchanged from the pre-engine implementation.
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
 * Split a plan's candidates into the reapable set and the report-only
 * `content-merged` set (Story #4396). A candidate the `git-cleanup`
 * planner classified `detectedBy: 'content-merged'` (Story #4395's
 * `git merge-tree --write-tree` probe) never reaches protection or
 * `executeCleanup` — it is a weaker signal than a merged PR or git
 * ancestry, so the engine only reports it for the operator to route to
 * `/git-cleanup`.
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

/**
 * Inner: the plan + protect + execute pipeline. Kept separate so the
 * outer engine can stay focused on the lock and fast-forward wrappers.
 */
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

/**
 * Execute the reap plan for the reapable candidates and shape the result
 * envelope. Split out of {@link runSweepUnderLock} so each function keeps
 * a single responsibility.
 */
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
    protected: protectedList,
    contentMerged,
    failures: result.failures,
  };
}

/**
 * Best-effort fast-forward of the base branch through the git-cleanup
 * fast-forward phase. Never throws — a failed fast-forward is logged and
 * returned as `{ ok: false, error }` but must never fail the sweep.
 */
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
 * Iterate plan candidates and split them into `reapable` (safe to pass
 * to executeCleanup) and `protectedList` (skipped, with a reason).
 *
 * Protection failures are treated as protected — never reap a candidate
 * whose state we cannot verify. The reason string travels into the
 * result envelope and the log line for postmortem clarity.
 *
 * When no `protectionCtx` is supplied (legacy callers, unit tests),
 * the protection check is bypassed entirely and every candidate is
 * reapable. The boot-path CLI surfaces always supply a ctx, so this
 * fallback never fires in production.
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
    protected: [],
    contentMerged: [],
    failures: [],
    error,
  };
}
